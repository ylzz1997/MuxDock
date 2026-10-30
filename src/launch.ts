import { t } from './i18n';
import os from 'node:os';
import path from 'node:path';
import { access, chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { constants, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { findExecutable } from './runner';
import type { Command, LaunchProfile, ShellDialect } from './model';

export interface SavedLaunchCommand { id: string; command: string }
export interface LaunchSettings { shell?: string; commandId?: string; commands: SavedLaunchCommand[] }

export function systemShell(): string {
  if (process.platform === 'win32') {
    const candidates = [path.join(process.env.ProgramFiles || 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe'),
      path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), process.env.ComSpec];
    return candidates.find((file): file is string => !!file && existsSync(file)) || 'cmd.exe';
  }
  try { const shell = os.userInfo().shell; if (shell && path.isAbsolute(shell)) return shell; } catch { /* Fall back to the login environment. */ }
  return process.env.SHELL && path.isAbsolute(process.env.SHELL) ? process.env.SHELL : '/bin/sh';
}
export async function discoverShells(defaultShell: string): Promise<string[]> {
  let listed: string[] = [];
  try { listed = (await readFile('/etc/shells', 'utf8')).split(/\r?\n/).map(line => line.split('#')[0].trim()).filter(shell => path.isAbsolute(shell)); } catch { }
  const found = await Promise.all((process.platform === 'win32' ? ['pwsh', 'powershell', 'cmd'] : ['zsh', 'bash', 'fish', 'sh', 'dash', 'ksh', 'nu']).map(name => findExecutable(name)));
  const candidates = [...new Set([defaultShell, ...listed, ...found.filter((shell): shell is string => !!shell)])];
  return (await Promise.all(candidates.map(async shell => { try { await access(shell, constants.X_OK); return shell; } catch { return undefined; } }))).filter((shell): shell is string => !!shell);
}
export function validateLaunchCommand(command: string): string | undefined {
  if (!command.trim()) return t('commandRequired');
  if (command.length > 4096) return t('commandTooLong');
  if (/[\0\r\n]/.test(command)) return t('commandSingleLine');
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
  const profiles: LaunchProfile[] = [{ id: 'system', name: path.basename(defaultShell), detail: t('systemDefault', { shell: defaultShell }), kind: 'shell' }];
  for (const shell of shells) if (shell !== defaultShell) profiles.push({ id: `shell:${shell}`, name: path.basename(shell), detail: shell, kind: 'shell' });
  for (const command of settings.commands) profiles.push({ id: `command:${command.id}`, name: command.command, detail: t('customCommand'), kind: 'command' });
  const command = settings.commands.find(command => command.id === settings.commandId);
  const selected = command ? `command:${command.id}` : settings.shell && shells.includes(settings.shell) && settings.shell !== defaultShell ? `shell:${settings.shell}` : 'system';
  return { launchProfiles: profiles, selectedLaunchProfile: selected };
}
export const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

export function shellDialect(shell: string, platform = process.platform): ShellDialect {
  if (platform !== 'win32') return 'posix';
  return /(?:^|[\\/])(?:pwsh|powershell)(?:\.exe)?$/i.test(shell) ? 'powershell' : 'cmd';
}
export async function launchCommand(shell: string, command: string | undefined, directory: string, platform = process.platform): Promise<Command> {
  if (command) { const error = validateLaunchCommand(command); if (error) throw new Error(error); }
  if (platform !== 'win32') return { file: await launchExecutable(shell, command, directory), args: ['-l'] };
  if (shellDialect(shell, platform) === 'powershell') return { file: shell, args: command
    ? ['-NoLogo', '-NoExit', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')]
    : ['-NoLogo'] };
  if (!command) return { file: shell, args: [] };
  // Passing CMD source as an argv element lets native Windows quoting turn its
  // embedded quotes into literal backslashes. A UTF-8 command file avoids that.
  await mkdir(directory, { recursive: true });
  const key = createHash('sha256').update(command).digest('hex').slice(0, 24);
  const file = path.join(directory, `launch-${key}.cmd`);
  await writeFile(file, `@echo off\r\n@chcp 65001 >nul\r\n${command}\r\n`, 'utf8');
  return { file: shell, args: ['/k', 'call', file] };
}

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
