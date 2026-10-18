"""Unix PTY fallback for hosts without a compatible node-pty binary. JSON-lines IPC."""
import codecs
import errno
import fcntl
import json
import os
import pty
import select
import signal
import struct
import sys
import termios


def emit(value):
    sys.stdout.write(json.dumps(value, ensure_ascii=True) + '\n')
    sys.stdout.flush()


def main():
    command = json.loads(sys.argv[1])
    ready_read, ready_write = os.pipe()
    child, master = pty.fork()
    if child == 0:
        os.close(ready_read)
        try:
            os.chdir(command['cwd'])
            fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack('HHHH', command['rows'], command['cols'], 0, 0))
            os.write(ready_write, b'1')
            os.close(ready_write)
            os.execvpe(command['file'], [command['file']] + command['args'], os.environ)
        except Exception as error:
            os.write(2, ('MuxDock: ' + str(error) + '\r\n').encode())
            os._exit(127)

    os.close(ready_write)
    os.read(ready_read, 1)  # Apply later resizes only after the initial child size is set.
    os.close(ready_read)

    def stop(*_):
        try:
            os.kill(child, signal.SIGHUP)
        except ProcessLookupError:
            pass
        try:
            os.close(master)
        except OSError:
            pass
        sys.exit(0)

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGHUP, stop)
    decoder = codecs.getincrementaldecoder('utf-8')('replace')
    incoming = b''
    try:
        while True:
            readable, _, _ = select.select([master, 0], [], [])
            if master in readable:
                try:
                    data = os.read(master, 32768)
                except OSError as error:
                    if error.errno == errno.EIO:
                        break
                    raise
                if not data:
                    break
                decoded = decoder.decode(data)
                if decoded:
                    emit({'type': 'data', 'data': decoded})
            if 0 in readable:
                data = os.read(0, 65536)
                if not data:
                    stop()
                incoming += data
                while b'\n' in incoming:
                    line, incoming = incoming.split(b'\n', 1)
                    message = json.loads(line)
                    if message['type'] == 'write':
                        pending = message['data'].encode('utf-8')
                        while pending:
                            pending = pending[os.write(master, pending):]
                    elif message['type'] == 'resize':
                        fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', message['rows'], message['cols'], 0, 0))
                    elif message['type'] == 'kill':
                        stop()
    finally:
        try:
            os.close(master)
        except OSError:
            pass
    tail = decoder.decode(b'', final=True)
    if tail:
        emit({'type': 'data', 'data': tail})
    _, status = os.waitpid(child, 0)
    emit({'type': 'exit', 'exitCode': os.WEXITSTATUS(status) if os.WIFEXITED(status) else 128 + os.WTERMSIG(status)})


if __name__ == '__main__':
    main()
