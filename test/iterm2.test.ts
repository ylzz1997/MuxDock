import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { decode, encode, messages, number, string } from '../src/iterm2/protocol';
import { ITermClient, type NativeSession } from '../src/iterm2/client';
import { parseDarwinArguments, processData, executableFor, sessionArgument } from '../src/iterm2/processes';
import { ITermService, terminalCommand } from '../src/iterm2/service';
import { MANAGER_IDS } from '../src/model';

const exec = promisify(execFile);
test('iTerm2 wire messages match independent protobuf fixtures and reject truncation', () => {
  assert.equal(encode({ 1: 1, 106: {} }).toString('hex'), '0801d20600');
  const decoded = decode(Buffer.from('0801d2060b0a09120777696e646f7731', 'hex'));
  assert.equal(number(decoded, 1), 1);
  assert.equal(string(messages(messages(decoded, 106)[0], 1)[0], 2), 'window1');
  for (const invalid of ['80', '0a04ff', '00', '0f', 'ffffffffffffffffffffff']) assert.throws(() => decode(Buffer.from(invalid, 'hex')));
});
test('macOS process argument parsing preserves spaces, quotes, empty arguments and only allowed environment', () => {
  const argc = Buffer.alloc(4); argc.writeInt32LE(4);
  const data = Buffer.concat([argc, Buffer.from("/bin/abduco\0\0abduco\0-a\0work ' 项目\0\0HOME=/tmp/home\0SECRET=hidden\0ZELLIJ_SOCKET_DIR=/tmp/sockets\0\0")]);
  const parsed = parseDarwinArguments(data);
  assert.deepEqual(parsed.argv, ['abduco', '-a', "work ' 项目", '']);
  assert.deepEqual(parsed.environment, { HOME: '/tmp/home', ZELLIJ_SOCKET_DIR: '/tmp/sockets' });
  assert.equal(sessionArgument('abduco', parsed.argv), "work ' 项目");
  assert.equal(sessionArgument('a4', ['a4', '-i', 'config path', '-a', 'target']), 'target');
  assert.equal(sessionArgument('zellij', ['zellij', '--server', 'socket']), undefined);
  assert.throws(() => parseDarwinArguments(Buffer.alloc(2)));
});
test('Node process inspection reads the current process without a Python subprocess', { skip: !['darwin', 'linux'].includes(process.platform) }, async () => {
  assert.equal(await executableFor(process.pid), await realpath(process.execPath));
  const data = await processData(process.pid);
  assert.ok(data?.argv.length);
  assert.equal(data.argv[0], process.argv0);
});
test('native terminal commands preserve literal argv and clear inherited multiplexer state', async () => {
  const args = ["space quote ' 项目", '$(echo INJECTED)', '`echo INJECTED`', 'a;b'];
  const command = terminalCommand({ file: process.execPath, args: ['-e', 'console.log(JSON.stringify({args:process.argv.slice(1),tmux:process.env.TMUX,custom:process.env.CUSTOM}))', ...args], env: { CUSTOM: "value ' $()" } });
  const { stdout } = await exec('/bin/sh', ['-c', command], { env: { ...process.env, TMUX: 'parent-session' } });
  assert.deepEqual(JSON.parse(stdout), { args, custom: "value ' $()" });
});
test('iTerm2 client correlates out-of-order replies and rejects pending requests on disconnect', async () => {
  const root = await mkdtemp('/tmp/md-api-'), socket = path.join(root, 'socket');
  const http = createServer(), ws = new WebSocketServer({ server: http });
  let native: WebSocket | undefined;
  ws.on('connection', (client, request) => {
    native = client;
    assert.equal(request.headers['x-iterm2-cookie'], 'test-cookie');
    client.on('message', data => {
      const wire = decode(Buffer.from(data as Buffer)), id = number(wire, 1);
      if (wire.has(104)) setTimeout(() => client.send(encode({ 1: id, 104: { 1: 0 } })), 20);
      if (wire.has(106)) client.send(encode({ 1: id, 106: { 1: [{ 2: 'window', 1: [{ 2: 'tab', 3: { 2: [{ 1: { 1: 'session', 4: 'title' } }] } }] }] } }));
    });
  });
  await new Promise<void>(resolve => http.listen(socket, resolve));
  const client = new ITermClient();
  try {
    await client.connect({ socketPath: socket, cookie: 'test-cookie', key: 'test-key' });
    const [_, sessions] = await Promise.all([client.registerTool('http://127.0.0.1/example/'), client.sessions()]);
    assert.deepEqual(sessions, [{ id: 'session', title: 'title', windowId: 'window', tabId: 'tab' }]);
    const pending = client.request(117); native!.close(); await assert.rejects(pending, /disconnected/);
  } finally { client.close(); for (const peer of ws.clients) peer.terminate(); ws.close(); await new Promise<void>(resolve => http.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
});

class FakeITerm extends ITermClient {
  entries: NativeSession[] = []; values = new Map<string, string>(); activated = ''; created = 0;
  get connected() { return true; }
  async connect() {} close() {} async registerTool() {} async subscribe() {}
  async sessions() { return this.entries; }
  async focus() { return { windowId: 'window', sessionId: this.activated }; }
  async create(_command: string, _cwd: string, name: string) { const id = `native-${++this.created}`; this.entries.push({ id, tabId: id, windowId: 'window', title: name }); this.emit('notification'); await new Promise(resolve => setTimeout(resolve, 40)); return id; }
  async activate(id: string) { this.activated = id; }
  async variable(id: string, value?: string) { if (value !== undefined) this.values.set(id, value); const result = this.values.get(id); if (value === undefined) await new Promise(resolve => setTimeout(resolve, 150)); return result; }
  async closeSession(id: string) { this.entries = this.entries.filter(item => item.id !== id); }
}
test('sidebar server authenticates requests, reuses native tabs and cancels destructive dialogs', async () => {
  const root = await mkdtemp('/tmp/md-service-'), fixture = path.join(root, 'tmux');
  await writeFile(fixture, `#!${process.execPath}\nconst fs=require('fs');const a=process.argv.slice(2);if(a.includes('-V'))console.log('tmux 3.5');else if(a.includes('list-sessions'))console.log('$1|1|test-session');else if(a.includes('list-windows'))console.log('$1|@1|0|shell|1|1');else if(a.includes('kill-session'))fs.writeFileSync(${JSON.stringify(path.join(root, 'killed'))},'yes');\n`, { mode: 0o755 });
  const config = { port: 0, language: 'en', executables: Object.fromEntries(MANAGER_IDS.map(id => [id, id === 'tmux' ? fixture : '/does/not/exist'])) };
  await writeFile(path.join(root, 'config.json'), JSON.stringify(config));
  const native = new FakeITerm(), service = new ITermService(root, path.resolve('artifacts/iterm2/dist'), native);
  let browser: WebSocket | undefined;
  try {
    await service.start();
    const saved = JSON.parse(await readFile(path.join(root, 'config.json'), 'utf8')), origin = `http://127.0.0.1:${service.port}`, url = `${origin}/${saved.token}/`;
    assert.equal((await fetch(origin)).status, 404);
    assert.equal((await fetch(url)).status, 200);
    const rejected = new WebSocket(url.replace('http:', 'ws:') + 'socket', { origin: 'https://untrusted.example' });
    await assert.rejects(new Promise((resolve, reject) => { rejected.on('open', resolve); rejected.on('error', reject); }), /403/);
    browser = new WebSocket(url.replace('http:', 'ws:') + 'socket', { origin });
    await new Promise<void>((resolve, reject) => { browser!.on('open', resolve); browser!.on('error', reject); });
    const received: any[] = []; browser.on('message', data => received.push(JSON.parse(data.toString())));
    const wait = async (predicate: () => boolean) => { const start = Date.now(); while (!predicate()) { if (Date.now() - start > 10000) throw new Error('sidebar timeout'); await new Promise(resolve => setTimeout(resolve, 20)); } };
    const send = (value: object) => browser!.send(JSON.stringify(value));
    send({ type: 'attach', manager: 'tmux', session: '$1' }); await wait(() => service.snapshot().connections.length === 1);
    send({ type: 'attach', manager: 'tmux', session: '$1' }); await wait(() => native.activated === 'native-1');
    send({ type: 'kill', manager: 'tmux', session: '$1' }); await wait(() => received.some(item => item.type === 'dialog'));
    const dialog = received.find(item => item.type === 'dialog'); send({ type: 'dialogResult', id: dialog.id });
    send({ type: 'refresh' }); await wait(() => received.some(item => item.type === 'snapshot'));
    assert.equal(native.created, 1);
    await assert.rejects(readFile(path.join(root, 'killed')));
    send({ type: 'disconnect', key: 'native-1' }); await wait(() => service.snapshot().connections.length === 0);
    assert.equal(service.snapshot().managers.find(item => item.id === 'tmux')?.sessions.length, 1);
  } finally { browser?.terminate(); await service.stop(); await rm(root, { recursive: true, force: true }); }
});
