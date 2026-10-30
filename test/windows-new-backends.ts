import assert from 'node:assert/strict';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Terminal } from '@xterm/headless';
import { Adapter } from '../src/adapters';
import { Connections } from '../src/connections';
import { launchCommand } from '../src/launch';
import { findExecutable, run } from '../src/runner';
import type { SessionInfo } from '../src/model';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const quote = (text: string) => `'${text.replaceAll("'", "''")}'`;
const read = (file: string) => readFile(file, 'utf8').catch(() => '');
const until = async <T>(fn: () => Promise<T | undefined | false>, label: string): Promise<T> => {
  const end = Date.now() + 20000;
  while (Date.now() < end) { const value = await fn(); if (value) return value; await delay(150); }
  throw new Error(`Timed out: ${label}`);
};
const token = `md_new_${Date.now()}`;
const root = path.resolve('.test-results', token + (process.env.MUXDOCK_TEST_BACKEND === 'herdr' ? " 中文 space's & [x]" : ''));
const results: string[] = [];
async function main() {
  assert.equal(process.platform, 'win32');
  const exe: Record<string, string> = {};
  for (const name of ['tmux', 'herdr', 'pwsh', 'powershell', 'cmd']) {
    const file = await findExecutable(name, name === 'tmux' ? path.join(process.env.LOCALAPPDATA!, 'Programs/tmux-windows/tmux.exe') : undefined);
    assert.ok(file, `${name} installed`); exe[name] = file;
  }
  await mkdir(root, { recursive: true });
  process.env.APPDATA = path.join(root, 'roaming');
  process.env.LOCALAPPDATA = path.join(root, 'local');
  process.env.HERDR_CONFIG_PATH = path.join(root, 'herdr.toml');
  await writeFile(process.env.HERDR_CONFIG_PATH, 'onboarding = false\n[update]\nversion_check = false\nmanifest_check = false\n[terminal]\nkitty_graphics = false\n');
  const tmuxConfig = path.join(root, 'tmux.conf');
  await writeFile(tmuxConfig, `set -g default-shell ${JSON.stringify(exe.pwsh.replaceAll('\\', '/'))}\nset -g automatic-rename off\n`);
  for (const id of ['tmux', 'herdr'] as const) {
    if (process.env.MUXDOCK_TEST_BACKEND && process.env.MUXDOCK_TEST_BACKEND !== id) continue;
    const adapter = new Adapter(id, { executable: exe[id], args: id === 'tmux' ? ['-L', token, '-f', tmuxConfig] : [] }, async command => {
      const result = await run(command);
      await appendFile(path.join(root, 'commands.jsonl'), JSON.stringify({ id, args: command.args, ...result }) + '\n'); return result;
    });
    assert.equal(await adapter.probe(), true);
    const connections = new Connections(), peer = new Connections();
    const displays = new Map<string, Terminal>();
    connections.on('output', output => {
      let terminal = displays.get(output.key);
      if (!terminal) { terminal = new Terminal({ cols: 100, rows: 28, allowProposedApi: true }); displays.set(output.key, terminal); terminal.onData(data => connections.input(output.key, data)); }
      terminal.write(output.data);
      void appendFile(path.join(root, `${id}.ansi`), output.data);
    });
    const owned: SessionInfo[] = [];
    const session = (name: string) => until(async () => (await adapter.list()).sessions.find(item => item.name === name), `${id} ${name}`);
    try {
      for (const shellName of ['pwsh', 'powershell', 'cmd']) {
        const name = `${token}_${shellName}`;
        const marker = path.join(root, `${id}-${shellName}.txt`);
        const startup = shellName === 'cmd' ? `echo ONCE>>"${marker}"` : `Add-Content -LiteralPath ${quote(marker)} -Value "ONCE:$($PID):中文" -Encoding utf8`;
        const launch = await launchCommand(exe[shellName], startup, path.join(root, 'launchers'));
        owned.push({ id: name, name });
        const command = id === 'herdr' ? await adapter.createHerdr(name, exe[shellName], startup, root, path.join(root, 'launchers')) : adapter.create(name, launch.file, exe[shellName], launch.args);
        const first = connections.connect(id, owned.at(-1)!, command, root);
        await until(async () => (await read(marker)).includes('ONCE'), `${id} ${shellName} startup`);
        const live = await session(name); owned[owned.length - 1] = live;
        connections.reconcile([await adapter.list()]);
        await delay(1000);
        const ready = path.join(root, `${id}-${shellName}-ready.txt`);
        connections.input(first.key, shellName === 'cmd' ? `echo READY>"${ready}"\r` : `Set-Content -LiteralPath ${quote(ready)} -Value READY\r`);
        await until(async () => (await read(ready)).includes('READY'), `${id} ${shellName} input`);
        assert.equal(await adapter.shellDialect(live), shellName === 'cmd' ? 'cmd' : 'powershell');
        connections.resize(first.key, 116, 36); displays.get(first.key)?.resize(116, 36);
        let heartbeat = '', before = '';
        if (shellName === 'pwsh') {
          heartbeat = path.join(root, `${id}-heartbeat.txt`);
          connections.input(first.key, `while ($true) { [IO.File]::WriteAllText(${quote(heartbeat)}, ('{0}:{1}' -f $PID, [DateTime]::UtcNow.Ticks)); Start-Sleep -Milliseconds 100 }\r`);
          before = await until(async () => await read(heartbeat), 'heartbeat starts');
        }
        connections.disconnect(first.key); await delay(1000);
        if (heartbeat) { assert.notEqual(await read(heartbeat), before); assert.equal((await read(heartbeat)).split(':')[0], before.split(':')[0]); }
        const second = connections.connect(id, live, adapter.attach(live), root);
        await delay(1800);
        assert.equal(connections.list().find(item => item.key === second.key)?.closed, false);
        if (heartbeat) { connections.input(second.key, '\x03'); await delay(1000); }
        assert.equal((await read(marker)).match(/ONCE/g)?.length, 1);
        const after = path.join(root, `${id}-${shellName}-after.txt`);
        connections.input(second.key, shellName === 'cmd' ? `echo AFTER>"${after}"\r` : `Set-Content -LiteralPath ${quote(after)} -Value AFTER\r`);
        await until(async () => (await read(after)).includes('AFTER'), 'input after reconnect');
        const details = await adapter.details(live);
        assert.ok(details.sections.length > 1);
        connections.disconnect(second.key);
        results.push(`${id}: ${shellName} startup once, input, shell detection, resize, close client, reattach, details`);
        console.log(results.at(-1));
      }
      let target = owned[0]; const spare = owned[1];
      const first = connections.connect(id, target, adapter.attach(target), root);
      await delay(1000);
      const before = (await session(target.name)).windows!;
      const windowName = id === 'herdr' ? 'test_窗口' : 'test_window';
      const renamedWindow = id === 'herdr' ? 'renamed_窗口' : 'renamed_window';
      await adapter.windowAction('new', target, undefined, windowName);
      const created = await until(async () => (await session(target.name)).windows?.find(item => item.name === windowName), 'new window');
      await adapter.windowAction('rename', target, created, renamedWindow);
      await adapter.windowAction('select', target, created);
      await until(async () => (await session(target.name)).windows?.some(item => item.id === created.id && item.name === renamedWindow && item.active), 'selected tab');
      await adapter.windowAction('kill', target, created);
      await until(async () => (await session(target.name)).windows?.length === before.length, 'closed tab');
      if (id === 'tmux') {
        await adapter.rename(target, target.name + '_renamed');
        target = await session(target.name + '_renamed'); assert.equal(target.id, owned[0].id); owned[0] = target;
        const second = peer.connect(id, target, adapter.attach(target), root);
        await until(async () => (await session(target.name)).attached === 2, 'two clients');
        await adapter.detachAll(target);
        await until(async () => connections.list().find(item => item.key === first.key)?.closed && peer.list().find(item => item.key === second.key)?.closed, 'detach both');
      } else {
        await assert.rejects(adapter.rename(target, 'new'));
        await assert.rejects(adapter.detachAll(target));
        await assert.rejects(adapter.createHerdr(target.name, exe.pwsh, undefined, root, path.join(root, 'launchers')));
      }
      await adapter.kill(target); assert.ok((await adapter.list()).sessions.some(item => item.id === spare.id));
      results.push(`${id}: window CRUD, stable identities, capability guards, scoped session termination`);
      console.log(results.at(-1));
    } finally {
      connections.dispose(); peer.dispose(); for (const terminal of displays.values()) terminal.dispose();
      for (const target of owned) await adapter.kill(target).catch(() => {});
      if (id === 'tmux') await run(adapter.command(['kill-server']));
      await until(async () => (await adapter.list()).sessions.length === 0, 'isolated test namespace cleaned');
    }
  }
  await writeFile(path.join(root, 'result.json'), JSON.stringify({ results }, null, 2));
  console.log(`PASS: ${results.length} integration groups. Evidence: ${root}`);
}
main().catch(error => { console.error(error); console.error(`Evidence: ${root}`); process.exitCode = 1; });
