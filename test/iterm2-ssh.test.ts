import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { WebSocket } from 'ws';
import { run, type Runner } from '../src/runner';
import type { Command } from '../src/model';
import { MANAGER_IDS } from '../src/model';
import { SshTransport, sshHostId, validSshTarget, remoteDirectory } from '../src/iterm2/ssh';
import { ITermService } from '../src/iterm2/service';
import { ITermClient, type NativeSession } from '../src/iterm2/client';

test('SSH destinations reject flags and shell input; remote argv and framed output stay literal', async () => {
  for (const value of ['server', 'user@server.example', '[::1]', 'user@[2001:db8::1]', '测试环境', 'user@火山引擎']) assert.ok(validSshTarget(value));
  for (const value of ['', '-oProxyCommand=bad', 'ssh server', 'server;whoami', 'server\ncommand', 'a$(id)', 'a`id`', 'host/command']) assert.equal(validSshTarget(value), false);
  const requests: Command[] = [];
  const execute: Runner = async command => {
    requests.push(command);
    const result = await run({ file: '/bin/sh', args: ['-c', command.args.at(-1)!] });
    return { ...result, stdout: `login banner\n${result.stdout}logout banner\n` };
  };
  const ssh = new SshTransport('qa-host', '/tmp/md-ssh-test', execute);
  const args = ['space quote \' 字符', '$(echo INJECTED)', '`echo INJECTED`', 'a;b', 'line\nbreak', ''];
  const result = await ssh.run({ file: process.execPath, args: ['-e', 'console.log(JSON.stringify(process.argv.slice(1)))', ...args] });
  assert.equal(result.code, 0); assert.deepEqual(JSON.parse(result.stdout), args);
  assert.ok(requests[0].args.includes('BatchMode=yes')); assert.ok(requests[0].args.includes('StrictHostKeyChecking=yes'));
  assert.equal(requests[0].file, '/usr/bin/ssh'); assert.ok(requests[0].args.includes('qa-host'));
  assert.equal((await ssh.script('printf failed; exit 23')).code, 23);
  const terminal = ssh.terminal({ file: '/bin/echo', args: ['literal;value'] }, '~/path with spaces');
  assert.ok(terminal.args.includes('-tt')); assert.ok(!terminal.args.includes('BatchMode=yes'));
  assert.equal((await ssh.script(`${remoteDirectory('~')}; printf '%s' "$PWD"`)).code, 0);
  const unavailable = new SshTransport('unavailable', '/tmp/md-ssh-test', async () => ({ code: 255, stdout: '', stderr: 'Permission denied' }));
  await assert.rejects(unavailable.info(), /Permission denied/); assert.equal(unavailable.failure, 'Permission denied');
});

