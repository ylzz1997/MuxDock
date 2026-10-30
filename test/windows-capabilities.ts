import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { pathToFileURL } from 'node:url';
import { Terminal } from '@xterm/headless';
import { spawnPty, type PtyProcess } from '../src/pty';
import { cleanEnvironment } from '../src/runner';
import { parseZellij } from '../src/adapters';

// Real Windows backends, separate namespaces/config/cache, and only targeted cleanup.
// Keep the evidence on disk so unsupported commands and backend bugs remain visible.
type Backend = 'psmux' | 'zellij';
type Result = { backend: Backend | 'host'; check: string; status: 'PASS' | 'FAIL'; detail?: unknown; elapsedMs: number };
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const quote = (text: string) => `'${text.replaceAll("'", "''")}'`;
const token = `md_${Date.now()}_${randomUUID().slice(0, 6)}`;
const root = path.resolve('.test-results', 'windows-capabilities', token);
const results: Result[] = [];
const commandLog: unknown[] = [];
const children = new Set<Client>();
const useConptyDll = process.env.MUXDOCK_TEST_CONPTY_DLL !== '0';
const require = createRequire(import.meta.url);
let binaries: Record<string, string>;
let env: Record<string, string>;
let psmuxConfig: string;
let zellijConfig: string;

