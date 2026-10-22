import test from 'node:test';
import assert from 'node:assert/strict';
import { Adapter } from '../src/adapters';
import { DETAIL_SEPARATOR as separator, sessionPath, timestamp, tmuxDetails, zmxRecords } from '../src/session-details';
import type { Command, WindowInfo } from '../src/model';

test('tmux details preserve names, Unicode paths and commands, with distinct server/pane PIDs', () => {
  const session = ['$7', 'dev|训练', '1792374522', '2', '2', '/tmp/working 目录', '321'].join(separator);
  const pane = ['%9', '@8', '2', 'log|api', '1', '0', '1', '456', '/tmp/当前 目录=a', 'python3', "python3 'my script.py'"].join(separator);
  const window: WindowInfo = { id: '@8', index: 2, name: 'log|api', active: true, panes: 1 };
  const details = tmuxDetails(`${session}\n`, `${pane}\n`, window);
  const value = (section: number, label: string) => details.sections[section].fields.find(field => field.label === label)?.value;
  assert.equal(details.title, 'Window 详情');
  assert.equal(value(0, '会话名称'), 'dev|训练');
  assert.equal(value(0, '服务端 PID'), 321);
  assert.equal(value(0, '会话创建时间'), new Date(1792374522000).toISOString());
  assert.equal(value(0, 'Window ID'), '@8');
  assert.equal(value(1, '进程 PID'), 456);
  assert.equal(value(1, '工作路径'), '/tmp/当前 目录=a');
  assert.equal(value(1, '正在执行'), 'python3');
  assert.equal(value(1, '启动命令'), "python3 'my script.py'");
  assert.throws(() => tmuxDetails('', ''), /会话已不存在/);
});

test('zmx metadata handles file URIs, leading indentation and missing/invalid timestamps', () => {
  const rows = zmxRecords('  name=a\tpid=23\tcreated=1792374522\tcwd=file://remote/tmp/%E7%9B%AE%E5%BD%95%20a=b\n  name=b\tdir=/tmp/other\n');
  assert.equal(rows.length, 2);
  assert.equal(sessionPath(rows[0].cwd), '/tmp/目录 a=b');
  assert.equal(sessionPath(rows[1].dir), '/tmp/other');
  assert.equal(timestamp('1792374522.123'), '2026-10-19T01:48:42.123Z');
  for (const value of [undefined, '', '-1', 'bad', 'Infinity', '1e20']) assert.equal(timestamp(value), undefined);
});

test('tmux window details query only the chosen window and explicitly request UTF-8', async () => {
  const calls: Command[] = [];
  const session = ['$2', 'dev', '1792374522', '1', '2', '/tmp', '123'].join(separator);
  const adapter = new Adapter('tmux', { executable: '/bin/echo', args: ['-S', '/tmp/custom.sock'] }, async command => {
    calls.push(command);
    return { code: 0, stderr: '', stdout: command.args.includes('display-message') ? session : '' };
  });
  await adapter.probe();
  await adapter.details({ id: '$2', name: 'dev' }, { id: '@4', index: 1, name: 'api', active: false, panes: 1 });
  for (const command of calls.slice(1)) {
    assert.deepEqual(command.args.slice(0, 3), ['-S', '/tmp/custom.sock', '-u']);
    assert.equal(command.args[command.args.indexOf('-t') + 1], '$2:@4');
    assert.ok(!command.args.includes('attach-session'));
  }
  assert.ok(!calls.at(-1)!.args.includes('-s'), 'A window query must not list all session panes');
});

test('disconnect-all targets one backend session and never invokes a kill command', async () => {
  const expected = {
    tmux: ['detach-client', '-s', '$2'],
    screen: ['-S', '123.dev', '-X', 'at', '%', 'detach'],
    zmx: ['detach'],
    shpool: ['detach', 'dev']
  };
  for (const id of ['tmux', 'screen', 'zmx', 'shpool'] as const) {
    const calls: Command[] = [];
    const adapter = new Adapter(id, { executable: '/bin/echo', args: ['custom-socket'] }, async command => {
      calls.push(command); return { code: 0, stdout: id === 'shpool' ? '{"sessions":[]}' : '', stderr: '' };
    });
    await adapter.probe();
    await adapter.detachAll({ id: id === 'tmux' ? '$2' : id === 'screen' ? '123.dev' : 'dev', name: 'dev' });
    assert.deepEqual(calls[1].args, ['custom-socket', ...expected[id]]);
    if (id === 'zmx') assert.deepEqual(calls[1].env, { ZMX_SESSION: 'dev' });
    assert.ok(!calls.some(command => command.args.some(arg => /kill|quit/.test(arg))));
  }
});
