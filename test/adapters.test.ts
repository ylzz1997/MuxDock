import test from 'node:test';
import assert from 'node:assert/strict';
import { Adapter, parseAbduco, parseA4, parseScreen, parseShpool, parseTmuxSessions, parseTmuxWindows, parseZellij, parseZmx } from '../src/adapters';
import { cleanEnvironment } from '../src/runner';
import { validateName } from '../src/model';

test('tmux session IDs survive names and multiple attached clients', () => {
  assert.deepEqual(parseTmuxSessions('$0|2|dev project\n$2|0|训练\n'), [
    { id: '$0', name: 'dev project', attached: 2, windows: [] }, { id: '$2', name: '训练', attached: 0, windows: [] }
  ]);
});
test('tmux linked windows retain the session context and stable window IDs', () => {
  const windows = parseTmuxWindows('$0|@1|0|1|2|api\n$1|@1|4|0|2|api\n$0|@3|1|0|1|logs\n');
  assert.equal(windows.get('$0')?.length, 2);
  assert.equal(windows.get('$1')?.[0].index, 4);
  assert.equal(windows.get('$0')?.[0].active, true);
});
test('tmux printable format delimiters preserve pipes inside session and window names', () => {
  assert.equal(parseTmuxSessions('$0|1|dev|team\n')[0].name, 'dev|team');
  assert.equal(parseTmuxWindows('$0|@1|0|1|2|logs|api\n').get('$0')![0].name, 'logs|api');
});
test('zmx key-value output preserves directories with spaces and equals signs', () => {
  assert.deepEqual(parseZmx('name=dev\tpid=123\tclients=2\tcreated=456\tdir=/tmp/my project=a\n'), [{ id: 'dev', name: 'dev', attached: 2, detail: '/tmp/my project=a' }]);
  assert.deepEqual(parseZmx(''), []);
});
test('zmx keeps every indented row when listing multiple sessions', () => {
  const output = '  name=0\tpid=43776\tclients=0\tcreated=1792374522\tcwd=file://host/Users/test/MuxDock\n'
    + '  name=1\tpid=43843\tclients=2\tcreated=1792374525\tcwd=file://host/Users/test\n';
  assert.deepEqual(parseZmx(output).map(({ id, name, attached }) => ({ id, name, attached })), [
    { id: '0', name: '0', attached: 0 }, { id: '1', name: '1', attached: 2 }
  ]);
  assert.deepEqual(parseZmx(`\n${output}\n`).map(session => session.name), ['0', '1']);
});
test('screen supports macOS legacy and current GNU output; dead sockets are ignored', () => {
  const sessions = parseScreen('There are screens on:\n\t123.dev\t(Attached)\n\t456.train.more\t(10/19/2026 01:00:00 AM)\t(Detached)\n\t789.stale\t(Dead ???)\n');
  assert.deepEqual(sessions, [{ id: '123.dev', name: 'dev', attached: 1 }, { id: '456.train.more', name: 'train.more', attached: 0 }]);
  assert.equal(parseScreen('\t123.my project\t(Attached)\n')[0].name, 'my project');
});
test('Zellij strips styling and excludes resurrectable exited sessions', () => {
  assert.deepEqual(parseZellij('\x1b[32mdev\x1b[0m [Created 2h ago] (current)\ntraining [Created 1d ago]\nold [Created 1d ago] (EXITED - attach to resurrect)\n'), [{ id: 'dev', name: 'dev' }, { id: 'training', name: 'training' }]);
});
test('shpool accepts the documented list reply and validates unexpected JSON', () => {
  assert.deepEqual(parseShpool('{"sessions":[{"name":"dev","status":"Attached"},{"name":"train","status":"Disconnected"}]}'), [{ id: 'dev', name: 'dev', attached: 1 }, { id: 'train', name: 'train', attached: 0 }]);
  assert.throws(() => parseShpool('{"error":"unavailable"}'));
});
test('abduco accepts both 0.6 and newer PID columns and skips terminated sessions', () => {
  assert.deepEqual(parseAbduco('Active sessions (on host test)\n* Mon\t 2026-10-19 01:00:00\tdev\n  Mon\t 2026-10-19 01:00:00\t1234\ttrain\n+ Mon\t 2026-10-19 01:00:00\tfinished\n'), [{ id: 'dev', name: 'dev', attached: 1 }, { id: 'train', name: 'train', attached: 0 }]);
});
test('a4 parses named persistent sessions without listing its header as a session', () => {
  assert.deepEqual(parseA4('Active sessions in /tmp/a4:\n  2026-10-19 01:00:00\t1234\tdev\n  (no active sessions)\n'), [{ id: 'dev', name: 'dev' }]);
});
test('new session names reject shell operators, control characters and leading options', () => {
  for (const name of ['', '-help', 'a; echo oops', 'a\nb', '../dir', 'x:y', '$(id)']) assert.ok(validateName(name), name);
  for (const name of ['dev', '训练', 'my_project-2']) assert.equal(validateName(name), undefined);
});
test('client environment does not inherit an existing mux attachment', () => {
  const env = cleanEnvironment({ TMUX: 'socket', STY: '123.dev', ZMX_SESSION: 'dev', ZMX_SESSION_PREFIX: 'prefix.', ZELLIJ: '1', ZELLIJ_SESSION_NAME: 'dev', PATH: '/bin', SSH_AUTH_SOCK: '/tmp/ssh' });
  for (const key of ['TMUX', 'STY', 'ZMX_SESSION', 'ZMX_SESSION_PREFIX', 'ZELLIJ', 'ZELLIJ_SESSION_NAME']) assert.equal(env[key], undefined);
  assert.equal(env.SSH_AUTH_SOCK, '/tmp/ssh'); assert.equal(env.TERM, 'xterm-256color');
});
test('unsupported operations are not advertised as working capabilities', () => {
  for (const id of ['abduco', 'a4'] as const) assert.deepEqual(new Adapter(id).capabilities, { kill: false, rename: false, windows: false, detachAll: true });
  assert.deepEqual(new Adapter('tmux').capabilities, { kill: true, rename: true, windows: true, detachAll: true });
});
test('command arguments cannot become shell syntax and preserve custom socket selection', async () => {
  const calls: string[][] = [];
  const adapter = new Adapter('tmux', { executable: '/bin/echo', args: ['-L', 'isolated'] }, async command => { calls.push(command.args); return { code: 0, stdout: '', stderr: '' }; });
  await adapter.probe();
  assert.deepEqual(adapter.attach({ id: '$1', name: '$(touch /tmp/unwanted)' }).args, ['-L', 'isolated', 'attach-session', '-t', '$1']);
  await adapter.windowAction('select', { id: '$1', name: 'dev' }, { id: '@7', index: 2, name: 'api', active: false, panes: 1 });
  assert.deepEqual(calls.at(-1), ['-L', 'isolated', 'select-window', '-t', '$1:@7']);
});
test('a failed backend reports its error instead of looking like an empty manager', async () => {
  const adapter = new Adapter('tmux', { executable: '/bin/echo' }, async command => command.args.includes('list-sessions') ? { code: 1, stdout: '', stderr: 'permission denied' } : { code: 0, stdout: 'tmux test', stderr: '' });
  const result = await adapter.list();
  assert.equal(result.available, true); assert.match(result.error!, /permission denied/);
});

test('tmux clients advertise supported hyperlinks and colors without changing server options', async () => {
  for (const [version, features] of [['3.4', 'RGB,hyperlinks,osc7'], ['3.2a', 'RGB'], ['3.1c', undefined], ['next-3.6', 'RGB,hyperlinks,osc7']] as const) {
    const adapter = new Adapter('tmux', { executable: '/bin/echo', args: ['-L', 'isolated'] }, async () => ({ code: 0, stdout: `tmux ${version}`, stderr: '' }));
    await adapter.probe();
    const prefix = features ? ['-L', 'isolated', '-T', features] : ['-L', 'isolated'];
    assert.deepEqual(adapter.attach({ id: '$1', name: 'dev' }).args, [...prefix, 'attach-session', '-t', '$1']);
    assert.deepEqual(adapter.create('dev', '/bin/sh').args, [...prefix, 'new-session', '-s', 'dev', '/bin/sh', '-l']);
    assert.deepEqual(adapter.command(['list-sessions']).args, ['-L', 'isolated', 'list-sessions']);
  }
});