class Native extends ITermClient {
  entries: NativeSession[] = [{ id: 'local-tab', tabId: 'local', windowId: 'window', title: 'local' }, { id: 'remote-tab', tabId: 'remote', windowId: 'window', title: 'remote' }];
  values = new Map([['local-tab', JSON.stringify({ manager: 'tmux', sessionId: '$1', name: 'same' })], ['remote-tab', JSON.stringify({ manager: 'tmux', sessionId: '$1', name: 'same', hostId: sshHostId('qa-host') })]]);
  activated = ''; created: string[] = [];
  get connected() { return true; }
  async connect() {} close() {} async registerTool() {} async subscribe() {}
  async sessions() { return this.entries; } async focus() { return { windowId: 'window', sessionId: this.activated }; }
  async variable(id: string, value?: string) { if (value !== undefined) this.values.set(id, value); return this.values.get(id); }
  async activate(id: string) { this.activated = id; }
  async create(command: string) { const id = `created-${this.created.length}`; this.created.push(command); this.entries.push({ id, tabId: id, windowId: 'window', title: 'test' }); return id; }
}
class Remote extends SshTransport {
  calls: Command[] = []; offline = false; delay = 0;
  async info() { if (this.offline) throw new Error('offline'); return { home: '/remote/home', shell: '/bin/bash', platform: 'linux' as const }; }
  async executable(name: string) { return name === 'tmux' ? '/remote/tmux' : undefined; }
  run: Runner = async command => {
    this.calls.push(command);
    if (this.offline) { this.failure = 'offline'; throw new Error('offline'); }
    if (this.delay && command.args.includes('list-sessions')) await new Promise(resolve => setTimeout(resolve, this.delay));
    const stdout = command.args.includes('-V') ? 'tmux 3.5' : command.args.includes('list-sessions') ? '$1|7|same' : command.args.includes('list-windows') ? '$1|@2|0|1|1|remote' : '';
    return { code: 0, stdout, stderr: '' };
  };
  terminal(command: Command, directory: string) { return { file: '/usr/bin/ssh', args: [this.target, directory, command.file, ...command.args] }; }
}
test('host switches isolate identical session IDs, reject stale actions and recover without local fallback', async () => {
  const root = await mkdtemp('/tmp/md-host-'), fixture = path.join(root, 'tmux');
  await writeFile(fixture, `#!${process.execPath}\nconst a=process.argv.slice(2);if(a.includes('-V'))console.log('tmux 3.5');else if(a.includes('list-sessions'))setTimeout(()=>console.log('$1|1|same'),100);else if(a.includes('list-windows'))console.log('$1|@1|0|1|1|local');\n`, { mode: 0o755 });
  await writeFile(path.join(root, 'config.json'), JSON.stringify({ language: 'en', executables: Object.fromEntries(MANAGER_IDS.map(id => [id, id === 'tmux' ? fixture : '/missing'])), sshHosts: [{ target: 'qa-host', defaultDirectory: '~' }] }));
  const native = new Native(), remote = new Remote('qa-host', root), service = new ITermService(root, path.resolve('artifacts/iterm2/dist'), native, () => remote, async () => []);
  let browser: WebSocket | undefined;
  try {
    await service.start(0);
    assert.deepEqual(service.snapshot().connections.map(item => item.key), ['local-tab']);
    const config = JSON.parse(await readFile(path.join(root, 'config.json'), 'utf8')), origin = `http://127.0.0.1:${service.port}`;
    browser = new WebSocket(`${origin.replace('http:', 'ws:')}/${config.token}/socket`, { origin });
    await new Promise<void>((resolve, reject) => { browser!.once('open', resolve); browser!.once('error', reject); });
    const messages: any[] = []; browser.on('message', value => messages.push(JSON.parse(value.toString())));
    const send = (message: object) => browser!.send(JSON.stringify(message));
    const wait = async (fn: () => boolean) => { const end = Date.now() + 10000; while (!fn()) { if (Date.now() > end) throw new Error('Host switch timeout'); await new Promise(resolve => setTimeout(resolve, 10)); } };
    const oldRefresh = service.refresh();
    send({ type: 'selectHost', hostId: 'local', id: sshHostId('qa-host') });
    await wait(() => service.snapshot().connections[0]?.key === 'remote-tab'); await oldRefresh;
    assert.equal(service.snapshot().managers[0].sessions[0].attached, 7);
    for (const item of messages.filter(item => item.type === 'snapshot' && item.state.selectedHost !== 'local')) assert.ok(item.state.connections.every((connection: { key: string }) => connection.key !== 'local-tab'));
    send({ type: 'kill', hostId: 'local', manager: 'tmux', session: '$1' }); await wait(() => messages.some(item => item.type === 'error' && /host changed/i.test(item.message)));
    assert.ok(!remote.calls.some(command => command.args.includes('kill-session')));
    send({ type: 'attach', hostId: sshHostId('qa-host'), manager: 'tmux', session: '$1' }); await wait(() => native.activated === 'remote-tab'); assert.equal(native.created.length, 0);
    native.entries = native.entries.filter(item => item.id !== 'remote-tab'); await service.refresh();
    send({ type: 'attach', hostId: sshHostId('qa-host'), manager: 'tmux', session: '$1' }); await wait(() => native.created.length === 1);
    const launcher = await readFile(native.created[0].slice('/bin/sh '.length + 1, -1), 'utf8');
    assert.match(launcher, /qa-host/); assert.match(launcher, /remote\/tmux/);
    await wait(() => !!native.values.get('created-0'));
    assert.equal(JSON.parse(native.values.get('created-0')!).hostId, sshHostId('qa-host'));
    remote.offline = true; await service.refresh(true);
    assert.equal(service.snapshot().hostError, 'offline'); assert.deepEqual(service.snapshot().managers, []); assert.equal(service.snapshot().selectedHost, sshHostId('qa-host'));
    send({ type: 'selectHost', hostId: sshHostId('qa-host'), id: 'local' }); await wait(() => service.snapshot().connections[0]?.key === 'local-tab');
    assert.equal(service.snapshot().hostError, undefined); assert.equal(service.snapshot().managers[0].sessions[0].attached, 1);
  } finally { browser?.terminate(); await service.stop(); await rm(root, { recursive: true, force: true }); }
});

