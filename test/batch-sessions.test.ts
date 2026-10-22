import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSessionBatch, runSessionBatch } from '../src/batch-sessions';

test('batch requests validate every target before any operation and deduplicate only within a manager', () => {
  const targets = [{ manager: 'tmux', session: 'same' }, { manager: 'zmx', session: 'same' }, { manager: 'tmux', session: 'same' }];
  assert.deepEqual(parseSessionBatch({ action: 'disconnect', targets }).targets, targets.slice(0, 2));
  for (const value of [
    { action: 'other', targets }, { action: 'kill', targets: [] },
    { action: 'kill', targets: [...targets, { manager: 'invalid', session: 'x' }] },
    { action: 'disconnect', targets: [null] }, { action: 'disconnect', targets: [{ manager: 'tmux', session: 7 }] }
  ]) assert.throws(() => parseSessionBatch(value));
});

test('batch failure does not stop later sessions and reports exactly which targets succeeded', async () => {
  const { targets } = parseSessionBatch({ action: 'kill', targets: [
    { manager: 'tmux', session: '$1' }, { manager: 'zmx', session: 'gone' }, { manager: 'tmux', session: '$3' }
  ] });
  const calls: string[] = [];
  const result = await runSessionBatch(targets, async target => {
    calls.push(`${target.manager}/${target.session}`);
    if (target.session === 'gone') throw new Error('会话已不存在');
  });
  assert.deepEqual(calls, ['tmux/$1', 'zmx/gone', 'tmux/$3']);
  assert.deepEqual(result.succeeded, [targets[0], targets[2]]);
  assert.deepEqual(result.failed, [{ target: targets[1], error: '会话已不存在' }]);
});
