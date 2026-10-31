import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { validSshTarget } from './ssh';

export interface SshConfigHost { target: string; source: string }
interface Options { home?: string; systemDirectory?: string; environment?: NodeJS.ProcessEnv }

// This is a candidate-list reader, not an SSH settings evaluator. In particular,
// Match exec and ProxyCommand must never run merely to populate a host menu.
function words(value: string): string[] {
  const result: string[] = []; let word = '', quote = '', started = false;
  for (let i = 0; i < value.length; i++) {
    const character = value[i];
    if (character === '\\' && i + 1 < value.length) { word += value[++i]; started = true; }
    else if (quote) { if (character === quote) quote = ''; else word += character; }
    else if (character === '"' || character === "'") { quote = character; started = true; }
    else if (character === '#') break;
    else if (/\s/.test(character)) { if (started) result.push(word); word = ''; started = false; }
    else { word += character; started = true; }
  }
  if (quote) return [];
  if (started) result.push(word);
  return result;
}
function patternMatcher(pattern: string): RegExp {
  let result = '';
  for (let i = 0; i < pattern.length; i++) {
    const character = pattern[i];
    if (character === '*') result += '.*';
    else if (character === '?') result += '.';
    else if (character === '[' && pattern.indexOf(']', i + 1) > i + 1) {
      const end = pattern.indexOf(']', i + 1), contents = pattern.slice(i + 1, end);
      result += `[${contents.startsWith('!') ? '^' + contents.slice(1) : contents}]`; i = end;
    } else result += character.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
  }
  try { return new RegExp(`^${result}$`); } catch { return /$a/; }
}
async function glob(pattern: string): Promise<string[]> {
  let matches = [path.parse(pattern).root];
  for (const part of pattern.slice(matches[0].length).split(path.sep).filter(Boolean)) {
    if (!/[*?[]/.test(part)) { matches = matches.map(parent => path.join(parent, part)); continue; }
    const next: string[] = [], matcher = patternMatcher(part);
    for (const parent of matches) {
      let names: string[];
      try { names = await readdir(parent); } catch (error) { if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code || '')) continue; throw error; }
      for (const name of names.sort()) if ((!name.startsWith('.') || part.startsWith('.')) && matcher.test(name)) {
        next.push(path.join(parent, name)); if (next.length >= 512) break;
      }
      if (next.length >= 512) break;
    }
    matches = next;
  }
  return matches.sort();
}
export async function readSshConfigHosts(options: Options = {}): Promise<SshConfigHost[]> {
  const home = options.home || os.homedir(), userDirectory = path.join(home, '.ssh'), systemDirectory = options.systemDirectory || '/etc/ssh';
  const environment = options.environment || process.env;
  const hosts = new Map<string, SshConfigHost>(), visited = new Set<string>();
  const username = os.userInfo().username;
  const tokens: Record<string, string> = { '%': '%', d: home, u: username, i: String(process.getuid?.() || 0), l: os.hostname(), L: os.hostname().split('.')[0] };
  function includePath(value: string, base: string): string | undefined {
    let supported = true;
    value = value.replace(/\$\{([^}]+)\}/g, (_, key: string) => { if (environment[key] === undefined) supported = false; return environment[key] || ''; });
    // Destination-dependent Include tokens cannot be enumerated without a host.
    value = value.replace(/%(.)/g, (_, key: string) => { if (tokens[key] === undefined) supported = false; return tokens[key] || ''; });
    if (value === '~' || value.startsWith('~/')) value = home + value.slice(1);
    else if (value === `~${username}` || value.startsWith(`~${username}/`)) value = home + value.slice(username.length + 1);
    else if (value.startsWith('~')) supported = false;
    return supported && value ? path.resolve(base, value) : undefined;
  }
  async function visit(filename: string, base: string, depth = 0): Promise<void> {
    if (depth > 16 || visited.size >= 512) return;
    let canonical: string, contents: string;
    try {
      canonical = await realpath(filename);
      const key = `${base}\0${canonical}`;
      if (visited.has(key)) return;
      const info = await stat(canonical);
      if (!info.isFile() || info.size > 1024 * 1024) return;
      visited.add(key); contents = await readFile(canonical, 'utf8');
    } catch (error) { if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code || '')) return; throw error; }
    for (const line of contents.split(/\r?\n/)) {
      const directive = /^\s*([a-z][a-z0-9]*)\s*(?:=\s*)?(.*)$/i.exec(line);
      if (!directive) continue;
      const values = words(directive[2]);
      if (directive[1].toLowerCase() === 'host') {
        for (const target of values) if (!/[*?!]/.test(target) && validSshTarget(target) && !hosts.has(target)) hosts.set(target, { target, source: filename });
      } else if (directive[1].toLowerCase() === 'include') {
        for (const value of values) {
          const expanded = includePath(value, base); if (!expanded) continue;
          for (const file of await glob(expanded)) await visit(file, base, depth + 1);
        }
      }
    }
  }
  await visit(path.join(userDirectory, 'config'), userDirectory);
  await visit(path.join(systemDirectory, 'ssh_config'), systemDirectory);
  return [...hosts.values()];
}
