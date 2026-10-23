"""Inspect abduco/a4 sessions and release only their verified client processes."""
import ctypes
import datetime
import json
import os
import pwd
import signal
import socket
import struct
import subprocess
import sys


def command(*args):
    return subprocess.check_output(args, text=True, stderr=subprocess.DEVNULL, timeout=3).strip()


def socket_path(manager, name, cwd=None, environment=None):
    environment = os.environ if environment is None else environment
    if name.startswith('/'):
        return name
    if name.startswith('./') or name.startswith('../'):
        if cwd is None:
            raise RuntimeError('MUXDOCK_ERROR:relativeCwdUnknown')
        return os.path.normpath(os.path.join(cwd, name))
    suffix = '@' + socket.gethostname()
    home = environment.get('HOME') or pwd.getpwuid(os.getuid()).pw_dir
    if manager == 'a4':
        base = environment.get('XDG_STATE_HOME') or os.path.join(home, '.local/state')
        return os.path.join(base, 'a4', name + suffix)
    user = pwd.getpwuid(os.getuid()).pw_name
    directories = [
        os.path.join(environment['ABDUCO_SOCKET_DIR'], 'abduco', user) if environment.get('ABDUCO_SOCKET_DIR') else None,
        os.path.join(environment['ABDUCO_SOCKET_DIR'], 'abduco') if environment.get('ABDUCO_SOCKET_DIR') else None,
        os.path.join(home, '.abduco'),
        os.path.join(environment.get('TMPDIR', '/tmp'), 'abduco', user),
        os.path.join('/tmp/abduco', user),
    ]
    for directory in directories:
        if directory and os.path.exists(os.path.join(directory, name + suffix)):
            return os.path.join(directory, name + suffix)
    raise RuntimeError('MUXDOCK_ERROR:socketMissing')


def server_pid(address, executable, rows):
    # Peer credentials can identify the original creator before daemonization.
    # Identify the process that actually owns the listening socket instead.
    if sys.platform == 'darwin':
        owners = [int(line[1:]) for line in command('/usr/sbin/lsof', '-n', '-a', '-U', '-Fp', '--', address).splitlines() if line.startswith('p')]
    else:
        with open('/proc/net/unix') as stream:
            inodes = {line.split()[6] for line in stream if len(line.split()) >= 8 and line.split(maxsplit=7)[7].strip() == address and line.split()[3] == '00010000'}
        owners = []
        for pid, _, uid in rows:
            if uid != os.getuid() or executable_for(pid) != executable:
                continue
            try:
                for fd in os.listdir('/proc/%d/fd' % pid):
                    try:
                        if os.readlink('/proc/%d/fd/%s' % (pid, fd)) in {'socket:[%s]' % inode for inode in inodes}:
                            owners.append(pid)
                            break
                    except OSError:
                        pass
            except OSError:
                pass
    owners = list({pid for pid in owners if executable_for(pid) == executable})
    if len(owners) != 1:
        raise RuntimeError('MUXDOCK_ERROR:serverAmbiguous')
    return owners[0]


def cwd_for(pid):
    try:
        if sys.platform == 'linux':
            return os.readlink('/proc/%d/cwd' % pid)
        return next((line[1:] for line in command('/usr/sbin/lsof', '-a', '-p', str(pid), '-d', 'cwd', '-Fn').splitlines() if line.startswith('n')), None)
    except (OSError, subprocess.SubprocessError):
        return None


def process_data(pid):
    try:
        if sys.platform == 'linux':
            with open('/proc/%d/cmdline' % pid, 'rb') as stream:
                argv = [os.fsdecode(value) for value in stream.read().rstrip(b'\0').split(b'\0')]
            with open('/proc/%d/environ' % pid, 'rb') as stream:
                entries = stream.read().split(b'\0')
            return argv, selected_environment(entries)
        libc = ctypes.CDLL(None, use_errno=True)
        mib = (ctypes.c_int * 3)(1, 49, pid)  # CTL_KERN, KERN_PROCARGS2
        size = ctypes.c_size_t()
        if libc.sysctl(mib, 3, None, ctypes.byref(size), None, 0):
            return [], {}
        buffer = ctypes.create_string_buffer(size.value)
        if libc.sysctl(mib, 3, buffer, ctypes.byref(size), None, 0):
            return [], {}
        data = buffer.raw[:size.value]
        argc = struct.unpack_from('i', data)[0]
        start = data.index(b'\0', 4)
        while start < len(data) and data[start] == 0:
            start += 1
        entries = data[start:].split(b'\0')
        return [os.fsdecode(value) for value in entries[:argc]], selected_environment(entries[argc:])
    except (OSError, ValueError):
        return [], {}


def selected_environment(entries):
    allowed = {'HOME', 'TMPDIR', 'XDG_RUNTIME_DIR', 'XDG_STATE_HOME', 'ABDUCO_SOCKET_DIR', 'ZELLIJ_SOCKET_DIR'}
    result = {}
    for entry in entries:
        key, separator, value = os.fsdecode(entry).partition('=')
        if separator and key in allowed:
            result[key] = value
    return result