test('SSH refresh slower than the polling interval completes instead of starving actions', async () => {
  const root = await mkdtemp('/tmp/md-slow-host-');
  await writeFile(path.join(root, 'config.json'), JSON.stringify({ language: 'en', selectedHost: sshHostId('qa-host'), sshHosts: [{ target: 'qa-host' }] }));
  const remote = new Remote('qa-host', root); remote.delay = 3200;
  const service = new ITermService(root, path.resolve('artifacts/iterm2/dist'), new Native(), () => remote, async () => []);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([service.start(0), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Refresh did not finish')), 7000); })]);
    assert.equal(remote.calls.filter(command => command.args.includes('list-sessions')).length, 1);
    assert.equal(service.snapshot().managers[0].sessions[0].name, 'same');
  } finally { clearTimeout(timer); await service.stop(); await rm(root, { recursive: true, force: true }); }
});

test('discovered SSH hosts merge with manual entries, refresh without connecting and preserve selected host settings', async () => {
  const root = await mkdtemp('/tmp/md-discovered-host-');
  const configFile = path.join(root, 'config.json');
  await writeFile(configFile, JSON.stringify({ language: 'en', executables: Object.fromEntries(MANAGER_IDS.map(id => [id, '/missing'])), sshHosts: [{ target: 'qa-host', defaultDirectory: '/saved' }, { target: 'manual-only' }] }));
  let candidates = ['qa-host', '测试环境'].map(target => ({ target, source: '/fixture/.ssh/config' }));
  const created: string[] = [], native = new Native();
  const service = new ITermService(root, path.resolve('artifacts/iterm2/dist'), native, (target, directory) => { created.push(target); return new Remote(target, directory); }, async () => candidates);
  let browser: WebSocket | undefined;
  const messages: any[] = [];
  const wait = async (fn: () => boolean) => { const end = Date.now() + 10000; while (!fn()) { if (Date.now() > end) throw new Error('Discovery test timeout'); await new Promise(resolve => setTimeout(resolve, 10)); } };
  try {
    await service.start(0);
    assert.deepEqual(created, []);
    assert.deepEqual(service.snapshot().hosts?.map(host => [host.id, host.removable]), [['local', false], ['ssh:qa-host', false], ['ssh:测试环境', false], ['ssh:manual-only', true]]);
    const config = JSON.parse(await readFile(configFile, 'utf8')), origin = `http://127.0.0.1:${service.port}`;
    browser = new WebSocket(`${origin.replace('http:', 'ws:')}/${config.token}/socket`, { origin });
    browser.on('message', value => messages.push(JSON.parse(value.toString())));
    await new Promise<void>((resolve, reject) => { browser!.once('open', resolve); browser!.once('error', reject); });
    const send = (message: object) => browser!.send(JSON.stringify({ hostId: service.snapshot().selectedHost, ...message }));
    candidates = [...candidates, { target: 'new-config-host', source: '/fixture/.ssh/include' }];
    send({ type: 'refreshHosts' });
    await wait(() => messages.some(m => m.type === 'snapshot' && m.state.hosts.some((host: { id: string }) => host.id === 'ssh:new-config-host')));
    assert.deepEqual(created, []);
    send({ type: 'removeSshHost', id: 'ssh:qa-host' });
    send({ type: 'selectHost', id: 'ssh:测试环境' });
    await wait(() => service.snapshot().selectedHost === 'ssh:测试环境' && service.snapshot().managers.length > 0);
    assert.deepEqual(created, ['测试环境']);
    const saved = JSON.parse(await readFile(configFile, 'utf8'));
    assert.equal(saved.sshHosts.find((host: { target: string }) => host.target === 'qa-host').defaultDirectory, '/saved');
    assert.equal(saved.sshHosts.find((host: { target: string }) => host.target === '测试环境').source, 'sshConfig');
    assert.equal(saved.sshHosts.find((host: { target: string }) => host.target === '测试环境').defaultDirectory, '~');
    assert.ok(!messages.some(m => m.type === 'dialog'));
    candidates = candidates.filter(host => host.target !== '测试环境');
    send({ type: 'refreshHosts' });
    await wait(() => service.snapshot().hosts?.find(host => host.id === 'ssh:测试环境')?.source === undefined);
    assert.equal(service.snapshot().selectedHost, 'ssh:测试环境');
    send({ type: 'selectHost', id: 'local' });
    await wait(() => service.snapshot().selectedHost === 'local');
    assert.ok(!service.snapshot().hosts?.some(host => host.id === 'ssh:测试环境'));
    assert.deepEqual(created, ['测试环境']);
    assert.equal(native.entries.length, 2); // discovery/switching never closes native terminals
    assert.equal(native.created.length, 0);
  } finally { browser?.terminate(); await service.stop(); await rm(root, { recursive: true, force: true }); }
});
