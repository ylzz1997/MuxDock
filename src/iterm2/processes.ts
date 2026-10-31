import os from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { realpath, readFile, readlink, readdir } from 'node:fs/promises';
import { t } from '../i18n';
import { run, requireSuccess } from '../runner';

export interface ProcessInfo { serverPid: number; shellPid?: number; terminalPids: number[]; clients: number[]; createdAt?: string; socket: string }
export interface InspectOptions { manager: string; name: string; file: string; detach?: boolean; environment?: Record<string, string | undefined>; cwd?: string }
interface ProcessData { argv: string[]; environment: Record<string, string> }
const environmentKeys = new Set(['HOME', 'TMPDIR', 'XDG_RUNTIME_DIR', 'XDG_STATE_HOME', 'ABDUCO_SOCKET_DIR', 'ZELLIJ_SOCKET_DIR']);
function selectedEnvironment(entries: string[]) {
  const result: Record<string, string> = {};
  for (const entry of entries) { const i = entry.indexOf('='); if (i > 0 && environmentKeys.has(entry.slice(0, i))) result[entry.slice(0, i)] = entry.slice(i + 1); }
  return result;
}
export function parseDarwinArguments(data: Buffer): ProcessData {
  if (data.length < 5) throw new Error('Invalid process arguments');
  const argc = data.readInt32LE(0);
  if (argc < 1 || argc > 65536) throw new Error('Invalid process argument count');
  let start = data.indexOf(0, 4);
  if (start < 0) throw new Error('Missing process path');
  while (start < data.length && data[start] === 0) start++;
  const entries = data.subarray(start).toString('utf8').split('\0');
  if (entries.length < argc) throw new Error('Truncated process arguments');
  return { argv: entries.slice(0, argc), environment: selectedEnvironment(entries.slice(argc)) };
}
let native: Promise<{ sysctl: (...args: unknown[]) => number; pidpath: (...args: unknown[]) => number }> | undefined;
function darwin() {
  return native ||= import('koffi').then(({ default: koffi }) => ({
    sysctl: koffi.load('/usr/lib/libSystem.B.dylib').func('int sysctl(const int *name, unsigned int namelen, void *oldp, void *oldlenp, const void *newp, size_t newlen)'),
    pidpath: koffi.load('/usr/lib/libproc.dylib').func('int proc_pidpath(int pid, void *buffer, unsigned int buffersize)')
  }));
}
export async function processData(pid: number): Promise<ProcessData | undefined> {
  try {
    if (process.platform === 'linux') {
      const [argv, env] = await Promise.all([readFile(`/proc/${pid}/cmdline`), readFile(`/proc/${pid}/environ`)]);
      return { argv: argv.toString().replace(/\0$/, '').split('\0'), environment: selectedEnvironment(env.toString().split('\0')) };
    }
    const { sysctl } = await darwin();
    const mib = new Int32Array([1, 49, pid]); // CTL_KERN, KERN_PROCARGS2
    const size = Buffer.alloc(8);
    if (sysctl(mib, 3, null, size, null, 0)) return;
    const length = Number(size.readBigUInt64LE());
    if (length < 5 || length > 8 * 1024 * 1024) return;
    const buffer = Buffer.alloc(length);
    if (sysctl(mib, 3, buffer, size, null, 0)) return;
    return parseDarwinArguments(buffer.subarray(0, Number(size.readBigUInt64LE())));
  } catch { return; }
}
export async function executableFor(pid: number): Promise<string | undefined> {
  try {
    if (process.platform === 'linux') return await realpath(`/proc/${pid}/exe`);
    const buffer = Buffer.alloc(4096), { pidpath } = await darwin();
    if (pidpath(pid, buffer, buffer.length) > 0) return await realpath(buffer.subarray(0, buffer.indexOf(0)).toString());
  } catch { /* Process exited or is inaccessible. */ }
}
const command = async (file: string, ...args: string[]) => requireSuccess(await run({ file, args }), t('readProcessesFailed')).trim();
async function cwdFor(pid: number): Promise<string | undefined> {
  try {
    if (process.platform === 'linux') return await readlink(`/proc/${pid}/cwd`);
    return (await command('/usr/sbin/lsof', '-a', '-p', String(pid), '-d', 'cwd', '-Fn')).split('\n').find(line => line.startsWith('n'))?.slice(1);
  } catch { return; }
}
export function sessionArgument(manager: string, argv: string[]): string | undefined {
  let attaching = false;
  for (let i = 1; i < argv.length; i++) {
    const value = argv[i];
    if (manager === 'zellij') { if (['--session', '-s', 'attach', 'a', 'watch', 'w'].includes(value)) return argv[i + 1]; }
    else if (manager === 'a4') { if (value === '-a') return argv[i + 1]; if (['-i', '-e'].includes(value)) i++; }
    else if (value === '-e') i++;
    else if (value.startsWith('-')) attaching ||= /[caA]/.test(value.slice(1));
    else return attaching ? value : undefined;
  }
}
export function socketPath(manager: string, name: string, cwd?: string, env: Record<string, string | undefined> = process.env): string {
  if (path.isAbsolute(name)) return name;
  if (name.startsWith('./') || name.startsWith('../')) { if (!cwd) throw new Error(t('relativeCwdUnknown')); return path.resolve(cwd, name); }
  const filename = `${name}@${os.hostname()}`, home = env.HOME || os.homedir();
  if (manager === 'a4') return path.join(env.XDG_STATE_HOME || path.join(home, '.local/state'), 'a4', filename);
  const user = os.userInfo().username;
  const directories = [env.ABDUCO_SOCKET_DIR && path.join(env.ABDUCO_SOCKET_DIR, 'abduco', user), env.ABDUCO_SOCKET_DIR && path.join(env.ABDUCO_SOCKET_DIR, 'abduco'), path.join(home, '.abduco'), path.join(env.TMPDIR || '/tmp', 'abduco', user), path.join('/tmp/abduco', user)];
  const match = directories.find(directory => directory && existsSync(path.join(directory, filename)));
  if (!match) throw new Error(t('socketMissing'));
  return path.join(match, filename);
}
export async function inspectProcesses(settings: InspectOptions): Promise<ProcessInfo> {
  const { manager, name } = settings, executable = await realpath(settings.file);
  const environment = settings.environment || process.env;
  const rows = (await command('/bin/ps', '-axo', 'pid=,ppid=,uid=')).split('\n').map(line => line.trim().split(/\s+/).map(Number)).filter(row => row.length === 3 && row.every(Number.isSafeInteger));
  const candidates: { pid: number; parent: number; data?: ProcessData }[] = [];
  for (const [pid, parent, uid] of rows) if (uid === process.getuid!() && await executableFor(pid) === executable) candidates.push({ pid, parent, data: await processData(pid) });
  let server: number, address: string;
  if (manager === 'zellij') {
    const servers = candidates.flatMap(({ pid, data }) => {
      const i = data?.argv.indexOf('--server') ?? -1, socket = i < 0 ? undefined : data!.argv[i + 1];
      return socket && path.basename(socket) === name && (!environment.ZELLIJ_SOCKET_DIR || socket.startsWith(environment.ZELLIJ_SOCKET_DIR.replace(/\/$/, '') + '/')) ? [{ pid, socket }] : [];
    });
    if (servers.length !== 1) throw new Error(t('zellijAmbiguous'));
    server = servers[0].pid; address = servers[0].socket;
  } else {
    address = socketPath(manager, name, settings.cwd || process.cwd(), environment);
    let owners: number[];
    if (process.platform === 'darwin') owners = (await command('/usr/sbin/lsof', '-n', '-a', '-U', '-Fp', '--', address)).split('\n').filter(line => /^p\d+$/.test(line)).map(line => Number(line.slice(1)));
    else {
      const inodes = new Set((await readFile('/proc/net/unix', 'utf8')).split('\n').flatMap(line => { const cells = line.trim().split(/\s+/); return cells.slice(7).join(' ') === address && cells[3] === '00010000' ? [`socket:[${cells[6]}]`] : []; }));
      owners = [];
      for (const { pid } of candidates) try { for (const fd of await readdir(`/proc/${pid}/fd`)) { try { if (inodes.has(await readlink(`/proc/${pid}/fd/${fd}`))) { owners.push(pid); break; } } catch {} } } catch {}
    }
    owners = [...new Set(owners)].filter(pid => candidates.some(item => item.pid === pid));
    if (owners.length !== 1) throw new Error(t('serverAmbiguous'));
    server = owners[0];
  }
  if (server <= 1 || await executableFor(server) !== executable) throw new Error(t('serverUnverified'));
  const descendants = new Set([server]);
  for (;;) { const before = descendants.size; for (const [pid, parent] of rows) if (descendants.has(parent)) descendants.add(pid); if (before === descendants.size) break; }
  const clients: typeof candidates = [], serverData = candidates.find(item => item.pid === server)?.data;
  for (const candidate of candidates) {
    const { pid, data } = candidate;
    if (!data || descendants.has(pid) || pid === process.pid) continue;
    const argument = sessionArgument(manager, data.argv); if (!argument) continue;
    try {
      if (manager === 'zellij') {
        if (!serverData || argument !== name || ['ZELLIJ_SOCKET_DIR', 'TMPDIR', 'XDG_RUNTIME_DIR'].some(key => data.environment[key] !== serverData.environment[key])) continue;
      } else if (await realpath(socketPath(manager, argument, await cwdFor(pid), data.environment)) !== await realpath(address)) continue;
      clients.push(candidate);
    } catch { /* Cannot prove that this is a client of this session. */ }
  }
  let terminalPids = rows.filter(([, parent]) => parent === server).map(([pid]) => pid);
  if (manager === 'a4') { const children = rows.filter(([, parent]) => terminalPids.includes(parent)).map(([pid]) => pid); if (children.length) terminalPids = children; }
  let createdAt: string | undefined;
  try { const date = new Date(await command('/bin/ps', '-p', String(server), '-o', 'lstart=')); if (Number.isFinite(date.getTime())) createdAt = date.toISOString(); } catch {}
  if (settings.detach) for (const { pid, parent, data } of clients) {
    if (await executableFor(pid) !== executable || JSON.stringify((await processData(pid))?.argv) !== JSON.stringify(data!.argv)) continue;
    try { if (Number(await command('/bin/ps', '-p', String(pid), '-o', 'ppid=')) === parent) process.kill(pid, 'SIGHUP'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
  }
  return { serverPid: server, shellPid: terminalPids[0], terminalPids, clients: clients.map(item => item.pid), createdAt, socket: address };
}
