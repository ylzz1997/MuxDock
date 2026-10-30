import type { ShellDialect } from './model';

/** Quote literal paths for the workspace host's current shell. */
export function droppedPathText(paths: string[], dialect: ShellDialect = 'posix'): string {
  if (dialect === 'powershell') return paths.map(path => `'${path.replaceAll("'", "''")}'`).join(' ');
  if (dialect === 'cmd') {
    // CMD expands variables inside quotes. Refuse ambiguous names.
    if (paths.some(path => /[%!"\r\n]/.test(path))) return '';
    return paths.map(path => `"${path}"`).join(' ');
  }
  return paths.map(path => /^[\w/.:@%+=,-]+$/.test(path) ? path : `'${path.replaceAll("'", "'\\''")}'`).join(' ');
}
