import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { spawnPty, type PtyProcess } from './pty';
import { cleanEnvironment } from './runner';
import type { Command, ConnectionInfo, ManagerId, ManagerInfo, SessionInfo } from './model';

export interface Output { type: 'output'; key: string; seq: number; data: string; replay?: boolean }
interface Connection extends ConnectionInfo {
  process: PtyProcess;
  history: { seq: number; data: string }[];
  bytes: number;
  seq: number;
  pending: string;
  unacknowledged: Map<number, number>;
  outstanding: number;
  timer?: ReturnType<typeof setTimeout>;
}
export class Connections extends EventEmitter {
  private entries = new Map<string, Connection>();
  private disposed = false;
  private deliveryEnabled = false;
  activeKey?: string;
  list(): ConnectionInfo[] { return [...this.entries.values()].map(({ key, manager, sessionId, name, closed, cwd }) => ({ key, manager, sessionId, name, closed: !!closed, cwd })); }
  setCwd(key: string, cwd: string) { const item = this.entries.get(key); if (item) item.cwd = cwd; }
  find(manager: ManagerId, session: SessionInfo): ConnectionInfo | undefined {
    return this.list().find(item => item.manager === manager && (item.sessionId === session.id || item.name === session.name));
  }
  connect(manager: ManagerId, session: SessionInfo, command: Command, cwd: string, cols = 100, rows = 28): ConnectionInfo {
    const existing = this.find(manager, session);
    if (existing && !existing.closed) { this.activeKey = existing.key; this.emit('change'); return existing; }
    if (existing) this.disconnect(existing.key);
    const key = randomUUID();
    const process = spawnPty(command.file, command.args, { name: 'xterm-256color', cols, rows, cwd, env: { ...cleanEnvironment(), ...command.env }, encoding: 'utf8' });
    const item: Connection = { key, manager, sessionId: session.id, name: session.name, cwd, process, history: [], bytes: 0, seq: 0, pending: '', outstanding: 0, unacknowledged: new Map() };
    this.entries.set(key, item);
    this.activeKey = key;
    process.onData(data => {
      item.pending += data;
      if (item.pending.length >= 32 * 1024) this.flush(item);
      else if (!item.timer) item.timer = setTimeout(() => this.flush(item), 12);
    });
    process.onExit(({ exitCode }) => {
      this.flush(item);
      if (this.entries.has(key) && !item.closed) {
        item.closed = true;
        if (!this.disposed) {
          this.emit('exit', { key, name: item.name, code: exitCode });
          this.emit('change');
        }
      }
      // A removed or retained closed tab still owns a client until it exits.
      if (!this.disposed) this.emit('clientExit', { key });
    });
    this.emit('change');
    return item;
  }
  private flush(item: Connection) {
    if (item.timer) clearTimeout(item.timer);
    item.timer = undefined;
    if (!item.pending) return;
    const data = item.pending;
    item.pending = '';
    const seq = ++item.seq;
    item.history.push({ seq, data });
    item.bytes += Buffer.byteLength(data);
    while (item.bytes > 2 * 1024 * 1024 && item.history.length > 1) item.bytes -= Buffer.byteLength(item.history.shift()!.data);
    if (this.deliveryEnabled && !item.closed) {
      const bytes = Buffer.byteLength(data);
      item.unacknowledged.set(seq, bytes); item.outstanding += bytes;
      if (item.outstanding > 512 * 1024) item.process.pause();
    }
    if (!this.disposed) this.emit('output', { type: 'output', key: item.key, seq, data } satisfies Output);
  }
  setDeliveryEnabled(enabled: boolean) {
    this.deliveryEnabled = enabled;
    for (const item of this.entries.values()) { item.unacknowledged.clear(); item.outstanding = 0; if (!item.closed) item.process.resume(); }
  }
  acknowledge(key: string, seq: number) {
    const item = this.entries.get(key);
    if (!item || !Number.isInteger(seq) || seq > item.seq) return;
    for (const [number, bytes] of item.unacknowledged) if (number <= seq) { item.outstanding -= bytes; item.unacknowledged.delete(number); }
    if (item.outstanding < 128 * 1024 && !item.closed) item.process.resume();
  }
  replay(key: string): Output | undefined {
    const item = this.entries.get(key);
    if (!item) return;
    this.flush(item);
    return { type: 'output', key, seq: item.seq, data: item.history.map(chunk => chunk.data).join(''), replay: true };
  }
  input(key: string, data: string) { const item = this.entries.get(key); if (key === this.activeKey && item && !item.closed) item.process.write(data); }
  resize(key: string, cols: number, rows: number) {
    if (key !== this.activeKey || !Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || rows < 1 || cols > 1000 || rows > 500) return;
    const item = this.entries.get(key); if (item && !item.closed) item.process.resize(cols, rows);
  }
  select(key: string) { if (this.entries.has(key)) { this.activeKey = key; this.emit('change'); } }
  closeSession(manager: ManagerId, sessionId: string) {
    for (const item of this.list()) if (item.manager === manager && item.sessionId === sessionId) this.disconnect(item.key);
  }
  retainDetachedSession(manager: ManagerId, sessionId: string) {
    for (const item of this.entries.values()) if (item.manager === manager && item.sessionId === sessionId) {
      this.flush(item);
      item.closed = true;
      item.unacknowledged.clear(); item.outstanding = 0;
      // The backend already detached the client. Let its final output and exit
      // drain naturally instead of racing it with another termination signal.
      item.process.resume();
    }
    this.emit('change');
  }
  disconnect(key: string, keepTab = false) {
    const item = this.entries.get(key);
    if (!item) return;
    this.flush(item);
    const wasClosed = item.closed;
    if (keepTab) item.closed = true;
    else {
      const keys = [...this.entries.keys()]; const index = keys.indexOf(key);
      this.entries.delete(key);
      if (this.activeKey === key) this.activeKey = keys[index + 1] || keys[index - 1];
    }
    if (!wasClosed) {
      item.process.resume(); // Drain a backpressured client so its exit can finish.
      item.process.kill(); // Only the attached client is owned by MuxDock, never the multiplexer daemon.
    }
    this.emit('change');
  }
  reconcile(managers: ManagerInfo[]) {
    for (const item of this.entries.values()) {
      if (item.closed) continue;
      const sessions = managers.find(manager => manager.id === item.manager)?.sessions || [];
      const session = sessions.find(session => session.id === item.sessionId) || sessions.find(session => session.name === item.name);
      if (session) { item.sessionId = session.id; item.name = session.name; }
    }
  }
  dispose() { this.disposed = true; for (const key of this.entries.keys()) this.disconnect(key); this.removeAllListeners(); }
}
