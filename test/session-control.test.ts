import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { detachZellijClients } from '../src/session-control';

test('Zellij detach sends an explicit client ID list using the versioned native contract', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'md-wire-'));
  const directory = path.join(root, 'contract_version_1'); await mkdir(directory);
  const socketPath = path.join(directory, 'session');
  const address = process.platform === 'win32' ? `\\\\.\\pipe\\${socketPath}` : socketPath;
  const clients = new Set<net.Socket>();
  let replies = 0;
  const reply = process.platform === 'win32' ? net.createServer(socket => { replies++; clients.add(socket); socket.on('data', () => {}); }) : undefined;
  let receive!: (value: Buffer) => void;
  const received = new Promise<Buffer>(resolve => { receive = resolve; });
  const server = net.createServer(socket => {
    clients.add(socket);
    const chunks: Buffer[] = [];
    socket.on('data', chunk => { chunks.push(chunk); const frame = Buffer.concat(chunks); if (frame.length >= 4 && frame.length === frame.readUInt32LE(0) + 4) receive(frame); });
    socket.on('end', () => socket.end());
  });
  try {
    await new Promise<void>(resolve => server.listen(address, resolve));
    if (reply) await new Promise<void>(resolve => reply.listen(`${address}-reply`, resolve));
    await detachZellijClients(socketPath, [1, 127, 128, 65535]);
    const frame = await received;
    assert.equal(frame.readUInt32LE(0), frame.length - 4);
    assert.deepEqual([...frame.subarray(4)], [10, 9, 10, 7, 1, 127, 128, 1, 255, 255, 3]);
    await assert.rejects(detachZellijClients('/tmp/contract_version_2/session', [1]), /Unsupported/);
    await assert.rejects(detachZellijClients(socketPath, [-1]), /Invalid/);
    if (reply) assert.equal(replies, 1);
  } finally {
    for (const socket of clients) socket.destroy();
    if (reply) await new Promise<void>(resolve => reply.close(() => resolve()));
    await new Promise<void>(resolve => server.close(() => resolve()));
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await rm(root, { recursive: true, force: true });
  }
});
