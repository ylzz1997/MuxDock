import { createHash, randomBytes } from 'node:crypto';
import { lstat, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { shellQuote } from '../launch';
import { run, type Runner, type RunResult } from '../runner';
import type { Command } from '../model';

export const SSH_MANAGERS = ['tmux', 'zmx'] as const;
export const sshHostId = (target: string) => `ssh:${target}`;
export function validSshTarget(target: unknown): target is string {
  // Destinations are data, never SSH flags or command fragments. Ports, proxy
  // jumps and identities belong to the user's existing OpenSSH configuration.
  return typeof target === 'string' && target.length <= 255 && /^(?:[\p{L}\p{N}_][\p{L}\p{M}\p{N}_.-]*@)?(?:[\p{L}\p{N}_][\p{L}\p{M}\p{N}_.-]*|\[[A-Fa-f0-9:]+\])$/u.test(target);
}
export function remoteDirectory(directory: string): string {
  return `directory=${shellQuote(directory)}; case "$directory" in '~') directory=$HOME ;; '~/'*) directory="$HOME/\${directory#??}" ;; esac; cd -- "$directory" || exit`;
}
function commandSource(command: Command) {
  const env = Object.entries(command.env || {}).map(([key, value]) => shellQuote(`${key}=${value}`));
  return ['exec', '/usr/bin/env', ...env, shellQuote(command.file), ...command.args.map(shellQuote)].join(' ');
}
const remotePath = 'export PATH="$PATH:$HOME/.local/bin:$HOME/.cargo/bin:/opt/homebrew/bin:/usr/local/bin"';
export class SshTransport {
  failure?: string;
  private socket = '';
  constructor(readonly target: string, private readonly directory: string, private readonly execute: Runner = run) {
    if (!validSshTarget(target)) throw new Error('Invalid SSH destination');
  }
  async prepare() {
    if (this.socket) return;
    // Keep ControlPath below macOS's Unix-socket path limit. Each user owns a
    // private directory; each service configuration and destination gets a key.
    const root = `/tmp/muxdock-ssh-${process.getuid?.() ?? 'user'}`;
    await mkdir(root, { recursive: true, mode: 0o700 });
    const info = await lstat(root);
    if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o077)) throw new Error('SSH control directory must be owned by you and private');
    this.socket = path.join(root, createHash('sha256').update(`${this.directory}\0${this.target}`).digest('hex').slice(0, 24));
  }
  private options(interactive: boolean): string[] {
    if (!this.socket) throw new Error('SSH transport is not ready');
    return ['-S', this.socket, '-o', 'ControlMaster=auto', '-o', 'ControlPersist=600', '-o', 'ConnectTimeout=5', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=2',
      ...(!interactive ? ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes'] : []), interactive ? '-tt' : '-T', this.target];
  }
  loginCommand(): Command { return { file: '/usr/bin/ssh', args: this.options(true) }; }
  terminal(command: Command, directory: string): Command {
    const source = `${remotePath}; ${remoteDirectory(directory)}; unset TMUX TMUX_PANE ZMX_SESSION ZMX_SESSION_PREFIX; ${commandSource(command)}`;
    return { file: '/usr/bin/ssh', args: [...this.options(true), `/bin/sh -c ${shellQuote(source)}`] };
  }
  async script(source: string): Promise<RunResult> {
    await this.prepare();
    const marker = `MUXDOCK_${randomBytes(12).toString('hex')}`;
    const body = `${remotePath}; export LC_ALL=C NO_COLOR=1; printf '\\n${marker}:begin\\n'; ( ${source}\n); result=$?; printf '\\n${marker}:end:%s\\n' "$result"; exit "$result"`;
    const result = await this.execute({ file: '/usr/bin/ssh', args: [...this.options(false), `/bin/sh -c ${shellQuote(body)}`] });
    const start = result.stdout.indexOf(`\n${marker}:begin\n`), end = result.stdout.lastIndexOf(`\n${marker}:end:`);
    if (start < 0 || end < start) { this.failure = result.stderr.trim() || 'SSH connection failed'; throw new Error(this.failure); }
    const status = result.stdout.slice(end + marker.length + 6).match(/^(\d{1,3})\n/);
    const code = status ? Number(status[1]) : NaN;
    if (!Number.isInteger(code) || code > 255) { this.failure = 'Incomplete SSH response'; throw new Error(this.failure); }
    return { stdout: result.stdout.slice(start + marker.length + 8, end), stderr: result.stderr, code };
  }
  readonly run: Runner = command => this.script(commandSource(command));
  async info(): Promise<{ home: string; shell: string; platform: NodeJS.Platform }> {
    const result = await this.script('printf \'%s\\n\' "$HOME" "${SHELL:-/bin/sh}" "$(uname -s)"');
    const [home, shell, platform] = result.stdout.trimEnd().split('\n');
    if (result.code || !home?.startsWith('/') || !shell?.startsWith('/') || !['Linux', 'Darwin'].includes(platform)) throw new Error('SSH requires a Linux or macOS host with a POSIX shell');
    return { home, shell, platform: platform === 'Darwin' ? 'darwin' : 'linux' };
  }
  async executable(name: string): Promise<string | undefined> {
    const result = await this.script(`command -v ${shellQuote(name)}`);
    const value = result.stdout.trim();
    return !result.code && value.startsWith('/') && !value.includes('\n') ? value : undefined;
  }
}
