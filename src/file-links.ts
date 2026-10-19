import path from 'node:path';
import os from 'node:os';
import { stat } from 'node:fs/promises';
import { parseTerminalLink } from './links';

export interface FileLinkLocation { path: string; line?: number; column?: number; directory: boolean }
export async function resolveFileLink(value: string, directories: string[]): Promise<FileLinkLocation | undefined> {
  const target = parseTerminalLink(value);
  if (target?.kind !== 'file' || target.authority && !['localhost', os.hostname().toLowerCase()].includes(target.authority.toLowerCase())) return;
  const file = target.path.replace(/^~(?=\/)/, os.homedir());
  const candidates = path.isAbsolute(file) ? [file] : [...new Set(directories.map(directory => path.resolve(directory, file)))];
  for (const candidate of candidates) try {
    const info = await stat(candidate);
    if (info.isFile() || info.isDirectory()) return { path: candidate, line: target.line, column: target.column, directory: info.isDirectory() };
  } catch { /* A printed path is only linked when it exists on this host. */ }
}
