import os from 'node:os';
import path from 'node:path';
import { access, chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { findExecutable } from './runner';
import type { LaunchProfile } from './model';

export interface SavedLaunchCommand { id: string; command: string }
export interface LaunchSettings { shell?: string; commandId?: string; commands: SavedLaunchCommand[] }

export function systemShell(): string {
  try { const shell = os.userInfo().shell; if (shell && path.isAbsolute(shell)) return shell; } catch { /* Fall back to the login environment. */ }
  return process.env.SHELL && path.isAbsolute(process.env.SHELL) ? process.env.SHELL : '/bin/sh';
}
export async function discoverShells(defaultShell: string): Promise<string[]> {
  let listed: string[] = [];
  try { listed = (await readFile('/etc/shells', 'utf8')).split(/\r?\n/).map(line => line.split('#')[0].trim()).filter(shell => path.isAbsolute(shell)); } catch { }
  const found = await Promise.all(['zsh', 'bash', 'fish', 'sh', 'dash', 'ksh', 'nu'].map(name => findExecutable(name)));
  const candidates = [...new Set([defaultShell, ...listed, ...found.filter((shell): shell is string => !!shell)])];
  return (await Promise.all(candidates.map(async shell => { try { await access(shell, constants.X_OK); return shell; } catch { return undefined; } }))).filter((shell): shell is string => !!shell);
}
export function validateLaunchCommand(command: string): string | undefined {
  if (!command.trim()) return '请输入启动命令。';
  if (command.length > 4096) return '启动命令不能超过 4096 个字符。';
  if (/[\0\r\n]/.test(command)) return '请输入单行命令，可使用 && 连接多个命令。';
  return undefined;
}
export function readLaunchSettings(value: unknown): LaunchSettings {
  if (!value || typeof value !== 'object') return { commands: [] };
  const saved = value as Record<string, unknown>;
  const ids = new Set<string>();
  const commands: SavedLaunchCommand[] = [];
  if (Array.isArray(saved.commands)) for (const item of saved.commands) {
    if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !item.id || ids.has(item.id) || typeof item.command !== 'string' || validateLaunchCommand(item.command)) continue;
    ids.add(item.id); commands.push({ id: item.id, command: item.command.trim() });
  }
  return { shell: typeof saved.shell === 'string' && path.isAbsolute(saved.shell) ? saved.shell : undefined, commandId: typeof saved.commandId === 'string' && ids.has(saved.commandId) ? saved.commandId : undefined, commands };
}
export function launchProfiles(settings: LaunchSettings, shells: string[], defaultShell: string): { launchProfiles: LaunchProfile[]; selectedLaunchProfile: string } {
  const profiles: LaunchProfile[] = [{ id: 'system', name: path.basename(defaultShell), detail: `系统默认 · ${defaultShell}`, kind: 'shell' }];
  for (const shell of shells) if (shell !== defaultShell) profiles.push({ id: `shell:${shell}`, name: path.basename(shell), detail: shell, kind: 'shell' });
  for (const command of settings.commands) profiles.push({ id: `command:${command.id}`, name: command.command, detail: '自定义命令', kind: 'command' });
  const command = settings.commands.find(command => command.id === settings.commandId);
  const selected = command ? `command:${command.id}` : settings.shell && shells.includes(settings.shell) && settings.shell !== defaultShell ? `shell:${settings.shell}` : 'system';
  return { launchProfiles: profiles, selectedLaunchProfile: selected };
}
export const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

/** A cached executable lets every backend start commands after shell initialization. */
export async function launchExecutable(shell: string, command: string | undefined, directory: string): Promise<string> {
  if (!command) return shell;
  const error = validateLaunchCommand(command); if (error) throw new Error(error);
  const key = createHash('sha256').update(JSON.stringify([shell, command])).digest('hex').slice(0, 24);
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, `launch-${key}`);
  const initialCommand = `${command}\nexec ${shellQuote(shell)} -l`;
  // csh/tcsh require -l to be the only option; -i still loads their interactive rc.
  const options = ['csh', 'tcsh'].includes(path.basename(shell)) ? '-ic' : '-ilc';
  const source = `#!/bin/sh\nSHELL=${shellQuote(shell)}\nexport SHELL\nexec ${shellQuote(shell)} ${options} ${shellQuote(initialCommand)}\n`;
  await writeFile(file, source, { mode: 0o700 });
  await chmod(file, 0o700);
  return file;
}
