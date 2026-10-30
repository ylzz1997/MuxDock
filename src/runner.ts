import { t, catalogs, type MessageKey } from './i18n';
import { execFile } from 'node:child_process';
import { access, readdir, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { Command } from './model';

export interface RunResult { stdout: string; stderr: string; code: number }
export type Runner = (command: Command) => Promise<RunResult>;
export function cleanEnvironment(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) if (value !== undefined) env[key] = value;
  for (const key of ['TMUX', 'TMUX_PANE', 'PSMUX_SESSION_NAME', 'STY', 'WINDOW', 'ZELLIJ', 'ZELLIJ_SESSION_NAME', 'ZMX_SESSION', 'ZMX_SESSION_PREFIX', 'SHPOOL_SESSION_NAME', 'HERDR_ENV', 'HERDR_SESSION', 'HERDR_SOCKET_PATH', 'HERDR_CLIENT_SOCKET_PATH', 'HERDR_PANE_ID', 'HERDR_TERMINAL_ID', 'HERDR_WORKSPACE_ID', 'HERDR_TAB_ID']) delete env[key];
  if (process.platform === 'win32') {
    const key = Object.keys(env).find(key => key.toLowerCase() === 'path');
    const value = key && env[key];
    for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key];
    if (value !== undefined) env.PATH = value;
  }
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  return env;
}
export const run: Runner = command => new Promise(resolve => {
  execFile(command.file, command.args, {
    env: { ...cleanEnvironment(), LC_ALL: 'C', NO_COLOR: '1', ...command.env }, timeout: 6000, maxBuffer: 4 * 1024 * 1024,
    encoding: 'utf8', windowsHide: true
  }, (error, stdout, stderr) => {
    const code = !error ? 0 : typeof error.code === 'number' ? error.code : 1;
    resolve({ stdout, stderr: stderr || (error && !stdout ? error.message : ''), code });
  });
});
export async function findExecutable(name: string, configured?: string, accept?: (file: string) => Promise<boolean>): Promise<string | undefined> {
  const expanded = configured?.replace(/^~(?=[\\/])/, os.homedir());
  const windows = process.platform === 'win32';
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const directories = [...(cleanEnvironment().PATH || '').split(path.delimiter).filter(Boolean), ...(windows ? [
    path.join(local, 'Microsoft', 'WinGet', 'Links'), path.join(local, 'Zellij'),
    path.join(local, 'Programs', 'Herdr', 'bin'), path.join(local, 'Programs', 'tmux-windows'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'PowerShell', '7'),
    path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0'),
    path.join(process.env.SystemRoot || 'C:\\Windows', 'System32'),
    path.join(os.homedir(), 'scoop', 'shims'), path.join(os.homedir(), '.cargo', 'bin')
  ] : ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', path.join(os.homedir(), '.local/bin'), path.join(os.homedir(), '.cargo/bin')])];
  if (windows && !expanded && ['psmux', 'tmux'].includes(name)) {
    const packages = path.join(local, 'Microsoft', 'WinGet', 'Packages');
    const prefix = name === 'psmux' ? 'marlocarlo.psmux_' : 'arndawg.tmux-windows_';
    try { for (const entry of await readdir(packages, { withFileTypes: true })) if (entry.isDirectory() && entry.name.startsWith(prefix)) directories.push(path.join(packages, entry.name)); } catch { }
  }
  // execFile and ConPTY require native executables, not .cmd/.bat shims.
  const executableName = windows && !path.extname(name) ? `${name}.exe` : name;
  const candidates = expanded ? [expanded] : [...new Set(directories)].map(directory => path.join(directory.replace(/^"|"$/g, ''), executableName));
  for (const candidate of candidates) {
    try {
      if (windows && !/\.(exe|com)$/i.test(candidate)) continue;
      await access(candidate, constants.X_OK);
      if ((await stat(candidate)).isFile() && (!accept || await accept(candidate))) return candidate;
    } catch { /* Try the next PATH entry. */ }
  }
  return undefined;
}
export function requireSuccess(result: RunResult, context: string): string {
  const diagnostic = result.stderr || result.stdout;
  const code = /MUXDOCK_ERROR:(\w+)/.exec(diagnostic)?.[1];
  if (result.code && code && Object.hasOwn(catalogs.en, code)) throw new Error(`${context}: ${t(code as MessageKey)}`);
  if (result.code) throw new Error(`${context}: ${(result.stderr || result.stdout || t('commandFailed')).trim().slice(0, 1000)}`);
  return result.stdout;
}