async function until<T>(fn: () => Promise<T | false | undefined>, label: string, timeout = 15000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await fn(); if (value) return value; await sleep(120); }
  throw new Error(`Timed out: ${label}`);
}
async function textFile(file: string) { return readFile(file, 'utf8').catch(() => ''); }
async function check(backend: Result['backend'], name: string, fn: () => Promise<unknown>) {
  const start = Date.now();
  try { const detail = await fn(); results.push({ backend, check: name, status: 'PASS', detail, elapsedMs: Date.now() - start }); console.log(`${backend}: PASS ${name}`); return true; }
  catch (error) { const detail = error instanceof Error ? error.message : String(error); results.push({ backend, check: name, status: 'FAIL', detail, elapsedMs: Date.now() - start }); console.error(`${backend}: FAIL ${name}: ${detail}`); return false; }
}
function argumentsFor(backend: Backend, args: string[]) {
  return backend === 'psmux' ? ['-L', token, '-f', psmuxConfig, ...args] : ['--config', zellijConfig, ...args];
}
function execute(backend: Backend, args: string[], required = true): Promise<{ code: number; stdout: string; stderr: string }> {
  const started = Date.now();
  return new Promise((resolve, reject) => execFile(binaries[backend], argumentsFor(backend, args), { env, cwd: root, windowsHide: true, timeout: 15000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' }, (error, stdout, stderr) => {
    const result = { code: error ? typeof error.code === 'number' ? error.code : 1 : 0, stdout, stderr };
    commandLog.push({ backend, args, ...result, elapsedMs: Date.now() - started, timedOut: !!error?.killed });
    if (required && result.code) reject(new Error(`${backend} ${args.join(' ')}: ${error?.killed ? 'timed out after 15 seconds; ' : ''}${stderr || stdout || error?.message}`)); else resolve(result);
  }));
}
class Client {
  readonly terminal = new Terminal({ cols: 100, rows: 30, allowProposedApi: true });
  readonly pty: PtyProcess;
  closed = false;
  exitCode?: number;
  raw = '';
  constructor(readonly backend: Backend, readonly name: string, args: string[], cwd = root) {
    const options = { name: 'xterm-256color', cols: 100, rows: 30, cwd, env, useConptyDll };
    this.pty = spawnPty(binaries[backend], argumentsFor(backend, args), options);
    this.pty.onData(data => { this.raw = (this.raw + data).slice(-200000); this.terminal.write(data); });
    this.pty.onExit(({ exitCode }) => { this.closed = true; this.exitCode = exitCode; });
    this.terminal.onData(data => { if (!this.closed) this.pty.write(data); });
    children.add(this);
  }
  write(data: string) { assert.ok(!this.closed, `${this.backend} client already exited (${this.exitCode})`); this.pty.write(data); }
  screen() { const buffer = this.terminal.buffer.active; return Array.from({ length: buffer.length }, (_, i) => buffer.getLine(i)?.translateToString(true) || '').join('\n'); }
  async kill() { if (!this.closed) { this.pty.kill(); await until(async () => this.closed, 'client exit'); } }
  async save(label: string) { await writeFile(path.join(root, `${this.backend}-${label}.ansi`), this.raw); await writeFile(path.join(root, `${this.backend}-${label}.txt`), this.screen()); }
}
function attach(backend: Backend, name: string) { return new Client(backend, name, backend === 'psmux' ? ['attach-session', '-t', name] : ['attach', name]); }
async function list(backend: Backend) { return (await execute(backend, backend === 'psmux' ? ['list-sessions', '-F', '#{session_id}|#{session_name}|#{session_attached}'] : ['list-sessions', '--no-formatting'], false)).stdout; }
async function sessionExists(backend: Backend, name: string) {
  const output = await list(backend);
  return backend === 'psmux' ? output.split(/\r?\n/).some(line => line.split('|')[1] === name) : parseZellij(output).some(session => session.name === name);
}
async function clients(backend: Backend, name: string) {
  const args = backend === 'psmux' ? ['list-clients', '-t', name, '-F', '#{client_id}|#{client_pid}|#{session_name}'] : ['--session', name, 'action', 'list-clients'];
  const text = (await execute(backend, args)).stdout;
  return { count: text.split(/\r?\n/).filter(line => backend === 'psmux' ? line.includes(`|${name}`) : /^\s*\d+\s/.test(line)).length, text };
}
async function detachZellijThroughPipe(name: string) {
  const response = await clients('zellij', name);
  const ids = response.text.split(/\r?\n/).flatMap(line => { const id = /^\s*(\d+)\s/.exec(line); return id ? [Number(id[1])] : []; });
  assert.ok(ids.length > 0);
  // Zellij v0.45.1 client_to_server.proto: length-prefixed protobuf DetachSession.
  const varint = (value: number) => { const bytes: number[] = []; do { const byte = value & 127; value >>>= 7; bytes.push(byte | (value ? 128 : 0)); } while (value); return bytes; };
  const packed = ids.flatMap(varint), detach = [10, ...varint(packed.length), ...packed];
  const payload = Buffer.from([10, ...varint(detach.length), ...detach]);
  const frame = Buffer.alloc(4); frame.writeUInt32LE(payload.length);
  const socketPath = path.join(env.ZELLIJ_SOCKET_DIR, 'contract_version_1', name);
  const pipePath = '\\\\.\\pipe\\' + socketPath;
  await new Promise<void>((resolve, reject) => {
    const socket = net.createConnection(pipePath);
    const reply = net.createConnection(`${pipePath}-reply`);
    const dispose = () => { socket.destroy(); reply.destroy(); };
    const timer = setTimeout(() => { dispose(); reject(new Error(`Named pipe timeout: ${pipePath}`)); }, 3000);
    const fail = (error: Error) => { clearTimeout(timer); dispose(); reject(error); };
    socket.once('error', fail); reply.once('error', fail); reply.on('data', () => {});
    // Windows Zellij requires paired command + reply pipes, even for fire-and-
    // forget messages. Omitting reply desynchronizes later CLI connections.
    Promise.all([socket, reply].map(stream => new Promise<void>(ready => stream.once('connect', ready)))).then(() => {
      socket.write(Buffer.concat([frame, payload]), error => {
        if (error) { fail(error); return; }
        setTimeout(() => { clearTimeout(timer); dispose(); resolve(); }, 100);
      });
    }).catch(fail);
  });
  return { ids, pipePath, serverPid: await textFile(socketPath) };
}
async function fixture(backend: Backend, name: string, shell = binaries.pwsh) {
  const directory = path.join(root, `${backend}-${name} working 目录 a'b&[x]`); await mkdir(directory, { recursive: true });
  const ready = path.join(directory, 'ready.txt'), startup = path.join(directory, 'startup.txt'), heartbeat = path.join(directory, 'heartbeat.txt');
  const script = path.join(directory, 'startup.ps1');
  await writeFile(script, `\ufeff$global:MuxDockNonce = ${quote(randomUUID())}\n[IO.File]::AppendAllText(${quote(startup)}, "started\n")\n[IO.File]::WriteAllText(${quote(ready)}, [string]$PID)\nfunction global:Start-MuxDockHeartbeat { while ($true) { [IO.File]::WriteAllText(${quote(heartbeat)}, [string][DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()); Start-Sleep -Milliseconds 150 } }\nWrite-Output ('MD_' + 'READY')\n`, 'utf8');
  // PS 5.1 defaults to Restricted on this host. Launch the test's command text
  // through its documented command argument; never change execution policy.
  const command = [shell, '-NoLogo', '-NoProfile', '-NoExit', ...(path.basename(shell).toLowerCase() === 'powershell.exe'
    ? ['-EncodedCommand', Buffer.from((await readFile(script, 'utf8')).replace(/^\ufeff/, ''), 'utf16le').toString('base64')]
    : ['-File', script])];
  const args = backend === 'psmux' ? ['new-session', '-s', name, '-c', directory, '--', ...command] : ['attach', '--create', name, '--', ...command];
  const client = new Client(backend, name, args, directory);
  await until(async () => /^\d+$/.test(await textFile(ready)), `${backend} shell startup`);
  await until(async () => client.screen().includes('MD_READY'), `${backend} rendered terminal output`);
  return { client, directory, ready, startup, heartbeat };
}
async function inputFile(client: Client, file: string, expression: string) {
  client.write(`[IO.File]::WriteAllText(${quote(file)}, [string](${expression}))\r`);
  return until(async () => (await textFile(file)) || false, 'interactive command completed');
}
async function backendChecks(backend: Backend) {
  let name = `${token}_${backend}`, spareName = `${name}_spare`;
  const ownedNames = new Set([name, spareName]);
  let active: Client | undefined;
  await check(backend, 'version and empty isolated namespace', async () => ({ version: (await execute(backend, ['--version'])).stdout.trim(), sessions: await list(backend) }));
  try {
    let main: Awaited<ReturnType<typeof fixture>> | undefined;
    if (!await check(backend, 'create attached session with PowerShell and Unicode/space cwd', async () => { main = await fixture(backend, name); active = main.client; return { shellPid: await textFile(main.ready), directory: main.directory }; })) return;
    const primary = main!;
    await check(backend, 'interactive Unicode input reaches the shell', async () => {
      const value = await inputFile(active!, path.join(primary.directory, 'input.txt'), quote('中文 输入 ✓'));
      assert.equal(value, '中文 输入 ✓'); return value;
    });
    await check(backend, 'ANSI colors and Unicode output render through ConPTY/xterm', async () => {
      active!.write("Write-Host ('MD_COLOR_' + '中文') -ForegroundColor Cyan\r");
      await until(async () => active!.screen().includes('MD_COLOR_中文'), 'colored Unicode output');
      assert.match(active!.raw, /\x1b\[[\d;]*m/); return 'Rendered output and ANSI SGR received';
    });
    await check(backend, 'list sessions and stable identity', async () => { const output = await list(backend); assert.ok(output.includes(name)); return output; });
    await check(backend, 'session and pane details', async () => {
      const output = backend === 'psmux'
        ? (await execute(backend, ['list-panes', '-s', '-t', name, '-F', '#{session_id}|#{window_id}|#{pane_id}|#{pane_pid}|#{pane_current_path}|#{pane_current_command}|#{pane_start_command}'])).stdout
        : (await execute(backend, ['--session', name, 'action', 'list-panes', '--all', '--json'])).stdout;
      await writeFile(path.join(root, `${backend}-details.json`), backend === 'psmux' ? JSON.stringify({ panes: output, session: (await execute(backend, ['display-message', '-p', '-t', name, '#{session_created}|#{session_attached}|#{session_path}|#{pid}'])).stdout }, null, 2) : output);
      assert.ok(output.includes('working') && (output.includes('目录') || output.includes('\\u76ee')), 'details expose actual working directory'); return output;
    });
    await check(backend, 'resize reaches the pane', async () => {
      const before = await inputFile(active!, path.join(primary.directory, 'size-before.txt'), '($Host.UI.RawUI.WindowSize | ConvertTo-Json -Compress)');
      active!.terminal.resize(124, 42); active!.pty.resize(124, 42); await sleep(400);
      const after = await inputFile(active!, path.join(primary.directory, 'size-after.txt'), '($Host.UI.RawUI.WindowSize | ConvertTo-Json -Compress)');
      assert.notDeepEqual(JSON.parse(after), JSON.parse(before)); return { before: JSON.parse(before), after: JSON.parse(after) };
    });
    await check(backend, 'bracketed paste executes once with literal special characters', async () => {
      const file = path.join(primary.directory, 'bracketed.txt'), value = "粘贴 a'b & [x] $literal";
      active!.write(`\x1b[200~[IO.File]::WriteAllText(${quote(file)}, ${quote(value)})\x1b[201~\r`);
      await until(async () => await textFile(file), 'bracketed paste command'); assert.equal(await textFile(file), value); return value;
    });
    const paneDirectory = async () => {
      if (backend === 'psmux') return (await execute(backend, ['display-message', '-p', '-t', name, '#{pane_current_path}'])).stdout.trim().replace(/[\\/]$/, '');
      const panes = JSON.parse((await execute(backend, ['--session', name, 'action', 'list-panes', '--all', '--json'])).stdout);
      return panes.find((pane: any) => !pane.is_plugin && pane.is_focused)?.pane_cwd?.replace(/[\\/]$/, '');
    };
    const announceDirectory = (directory: string) => active!.write(`[Console]::Write([char]27 + ${quote(']7;' + pathToFileURL(directory).href)} + [char]7)\r`);
    await check(backend, 'live PowerShell cwd without shell integration', async () => {
      const directory = path.join(primary.directory, 'child 目录'); await mkdir(directory);
      try {
        active!.write(`Set-Location -LiteralPath ${quote(directory)}\r`);
        assert.equal(await inputFile(active!, path.join(primary.directory, 'actual-cwd.txt'), '$PWD.Path'), directory);
        await sleep(300); const reported = await paneDirectory();
        assert.equal(reported, directory, 'native pane metadata must reflect the shell location'); return directory;
      } finally { active!.write(`Set-Location -LiteralPath ${quote(primary.directory)}\r`); }
    });
    await check(backend, 'live directory via OSC 7 shell integration', async () => {
      const directory = path.join(primary.directory, 'child 目录');
      try {
        active!.write(`Set-Location -LiteralPath ${quote(directory)}\r`); announceDirectory(directory);
        await until(async () => (await paneDirectory()) === directory, 'OSC 7 cwd', 5000); return directory;
      } finally { active!.write(`Set-Location -LiteralPath ${quote(primary.directory)}\r`); announceDirectory(primary.directory); }
    });
    await check(backend, 'native detach preserves a running foreground task and same shell PID', async () => {
      active!.write('Start-MuxDockHeartbeat\r');
      const before = await until(async () => await textFile(primary.heartbeat), 'heartbeat starts');
      const shellPid = await textFile(primary.ready);
      active!.write(backend === 'psmux' ? '\x02d' : '\x0fd');
      await until(async () => active!.closed, 'native keyboard detach');
      await until(async () => (await textFile(primary.heartbeat)) !== before, 'task continues while detached');
      assert.equal(await textFile(primary.ready), shellPid);
      active = attach(backend, name); await sleep(1000); active.write('\x03'); await sleep(300);
      const pid = await inputFile(active, path.join(primary.directory, 'reattached-pid.txt'), '$PID');
      assert.equal(pid, shellPid); assert.equal(await textFile(primary.startup), 'started\n'); return { shellPid, startupRuns: 1 };
    });
    await check(backend, 'closing PTY preserves live task and permits reattach', async () => {
      assert.ok(active && !active.closed); active.write('Start-MuxDockHeartbeat\r'); await sleep(500);
      const before = await textFile(primary.heartbeat); await active.kill();
      await until(async () => (await textFile(primary.heartbeat)) !== before, 'heartbeat after PTY kill');
      assert.ok((await list(backend)).includes(name)); active = attach(backend, name); await sleep(1000); active.write('\x03'); await sleep(300);
      assert.equal(await inputFile(active, path.join(primary.directory, 'pty-close-pid.txt'), '$PID'), await textFile(primary.ready)); return 'Same shell and background session survived PTY.kill()';
    });
    await check(backend, 'multiple clients attach to one live session', async () => {
      attach(backend, name); await until(async () => (await clients(backend, name)).count === 2, 'exactly two clients'); await sleep(300); return clients(backend, name);
    });
    let spare: Awaited<ReturnType<typeof fixture>> | undefined;
    await check(backend, 'independent second session', async () => { spare = await fixture(backend, spareName); return { shellPid: await textFile(spare.ready) }; });
    await check(backend, 'disconnect all clients preserves both sessions and unrelated clients', async () => {
      assert.ok(spare); assert.ok(active && !active.closed);
      active.write('Start-MuxDockHeartbeat\r'); await sleep(350); const before = await textFile(primary.heartbeat);
      const beforeClients = await clients(backend, name);
      await execute(backend, backend === 'psmux' ? ['detach-client', '-s', name] : ['--session', name, 'action', 'detach']);
      let remaining = await clients(backend, name);
      try { await until(async () => { remaining = await clients(backend, name); return remaining.count === 0; }, 'all clients detached', 5000); }
      catch { throw new Error(`detach did not release all clients: before=${JSON.stringify(beforeClients)}, after=${JSON.stringify(remaining)}`); }
      assert.ok(!spare.client.closed); assert.ok((await clients(backend, spareName)).count >= 1);
      await until(async () => (await textFile(primary.heartbeat)) !== before, 'task survives detach-all');
      active = attach(backend, name); await sleep(1000); active.write('\x03'); await sleep(200);
      return 'Only the targeted session clients detached';
    });
    if (backend === 'zellij') await check(backend, 'versioned named-pipe detach-all preserves live task and unrelated clients', async () => {
      assert.ok(spare); while ((await clients(backend, name)).count < 2) { attach(backend, name); await sleep(250); }
      const before = await textFile(primary.heartbeat);
      const evidence = await detachZellijThroughPipe(name);
      await until(async () => (await clients(backend, name)).count === 0, 'named-pipe detach-all');
      assert.ok(!spare.client.closed); assert.equal((await clients(backend, spareName)).count, 1);
      await until(async () => (await textFile(primary.heartbeat)) !== before, 'heartbeat after named-pipe detach');
      active = attach(backend, name); await sleep(1000); active.write('\x03'); await sleep(300);
      return evidence;
    });
    await check(backend, 'window/tab list in machine-readable form', async () => {
      const output = (await execute(backend, backend === 'psmux' ? ['list-windows', '-a', '-F', '#{session_id}|#{window_id}|#{window_index}|#{window_active}|#{window_name}'] : ['--session', name, 'action', 'list-tabs', '--all', '--json'])).stdout;
      await writeFile(path.join(root, `${backend}-windows.json`), backend === 'psmux' ? JSON.stringify({ output }) : output); assert.ok(output.trim()); return output;
    });
    await check(backend, 'window/tab create, rename, select, close by stable ID', async () => {
      const windowName = 'logs_中文';
      if (backend === 'psmux') {
        const first = (await execute(backend, ['list-windows', '-t', name, '-F', '#{window_id}'])).stdout.trim().split(/\r?\n/)[0];
        await execute(backend, ['new-window', '-t', name, '-n', windowName, '-c', primary.directory, '--', binaries.pwsh, '-NoLogo', '-NoProfile']);
        const rows = (await execute(backend, ['list-windows', '-t', name, '-F', '#{window_id}|#{window_name}'])).stdout.trim().split(/\r?\n/);
        const id = rows.find(row => row.endsWith(`|${windowName}`))?.split('|')[0]; assert.ok(id);
        await execute(backend, ['rename-window', '-t', `${name}:${id}`, 'renamed_日志']);
        await execute(backend, ['select-window', '-t', `${name}:${first}`]);
        await execute(backend, ['select-window', '-t', `${name}:${id}`]);
        assert.equal((await execute(backend, ['display-message', '-p', '-t', `${name}:${id}`, '#{window_name}|#{window_active}'])).stdout.trim(), 'renamed_日志|1');
        await execute(backend, ['kill-window', '-t', `${name}:${id}`]);
        assert.equal((await execute(backend, ['list-windows', '-t', name, '-F', '#{window_id}'])).stdout.trim(), first);
        return { createdId: id, retainedId: first };
      }
      const action = (args: string[]) => execute(backend, ['--session', name, 'action', ...args]);
      const first = JSON.parse((await action(['list-tabs', '--all', '--json'])).stdout)[0].tab_id;
      const created = (await action(['new-tab', '--name', windowName, '--cwd', primary.directory, '--', binaries.pwsh, '-NoLogo', '-NoProfile'])).stdout.trim();
      assert.match(created, /^\d+$/);
      await action(['rename-tab-by-id', created, 'renamed_日志']); await action(['go-to-tab-by-id', String(first)]); await action(['go-to-tab-by-id', created]);
      const tabs = JSON.parse((await action(['list-tabs', '--all', '--json'])).stdout);
      assert.ok(tabs.some((tab: any) => String(tab.tab_id) === created && tab.name === 'renamed_日志' && tab.active));
      await action(['close-tab-by-id', created]);
      await until(async () => JSON.parse((await action(['list-tabs', '--json'])).stdout).length === 1, 'tab closed'); return { createdId: created, retainedId: first };
    });
    await check(backend, 'split pane, inspect, capture output, and close targeted pane', async () => {
      if (backend === 'psmux') {
        const first = (await execute(backend, ['list-panes', '-t', name, '-F', '#{pane_id}'])).stdout.trim();
        await execute(backend, ['split-window', '-h', '-t', name, '-c', primary.directory, '--', binaries.pwsh, '-NoLogo', '-NoProfile']);
        const rows = (await execute(backend, ['list-panes', '-t', name, '-F', '#{pane_id}|#{window_index}|#{pane_index}'])).stdout.trim().split(/\r?\n/); assert.equal(rows.length, 2);
        const [second, windowIndex, paneIndex] = rows.find(row => row.split('|')[0] !== first)!.split('|');
        const target = `${name}:${windowIndex}.${paneIndex}`;
        await sleep(500);
        await execute(backend, ['send-keys', '-t', target, "Write-Output ('PANE_' + 'CAPTURE')", 'Enter']);
        await until(async () => (await execute(backend, ['capture-pane', '-p', '-t', target])).stdout.includes('PANE_CAPTURE'), 'captured pane output');
        await execute(backend, ['kill-pane', '-t', target]); return { original: first, closed: second, target };
      }
      const action = (args: string[]) => execute(backend, ['--session', name, 'action', ...args]);
      const created = (await action(['new-pane', '--direction', 'right', '--cwd', primary.directory, '--', binaries.pwsh, '-NoLogo', '-NoProfile'])).stdout.trim();
      assert.match(created, /^terminal_\d+$/);
      await sleep(700);
      await action(['write-chars', '--pane-id', created, "Write-Output ('PANE_' + 'CAPTURE')"]);
      await action(['write', '--pane-id', created, '13']);
      await until(async () => (await action(['dump-screen', '--pane-id', created])).stdout.includes('PANE_CAPTURE'), 'captured pane output');
      await action(['close-pane', '--pane-id', created]); return { closed: created };
    });
    await check(backend, 'session rename remains addressable and reattachable', async () => {
      // Isolate rename: Windows Zellij 0.45.1 renames the discovery file but not
      // its live named pipe, which must not poison the other capability checks.
      const original = `${token}_rename_${backend}`, renamed = `${original}_new`; ownedNames.add(original); ownedNames.add(renamed);
      const isolated = await fixture(backend, original); const shellPid = await textFile(isolated.ready);
      const identity = backend === 'psmux' ? (await execute(backend, ['display-message', '-p', '-t', original, '#{session_id}'])).stdout.trim() : undefined;
      await execute(backend, backend === 'psmux' ? ['rename-session', '-t', original, renamed] : ['--session', original, 'action', 'rename-session', renamed]);
      await until(async () => (await list(backend)).includes(renamed), 'renamed session listed');
      await execute(backend, backend === 'psmux' ? ['list-panes', '-t', renamed] : ['--session', renamed, 'action', 'list-panes', '--json']);
      if (identity) assert.equal((await execute(backend, ['display-message', '-p', '-t', renamed, '#{session_id}'])).stdout.trim(), identity);
      const reattached = attach(backend, renamed); await sleep(800);
      assert.equal(await inputFile(reattached, path.join(isolated.directory, 'rename-pid.txt'), '$PID'), shellPid);
      return { identity, shellPid };
    });
    await check(backend, 'Windows PowerShell 5.1 shell and Unicode paths', async () => {
      const shellName = `${token}_ps5_${backend}`; ownedNames.add(shellName);
      const shell = await fixture(backend, shellName, binaries.powershell);
      const value = await inputFile(shell.client, path.join(shell.directory, 'ps5-result.txt'), "([string]$PSVersionTable.PSVersion.Major) + ' 中文'");
      assert.equal(value, '5 中文'); return { version: value, shellPid: await textFile(shell.ready) };
    });
    await check(backend, 'CMD shell interactive input and working directory', async () => {
      const cmdName = `${token}_cmd_${backend}`; ownedNames.add(cmdName);
      const args = backend === 'psmux' ? ['new-session', '-s', cmdName, '-c', primary.directory, '--', binaries.cmd, '/d', '/q'] : ['attach', '--create', cmdName, '--', binaries.cmd, '/d', '/q'];
      const client = new Client(backend, cmdName, args, primary.directory); await sleep(800);
      const file = path.join(primary.directory, 'cmd-cwd.txt');
      client.write(`cd > "${file}"\r`);
      // CMD writes its local code page; compare an ASCII marker and verify cwd
      // separately with the backend's Unicode metadata.
      await until(async () => await textFile(file), 'CMD command');
      if (backend === 'psmux') assert.equal((await execute(backend, ['display-message', '-p', '-t', cmdName, '#{pane_current_path}'])).stdout.trim().replace(/[\\/]$/, ''), primary.directory);
      else assert.ok(JSON.parse((await execute(backend, ['--session', cmdName, 'action', 'list-panes', '--all', '--json'])).stdout).some((pane: any) => !pane.is_plugin && pane.pane_cwd?.replace(/[\\/]$/, '') === primary.directory));
      const marker = path.join(root, `${backend}-cmd-marker.txt`); client.write(`echo MD_CMD_OK>"${marker}"\r`);
      await until(async () => (await textFile(marker)).trim() === 'MD_CMD_OK', 'CMD exact command execution');
      return { shell: binaries.cmd, marker: (await textFile(marker)).trim() };
    });
    await check(backend, 'Unicode session name can be discovered, attached and ended', async () => {
      const unicode = `${token}_训练_${backend}`; ownedNames.add(unicode);
      const isolated = await fixture(backend, unicode); assert.ok(await sessionExists(backend, unicode));
      const client = attach(backend, unicode); await sleep(700);
      assert.equal(await inputFile(client, path.join(isolated.directory, 'unicode-name-pid.txt'), '$PID'), await textFile(isolated.ready));
      await execute(backend, backend === 'psmux' ? ['kill-session', '-t', unicode] : ['kill-session', unicode]);
      await until(async () => !await sessionExists(backend, unicode), 'Unicode session ended'); return unicode;
    });
    await check(backend, 'host process exit preserves a session created by that host', async () => {
      const hostName = `${token}_host_${backend}`; ownedNames.add(hostName);
      const heartbeat = path.join(root, `${backend}-host-heartbeat.txt`), ready = path.join(root, `${backend}-host-pid.txt`);
      const script = path.join(root, `${backend}-host-task.ps1`);
      await writeFile(script, `\ufeff[IO.File]::WriteAllText(${quote(ready)}, [string]$PID)\nwhile ($true) { [IO.File]::WriteAllText(${quote(heartbeat)}, [string][DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()); Start-Sleep -Milliseconds 150 }\n`);
      const command = [binaries.pwsh, '-NoLogo', '-NoProfile', '-File', script];
      const args = backend === 'psmux' ? ['new-session', '-s', hostName, '--', ...command] : ['attach', '--create', hostName, '--', ...command];
      const helper = path.join(root, `${backend}-pty-host.cjs`);
      const moduleFile = path.resolve('node_modules/node-pty');
      await writeFile(helper, `const p = require(${JSON.stringify(moduleFile)}).spawn(${JSON.stringify(binaries[backend])}, ${JSON.stringify(argumentsFor(backend, args))}, {cwd:${JSON.stringify(root)},env:process.env,cols:100,rows:30,useConptyDll:${useConptyDll}}); p.onData(d => {if(d.includes('\\x1b[6n')) p.write('\\x1b[1;1R');}); setInterval(()=>{},1000);`);
      const host = spawn(process.execPath, [helper], { env, cwd: root, windowsHide: true, stdio: 'ignore' });
      try {
        await until(async () => await textFile(heartbeat), 'host-created heartbeat');
        const before = await textFile(heartbeat), shellPid = await textFile(ready);
        const exited = new Promise<void>(resolve => host.once('exit', () => resolve())); host.kill(); await exited;
        await until(async () => (await textFile(heartbeat)) !== before, 'heartbeat after host exit');
        assert.ok(await sessionExists(backend, hostName)); const client = attach(backend, hostName); await sleep(700); assert.ok(!client.closed);
        assert.equal(await textFile(ready), shellPid); return { hostPid: host.pid, shellPid, heartbeatContinued: true };
      } finally { if (host.exitCode === null && host.signalCode === null) host.kill(); }
    });
    await check(backend, 'targeted session termination preserves unrelated session', async () => {
      await execute(backend, backend === 'psmux' ? ['kill-session', '-t', name] : ['kill-session', name]);
      await until(async () => !await sessionExists(backend, name), 'session ended');
      assert.ok(spare && !spare.client.closed); assert.ok((await list(backend)).includes(spareName)); return 'Unrelated session remains usable';
    });
  } finally {
    for (const client of children) if (client.backend === backend) { await client.save(client.name + '-' + [...children].indexOf(client)); }
    for (const name of ownedNames) {
      await execute(backend, backend === 'psmux' ? ['kill-session', '-t', name] : ['kill-session', name], false);
      if (backend === 'zellij') await execute(backend, ['delete-session', name, '--force'], false);
    }
    if (backend === 'psmux') await execute(backend, ['kill-server'], false); // Exact test-only -L namespace, including its warm server.
    for (const client of children) if (client.backend === backend) { await client.kill().catch(() => {}); client.terminal.dispose(); }
  }
}
async function main() {
  if (process.platform !== 'win32') throw new Error('Run this suite on a native Windows host.');
  binaries = JSON.parse(await readFile('.test-tools/executables.windows.json', 'utf8').catch(() => '{}'));
  for (const name of ['psmux', 'zellij', 'pwsh', 'powershell', 'cmd']) {
    if (binaries[name]) continue;
    const found = await new Promise<string>(resolve => execFile('where.exe', [`${name}.exe`], { windowsHide: true }, (error, stdout) => resolve(error ? '' : stdout.trim().split(/\r?\n/)[0])));
    if (!found) throw new Error(`${name}.exe is missing from PATH. Reopen your shell after installation or configure .test-tools/executables.windows.json.`);
    binaries[name] = found;
  }
  await mkdir(root, { recursive: true });
  for (const directory of ['psmux-data', 'zellij-sockets', 'local', 'roaming']) await mkdir(path.join(root, directory));
  env = { ...cleanEnvironment(), PSMUX_DATA_DIR: path.join(root, 'psmux-data'), ZELLIJ_SOCKET_DIR: path.join(root, 'zellij-sockets'), LOCALAPPDATA: path.join(root, 'local'), APPDATA: path.join(root, 'roaming'), NO_COLOR: '1' };
  psmuxConfig = path.join(root, 'psmux.conf'); zellijConfig = path.join(root, 'zellij.kdl');
  await writeFile(psmuxConfig, `set -g default-shell ${JSON.stringify(binaries.pwsh.replaceAll('\\', '/'))}\nset -g automatic-rename off\n`);
  await writeFile(zellijConfig, `show_release_notes false\nshow_startup_tips false\nsession_serialization false\ndefault_shell ${JSON.stringify(binaries.pwsh)}\n`);
  const before = { psmux: await list('psmux'), zellij: await list('zellij') };
  await check('host', 'isolated namespaces start empty', async () => { assert.equal(before.psmux.trim(), ''); assert.ok(!before.zellij.trim() || /No active/.test(before.zellij)); return before; });
  const requested = (process.env.MUXDOCK_TEST_MANAGERS || 'psmux,zellij').split(',');
  for (const backend of ['psmux', 'zellij'] as const) if (requested.includes(backend)) await backendChecks(backend);
  await check('host', 'all test sessions have been cleaned up', async () => {
    const remaining = { psmux: await list('psmux'), zellij: await list('zellij') };
    assert.equal(remaining.psmux.trim(), ''); assert.equal(parseZellij(remaining.zellij).length, 0); return remaining;
  });
  const report = { timestamp: new Date().toISOString(), platform: process.platform, release: os.release(), arch: process.arch, node: process.version, nodePty: require('node-pty/package.json').version, useConptyDll, binaries, root, results };
  await writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
  await writeFile(path.join(root, 'commands.json'), JSON.stringify(commandLog, null, 2));
  await writeFile(path.resolve('.test-results/windows-capabilities-latest.json'), JSON.stringify(report, null, 2));
  console.log(`Report: ${path.join(root, 'report.json')}`);
  console.log(`${results.filter(r => r.status === 'PASS').length} passed, ${results.filter(r => r.status === 'FAIL').length} failed`);
  // node-pty 1.1.0 may retain a Windows worker after natural exit; all owned sessions
  // and clients above have been explicitly cleaned up before exiting the harness.
  process.exit(results.some(r => r.status === 'FAIL') ? 1 : 0);
}
main().catch(async error => { console.error(error); for (const client of children) await client.kill().catch(() => {}); process.exit(1); });
