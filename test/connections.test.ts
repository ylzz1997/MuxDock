import test from 'node:test';
import assert from 'node:assert/strict';
import { Connections } from '../src/connections';

test('exited terminals retain their output and can be replaced by reconnecting', { timeout: 10000 }, async () => {
  const connections = new Connections();
  try {
    const exited = new Promise<void>(resolve => connections.once('exit', () => resolve()));
    const first = connections.connect('tmux', { id: '$1', name: 'work' }, { file: '/bin/sh', args: ['-c', "printf 'RETAINED_OUTPUT\\n'"] }, '/tmp');
    await exited;
    assert.equal(connections.list()[0].closed, true);
    assert.equal(connections.activeKey, first.key);
    assert.match(connections.replay(first.key)!.data, /RETAINED_OUTPUT/);
    connections.setDeliveryEnabled(true);
    connections.input(first.key, 'ignored');
    connections.resize(first.key, 80, 24);
    const reopened = connections.connect('tmux', { id: '$1', name: 'work' }, { file: '/bin/sh', args: [] }, '/tmp');
    assert.notEqual(reopened.key, first.key);
    assert.equal(connections.list().length, 1);
    assert.equal(connections.list()[0].closed, false);
    assert.equal(connections.replay(first.key), undefined);
  } finally { connections.dispose(); }
});

test('closing an inactive tab preserves selection; closing an active tab selects its neighbor', () => {
  const connections = new Connections();
  try {
    const create = (name: string) => connections.connect('zmx', { id: name, name }, { file: '/bin/sh', args: [] }, '/tmp');
    const first = create('first'); const middle = create('middle'); const last = create('last');
    connections.select(middle.key);
    connections.disconnect(first.key);
    assert.equal(connections.activeKey, middle.key);
    connections.disconnect(middle.key);
    assert.equal(connections.activeKey, last.key);
    connections.disconnect(last.key);
    assert.equal(connections.activeKey, undefined);
    assert.deepEqual(connections.list(), []);
  } finally { connections.dispose(); }
});

test('disconnect can retain a closed tab without allowing terminal input', () => {
  const connections = new Connections();
  try {
    const tab = connections.connect('screen', { id: 'test', name: 'test' }, { file: '/bin/sh', args: [] }, '/tmp');
    connections.disconnect(tab.key, true);
    assert.equal(connections.activeKey, tab.key);
    assert.equal(connections.list()[0].closed, true);
    connections.disconnect(tab.key);
    assert.deepEqual(connections.list(), []);
  } finally { connections.dispose(); }
});

test('ending a session removes only its matching manager and session, then selects a remaining tab', () => {
  const connections = new Connections();
  try {
    const create = (manager: 'tmux' | 'zmx', id: string) => connections.connect(manager, { id, name: 'shared' }, { file: '/bin/sh', args: [] }, '/tmp');
    const target = create('tmux', '$1');
    const otherManager = create('zmx', '$1');
    const otherSession = connections.connect('tmux', { id: '$2', name: 'other' }, { file: '/bin/sh', args: [] }, '/tmp');
    connections.select(target.key);
    connections.closeSession('tmux', '$1');
    assert.deepEqual(connections.list().map(item => item.key), [otherManager.key, otherSession.key]);
    assert.equal(connections.activeKey, otherManager.key);
    assert.equal(connections.replay(target.key), undefined);
    connections.closeSession('tmux', '$2');
    assert.equal(connections.activeKey, otherManager.key);
  } finally { connections.dispose(); }
});

test('ending a session also removes its retained closed tab and clears the last active terminal', () => {
  const connections = new Connections();
  try {
    const tab = connections.connect('screen', { id: '123.work', name: 'work' }, { file: '/bin/sh', args: [] }, '/tmp');
    connections.disconnect(tab.key, true);
    connections.closeSession('screen', '123.work');
    assert.deepEqual(connections.list(), []);
    assert.equal(connections.activeKey, undefined);
  } finally { connections.dispose(); }
});

test('intentional closes still report the actual client exit without reporting an unexpected exit', { timeout: 10000 }, async () => {
  const connections = new Connections();
  const unexpected: unknown[] = [];
  connections.on('exit', event => unexpected.push(event));
  try {
    for (const keepTab of [false, true]) {
      const tab = connections.connect('tmux', { id: '$1', name: 'work' }, { file: '/bin/sh', args: [] }, '/tmp');
      const exited = new Promise<string>(resolve => connections.once('clientExit', ({ key }) => resolve(key)));
      connections.disconnect(tab.key, keepTab);
      assert.equal(await exited, tab.key);
      assert.deepEqual(unexpected, []);
      assert.equal(connections.list().length, keepTab ? 1 : 0);
      if (keepTab) assert.equal(connections.list()[0].closed, true);
    }
  } finally { connections.dispose(); }
});