def argv_for(pid):
    return process_data(pid)[0]


def executable_for(pid):
    try:
        if sys.platform == 'linux':
            return os.path.realpath('/proc/%d/exe' % pid)
        libproc = ctypes.CDLL('/usr/lib/libproc.dylib')
        buffer = ctypes.create_string_buffer(4096)
        if libproc.proc_pidpath(pid, buffer, len(buffer)) > 0:
            return os.path.realpath(os.fsdecode(buffer.value))
    except OSError:
        pass
    return None


def session_argument(manager, argv):
    # Parse arguments as discrete argv entries, including session names with spaces.
    index = 1
    attaching = False
    while index < len(argv):
        value = argv[index]
        if manager == 'zellij':
            if value in ('--session', '-s', 'attach', 'a', 'watch', 'w') and index + 1 < len(argv):
                return argv[index + 1]
            index += 1
            continue
        if manager == 'a4':
            if value == '-a' and index + 1 < len(argv):
                return argv[index + 1]
            if value in ('-i', '-e'):
                index += 2
                continue
        else:
            if value == '-e':
                index += 2
                continue
            if value.startswith('-'):
                attaching |= any(option in value[1:] for option in 'caA')
            else:
                return value if attaching else None
        index += 1
    return None


def process_table():
    rows = []
    for line in command('ps', '-axo', 'pid=,ppid=,uid=').splitlines():
        values = line.split()
        if len(values) == 3:
            pid, parent, uid = map(int, values)
            rows.append((pid, parent, uid))
    return rows


def inspect(settings):
    manager, name = settings['manager'], settings['name']
    executable = os.path.realpath(settings['file'])
    rows = process_table()
    if manager == 'zellij':
        candidates = []
        for pid, _, uid in rows:
            if uid != os.getuid() or executable_for(pid) != executable:
                continue
            argv = argv_for(pid)
            if '--server' in argv:
                index = argv.index('--server')
                if index + 1 < len(argv) and os.path.basename(argv[index + 1]) == name:
                    candidates.append((pid, argv[index + 1]))
        if os.environ.get('ZELLIJ_SOCKET_DIR'):
            candidates = [(pid, address) for pid, address in candidates if address.startswith(os.environ['ZELLIJ_SOCKET_DIR'].rstrip('/') + '/')]
        if len(candidates) != 1:
            raise RuntimeError('MUXDOCK_ERROR:zellijAmbiguous')
        server, address = candidates[0]
    else:
        address = socket_path(manager, name, os.getcwd())
        server = server_pid(address, executable, rows)
    if server <= 1 or executable_for(server) != executable:
        raise RuntimeError('MUXDOCK_ERROR:serverUnverified')
    descendants = {server}
    while True:
        extended = descendants | {pid for pid, parent, _ in rows if parent in descendants}
        if extended == descendants:
            break
        descendants = extended
    clients = []
    server_environment = process_data(server)[1]
    for pid, parent, uid in rows:
        if uid != os.getuid() or pid in descendants or pid == os.getpid():
            continue
        if executable_for(pid) != executable:
            continue
        argv, candidate_environment = process_data(pid)
        argument = session_argument(manager, argv)
        if argument is None:
            continue
        try:
            if manager == 'zellij':
                if argument != name:
                    continue
                # Legacy process fallback must stay inside this daemon's socket namespace.
                if any(candidate_environment.get(key) != server_environment.get(key) for key in ('ZELLIJ_SOCKET_DIR', 'TMPDIR', 'XDG_RUNTIME_DIR')):
                    continue
            else:
                candidate_cwd = cwd_for(pid) if argument.startswith('./') or argument.startswith('../') else None
                if os.path.realpath(socket_path(manager, argument, candidate_cwd, candidate_environment)) != os.path.realpath(address):
                    continue
        except (OSError, RuntimeError):
            continue
        clients.append((pid, parent, argv))
    terminals = [pid for pid, parent, _ in rows if parent == server]
    if manager == 'a4':
        terminals = [pid for pid, parent, _ in rows if parent in terminals] or terminals
    shell = next(iter(terminals), None)
    try:
        created = datetime.datetime.strptime(command('ps', '-p', str(server), '-o', 'lstart='), '%a %b %d %H:%M:%S %Y').astimezone().isoformat()
    except (ValueError, subprocess.SubprocessError):
        created = None
    result = {'serverPid': server, 'shellPid': shell, 'terminalPids': terminals, 'clients': [pid for pid, _, _ in clients], 'createdAt': created, 'socket': address}
    if settings.get('detach'):
        # Recheck identity immediately before signalling. Never signal a process group.
        for pid, parent, argv in clients:
            if executable_for(pid) != executable or argv_for(pid) != argv:
                continue
            try:
                if int(command('ps', '-p', str(pid), '-o', 'ppid=')) != parent:
                    continue
                os.kill(pid, signal.SIGHUP)
            except ProcessLookupError:
                pass
    return result


try:
    print(json.dumps(inspect(json.loads(sys.argv[1])), ensure_ascii=False))
except Exception as error:
    print(str(error), file=sys.stderr)
    sys.exit(1)
