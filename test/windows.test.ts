import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { Adapter, parseTmuxSessions, parseTmuxWindows, parseZellijTabs } from '../src/adapters';
import { launchCommand } from '../src/launch';
import { cleanEnvironment, findExecutable } from '../src/runner';
import { findFileLinks, parseTerminalLink } from '../src/links';
import { droppedPaths, droppedPathText } from '../webview/drop';

test('Windows exposes psmux separately and rejects Unix aliases without probing them', async () => {
  let calls = 0;
  for (const id of ['zmx', 'screen', 'shpool', 'abduco', 'a4'] as const) {
    const adapter = new Adapter(id, { executable: process.execPath }, async () => { calls++; return { code: 0, stdout: 'tmux 3.4.0', stderr: '' }; }, 'win32');
    assert.equal((await adapter.list()).available, false);
  }
  assert.equal(calls, 0);
  const impostor = new Adapter('psmux', { executable: process.execPath }, async () => ({ code: 0, stdout: 'tmux 3.4.0', stderr: '' }), 'win32');
  assert.equal(await impostor.probe(), false);
});

test('Windows tmux identifies the native port and rejects psmux aliases and Unix binaries', async () => {
  for (const [stdout, stderr, available] of [['tmux 3.6a-win32', '', true], ['tmux 3.4.0', 'psmux 3.4.0', false], ['tmux 3.6a', '', false]] as const) {
    const adapter = new Adapter('tmux', { executable: process.execPath }, async () => ({ code: 0, stdout, stderr }), 'win32');
    assert.equal(await adapter.probe(), available);
    if (available) {
      assert.deepEqual(adapter.create('dev', 'C:\\Program Files\\pwsh.exe', undefined, ['-NoLogo']).args.slice(-4), ['dev', '--', '"C:\\Program Files\\pwsh.exe"', '-NoLogo']);
      assert.equal(adapter.capabilities.rename, true);
    }
  }
});

test('psmux preserves argv, qualified window targets and its identity despite the tmux version banner', async () => {
  const calls: string[][] = [];
  const adapter = new Adapter('psmux', { executable: process.execPath, args: ['-L', 'scope'] }, async command => {
    calls.push(command.args); return { code: 0, stdout: 'tmux 3.4.0\r\n', stderr: 'psmux 3.4.0 (20aa1d7)\r\n' };
  }, 'win32');
  assert.equal(await adapter.probe(), true);
  assert.deepEqual(adapter.create('中', 'C:\\Program Files\\pwsh.exe', undefined, ['-NoLogo']).args, ['-L', 'scope', 'new-session', '-s', '中', '--', 'C:\\Program Files\\pwsh.exe', '-NoLogo']);
  assert.deepEqual(adapter.create('cmd', 'C:\\Windows\\cmd.exe', undefined, ['/k', 'call', 'C:\\中文\\launch.cmd']).args.slice(-3), ['/k', 'call', 'C:\\中文\\launch.cmd']);
  assert.deepEqual(adapter.attach({ id: '$2', name: '中' }).args, ['-L', 'scope', 'attach-session', '-t', '中']);
  await adapter.windowAction('kill', { id: '$2', name: '中' }, { id: '@1', index: 0, name: 'same', active: true, panes: 1 });
  assert.deepEqual(calls.at(-1), ['-L', 'scope', 'kill-window', '-t', '$2:@1']);
  assert.equal(parseTmuxSessions('$0|1|中\r\n$2|0|two\r\n')[0].name, '中');
  assert.equal(parseTmuxWindows('$0|@1|0|1|1|one\r\n$2|@1|0|1|1|two\r\n').get('$0')![0].name, 'one');
});

