import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Terminal } from '@xterm/headless';
import { Adapter } from '../src/adapters';
import { Connections } from '../src/connections';
import { MANAGER_IDS, type ManagerId, type Command, type SessionInfo } from '../src/model';
import { run, cleanEnvironment } from '../src/runner';
import { launchExecutable, shellQuote } from '../src/launch';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until<T>(fn: () => Promise<T | undefined | false>, description: string, timeout = 20000): Promise<T> {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await fn(); if (value) return value; await sleep(100); }
  throw new Error(`Timed out: ${description}`);
}
async function main() {
let paths: Partial<Record<ManagerId, string>> = {};
try { paths = JSON.parse(await readFile('.test-tools/executables.json', 'utf8')); } catch { /* Use installed tools when no test toolchain was prepared. */ }
const root = await mkdtemp(path.join(os.tmpdir().startsWith('/var/') ? '/tmp' : os.tmpdir(), 'muxdock-'));
const env = { ...cleanEnvironment(), SHELL: '/bin/sh', XDG_CACHE_HOME: `${root}/cache`, XDG_CONFIG_HOME: `${root}/config`, XDG_STATE_HOME: `${root}/state`, XDG_RUNTIME_DIR: `${root}/run`, ZMX_DIR: `${root}/zmx`, SCREENDIR: `${root}/screen`, TERM: 'xterm-256color' };
for (const directory of ['cache', 'config', 'state', 'run', 'screen', 'zmx']) await mkdir(`${root}/${directory}`, { mode: 0o700 });
const workDir = `${root}/working 目录`;
await mkdir(workDir);
await mkdir(`${root}/config/zellij`);
await writeFile(`${root}/config/zellij/config.kdl`, 'show_release_notes false\nshow_startup_tips false\n');
const results: Record<string, unknown>[] = [];
await mkdir('.test-results', { recursive: true });
let failed = false;
for (const id of MANAGER_IDS.filter(id => !process.env.MUXDOCK_TEST_MANAGERS || process.env.MUXDOCK_TEST_MANAGERS.split(',').includes(id))) {
  const args = id === 'tmux' ? ['-S', `${root}/tmux.sock`, '-f', '/dev/null'] : id === 'shpool' ? ['-s', `${root}/shpool.sock`, '-D'] : id === 'a4' && paths.a4?.includes('.test-tools') ? ['-i', path.resolve('.test-tools/a4-main/etc/a4.ini')] : [];
  const execute = (command: Command) => run({ ...command, env: { ...env, ...command.env } });
  const adapter = new Adapter(id, { executable: paths[id], args }, execute);
  const runtime = new Connections();
  const external = new Connections();
  const untouched = new Connections();
  const terminal = new Terminal({ cols: 100, rows: 28, allowProposedApi: true });
  let rawOutput = '';
  const exits: unknown[] = [];
  let daemon: ReturnType<typeof spawn> | undefined;
  let created: SessionInfo | undefined;
  let spare: SessionInfo | undefined;
  const name = `md_${id}_${process.pid}`;
  const screen = () => { const buffer = terminal.buffer.active; const lines: string[] = []; for (let i = 0; i < buffer.length; i++) lines.push(buffer.getLine(i)?.translateToString(true) || ''); return lines.join('\n'); };
  runtime.on('output', message => { rawOutput = (rawOutput + message.data).slice(-4000); terminal.write(message.data); });
  runtime.on('exit', event => exits.push(event));
  terminal.onData(data => { if (runtime.activeKey) runtime.input(runtime.activeKey, data); });
  try {
    if (!(await adapter.probe())) { results.push({ id, status: 'SKIP', reason: 'executable unavailable' }); console.log(`${id}: SKIP`); continue; }
    if (id === 'shpool') {
      const command = adapter.command(['daemon']);
      daemon = spawn(command.file, command.args, { env, stdio: 'ignore' });
      await until(async () => { try { await readFile(`${root}/shpool.sock`); } catch (error: any) { return error.code !== 'ENOENT'; } return true; }, 'shpool daemon');
    }
    const startupFile = `${root}/startup-${id}.txt`;
    const executable = await launchExecutable('/bin/sh', `printf '%s\\n' '${id}' >> ${shellQuote(startupFile)}`, `${root}/launchers`);
    const command = adapter.create(name, executable, '/bin/sh'); command.env = { ...env, ...command.env };
    runtime.connect(id, { id: name, name }, command, workDir);
    created = await until(async () => { const manager = await adapter.list(); if (manager.error) throw new Error(manager.error); return manager.sessions.find(session => session.name === name); }, `${id} create`);
    runtime.reconcile([await adapter.list()]);
    await until(async () => { try { return (await readFile(startupFile, 'utf8')) === `${id}\n`; } catch { return false; } }, `${id} startup command executed once`);
    if (id === 'zmx') await sleep(400);
    else await until(async () => /(?:sh-[\d.]+\$|\$ |# )/.test(screen()), `${id} interactive shell ready`);
    if (id === 'zellij') {
      await sleep(1800);
      await until(async () => { if (/<ESC> - Dismiss/.test(screen())) { runtime.input(runtime.activeKey!, '\x1b'); return false; } return true; }, 'Zellij first-run dialog dismissed');
    }
    runtime.input(runtime.activeKey!, `printf 'MD_RUN_%s\\n' '${id}'\r`);
    await until(async () => screen().includes(`MD_RUN_${id}`), `${id} real shell output`);
    if (id === 'tmux') {
      await adapter.windowAction('new', created, undefined, 'logs');
      let session = (await adapter.list()).sessions.find(session => session.id === created!.id)!;
      assert.equal(session.windows?.length, 2);
      const window = session.windows!.find(window => window.name === 'logs')!;
      await adapter.windowAction('rename', session, window, 'renamed');
      await adapter.windowAction('select', session, window);
      session = (await adapter.list()).sessions.find(session => session.id === created!.id)!;
      assert.equal(session.windows?.find(window => window.active)?.name, 'renamed');
      const stableId = session.id;
      await adapter.rename(session, `${name}_renamed`);
      created = (await adapter.list()).sessions.find(session => session.id === stableId && session.name === `${name}_renamed`)!;
      assert.ok(created);
      await adapter.windowAction('select', created, created.windows![0]);
    }
    const details = await adapter.details(created);
    await writeFile(`.test-results/details-${id}.json`, JSON.stringify(details, null, 2));
    assert.equal(details.sections[0].fields.find(field => field.label === '会话名称')?.value, created.name);
    assert.ok(details.sections.some(section => section.fields.some(field => field.label === '工作路径' && String(field.value).includes('working 目录'))), `${id} details preserve Unicode/space-containing working paths`);
    assert.ok(details.sections.some(section => section.fields.some(field => field.label.includes('PID') && Number(field.value) > 1)), `${id} exposes native process IDs`);
    assert.ok(details.sections[0].fields.some(field => field.label.includes('创建时间') && field.value), `${id} exposes creation time`);
    if (id === 'tmux') {
      const window = created.windows![0];
      const windowDetails = await adapter.details(created, window);
      assert.ok(windowDetails.sections.slice(1).every(section => section.fields.find(field => field.label === 'Window ID')?.value === window.id));
      assert.ok(details.sections.some(section => section.fields.some(field => field.label === '工作路径' && field.value)));
    }
    if (id !== 'shpool') {
      const attach = adapter.attach(created); attach.env = { ...env, ...attach.env };
      external.connect(id, created, attach, root);
      await sleep(600);
      assert.equal(external.list()[0].closed, false);
    }
    const spareName = `keep_${process.pid}`;
    const spareCommand = adapter.create(spareName, '/bin/sh'); spareCommand.env = { ...env, ...spareCommand.env };
    untouched.connect(id, { id: spareName, name: spareName }, spareCommand, root);
    spare = await until(async () => (await adapter.list()).sessions.find(session => session.name === spareName), 'unrelated session ready');
    await adapter.detachAll(created);
    await until(async () => runtime.list()[0]?.closed && (id === 'shpool' || external.list()[0]?.closed), `${id} all clients exited`);
    assert.equal(untouched.list()[0].closed, false, 'Disconnect all must preserve clients of unrelated sessions');
    const detachedDetails = await adapter.details(created);
    if (id === 'screen') assert.equal(detachedDetails.sections[0].fields.find(field => field.label === '客户端连接状态')?.value, '未连接');
    else assert.equal(Number(detachedDetails.sections[0].fields.find(field => field.label === '客户端连接数')?.value), 0);
    if (id === 'shpool') await until(async () => (await adapter.list()).sessions.find(session => session.id === created!.id)?.attached === 0, 'shpool client released');
    runtime.disconnect(runtime.activeKey!);
    const afterDetach = (await adapter.list()).sessions.find(session => session.id === created!.id);
    assert.ok(afterDetach, `${id} session must survive detaching its client`);
    terminal.reset();
    const reconnect = adapter.attach(afterDetach); reconnect.env = env;
    runtime.connect(id, afterDetach, reconnect, root);
    await sleep(1200);
    runtime.input(runtime.activeKey!, `printf 'MD_BACK_%s\\n' '${id}'\r`);
    await until(async () => screen().includes(`MD_BACK_${id}`), `${id} reattach`);
    assert.equal(await readFile(startupFile, 'utf8'), `${id}\n`, `${id} reconnect must not rerun startup commands`);
    if (adapter.capabilities.kill) await adapter.kill(afterDetach);
    else runtime.input(runtime.activeKey!, 'exit\r');
    await until(async () => !(await adapter.list()).sessions.some(session => session.id === afterDetach.id), `${id} cleanup`);
    results.push({ id, status: 'PASS', checks: ['create with selected shell', 'startup command runs once', 'shell remains usable after startup command', 'shell input/output', 'session details', 'disconnect all releases external clients and preserves unrelated sessions', 'detach persistence', 'reattach does not rerun command', 'cleanup', ...(id === 'tmux' ? ['window create/rename/select', 'session rename', 'window details'] : [])] });
    console.log(`${id}: PASS`);
  } catch (error) {
    failed = true;
    results.push({ id, status: 'FAIL', error: error instanceof Error ? error.message : String(error), terminal: screen().slice(-3000), rawOutput, exits });
    console.error(`${id}: FAIL ${error}`);
    if (created && adapter.capabilities.kill) await adapter.kill(created).catch(() => {});
    else if (runtime.activeKey) runtime.input(runtime.activeKey, 'exit\r');
    await sleep(200);
  } finally {
    if (spare) {
      if (adapter.capabilities.kill) await adapter.kill(spare).catch(() => {});
      else { untouched.input(untouched.activeKey!, 'exit\r'); await sleep(400); }
    }
    runtime.dispose(); external.dispose(); untouched.dispose(); terminal.dispose(); daemon?.kill('SIGTERM');
    if (id === 'tmux') await execute(adapter.command(['kill-server'])).catch(() => {});
  }
}
await mkdir('.test-results', { recursive: true });
await writeFile('.test-results/integration.json', JSON.stringify({ platform: process.platform, arch: process.arch, results }, null, 2));
await rm(root, { recursive: true, force: true });
if (failed) process.exitCode = 1;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
