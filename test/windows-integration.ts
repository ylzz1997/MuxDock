import assert from 'node:assert/strict';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Adapter } from '../src/adapters';
import { Connections } from '../src/connections';
import { launchCommand, shellDialect } from '../src/launch';
import { findExecutable, run } from '../src/runner';
import type { SessionInfo } from '../src/model';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const until = async <T>(fn: () => Promise<T | undefined | false>, label: string): Promise<T> => {
  const end = Date.now() + 20000;
  while (Date.now() < end) { const value = await fn(); if (value) return value; await delay(150); }
  throw new Error(`Timed out: ${label}`);
};
const quote = (text: string) => `'${text.replaceAll("'", "''")}'`;
const read = (file: string) => readFile(file, 'utf8').catch(() => '');
const token = `md_integration_${Date.now()}`;
const root = path.resolve('.test-results', token + " 中文 space's & [x]");
const results: string[] = [];
async function main() {
  assert.equal(process.platform, 'win32');
  // Discover before isolating user data. No production sessions/config are touched.
  const executables: Record<string, string> = {};
  for (const name of ['psmux', 'zellij', 'pwsh', 'powershell', 'cmd']) {
    const file = await findExecutable(name); assert.ok(file, `${name} installed`); executables[name] = file;
  }
  await mkdir(root, { recursive: true });
  process.env.PSMUX_DATA_DIR = path.join(root, 'psmux-data');
  process.env.ZELLIJ_SOCKET_DIR = path.join(root, 'zellij-sockets');
  process.env.LOCALAPPDATA = path.join(root, 'local');
  process.env.APPDATA = path.join(root, 'roaming');
  const config = { psmux: path.join(root, 'psmux.conf'), zellij: path.join(root, 'zellij.kdl') };
  await writeFile(config.psmux, `set -g default-shell ${JSON.stringify(executables.pwsh.replaceAll('\\', '/'))}\nset -g automatic-rename off\n`);
  await writeFile(config.zellij, `show_release_notes false\nshow_startup_tips false\nsession_serialization false\ndefault_shell ${JSON.stringify(executables.pwsh)}\n`);
  for (const id of ['psmux', 'zellij'] as const) {
    if (process.env.MUXDOCK_TEST_BACKEND && process.env.MUXDOCK_TEST_BACKEND !== id) continue;
    const adapter = new Adapter(id, { executable: executables[id], args: id === 'psmux' ? ['-L', token, '-f', config[id]] : ['--config', config[id]] }, async command => {
      const result = await run(command);
      await appendFile(path.join(root, 'commands.jsonl'), JSON.stringify({ id, args: command.args, ...result }) + '\n');
      return result;
    });
    assert.equal(await adapter.probe(), true);
    assert.equal(adapter.capabilities.windows, true);
    const connections = new Connections(); const peer = new Connections();
    const owned: SessionInfo[] = [];
    connections.on('output', output => { void writeFile(path.join(root, `${id}-last-output.txt`), connections.replay(output.key)?.data || ''); });
    const session = (name: string) => until(async () => (await adapter.list()).sessions.find(session => session.name === name), `${id} session ${name}`);
    try {
      for (const shellName of ['pwsh', 'powershell', 'cmd']) {
        const name = `${token}_${shellName}_中`;
        const marker = path.join(root, `${id}-${shellName}.txt`);
        const command = shellName === 'cmd' ? `echo ONCE>>"${marker}"` : `Add-Content -LiteralPath ${quote(marker)} -Value "ONCE:$($PID):中文" -Encoding utf8`;
        const launch = await launchCommand(executables[shellName], command, path.join(root, 'launchers'));
        const first = connections.connect(id, { id: name, name }, adapter.create(name, launch.file, executables[shellName], launch.args), root);
        owned.push({ id: name, name });
        await until(async () => (await read(marker)).includes('ONCE'), `${id} ${shellName} startup command`);
        const live = await session(name); owned[owned.length - 1] = live;
        connections.reconcile([await adapter.list()]);
        assert.equal(connections.list().find(item => item.key === first.key)?.sessionId, live.id);
        connections.resize(first.key, 111, 33);
        // Startup command has returned; the original shell must still accept input.
        const ready = path.join(root, `${id}-${shellName}-ready.txt`);
        await delay(1000);
        connections.input(first.key, shellName === 'cmd' ? `echo READY>"${ready}"\r` : `Set-Content -LiteralPath ${quote(ready)} -Value READY\r`);
        await until(async () => (await read(ready)).includes('READY'), `${id} ${shellName} interactive shell`);
        const heartbeat = path.join(root, `${id}-heartbeat.txt`);
        let beforeDetach = '';
        if (shellName === 'pwsh') {
          connections.input(first.key, `while ($true) { [IO.File]::WriteAllText(${quote(heartbeat)}, ('{0}:{1}' -f $PID, [DateTime]::UtcNow.Ticks)); Start-Sleep -Milliseconds 100 }\r`);
          beforeDetach = await until(async () => await read(heartbeat), 'foreground heartbeat');
        }
        connections.disconnect(first.key);
        await delay(700);
        if (beforeDetach) {
          const afterDetach = await read(heartbeat);
          assert.notEqual(afterDetach, beforeDetach, 'foreground work keeps progressing while detached');
          assert.equal(afterDetach.split(':')[0], beforeDetach.split(':')[0], 'original shell PID survives');
          assert.ok((await read(marker)).includes(`ONCE:${afterDetach.split(':')[0]}:`));
        }
        const reattached = connections.connect(id, live, adapter.attach(live), root);
        await delay(1200);
        assert.equal((await read(marker)).match(/ONCE/g)?.length, 1, `${id} ${shellName} command must not run again`);
        assert.equal(connections.list().find(item => item.key === reattached.key)?.closed, false);
        if (beforeDetach) {
          await delay(2500);
          connections.input(reattached.key, '\x03'); await delay(200);
        }
        const details = await adapter.details(live);
        assert.ok(details.sections.length > 1);
        assert.match(details.note!, /initial directory/);
        results.push(`${id}: ${shellName} startup once, interactive, resize, detach/reattach, details`);
        console.log(results.at(-1));
        connections.disconnect(reattached.key);
      }
      let target = owned[0]; const spare = owned[1];
      const first = connections.connect(id, target, adapter.attach(target), root);
      const second = peer.connect(id, target, adapter.attach(target), root);
      await until(async () => {
        const result = await run(adapter.command(id === 'psmux'
          ? ['list-clients', '-t', target.name, '-F', '#{client_pid}']
          : ['--session', target.name, 'action', 'list-clients']));
        return !result.code && result.stdout.split(/\r?\n/).filter(line => id === 'psmux' ? /^\d+$/.test(line) : /^\s*\d+\s/.test(line)).length === 2;
      }, 'two live interactive clients before window actions');
      const before = (await session(target.name)).windows!;
      await adapter.windowAction('new', target, undefined, 'test_窗口');
      const created = await until(async () => (await session(target.name)).windows?.find(window => window.name === 'test_窗口'), 'new window');
      await adapter.windowAction('rename', target, created, 'renamed_窗口');
      await adapter.windowAction('select', target, created);
      await until(async () => (await session(target.name)).windows?.some(window => window.id === created.id && window.name === 'renamed_窗口' && window.active), 'selected renamed window');
      await adapter.windowAction('kill', target, created);
      await until(async () => (await session(target.name)).windows?.length === before.length, 'close only target window');
      if (id === 'psmux') {
        const renamed = target.name + '_renamed'; await adapter.rename(target, renamed);
        target = await session(renamed); assert.equal(target.id, owned[0].id); owned[0] = target;
      } else await assert.rejects(adapter.rename(target, 'forbidden'));
      const detachedWork = path.join(root, `${id}-detach-all-work.txt`);
      connections.input(first.key, `while ($true) { [IO.File]::WriteAllText(${quote(detachedWork)}, ('{0}:{1}' -f $PID, [DateTime]::UtcNow.Ticks)); Start-Sleep -Milliseconds 100 }\r`);
      const beforeAll = await until(async () => await read(detachedWork), 'foreground work before disconnect all');
      await adapter.detachAll(target);
      await until(async () => connections.list().find(item => item.key === first.key)?.closed && peer.list().find(item => item.key === second.key)?.closed, 'both clients detached');
      const afterAll = await until(async () => { const value = await read(detachedWork); return value && value !== beforeAll ? value : undefined; }, 'foreground work after disconnect all');
      assert.equal(afterAll.split(':')[0], beforeAll.split(':')[0]);
      // A CLI request after paired-pipe detach must still receive its own reply.
      assert.ok((await adapter.details(target)).sections.length > 1);
      await adapter.kill(target);
      assert.ok((await adapter.list()).sessions.some(session => session.id === spare.id));
      results.push(`${id}: window CRUD, stable targets, rename capability, detach all clients, targeted kill`);
      console.log(results.at(-1));
    } finally {
      connections.dispose(); peer.dispose();
      for (const target of owned) await adapter.kill(target).catch(() => {});
      assert.equal((await adapter.list()).sessions.length, 0, 'isolated test namespace cleaned');
      if (id === 'psmux') await run(adapter.command(['kill-server']));
    }
  }
  await writeFile(path.join(root, 'result.json'), JSON.stringify({ results }, null, 2));
  console.log(`PASS: ${results.length} integration groups. Evidence: ${root}`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
