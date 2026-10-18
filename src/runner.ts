import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { Command } from './model';

export interface RunResult { stdout: string; stderr: string; code: number }
export type Runner = (command: Command) => Promise<RunResult>;
export function cleanEnvironment(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) if (value !== undefined) env[key] = value;
  for (const key of ['TMUX', 'TMUX_PANE', 'STY', 'WINDOW', 'ZELLIJ', 'ZELLIJ_SESSION_NAME', 'ZMX_SESSION', 'ZMX_SESSION_PREFIX', 'SHPOOL_SESSION_NAME']) delete env[key];
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
export async function findExecutable(name: string, configured?: string): Promise<string | undefined> {
  const expanded = configured?.replace(/^~(?=\/)/, os.homedir());
  const candidates = expanded ? [expanded] : [...new Set([
    ...(process.env.PATH || '').split(path.delimiter), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin',
    path.join(os.homedir(), '.local/bin'), path.join(os.homedir(), '.cargo/bin')
  ])].map(directory => path.join(directory, name));
  for (const candidate of candidates) {
    try { await access(candidate, constants.X_OK); return candidate; } catch { /* Try the next PATH entry. */ }
  }
  return undefined;
}
export function requireSuccess(result: RunResult, context: string): string {
  if (result.code) throw new Error(`${context}：${(result.stderr || result.stdout || '命令执行失败').trim().slice(0, 1000)}`);
  return result.stdout;
}
