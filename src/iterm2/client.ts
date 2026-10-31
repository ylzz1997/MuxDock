import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';
import net from 'node:net';
import WebSocket from 'ws';
import { checkStatus, decode, encode, messages, number, string, type Fields, type Wire } from './protocol';

const exec = promisify(execFile);
export interface NativeSession { id: string; tabId: string; windowId: string; title: string }
export class ITermClient extends EventEmitter {
  private socket?: WebSocket;
  private nextId = 1;
  private pending = new Map<number, { resolve: (wire: Wire) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  get connected() { return this.socket?.readyState === WebSocket.OPEN; }
  async connect(options: { socketPath?: string; cookie?: string; key?: string } = {}) {
    if (this.connected) return;
    const socketPath = options.socketPath || path.join(os.homedir(), 'Library/Application Support/iTerm2/private/socket');
    if (!existsSync(socketPath)) throw new Error('Enable “Python API” in iTerm2 Settings → General → Magic. No Python installation is needed.');
    let { cookie, key } = options;
    if (!cookie) {
      const { stdout } = await exec('/usr/bin/osascript', ['-e', 'tell application id "com.googlecode.iterm2" to request cookie and key for app named "MuxDock"'], { timeout: 30000 });
      [cookie, key] = stdout.trim().split(/\s+/);
    }
    if (!cookie || !key) throw new Error('iTerm2 did not grant MuxDock an API credential.');
    const ws = new WebSocket('ws://localhost/', 'api.iterm2.com', {
      createConnection: () => net.createConnection({ path: socketPath }), handshakeTimeout: 10000, maxPayload: 8 * 1024 * 1024,
      headers: { origin: 'ws://localhost/', 'x-iterm2-cookie': cookie, 'x-iterm2-key': key, 'x-iterm2-advisory-name': 'MuxDock', 'x-iterm2-library-version': 'node muxdock' }
    });
    this.socket = ws;
    ws.on('message', data => {
      try {
        const wire = decode(Buffer.from(data as Buffer));
        const id = number(wire, 1), entry = this.pending.get(id);
        if (process.env.MUXDOCK_API_TRACE) console.error('iTerm2 receive', id, [...wire.keys()]);
        if (entry) {
          clearTimeout(entry.timer); this.pending.delete(id);
          const error = string(wire, 2); if (error) entry.reject(new Error(error)); else entry.resolve(wire);
        } else if (wire.has(1000)) this.emit('notification', messages(wire, 1000)[0]);
      } catch (error) { this.emit('diagnostic', error); ws.close(1002, 'Invalid API message'); }
    });
    ws.on('close', () => {
      if (this.socket === ws) this.socket = undefined;
      for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('iTerm2 disconnected')); }
      this.pending.clear(); this.emit('disconnected');
    });
    ws.on('error', error => this.emit('diagnostic', error));
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { ws.terminate(); finish(new Error('iTerm2 connection timed out')); }, 10000);
      const opened = () => finish(), failed = (error: Error) => finish(error), closed = () => finish(new Error('iTerm2 closed the connection'));
      const finish = (error?: Error) => { clearTimeout(timer); ws.off('open', opened); ws.off('error', failed); ws.off('close', closed); error ? reject(error) : resolve(); };
      ws.once('open', opened); ws.once('error', failed); ws.once('close', closed);
    });
  }
  close() { this.socket?.close(); }
  async request(field: number, payload: Fields = {}): Promise<Wire> {
    if (!this.connected) throw new Error('iTerm2 is not connected');
    const id = this.nextId++;
    if (process.env.MUXDOCK_API_TRACE) console.error('iTerm2 send', id, field);
    const response = await new Promise<Wire>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id); reject(new Error(`iTerm2 request ${field} timed out`));
        // A half-open API socket must not leave the sidebar permanently stuck.
        this.socket?.terminate();
      }, 10000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket!.send(encode({ 1: id, [field]: payload }), error => {
        if (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
      });
    });
    const body = messages(response, field)[0];
    if (!body) throw new Error(`Missing iTerm2 response ${field}`);
    return body;
  }
  async registerTool(url: string, reveal = true) {
    checkStatus(await this.request(104, { 1: 'MuxDock', 2: 'com.muxdock.iterm2', 3: 1, 4: url, 5: reveal }), 'register sidebar');
  }
  async sessions(): Promise<NativeSession[]> {
    const result: NativeSession[] = [];
    for (const window of messages(await this.request(106), 1)) for (const tab of messages(window, 1)) {
      const add = (session: Wire) => result.push({ id: string(session, 1), title: string(session, 4), windowId: string(window, 2), tabId: string(tab, 2) });
      const walk = (node: Wire) => { for (const link of messages(node, 2)) { for (const session of messages(link, 1)) add(session); for (const child of messages(link, 2)) walk(child); } };
      for (const root of messages(tab, 3)) walk(root);
      for (const session of messages(tab, 6)) add(session);
    }
    return result;
  }
  async focus(): Promise<{ windowId?: string; sessionId?: string }> {
    let windowId: string | undefined, sessionId: string | undefined;
    const notifications = messages(await this.request(117), 1);
    for (const entry of notifications) for (const window of messages(entry, 2)) if (number(window, 1) !== 2) windowId = string(window, 2);
    // Several windows may each report an active session. Match the current window.
    const ids = new Set(notifications.map(entry => string(entry, 4)).filter(Boolean));
    if (ids.size) sessionId = (await this.sessions()).find(session => ids.has(session.id) && session.windowId === windowId)?.id;
    return { windowId, sessionId };
  }
  async create(command: string, cwd: string, name: string, windowId?: string): Promise<string> {
    // These managed clients may end immediately after a detach/kill. iTerm2's
    // per-session flag prevents its short-lived-command modal from blocking
    // the API; the user's ordinary terminal profiles are not modified.
    const properties = { 'Custom Command': 'Yes', Command: command, 'Custom Directory': 'Yes', 'Working Directory': cwd, Name: name, 'Close Sessions On End': true, 'Short-Lived Single Use': true };
    const payload: Fields = { 5: Object.entries(properties).map(([key, value]) => ({ 1: key, 2: JSON.stringify(value) })), 6: true };
    if (windowId) payload[2] = windowId;
    const response = await this.request(108, payload);
    checkStatus(response, 'create tab');
    const id = string(response, 4); if (!id) throw new Error('iTerm2 returned no session ID'); return id;
  }
  async activate(id: string) { checkStatus(await this.request(114, { 3: id, 4: true, 5: true, 6: true, 7: { 2: true } }), 'activate session'); }
  async closeSession(id: string) {
    const response = await this.request(131, { 2: { 1: [id] }, 4: true });
    if (number(response, 1) !== 0 && number(response, 1) !== 1) throw new Error('iTerm2 declined to close the session');
  }
  async variable(id: string, value?: string): Promise<string | undefined> {
    const response = await this.request(115, { 1: id, ...(value === undefined ? { 3: ['user.muxdock'] } : { 2: [{ 1: 'user.muxdock', 2: JSON.stringify(value) }] }) });
    checkStatus(response, 'session metadata');
    const json = string(response, 2); return json ? JSON.parse(json) ?? undefined : undefined;
  }
  async subscribe() {
    // New session, terminated session, layout changed, focus changed.
    for (const type of [6, 7, 8, 9]) checkStatus(await this.request(103, { 2: true, 3: type }), 'subscribe');
  }
}