test('Zellij gates Windows versions and the verified detach contract, and targets stable tab IDs', async () => {
  for (const [version, available, detachAll] of [['0.44.0', false, false], ['0.45.1', true, true], ['0.46.0', true, false]] as const) {
    const calls: string[][] = [];
    const adapter = new Adapter('zellij', { executable: process.execPath }, async command => { calls.push(command.args); return { code: 0, stdout: `zellij ${version}`, stderr: '' }; }, 'win32');
    assert.equal(await adapter.probe(), available);
    assert.equal(adapter.capabilities.detachAll, detachAll);
    assert.equal(adapter.capabilities.rename, false);
    if (available) {
      await adapter.windowAction('rename', { id: 'dev', name: 'dev' }, { id: '15', index: 2, name: 'tab', panes: 1, active: false }, 'new');
      assert.deepEqual(calls.at(-1), ['--session', 'dev', 'action', 'rename-tab-by-id', '15', 'new']);
    }
  }
  assert.deepEqual(parseZellijTabs('[{"tab_id":15,"position":2,"name":"tab","active":true,"selectable_tiled_panes_count":2,"selectable_floating_panes_count":1}]'), [{ id: '15', index: 2, name: 'tab', active: true, panes: 3 }]);
});

test('PowerShell startup commands use Unicode argv without script-policy changes; CMD uses a quoted file', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'md-launch-'));
  try {
    const command = "Write-Host '中文 & it''s literal'; codex";
    for (const shell of ['C:\\Program Files\\PowerShell\\7\\pwsh.exe', 'C:\\Windows\\powershell.exe']) {
      const launch = await launchCommand(shell, command, directory, 'win32');
      assert.deepEqual(launch.args.slice(0, 3), ['-NoLogo', '-NoExit', '-EncodedCommand']);
      assert.equal(Buffer.from(launch.args[3], 'base64').toString('utf16le'), command);
    }
    const cmd = await launchCommand('C:\\Windows\\cmd.exe', 'echo "中文 & hello"', directory, 'win32');
    assert.deepEqual(cmd.args.slice(0, 2), ['/k', 'call']);
    assert.match(await readFile(cmd.args[2], 'utf8'), /echo "中文 & hello"/);
  } finally { assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep)); await rm(directory, { recursive: true, force: true }); }
});

test('Windows drive paths, file URIs and PowerShell drops preserve literal characters', () => {
  assert.deepEqual(parseTerminalLink('C:\\项目\\main.ts:12:3'), { kind: 'file', path: 'C:\\项目\\main.ts', line: 12, column: 3 });
  assert.deepEqual(parseTerminalLink('file:///C:/project/a%20b.ts#L2'), { kind: 'file', path: 'C:/project/a b.ts', line: 2 });
  assert.equal(findFileLinks('error C:\\project\\main.ts:12:3')[0].target, 'C:\\project\\main.ts:12:3');
  assert.deepEqual(droppedPaths({ types: ['resourceurls'], getData: () => '["file:///C:/%E4%B8%AD%20a.ts"]' }), ['C:/中 a.ts']);
  assert.equal(droppedPathText(["C:\\it's\\$var & [x]`name"], 'powershell'), "'C:\\it''s\\$var & [x]`name'");
  assert.equal(droppedPathText(['C:\\space & name'], 'cmd'), '"C:\\space & name"');
  assert.equal(droppedPathText(['C:\\%TEMP%\\!x!'], 'cmd'), '');
  // A Windows editor attached to a Unix workspace still uses POSIX quoting.
  assert.equal(droppedPathText(["/tmp/it's"], 'posix'), "'/tmp/it'\\''s'");
});

test('Windows native executable discovery rejects batch shims and normalizes PATH', { skip: process.platform !== 'win32' }, async () => {
  assert.equal(await findExecutable('node', process.execPath), process.execPath);
  assert.equal(await findExecutable('npm', 'C:\\tools\\npm.cmd'), undefined);
  const env = cleanEnvironment({ Path: 'C:\\tools', PATH: 'wrong', PSMUX_SESSION_NAME: 'nested' });
  assert.equal(env.PATH, 'C:\\tools'); assert.equal(env.Path, undefined); assert.equal(env.PSMUX_SESSION_NAME, undefined);
});
