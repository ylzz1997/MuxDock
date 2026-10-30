import { t } from './i18n';
import { fork, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { IPty, IPtyForkOptions, IWindowsPtyForkOptions } from 'node-pty';

export type PtyProcess = Pick<IPty, 'write' | 'resize' | 'kill' | 'pause' | 'resume' | 'onData' | 'onExit'>;
function spawnWindowsPty(file: string, args: string[], options: IPtyForkOptions & Pick<IWindowsPtyForkOptions, 'useConptyDll'>): PtyProcess {
  const script = path.join(__dirname, 'windows-pty-host.cjs');
  if (!existsSync(script)) throw new Error(t('ptyMissing'));
  const child = fork(script, [], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, execArgv: [], windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const events = new EventEmitter(); let exited = false, stopping = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const exit = (exitCode: number) => { if (exited) return; exited = true; clearTimeout(killTimer); events.emit('exit', { exitCode }); };
  const send = (message: unknown) => { if (!exited && child.connected) child.send(message as object, () => {}); };
  child.on('message', (message: { type: string; data?: string; code?: number }) => {
    if (message.type === 'data' && typeof message.data === 'string') events.emit('data', message.data);
    else if (message.type === 'exit') exit(message.code ?? 1);
  });
  child.on('error', error => { events.emit('data', `${error.message}\r\n`); exit(127); });
  child.on('exit', code => exit(code ?? 1));
  child.stderr?.on('data', data => events.emit('data', data.toString()));
  child.stdout?.on('data', data => events.emit('data', data.toString()));
  send({ type: 'start', file, args, options });
  const listen = (event: string, callback: (...args: any[]) => void) => { events.on(event, callback); return { dispose: () => events.off(event, callback) }; };
  return {
    write: data => { if (!stopping) send({ type: 'write', data }); }, resize: (cols, rows) => { if (!stopping) send({ type: 'resize', cols, rows }); },
    kill: () => {
      if (stopping || exited) return; stopping = true; send({ type: 'kill' });
      killTimer = setTimeout(() => { if (!exited) child.kill(); }, 8000);
    },
    pause: () => send({ type: 'pause' }), resume: () => send({ type: 'resume' }),
    onData: callback => listen('data', callback), onExit: callback => listen('exit', callback)
  };
}
export function spawnPty(file: string, args: string[], options: IPtyForkOptions & Pick<IWindowsPtyForkOptions, 'useConptyDll'>): PtyProcess {
  if (process.platform === 'win32') return spawnWindowsPty(file, args, options);
  if (process.env.MUXDOCK_PTY_DRIVER !== 'python') {
    try {
      // Load lazily so the extension can fall back on Linux/WSL without a native prebuild.
      return (require('node-pty') as typeof import('node-pty')).spawn(file, args, options);
    } catch { /* Unix hosts can use the Python PTY fallback. */ }
  }
  const script = [path.join(__dirname, 'pty-host.py'), path.join(__dirname, '../src/pty-host.py')].find(existsSync);
  if (!script) throw new Error(t('ptyMissing'));
  const python = [...(process.env.PATH || '').split(path.delimiter), '/usr/bin', '/usr/local/bin', '/opt/homebrew/bin'].map(directory => path.join(directory, 'python3')).find(existsSync);
  if (!python) throw new Error(t('ptyPython'));
  const child = spawn(python, ['-u', script, JSON.stringify({ file, args, cwd: options.cwd || process.cwd(), cols: options.cols || 100, rows: options.rows || 28 })], { env: options.env, stdio: ['pipe', 'pipe', 'pipe'] });
  const events = new EventEmitter(); let exited = false;
  const exit = (exitCode: number) => { if (!exited) { exited = true; events.emit('exit', { exitCode }); } };
  createInterface({ input: child.stdout }).on('line', line => {
    try { const message = JSON.parse(line); if (message.type === 'data') events.emit('data', message.data); else if (message.type === 'exit') exit(message.exitCode); }
    catch { /* Ignore a truncated frame if the helper is terminating. */ }
  });
  child.stderr.on('data', data => events.emit('data', data.toString()));
  child.on('error', error => { events.emit('data', `${error.message}\r\n`); exit(127); });
  child.on('exit', code => exit(code ?? 1));
  child.stdin.on('error', () => { /* A client may exit while its final input is in flight. */ });
  const send = (message: unknown) => { if (!exited && child.stdin.writable) child.stdin.write(`${JSON.stringify(message)}\n`); };
  const listen = (event: string, callback: (...args: any[]) => void) => { events.on(event, callback); return { dispose: () => events.off(event, callback) }; };
  return {
    write: data => send({ type: 'write', data }), resize: (cols, rows) => send({ type: 'resize', cols, rows }),
    kill: () => { child.kill('SIGTERM'); }, pause: () => child.stdout.pause(), resume: () => child.stdout.resume(),
    onData: callback => listen('data', callback), onExit: callback => listen('exit', callback)
  };
}
