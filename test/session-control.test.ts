import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { detachZellijClients } from '../src/session-control';

test('Zellij detach sends an explicit client ID list using the versioned native contract', async () => {
  const root = await mkdtemp('/tmp/md-wire-');
  const directory = `${root}/contract_version_1`; await mkdir(directory);
  const address = `${directory}/session`;
  let receive!: (value: Buffer) => void;
  const received = new Promise<Buffer>(resolve => { receive = resolve; });
  const server = net.createServer(socket => {
    const chunks: Buffer[] = [];
    socket.on('data', chunk => chunks.push(chunk)); socket.on('end', () => { receive(Buffer.concat(chunks)); socket.end(); });
  });
  try {
    await new Promise<void>(resolve => server.listen(address, resolve));
    await detachZellijClients(address, [1, 127, 128, 65535]);
    const frame = await received;
    assert.equal(frame.readUInt32LE(0), frame.length - 4);
    assert.deepEqual([...frame.subarray(4)], [10, 9, 10, 7, 1, 127, 128, 1, 255, 255, 3]);
    await assert.rejects(detachZellijClients('/tmp/contract_version_2/session', [1]), /不支持/);
    await assert.rejects(detachZellijClients(address, [-1]), /无效/);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
