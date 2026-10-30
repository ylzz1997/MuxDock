import test from 'node:test';
import assert from 'node:assert/strict';
import { Adapter } from '../src/adapters';
import { parseHerdrSessions, herdrResult, herdrSnapshot, herdrWindows, validateHerdrName } from '../src/herdr';
import { cleanEnvironment } from '../src/runner';

test('Herdr discovery excludes saved stopped sessions and rejects error responses', () => {
  assert.deepEqual(parseHerdrSessions(JSON.stringify({ sessions: [{ name: 'dev', running: true }, { name: 'old', running: false }] })), [{ id: 'dev', name: 'dev' }]);
  assert.throws(() => parseHerdrSessions('{"error":"denied"}'));
  assert.throws(() => herdrResult('{"error":{"code":"not_found","message":"pane disappeared"}}'), /pane disappeared/);
  assert.throws(() => herdrSnapshot('{"result":{"snapshot":{}}}'));
});

test('Herdr tabs keep workspace-qualified identities and only the current workspace is active', () => {
  const snapshot = herdrSnapshot(JSON.stringify({ result: { snapshot: { panes: [], focused_tab_id: 'w2:t1',
    workspaces: [{ workspace_id: 'w1', label: 'API' }, { workspace_id: 'w2', label: 'Web' }],
    tabs: [{ tab_id: 'w1:t1', workspace_id: 'w1', number: 1, label: 'shell', pane_count: 2, focused: true }, { tab_id: 'w2:t1', workspace_id: 'w2', number: 1, label: 'shell', pane_count: 1, focused: true }] } } }));
  assert.deepEqual(herdrWindows(snapshot), [
    { id: 'w1:t1', index: 1, name: 'API / shell', renameName: 'shell', panes: 2, active: false },
    { id: 'w2:t1', index: 1, name: 'Web / shell', renameName: 'shell', panes: 1, active: true }
  ]);
});

test('Herdr scopes tab operations and stop to one named session and disables unsupported actions', async () => {
  const calls: string[][] = [];
  const adapter = new Adapter('herdr', { executable: process.execPath }, async command => { calls.push(command.args); return { code: 0, stdout: command.args.includes('--version') ? 'herdr 0.9.5' : '{"result":{}}', stderr: '' }; });
  assert.equal(await adapter.probe(), true);
  assert.deepEqual(adapter.capabilities, { rename: false, kill: true, windows: true, detachAll: false });
  const session = { id: 'work', name: 'work' }, window = { id: 'w2:t7', index: 2, name: 'logs', active: false, panes: 1 };
  await adapter.windowAction('rename', session, window, 'new "label"');
  assert.deepEqual(calls.at(-1), ['--session', 'work', 'tab', 'rename', 'w2:t7', 'new "label"']);
  await adapter.windowAction('select', session, window);
  assert.deepEqual(calls.at(-1), ['--session', 'work', 'tab', 'focus', 'w2:t7']);
  await adapter.kill(session);
  assert.deepEqual(calls.at(-1), ['session', 'stop', 'work', '--json']);
  await assert.rejects(adapter.rename(session, 'other'));
  await assert.rejects(adapter.detachAll(session));
  assert.equal(calls.at(-1)?.[1], 'stop');
});

test('Herdr uses its actual name rules and rejects older unverified CLI versions', async () => {
  for (const name of ['项目', 'x'.repeat(65), '-option', '../file', 'with space']) assert.ok(validateHerdrName(name));
  for (const name of ['work', 'api.dev-1', '_job']) assert.equal(validateHerdrName(name), undefined);
  for (const [version, available] of [['0.9.4', false], ['0.9.5', true], ['0.10.0', true], ['1.0.0', true]] as const) {
    const adapter = new Adapter('herdr', { executable: process.execPath }, async () => ({ code: 0, stdout: `herdr ${version}`, stderr: '' }));
    assert.equal(await adapter.probe(), available);
  }
  const env = cleanEnvironment({ HERDR_ENV: '1', HERDR_SESSION: 'outer', HERDR_SOCKET_PATH: 'outer.sock', HERDR_CONFIG_PATH: 'custom.toml', APPDATA: 'data' });
  assert.equal(env.HERDR_ENV, undefined); assert.equal(env.HERDR_SESSION, undefined); assert.equal(env.HERDR_SOCKET_PATH, undefined);
  assert.equal(env.HERDR_CONFIG_PATH, 'custom.toml'); assert.equal(env.APPDATA, 'data');
});
