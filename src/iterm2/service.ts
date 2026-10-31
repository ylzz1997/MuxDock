import { createServer, type Server } from 'node:http';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { WebSocketServer, WebSocket } from 'ws';
import { Adapter, LABELS } from '../adapters';
import { MANAGER_IDS, isManagerId, validateName, type ManagerId, type ManagerInfo, type SessionInfo, type Snapshot, type ConnectionInfo } from '../model';
import { getLocale, languages, setLocale, t } from '../i18n';
import { discoverShells, launchCommand, launchProfiles, readLaunchSettings, shellQuote, systemShell, validateLaunchCommand, type LaunchSettings } from '../launch';
import { cleanEnvironment, requireSuccess } from '../runner';
import { parseSessionBatch, runSessionBatch } from '../batch-sessions';
import { validateHerdrName } from '../herdr';
import { inspectProcesses } from './processes';
import { ITermClient } from './client';
import { SSH_MANAGERS, SshTransport, remoteDirectory, sshHostId, validSshTarget } from './ssh';
import { readSshConfigHosts, type SshConfigHost } from './ssh-config';

interface HostSettings { defaultDirectory: string; launch: LaunchSettings }
interface SshHost extends HostSettings { target: string; source?: 'sshConfig' }
interface Config {
  token: string; port: number; language: string; defaultDirectory: string; visibleManagers: ManagerId[];
  showUnavailable: boolean; executables: Partial<Record<ManagerId, string>>; arguments: Partial<Record<ManagerId, string[]>>; launch: LaunchSettings;
  sshHosts: SshHost[]; selectedHost: string;
}
type Dialog = { title: string; value?: string; detail?: string; choices?: { id: string; label: string; detail?: string }[]; confirm?: boolean; accept?: string };
type Peer = { socket: WebSocket; dialogs: Map<string, { resolve: (value?: string) => void; timer: ReturnType<typeof setTimeout> }> };
export function terminalCommand(command: { file: string; args: string[]; env?: Record<string, string> }): string {
  const unset = ['TMUX', 'TMUX_PANE', 'PSMUX_SESSION_NAME', 'STY', 'WINDOW', 'ZELLIJ', 'ZELLIJ_SESSION_NAME', 'ZMX_SESSION', 'ZMX_SESSION_PREFIX', 'SHPOOL_SESSION_NAME', 'HERDR_ENV', 'HERDR_SESSION', 'HERDR_SOCKET_PATH', 'HERDR_CLIENT_SOCKET_PATH', 'HERDR_PANE_ID', 'HERDR_TERMINAL_ID', 'HERDR_WORKSPACE_ID', 'HERDR_TAB_ID'];
  const environment = { PATH: cleanEnvironment().PATH || '/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin', ...command.env };
  const source = `unset ${unset.join(' ')}; exec /usr/bin/env ${Object.entries(environment).map(([key, value]) => shellQuote(`${key}=${value}`)).join(' ')} ${[command.file, ...command.args].map(shellQuote).join(' ')}`;
  return `/bin/sh -c ${shellQuote(source)}`;
}
export class ITermService {
  private config!: Config;
  private readonly peers = new Set<Peer>();
  private adapters = new Map<ManagerId, Adapter>();
  private readonly localAdapters = new Map<ManagerId, Adapter>();
  private remote?: SshTransport;
  private remoteInfo?: Awaited<ReturnType<SshTransport['info']>>;
  private hostError?: string;
  private hostLoading = false;
  private hostRetryAfter = 0;
  private hostRevision = 0;
  private sshConfigHosts: SshConfigHost[] = [];
  private hostScanTask?: Promise<void>;
  private hostScanAt = 0;
  private hostScanError?: string;
  private localShells = [systemShell()];
  private managers: ManagerInfo[] = [];
  private connections: ConnectionInfo[] = [];
  private activeKey?: string;
  private readonly metadata = new Map<string, { manager: ManagerId; sessionId: string; name: string; hostId?: string } | null>();
  private shells = [systemShell()];
  private refreshTask?: Promise<void>;
  private pendingRefresh = false;
  private forceRefresh = false;
  private actions: Promise<unknown> = Promise.resolve();
  private server?: Server;
  private ws?: WebSocketServer;
  private interval?: ReturnType<typeof setInterval>;
  private reconnecting = false;
  private stopped = false;
  private retryAfter = 0;
  constructor(readonly directory: string, readonly assets: string, readonly client = new ITermClient(), private readonly createSsh = (target: string, directory: string) => new SshTransport(target, directory), private readonly discoverSshHosts = readSshConfigHosts) {}
  get port() { return this.config.port; }
  private async refreshSshHosts(force = false) {
    if (this.hostScanTask) return this.hostScanTask;
    if (!force && Date.now() - this.hostScanAt < 3000) return;
    this.hostScanAt = Date.now();
    const task = (async () => {
      try { this.sshConfigHosts = await this.discoverSshHosts(); this.hostScanError = undefined; }
      catch (error) { const message = String(error); if (message !== this.hostScanError) this.error(error); this.hostScanError = message; }
    })();
    this.hostScanTask = task; try { await task; } finally { this.hostScanTask = undefined; }
  }
  private hostChoices(): NonNullable<Snapshot['hosts']> {
    const result: NonNullable<Snapshot['hosts']> = [{ id: 'local', label: t('localHost'), removable: false }];
    const known = new Set(['local']);
    for (const host of this.sshConfigHosts) {
      const id = sshHostId(host.target); if (known.has(id)) continue; known.add(id);
      const source = host.source.startsWith(os.homedir() + path.sep) ? '~' + host.source.slice(os.homedir().length) : host.source;
      result.push({ id, label: `SSH · ${host.target}`, source, removable: false });
    }
    for (const host of this.config.sshHosts) {
      const id = sshHostId(host.target);
      if (known.has(id) || host.source === 'sshConfig' && id !== this.config.selectedHost) continue;
      known.add(id); result.push({ id, label: `SSH · ${host.target}`, removable: true });
    }
    return result;
  }
  private get hostSettings(): HostSettings { return this.config.sshHosts.find(host => sshHostId(host.target) === this.config.selectedHost) || this.config; }
  private get defaultShell() { return this.remote ? this.remoteInfo?.shell || '/bin/sh' : systemShell(); }
  private selectHost(id: string) {
    const host = this.config.sshHosts.find(host => sshHostId(host.target) === id);
    this.config.selectedHost = host ? id : 'local';
    this.hostRevision++; this.remoteInfo = undefined; this.hostError = undefined; this.hostRetryAfter = 0;
    this.remote = host ? this.createSsh(host.target, this.directory) : undefined;
    this.hostLoading = !!host;
    this.adapters = host ? new Map() : this.localAdapters;
    this.shells = host ? ['/bin/sh'] : this.localShells;
    this.managers = []; this.connections = []; this.activeKey = undefined;
  }
  async start(port?: number) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    let saved: Partial<Config> = {};
    try { saved = JSON.parse(await readFile(path.join(this.directory, 'config.json'), 'utf8')); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    this.config = {
      token: /^[a-f0-9]{48}$/.test(saved.token || '') ? saved.token! : randomBytes(24).toString('hex'),
      port: port ?? saved.port ?? 41739, language: typeof saved.language === 'string' ? saved.language : 'auto',
      defaultDirectory: typeof saved.defaultDirectory === 'string' ? saved.defaultDirectory : os.homedir(),
      visibleManagers: Array.isArray(saved.visibleManagers) ? [...new Set(saved.visibleManagers.filter(isManagerId))] : MANAGER_IDS.filter(id => id !== 'psmux'),
      showUnavailable: saved.showUnavailable === true, executables: saved.executables || {}, arguments: saved.arguments || {}, launch: readLaunchSettings(saved.launch),
      sshHosts: Array.isArray(saved.sshHosts) ? saved.sshHosts.filter((host, index, all) => host && validSshTarget(host.target) && all.findIndex(item => item?.target === host.target) === index).map(host => ({ target: host.target, ...(host.source === 'sshConfig' ? { source: 'sshConfig' as const } : {}), defaultDirectory: typeof host.defaultDirectory === 'string' ? host.defaultDirectory : '~', launch: readLaunchSettings(host.launch) })) : [],
      selectedHost: typeof saved.selectedHost === 'string' ? saved.selectedHost : 'local'
    };
    setLocale(this.config.language, process.env.LANG || Intl.DateTimeFormat().resolvedOptions().locale);
    for (const id of MANAGER_IDS) this.localAdapters.set(id, new Adapter(id, { executable: this.config.executables[id], args: this.config.arguments[id] }, undefined, process.platform, inspectProcesses));
    this.localShells = await discoverShells(systemShell()); await this.refreshSshHosts(true); this.selectHost(this.config.selectedHost);
    const prefix = `/${this.config.token}/`;
    this.server = createServer(async (request, response) => {
      if (request.headers.host !== `127.0.0.1:${this.config.port}` || request.method !== 'GET') { response.writeHead(403).end(); return; }
      const url = new URL(request.url || '/', `http://${request.headers.host}`);
      if (!url.pathname.startsWith(prefix)) { response.writeHead(404).end(); return; }
      const file = url.pathname.slice(prefix.length);
      response.setHeader('Cache-Control', 'no-store'); response.setHeader('X-Content-Type-Options', 'nosniff'); response.setHeader('Referrer-Policy', 'no-referrer');
      try {
        if (!file) {
          response.setHeader('Content-Type', 'text/html; charset=utf-8');
          response.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws://127.0.0.1:${this.config.port}; font-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'`);
          response.end(`<!doctype html><html lang="${getLocale()}" data-host="iterm2"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="sidebar.css"><link rel="stylesheet" href="iterm2.css"><title>MuxDock</title></head><body><div id="app"></div><script src="sidebar.js"></script></body></html>`);
        } else if (['sidebar.js', 'sidebar.css', 'iterm2.css'].includes(file) || /^PowerlineSymbols-[\w-]+\.otf$/.test(file)) {
          response.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript; charset=utf-8' : file.endsWith('.css') ? 'text/css; charset=utf-8' : 'font/otf'); response.end(await readFile(path.join(this.assets, file)));
        } else response.writeHead(404).end();
      } catch { response.writeHead(404).end(); }
    });
    this.ws = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
    this.server.on('upgrade', (request, socket, head) => {
      const origin = `http://127.0.0.1:${this.config.port}`;
      if (request.headers.host !== `127.0.0.1:${this.config.port}` || request.headers.origin !== origin || request.url !== `${prefix}socket`) { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
      this.ws!.handleUpgrade(request, socket, head, ws => this.addPeer(ws));
    });
    await new Promise<void>((resolve, reject) => { this.server!.once('error', reject); this.server!.listen(this.config.port, '127.0.0.1', resolve); });
    this.config.port = (this.server.address() as { port: number }).port;
    await this.save();
    this.client.on('diagnostic', error => console.error(String(error)));
    this.client.on('notification', () => { void this.refresh().catch(error => this.error(error)); });
    this.client.on('disconnected', () => this.broadcast({ type: 'nativeConnection', connected: false }));
    try { await this.connect(); } catch (error) { await this.stop(); throw error; }
    this.interval = setInterval(() => {
      // Slow SSH queries may exceed the polling interval. Do not keep their
      // refresh promise pending forever and starve actions waiting on it.
      if (this.client.connected) { if (!this.refreshTask) void this.refresh().catch(error => this.error(error)); }
      else if (!this.reconnecting && Date.now() > this.retryAfter) void this.connect().catch(error => { this.retryAfter = Date.now() + 30000; this.error(error); });
    }, 3000);
    await this.refresh(true);
  }
  private async connect() {
    this.reconnecting = true;
    try {
      await this.client.connect();
      if (this.stopped) { this.client.close(); return; }
      await this.client.registerTool(`http://127.0.0.1:${this.config.port}/${this.config.token}/`);
      await this.client.subscribe();
      this.metadata.clear(); this.broadcast({ type: 'nativeConnection', connected: true });
    } finally { this.reconnecting = false; }
  }
  private async save() {
    const temporary = path.join(this.directory, 'config.json.tmp');
    await writeFile(temporary, JSON.stringify(this.config, null, 2) + '\n', { mode: 0o600 });
    await rename(temporary, path.join(this.directory, 'config.json'));
  }
  private send(peer: Peer, message: unknown) { if (peer.socket.readyState === WebSocket.OPEN) peer.socket.send(JSON.stringify(message)); }
  private broadcast(message: unknown) { for (const peer of this.peers) this.send(peer, message); }
  private error(error: unknown, peer?: Peer) { const message = error instanceof Error ? error.message : String(error); console.error(message); if (peer) this.send(peer, { type: 'error', message }); else this.broadcast({ type: 'error', message }); }
  private addPeer(socket: WebSocket) {
    const peer: Peer = { socket, dialogs: new Map() }; this.peers.add(peer);
    socket.on('error', () => socket.close());
    socket.on('close', () => { this.peers.delete(peer); for (const entry of peer.dialogs.values()) { clearTimeout(entry.timer); entry.resolve(); } peer.dialogs.clear(); });
    socket.on('message', data => {
      try {
        const message = JSON.parse(data.toString());
        if (!message || typeof message !== 'object' || typeof message.type !== 'string') throw new Error('Invalid sidebar message');
        if (message.type === 'dialogResult') { const entry = peer.dialogs.get(message.id); if (entry) { peer.dialogs.delete(message.id); clearTimeout(entry.timer); entry.resolve(typeof message.value === 'string' ? message.value : undefined); } return; }
        if (message.type === 'refreshHosts') { void this.refreshSshHosts(true).then(() => this.broadcast({ type: 'snapshot', state: this.snapshot() })); return; }
        if (message.type === 'ready' || message.type === 'refresh') { this.send(peer, { type: 'snapshot', state: this.snapshot() }); void this.refresh(message.type === 'refresh').catch(error => this.error(error, peer)); return; }
        const action = this.actions.then(() => this.receive(peer, message)); this.actions = action.catch(error => this.error(error, peer));
      } catch (error) { this.error(error, peer); }
    });
  }
  private ask(peer: Peer, dialog: Dialog): Promise<string | undefined> {
    if (peer.socket.readyState !== WebSocket.OPEN) return Promise.resolve(undefined);
    const id = randomUUID();
    return new Promise(resolve => { const timer = setTimeout(() => { peer.dialogs.delete(id); resolve(undefined); }, 300000); peer.dialogs.set(id, { resolve, timer }); this.send(peer, { type: 'dialog', id, ...dialog }); });
  }
  private async input(peer: Peer, dialog: Dialog, validate: (value: string) => string | undefined): Promise<string | undefined> {
    let value = dialog.value, detail = dialog.detail;
    for (;;) { value = await this.ask(peer, { ...dialog, value, detail }); if (value === undefined) return; detail = validate(value); if (!detail) return value; }
  }
  snapshot(): Snapshot {
    return { locale: getLocale(), managers: this.managers, connections: this.connections, activeKey: this.activeKey,
      hosts: this.hostChoices(), selectedHost: this.config.selectedHost, hostError: this.hostError, hostLoading: this.hostLoading,
      showUnavailable: this.config.showUnavailable, visibleManagers: this.config.visibleManagers, showTabs: false, maxTabs: 50, host: this.remote?.target || os.hostname(),
      appearance: { fontSize: 12, fontFamily: '', scrollback: 10000, minimumContrastRatio: 4.5 }, ...launchProfiles(this.hostSettings.launch, this.shells, this.defaultShell) };
  }
  async refresh(force = false): Promise<void> {
    if (this.stopped || !this.client.connected) return;
    this.pendingRefresh = true; this.forceRefresh ||= force;
    if (this.refreshTask) return this.refreshTask;
    const task = (async () => {
      this.broadcast({ type: 'refreshing', value: true });
      do {
        this.pendingRefresh = false; const probe = this.forceRefresh; this.forceRefresh = false;
        await this.refreshSshHosts(probe);
        const revision = this.hostRevision, remote = this.remote, hostId = this.config.selectedHost;
        if (remote && this.hostError && !probe && Date.now() < this.hostRetryAfter) break;
        if (remote && (probe || !this.remoteInfo)) {
          this.hostLoading = true; this.hostError = undefined;
          this.broadcast({ type: 'snapshot', state: this.snapshot() });
        }
        try {
          if (remote) remote.failure = undefined;
          if (remote && !this.remoteInfo) {
            const info = await remote.info();
            if (revision !== this.hostRevision) continue;
            this.remoteInfo = info; this.shells = [...new Set([info.shell, '/bin/sh'])];
            this.adapters = new Map(SSH_MANAGERS.map(id => [id, new Adapter(id, {}, remote.run, info.platform, undefined, name => remote.executable(name))]));
          }
          const managers = await Promise.all([...this.adapters.values()].map(adapter => adapter.list(probe)));
          if (revision !== this.hostRevision) continue;
          if (remote?.failure) throw new Error(remote.failure);
          this.managers = managers; this.hostError = undefined;
        } catch (error) {
          if (revision !== this.hostRevision) continue;
          if (!remote) throw error;
          this.hostError = error instanceof Error ? error.message : String(error); this.hostRetryAfter = Date.now() + 15000;
          this.remoteInfo = undefined; this.managers = []; this.connections = []; this.hostLoading = false;
          this.broadcast({ type: 'snapshot', state: this.snapshot() }); break;
        }
        const native = await this.client.sessions();
        if (revision !== this.hostRevision) continue;
        for (const id of this.metadata.keys()) if (!native.some(session => session.id === id)) this.metadata.delete(id);
        for (const session of native) if (!this.metadata.has(session.id)) {
          try {
            const value = await this.client.variable(session.id), item = value && JSON.parse(value);
            // A create operation may tag this session while the read is in flight.
            if (!this.metadata.has(session.id)) this.metadata.set(session.id, item && isManagerId(item.manager) && typeof item.sessionId === 'string' && typeof item.name === 'string' ? item : null);
          } catch { /* The session may have closed while listing it. */ }
        }
        if (revision !== this.hostRevision) continue;
        this.connections = [];
        for (const item of native) {
          const metadata = this.metadata.get(item.id); if (!metadata || (metadata.hostId || 'local') !== hostId) continue;
          const session = this.managers.find(manager => manager.id === metadata.manager)?.sessions.find(session => session.id === metadata.sessionId || session.name === metadata.name);
          if (session) { metadata.sessionId = session.id; metadata.name = session.name; this.connections.push({ key: item.id, ...metadata }); }
        }
        const focus = await this.client.focus();
        if (revision !== this.hostRevision) continue;
        this.activeKey = focus.sessionId;
        this.broadcast({ type: 'snapshot', state: this.snapshot() });
      } while (this.pendingRefresh && !this.stopped);
    })();
    this.refreshTask = task;
    try { await task; } finally {
      this.refreshTask = undefined;
      if (this.hostLoading) { this.hostLoading = false; this.broadcast({ type: 'snapshot', state: this.snapshot() }); }
      this.broadcast({ type: 'refreshing', value: false });
    }
  }
  private resolve(manager: unknown, id: unknown) {
    if (!isManagerId(manager) || typeof id !== 'string') throw new Error(t('invalidSession'));
    const session = this.managers.find(item => item.id === manager)?.sessions.find(item => item.id === id);
    if (!session) throw new Error(t('sessionGone'));
    return { adapter: this.adapters.get(manager)!, session };
  }
  private async nativeCommand(command: { file: string; args: string[]; env?: Record<string, string> }, ssh = false): Promise<string> {
    // Let a real shell parse nested remote quotes. iTerm2's custom-command
    // tokenizer is only given a script path, never an SSH command nested in -c.
    const source = `#!/bin/sh\n${terminalCommand(command)}\nresult=$?\n${ssh ? `if [ "$result" -ne 0 ]; then printf '\\n%s\\n' ${shellQuote(t('sshFailedTerminal'))}; read -r ignored; fi\n` : ''}exit "$result"\n`;
    const directory = path.join(this.directory, 'launchers'); await mkdir(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, `native-${createHash('sha256').update(source).digest('hex').slice(0, 24)}.sh`);
    await writeFile(file, source, { mode: 0o700 }); return `/bin/sh ${shellQuote(file)}`;
  }
  private async attach(adapter: Adapter, session: SessionInfo, create = false) {
    if (process.env.MUXDOCK_API_TRACE) console.error('MuxDock attach', adapter.id, create, !!this.remote);
    const existing = this.connections.find(item => item.manager === adapter.id && item.sessionId === session.id);
    if (existing) { await this.client.activate(existing.key); return; }
    if (!create && adapter.id === 'shpool' && session.attached) throw new Error(t('shpoolAttached'));
    const settings = this.hostSettings, cwd = this.remote ? os.homedir() : settings.defaultDirectory.replace(/^~(?=\/|$)/, os.homedir());
    if (!(await stat(cwd)).isDirectory()) throw new Error(t('cwdMissing', { directory: cwd }));
    const shell = settings.launch.shell || this.defaultShell, startup = settings.launch.commands.find(item => item.id === settings.launch.commandId)?.command;
    const launcher = create && !this.remote ? await launchCommand(shell, startup, path.join(this.directory, 'launchers')) : undefined;
    let command = create && this.remote ? adapter.create(session.name, shell)
      : create && adapter.id === 'herdr' ? await adapter.createHerdr(session.name, shell, startup, cwd, path.join(this.directory, 'launchers'))
      : launcher ? adapter.create(session.name, launcher.file, shell, launcher.args) : adapter.attach(session);
    if (this.remote) {
      if (create && startup) command.args.splice(-2, 2, shell, ['csh', 'tcsh'].includes(path.posix.basename(shell)) ? '-ic' : '-ilc', `${startup}\nexec ${shellQuote(shell)} -l`);
      command = this.remote.terminal(command, settings.defaultDirectory);
    }
    const id = await this.client.create(await this.nativeCommand(command, !!this.remote), cwd, `MuxDock · ${session.name}${this.remote ? ` · ${this.remote.target}` : ''}`, (await this.client.focus()).windowId);
    if (process.env.MUXDOCK_API_TRACE) console.error('MuxDock native session created');
    const metadata = { manager: adapter.id, sessionId: session.id, name: session.name, hostId: this.config.selectedHost };
    this.metadata.set(id, metadata);
    await this.client.variable(id, JSON.stringify(metadata));
    await this.client.activate(id);
    // Some managers expose their socket only after the client has started.
    await new Promise(resolve => setTimeout(resolve, 200));
    await this.refresh();
  }
  private async receive(peer: Peer, m: Record<string, any>) {
    if (process.env.MUXDOCK_API_TRACE) console.error('MuxDock action', m.type);
    if (!this.client.connected) throw new Error(t('itermReconnecting'));
    if ((m.hostId || 'local') !== this.config.selectedHost) { this.send(peer, { type: 'snapshot', state: this.snapshot() }); throw new Error(t('hostChanged')); }
    if (m.type === 'selectHost' || m.type === 'addSshHost') {
      await this.refreshSshHosts(true);
      let id = m.id;
      if (m.type === 'addSshHost') {
        const value = await this.input(peer, { title: t('addSshHost'), detail: t('sshHostPrompt') }, value => validSshTarget(value.trim()) ? undefined : t('sshHostInvalid'));
        if (value === undefined) return;
        const target = value.trim(); id = sshHostId(target);
        if (!this.config.sshHosts.some(host => host.target === target)) this.config.sshHosts.push({ target, defaultDirectory: '~', launch: readLaunchSettings(undefined) });
      }
      const discovered = this.sshConfigHosts.find(host => sshHostId(host.target) === id);
      if (discovered && !this.config.sshHosts.some(host => host.target === discovered.target)) this.config.sshHosts.push({ target: discovered.target, source: 'sshConfig', defaultDirectory: '~', launch: readLaunchSettings(undefined) });
      if (!this.hostChoices().some(host => host.id === id)) throw new Error(t('sshHostInvalid'));
      this.selectHost(id); await this.save(); this.broadcast({ type: 'snapshot', state: this.snapshot() });
      await this.refresh(true); return;
    }
    if (m.type === 'removeSshHost') {
      await this.refreshSshHosts(true);
      if (this.sshConfigHosts.some(host => sshHostId(host.target) === m.id)) return;
      const host = this.config.sshHosts.find(host => sshHostId(host.target) === m.id); if (!host) return;
      if (await this.ask(peer, { title: t('removeSshHost'), detail: t('removeSshHostPrompt', { host: host.target }), confirm: true }) !== 'confirm') return;
      this.config.sshHosts = this.config.sshHosts.filter(item => item !== host);
      if (this.config.selectedHost === m.id) this.selectHost('local');
      await this.save(); this.broadcast({ type: 'snapshot', state: this.snapshot() }); await this.refresh(); return;
    }
    if (m.type === 'sshLogin') {
      if (!this.remote) return;
      await this.remote.prepare();
      const id = await this.client.create(await this.nativeCommand(this.remote.loginCommand(), true), os.homedir(), `SSH · ${this.remote.target}`, (await this.client.focus()).windowId);
      await this.client.activate(id); this.hostRetryAfter = 0; return;
    }
    if (m.type === 'copy') {
      if (typeof m.text !== 'string') return;
      await new Promise<void>((resolve, reject) => { const child = spawn('/usr/bin/pbcopy', [], { stdio: ['pipe', 'ignore', 'pipe'] }); child.on('error', reject); child.on('close', code => code ? reject(new Error('Copy failed')) : resolve()); child.stdin.on('error', reject); child.stdin.end(m.text); }); return;
    }
    if (m.type === 'showUnavailable') { this.config.showUnavailable = m.value === true; await this.save(); this.broadcast({ type: 'snapshot', state: this.snapshot() }); return; }
    if (m.type === 'language') {
      const value = await this.ask(peer, { title: t('languagePrompt'), value: getLocale(), choices: Object.entries(languages).map(([id, label]) => ({ id, label })) });
      if (value && Object.hasOwn(languages, value)) { this.config.language = value; setLocale(value); await this.save(); this.broadcast({ type: 'snapshot', state: this.snapshot() }); } return;
    }
    if (m.type === 'settings') {
      const settings = this.hostSettings;
      const setting = await this.ask(peer, { title: t('settings'), detail: t('settingsPrompt'), accept: t('nextAction'), choices: [
        { id: 'directory', label: t('defaultDirectory'), detail: t('defaultDirectoryHelp') },
        { id: 'managers', label: t('visibleManagers'), detail: t('visibleManagersHelp') }
      ] });
      if (setting === 'directory') {
        const value = await this.input(peer, { title: t('defaultDirectory'), detail: `${t('defaultDirectoryHelp')}${this.remote ? `\nSSH · ${this.remote.target}` : ''}`, value: settings.defaultDirectory }, value => path.posix.isAbsolute(value) || /^~(?:\/|$)/.test(value) ? undefined : t('cwdMissing', { directory: value }));
        if (value !== undefined) {
          if (this.remote) requireSuccess(await this.remote.script(remoteDirectory(value)), t('cwdMissing', { directory: value }));
          else if (!(await stat(value.replace(/^~(?=\/|$)/, os.homedir()))).isDirectory()) throw new Error(t('cwdMissing', { directory: value }));
          settings.defaultDirectory = value;
        }
      } else if (setting === 'managers') {
        const value = await this.input(peer, { title: t('visibleManagers'), value: this.config.visibleManagers.join(', '), detail: `${t('visibleManagersHelp')}\n${t('managerNamesHint', { managers: MANAGER_IDS.filter(id => id !== 'psmux').join(', ') })}` }, value => value.split(',').filter(part => part.trim()).every(part => isManagerId(part.trim()) && part.trim() !== 'psmux') ? undefined : t('invalidSession'));
        if (value !== undefined) this.config.visibleManagers = [...new Set(value.split(',').map(part => part.trim()).filter(isManagerId))];
      }
      await this.save(); this.broadcast({ type: 'snapshot', state: this.snapshot() }); return;
    }
    if (m.type === 'selectLaunchProfile') {
      const launch = this.hostSettings.launch;
      const profile = this.snapshot().launchProfiles.find(item => item.id === m.id); if (!profile) return;
      if (profile.kind === 'shell') { launch.shell = m.id === 'system' ? undefined : m.id.slice(6); launch.commandId = undefined; }
      else launch.commandId = m.id.slice(8);
      await this.save(); this.broadcast({ type: 'snapshot', state: this.snapshot() }); return;
    }
    if (m.type === 'addLaunchCommand') {
      const launch = this.hostSettings.launch;
      const value = await this.input(peer, { title: t('addLaunchCommand'), detail: t('launchPrompt') }, validateLaunchCommand);
      if (value) { const item = launch.commands.find(item => item.command === value.trim()) || { id: randomUUID(), command: value.trim() }; if (!launch.commands.includes(item)) launch.commands.push(item); launch.commandId = item.id; await this.save(); this.broadcast({ type: 'snapshot', state: this.snapshot() }); } return;
    }
    if (m.type === 'removeLaunchCommand') { const launch = this.hostSettings.launch; launch.commands = launch.commands.filter(item => item.id !== m.id); if (launch.commandId === m.id) launch.commandId = undefined; await this.save(); this.broadcast({ type: 'snapshot', state: this.snapshot() }); return; }
    await this.refresh();
    if (m.type === 'newSession') {
      const managers = this.managers.filter(item => item.available && this.config.visibleManagers.includes(item.id));
      if (!managers.length) throw new Error(t('noAvailableManagers'));
      const id = m.manager || await this.ask(peer, { title: t('chooseManager'), choices: managers.map(item => ({ id: item.id, label: item.name })) });
      if (!isManagerId(id) || !managers.some(item => item.id === id)) return;
      const name = await this.input(peer, { title: t('newManagerSession', { manager: LABELS[id] }) }, value => validateName(value) || (id === 'herdr' ? validateHerdrName(value) : id === 'tmux' && value.includes('.') ? t('tmuxDot') : undefined) || (this.managers.find(item => item.id === id)?.sessions.some(item => item.name === value) ? t('nameExists') : undefined));
      if (!name) return;
      if (process.env.MUXDOCK_API_TRACE) console.error('MuxDock new session name accepted');
      await this.refresh(); if (this.managers.find(item => item.id === id)?.sessions.some(item => item.name === name)) throw new Error(t('nameTaken'));
      if (process.env.MUXDOCK_API_TRACE) console.error('MuxDock new session refresh completed');
      await this.attach(this.adapters.get(id)!, { id: name, name }, true); return;
    }
    if (m.type === 'disconnect') {
      const connection = this.connections.find(item => item.key === m.key); if (!connection) return;
      if (connection.manager === 'shpool') await this.adapters.get('shpool')!.detach({ id: connection.sessionId, name: connection.name });
      else await this.client.closeSession(connection.key);
      await this.refresh(); return;
    }
    if (m.type === 'batchSessions') {
      let succeeded: { manager: ManagerId; session: string }[] = [], error: string | undefined;
      try {
        const { action, targets } = parseSessionBatch(m);
        for (const target of targets) { const { adapter } = this.resolve(target.manager, target.session); if (!adapter.capabilities[action === 'kill' ? 'kill' : 'detachAll']) throw new Error(t('unsupportedAction', { manager: LABELS[target.manager] })); }
        if (action === 'kill' && await this.ask(peer, { title: t('confirmBatchKill', { count: targets.length }), detail: targets.map(target => `${LABELS[target.manager]} · ${this.resolve(target.manager, target.session).session.name}`).join('\n'), confirm: true, accept: t('batchKill') }) !== 'confirm') return;
        const result = await runSessionBatch(targets, async target => { const { adapter, session } = this.resolve(target.manager, target.session); if (action === 'kill') await adapter.kill(session); else await adapter.detachAll(session); });
        succeeded = result.succeeded; if (result.failed.length) error = result.failed.map(item => `${item.target.manager}: ${item.error}`).join('\n');
      } catch (cause) { error = String(cause); }
      finally { this.send(peer, { type: 'batchResult', request: m.request, succeeded, error }); await this.refresh(); }
      if (error) throw new Error(error); return;
    }
    const { adapter, session } = this.resolve(m.manager, m.session);
    if (m.type === 'details') {
      try { const window = m.window ? session.windows?.find(item => item.id === m.window) : undefined; if (m.window && !window) throw new Error(t('windowGone')); this.send(peer, { type: 'details', request: m.request, details: await adapter.details(session, window) }); }
      catch (error) { this.send(peer, { type: 'details', request: m.request, error: String(error) }); } return;
    }
    if (m.type === 'attach') await this.attach(adapter, session);
    else if (m.type === 'disconnectAll') await adapter.detachAll(session);
    else if (m.type === 'kill') { if (await this.ask(peer, { title: t('confirmKill', { name: session.name }), confirm: true, accept: t('killSession') }) === 'confirm') await adapter.kill(session); }
    else if (m.type === 'rename') { const value = await this.input(peer, { title: t('renameSession'), value: session.name }, value => validateName(value) || (value.includes('.') ? t('tmuxRenameDot') : undefined)); if (value && value !== session.name) await adapter.rename(session, value); }
    else if (m.type === 'window') {
      if (!adapter.capabilities.windows) return;
      const window = session.windows?.find(item => item.id === m.window);
      if (m.action !== 'new' && !window) throw new Error(t('windowGone'));
      if (m.action === 'select') { await this.attach(adapter, session); await adapter.windowAction('select', session, window); }
      else if (m.action === 'new' || m.action === 'rename') {
        const value = await this.input(peer, { title: t(m.action === 'new' ? 'newTmuxWindow' : 'renameTmuxWindow'), value: window?.renameName || window?.name }, validateName);
        if (value) { if (adapter.id === 'zellij' && m.action === 'new') await this.attach(adapter, session); await adapter.windowAction(m.action, session, window, value); }
      } else if (m.action === 'kill' && await this.ask(peer, { title: t('confirmCloseWindow', { name: window!.name }), confirm: true, accept: t('closeWindow') }) === 'confirm') await adapter.windowAction('kill', session, window);
    }
    await this.refresh();
  }
  async stop() {
    this.stopped = true; if (this.interval) clearInterval(this.interval);
    for (const peer of this.peers) peer.socket.terminate();
    this.ws?.close(); this.client.close();
    if (this.server?.listening) await new Promise<void>(resolve => this.server!.close(() => resolve()));
  }
}
