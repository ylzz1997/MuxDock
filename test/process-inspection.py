"""Real abduco process-isolation regression on macOS/Linux.

Run: python3 test/process-inspection.py /path/to/abduco
"""
import glob
import json
import os
from pathlib import Path
import pty
import signal
import subprocess
import sys
import tempfile
import time


executable = os.path.realpath(sys.argv[1])
helper = str(Path(__file__).resolve().parents[1] / 'src/session-processes.py')
clients = []
servers = []
background = None


def wait(predicate):
    for _ in range(100):
        try:
            value = predicate()
            if value:
                return value
        except (OSError, subprocess.SubprocessError):
            pass
        time.sleep(.05)
    raise AssertionError('Fixture timed out')


with tempfile.TemporaryDirectory(prefix='md-inspect-', dir='/tmp') as root:
    os.mkdir(root + '/abduco', mode=0o700)
    environment = dict(os.environ, ABDUCO_SOCKET_DIR=root, SHELL='/bin/sh', TERM='xterm-256color', LC_ALL='C')

    def start(name, create, env=environment):
        pid, fd = pty.fork()
        if pid == 0:
            args = [executable, '-c' if create else '-a', name] + (['/bin/sh'] if create else [])
            os.execve(executable, args, env)
        clients.append((pid, fd))
        return pid, fd

    def inspect(name, detach=False, file=executable, env=environment):
        output = subprocess.check_output(['python3', helper, json.dumps(dict(manager='abduco', name=name, file=file, detach=detach))], env=env, text=True)
        return json.loads(output)

    try:
        first, fd = start('target', True)
        wait(lambda: glob.glob(root + '/abduco/target@*') or glob.glob(root + '/abduco/*/target@*'))
        second, _ = start('target', False)
        other, _ = start('other', True)
        os.mkdir(root + '/another-namespace', mode=0o700)
        other_environment = dict(environment, ABDUCO_SOCKET_DIR=root + '/another-namespace')
        same_name, _ = start('target', True, other_environment)
        wait(lambda: len(inspect('target', env=other_environment)['clients']) == 1)
        wait(lambda: len(inspect('target')['clients']) == 2)
        before = inspect('target')
        servers.extend([before['serverPid'], inspect('other')['serverPid'], inspect('target', env=other_environment)['serverPid']])
        assert before['serverPid'] not in (first, second)
        assert before['shellPid'] not in (first, second, before['serverPid'])
        os.write(fd, ('sleep 60 & echo $! > ' + root + '/taskpid\n').encode())
        wait(lambda: Path(root + '/taskpid').exists())
        background = int(Path(root + '/taskpid').read_text())
        wrong = subprocess.run(['python3', helper, json.dumps(dict(manager='abduco', name='target', file='/bin/false', detach=True))], env=environment, capture_output=True, text=True)
        assert wrong.returncode != 0
        assert len(inspect('target')['clients']) == 2
        inspect('target', True)
        wait(lambda: os.waitpid(first, os.WNOHANG)[0] == first)
        wait(lambda: os.waitpid(second, os.WNOHANG)[0] == second)
        assert inspect('target')['clients'] == []
        for pid in (before['serverPid'], before['shellPid'], background, other, same_name):
            os.kill(pid, 0)
        assert len(inspect('other')['clients']) == 1
        assert len(inspect('target', env=other_environment)['clients']) == 1
        start('target', False)
        wait(lambda: len(inspect('target')['clients']) == 1)
        print(json.dumps(dict(status='PASS', platform=sys.platform, checks=[
            'actual socket owner excludes pre-daemon creator PID',
            'executable mismatch refuses all signals', 'two external clients released',
            'server, shell and background task survive', 'unrelated session stays connected',
            'same-name session in another socket namespace stays connected', 'reattach succeeds'
        ])))
    finally:
        for pid in servers + ([background] if background else []):
            try:
                os.kill(pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
        for pid, fd in clients:
            os.close(fd)
            try:
                os.kill(pid, signal.SIGHUP)
            except ProcessLookupError:
                pass
