import * as vscode from 'vscode';
import os from 'node:os';
import path from 'node:path';
import { stat } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { Adapter, LABELS } from './adapters';
import { Connections } from './connections';
import { MAX_TERMINAL_CLIPBOARD_BYTES } from './clipboard';
import { discoverShells, launchExecutable, launchProfiles, readLaunchSettings, systemShell, validateLaunchCommand, type LaunchSettings } from './launch';
import { MANAGER_IDS, isManagerId, validateName, type ManagerInfo, type ManagerId, type SessionInfo, type Snapshot, type WindowInfo } from './model';
import { parseTerminalLink } from './links';
import { resolveFileLink } from './file-links';
import { run } from './runner';

let activeProvider: DockProvider | undefined;
export async function deactivate() { await activeProvider?.shutdown(); activeProvider = undefined; }
export function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel('MuxDock');
  const provider = new DockProvider(context, output);
  activeProvider = provider;
  context.subscriptions.push(output, provider,
    vscode.window.registerWebviewViewProvider('muxdock.dock', provider, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand('muxdock.open', () => vscode.commands.executeCommand('muxdock.dock.focus')),
    vscode.commands.registerCommand('muxdock.refresh', () => provider.refresh(true)),
    vscode.commands.registerCommand('muxdock.newSession', () => provider.newSession()),
    vscode.commands.registerCommand('muxdock.settings', (fontsOnly = false) => vscode.commands.executeCommand('workbench.action.openSettings', fontsOnly === true ? '@ext:muxdock.muxdock font' : '@ext:muxdock.muxdock')),
    vscode.commands.registerCommand('muxdock.logs', () => output.show()),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('muxdock') || event.affectsConfiguration('terminal.integrated.fontFamily')) provider.configure();
    })
  );
  return { getSnapshot: () => provider.snapshot() };
}

class DockProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view?: vscode.WebviewView;
  private readonly adapters = new Map<ManagerId, Adapter>();
  private readonly connections = new Connections();
  private managers: ManagerInfo[] = [];
  private refreshTask?: Promise<void>;
  private refreshRequested = false;
  private forceRefreshRequested = false;
  private timer?: ReturnType<typeof setInterval>;
  private ready = false;
  private disposed = false;
  private busy = false;
  private connectionTask: Promise<unknown> = Promise.resolve();
  private activationRevision = 0;
  private readonly defaultShell = systemShell();
  private shells = [this.defaultShell];
  private launchSettings: LaunchSettings;
  private readonly launchTask: Promise<void>;
  constructor(private readonly context: vscode.ExtensionContext, private readonly log: vscode.OutputChannel) {
    this.launchSettings = readLaunchSettings(context.globalState.get('launchSettings'));
    this.launchTask = discoverShells(this.defaultShell).then(shells => { this.shells = shells; this.publish(); }).catch(error => log.appendLine(`Shell discovery: ${error}`));
    for (const id of MANAGER_IDS) this.adapters.set(id, new Adapter(id));
    this.configure();
    this.connections.on('output', message => this.post(message));
    this.connections.on('change', () => this.publish());
    this.connections.on('exit', ({ key, name, code }) => {
      this.post({ type: 'exit', key, name, code });
      this.log.appendLine(`Client exited: ${name}, code=${code}`);
      if (code !== 0) void vscode.window.showWarningMessage(`${name} 的连接已退出（${code}）。请查看终端输出；后台会话状态可在刷新后确认。`);
    });
    this.connections.on('clientExit', () => { void this.refresh(); });
  }
  configure() {
    const config = vscode.workspace.getConfiguration('muxdock');
    const executables = config.get<Record<string, string>>('executables', {});
    const args = config.get<Record<string, string[]>>('arguments', {});
    for (const [id, adapter] of this.adapters) {
      const executable = typeof executables[id] === 'string' ? executables[id] : undefined;
      adapter.configure({ executable, args: Array.isArray(args[id]) ? args[id].filter(value => typeof value === 'string') : [] });
    }
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => { if (this.view?.visible && !this.refreshTask) void this.refresh(); }, Math.max(1, config.get('refreshInterval', 3)) * 1000);
    void this.queueConnections(async () => { await this.trimTabs(this.maxTabs()); this.publish(); }).catch(error => this.error(error));
    if (this.view) void this.refresh(true);
  }
  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view;
    this.ready = false;
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist')] };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage(message => { void this.receive(message).catch(error => this.error(error)); }, undefined, this.context.subscriptions);
    view.onDidChangeVisibility(() => { if (view.visible) { void this.refresh(); this.post({ type: 'visible' }); } }, undefined, this.context.subscriptions);
    view.onDidDispose(() => { this.view = undefined; this.ready = false; this.connections.setDeliveryEnabled(false); }, undefined, this.context.subscriptions);
  }
  private html(webview: vscode.Webview): string {
    const uri = (name: string) => webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', name));
    const nonce = randomBytes(18).toString('base64');
    // xterm's DOM renderer creates styles for its palette, cell sizes and cursor,
    // and uses inline styles for truecolor. Scripts remain restricted by nonce.
    return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${webview.cspSource}; img-src ${webview.cspSource} data:;"><link rel="stylesheet" href="${uri('webview.css')}"><title>MuxDock</title></head><body><div id="app"></div><script nonce="${nonce}" src="${uri('webview.js')}"></script></body></html>`;
  }
  private post(message: unknown) { if (this.ready && this.view) void this.view.webview.postMessage(message); }
  snapshot(): Snapshot {
    const config = vscode.workspace.getConfiguration('muxdock');
    const terminal = vscode.workspace.getConfiguration('terminal.integrated');
    return {
      managers: this.managers, connections: this.connections.list(), activeKey: this.connections.activeKey,
      showUnavailable: config.get('showUnavailable', false), host: vscode.env.remoteName ? `${vscode.env.remoteName} · ${os.hostname()}` : os.hostname(),
      visibleManagers: this.visibleManagers(), showTabs: config.get('showTabs', true), maxTabs: this.maxTabs(),
      appearance: { fontSize: config.get('fontSize', 12), fontFamily: config.get<string>('fontFamily') || terminal.get<string>('fontFamily') || 'Menlo, Monaco, monospace', scrollback: config.get('scrollback', 10000) },
      ...launchProfiles(this.launchSettings, this.shells, this.defaultShell)
    };
  }
  private publish() { this.post({ type: 'snapshot', state: this.snapshot() }); }
  private visibleManagers(): ManagerId[] {
    const value = vscode.workspace.getConfiguration('muxdock').get<unknown>('visibleManagers', [...MANAGER_IDS]);
    return Array.isArray(value) ? [...new Set(value.filter(isManagerId))] : [...MANAGER_IDS];
  }
  private maxTabs(): number {
    const value = Number(vscode.workspace.getConfiguration('muxdock').get('maxTabs', 8));
    return Number.isFinite(value) ? Math.max(1, Math.min(50, Math.floor(value))) : 8;
  }
  private queueConnections<T>(action: () => Promise<T>): Promise<T> {
    const task = this.connectionTask.then(action);
    this.connectionTask = task.catch(() => {});
    return task;
  }
  private async closeConnection(key: string, keepTab = false) {
    const info = this.connections.list().find(info => info.key === key);
    if (info?.manager === 'shpool' && !info.closed) await this.adapters.get('shpool')!.detach({ id: info.sessionId, name: info.name });
    this.connections.disconnect(key, keepTab);
  }
  private async trimTabs(limit: number) {
    while (this.connections.list().length > limit) await this.closeConnection(this.connections.list()[0].key);
  }
  async refresh(force = false): Promise<void> {
    if (this.disposed) return;
    this.refreshRequested = true;
    this.forceRefreshRequested ||= force;
    if (this.refreshTask) return this.refreshTask;
    const task = (async () => {
      this.post({ type: 'refreshing', value: true });
      try {
        do {
          const force = this.forceRefreshRequested;
          this.refreshRequested = false;
          this.forceRefreshRequested = false;
          const managers = await Promise.all([...this.adapters.values()].map(adapter => adapter.list(force)));
          if (this.disposed) return;
          this.managers = managers;
          this.connections.reconcile(this.managers);
          this.publish();
          // A close, client exit or manual refresh during the query needs a
          // fresh sample; joining the old query loses that state change.
        } while (this.refreshRequested);
      } catch (error) { this.error(error); }
      finally { this.refreshTask = undefined; this.post({ type: 'refreshing', value: false }); }
    })();
    this.refreshTask = task;
    return task;
  }
  private resolveSession(managerId: unknown, sessionId: unknown): { adapter: Adapter; session: SessionInfo } {
    if (!isManagerId(managerId) || typeof sessionId !== 'string') throw new Error('无效的会话。');
    const session = this.managers.find(manager => manager.id === managerId)?.sessions.find(session => session.id === sessionId);
    if (!session) throw new Error('会话已不存在，请刷新列表。');
    return { adapter: this.adapters.get(managerId)!, session };
  }
  private resolveWindow(session: SessionInfo, id: unknown): WindowInfo {
    const window = session.windows?.find(window => window.id === id);
    if (!window) throw new Error('此 window 已不存在，请刷新列表。');
    return window;
  }
  private async cwd(): Promise<string> {
    const configured = vscode.workspace.getConfiguration('muxdock').get<string>('defaultDirectory', '');
    const directory = configured ? configured.replace(/^~(?=\/)/, os.homedir()) : vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || os.homedir();
    if (!(await stat(directory)).isDirectory()) throw new Error(`工作目录不存在：${directory}`);
    return directory;
  }
  private async linkDirectories(key: string): Promise<string[]> {
    const connection = this.connections.list().find(info => info.key === key);
    const directories: string[] = [];
    if (connection?.manager === 'tmux' && !connection.closed) {
      const result = await run(this.adapters.get('tmux')!.command(['display-message', '-p', '-t', connection.sessionId, '#{pane_current_path}']));
      const directory = result.stdout.trim();
      if (!result.code && path.isAbsolute(directory)) directories.push(directory);
    }
    if (connection?.cwd) directories.push(connection.cwd);
    directories.push(...(vscode.workspace.workspaceFolders || []).map(folder => folder.uri.fsPath), await this.cwd());
    return [...new Set(directories)];
  }
  private async openTerminalLink(key: string, value: string) {
    if (key !== this.connections.activeKey) return;
    const target = parseTerminalLink(value);
    if (target?.kind === 'web') { await vscode.env.openExternal(vscode.Uri.parse(target.uri)); return; }
    if (target?.kind !== 'file') return;
    const location = await resolveFileLink(value, await this.linkDirectories(key));
    if (!location) throw new Error('链接对应的文件或目录不存在。');
    const uri = vscode.Uri.file(location.path);
    if (location.directory) { await vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow: true }); return; }
    const position = new vscode.Position((location.line || 1) - 1, (location.column || 1) - 1);
    await vscode.window.showTextDocument(uri, { preview: true, selection: new vscode.Range(position, position) });
  }
  private async connect(managerId: ManagerId, session: SessionInfo, create = false, revision = this.activationRevision) {
    return this.queueConnections(async () => {
      if (!create && revision !== this.activationRevision) return;
      if (process.platform === 'win32') throw new Error('请在 Remote WSL 或 Remote SSH 的 Linux 工作区使用这些管理器。');
      const adapter = this.adapters.get(managerId)!;
      const existing = this.connections.find(managerId, session);
      if (managerId === 'shpool' && session.attached && (!existing || existing.closed)) throw new Error('shpool 会话已有客户端连接。请先在原终端断开，再在这里连接。');
      if (existing?.closed) this.connections.disconnect(existing.key);
      if (!existing || existing.closed) await this.trimTabs(this.maxTabs() - 1);
      await this.launchTask;
      const shell = this.launchSettings.shell && this.shells.includes(this.launchSettings.shell) ? this.launchSettings.shell : this.defaultShell;
      const command = this.launchSettings.commands.find(item => item.id === this.launchSettings.commandId)?.command;
      const executable = create ? await launchExecutable(shell, command, path.join(this.context.globalStorageUri.fsPath, 'launchers')) : shell;
      const cwd = await this.cwd();
      if (!create && revision !== this.activationRevision) return;
      const previous = this.connections.activeKey;
      const connection = this.connections.connect(managerId, session, create ? adapter.create(session.name, executable, shell) : adapter.attach(session), cwd);
      if (revision !== this.activationRevision && previous) this.connections.select(previous);
      this.publish();
      if (revision === this.activationRevision) this.post({ type: 'focus', key: connection.key });
      setTimeout(() => { if (!this.disposed) void this.refresh(); }, 400);
    });
  }
  private async saveLaunchSettings(settings: LaunchSettings) {
    this.launchSettings = settings;
    await this.context.globalState.update('launchSettings', settings);
    this.publish();
  }
  private async selectLaunchProfile(id: string) {
    await this.launchTask;
    const profile = this.snapshot().launchProfiles.find(profile => profile.id === id);
    if (!profile) return;
    if (profile.kind === 'shell') await this.saveLaunchSettings({ ...this.launchSettings, shell: id === 'system' ? undefined : id.slice(6), commandId: undefined });
    else await this.saveLaunchSettings({ ...this.launchSettings, commandId: id.slice(8) });
  }
  private async addLaunchCommand() {
    if (this.busy) return;
    this.busy = true;
    try {
      const value = await vscode.window.showInputBox({ title: '添加启动命令', prompt: '新建会话时在所选 shell 中执行；退出命令后可继续使用 shell。', placeHolder: 'codex', ignoreFocusOut: true, validateInput: validateLaunchCommand });
      if (!value) return;
      const command = value.trim();
      const existing = this.launchSettings.commands.find(item => item.command === command);
      const item = existing || { id: randomUUID(), command };
      await this.saveLaunchSettings({ ...this.launchSettings, commands: existing ? this.launchSettings.commands : [...this.launchSettings.commands, item], commandId: item.id });
    } finally { this.busy = false; }
  }
  async newSession(preferred?: ManagerId) {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.refresh();
      const available = this.managers.filter(manager => manager.available && this.visibleManagers().includes(manager.id));
      const selected = preferred ? available.find(manager => manager.id === preferred) : await vscode.window.showQuickPick(available.map(manager => ({ label: manager.name, description: manager.version, id: manager.id })), { placeHolder: '选择终端管理器', ignoreFocusOut: true });
      if (!selected) {
        if (!available.length) void vscode.window.showInformationMessage('没有可用的所选管理器。请在 MuxDock 设置中选择要显示的管理器，或安装后刷新。');
        return;
      }
      const name = await vscode.window.showInputBox({ title: `新建 ${LABELS[selected.id]} 会话`, prompt: '输入会话名称', placeHolder: 'my-project', ignoreFocusOut: true, validateInput: value => {
        const error = validateName(value);
        if (error) return error;
        if (selected.id === 'tmux' && value.includes('.')) return 'tmux 会将点替换为下划线，请直接使用下划线。';
        if (this.managers.find(manager => manager.id === selected.id)?.sessions.some(session => session.name === value)) return '此名称已经存在。';
        return undefined;
      } });
      if (!name) return;
      const revision = ++this.activationRevision;
      await this.refresh();
      if (this.managers.find(manager => manager.id === selected.id)?.sessions.some(session => session.name === name)) throw new Error('此名称已被其他终端创建，请选择已有会话。');
      await vscode.commands.executeCommand('muxdock.dock.focus');
      await this.connect(selected.id, { id: name, name }, true, revision);
    } finally { this.busy = false; }
  }
  private async receive(message: unknown) {
    if (!message || typeof message !== 'object' || !('type' in message)) return;
    const m = message as Record<string, unknown>;
    if (m.type === 'ready') {
      await this.launchTask;
      this.ready = true;
      this.connections.setDeliveryEnabled(true);
      this.publish();
      for (const connection of this.connections.list()) { const replay = this.connections.replay(connection.key); if (replay) this.post(replay); }
      await this.refresh();
      return;
    }
    if (m.type === 'input' && typeof m.key === 'string' && typeof m.data === 'string' && m.data.length <= 1024 * 1024) { this.connections.input(m.key, m.data); return; }
    if (m.type === 'ack' && typeof m.key === 'string' && typeof m.seq === 'number') { this.connections.acknowledge(m.key, m.seq); return; }
    if (m.type === 'resize' && typeof m.key === 'string') { this.connections.resize(m.key, Number(m.cols), Number(m.rows)); return; }
    if (m.type === 'refresh') { await this.refresh(true); return; }
    if (m.type === 'newSession') { await this.newSession(isManagerId(m.manager) ? m.manager : undefined); return; }
    if (m.type === 'selectLaunchProfile' && typeof m.id === 'string') { await this.selectLaunchProfile(m.id); return; }
    if (m.type === 'addLaunchCommand') { await this.addLaunchCommand(); return; }
    if (m.type === 'removeLaunchCommand' && typeof m.id === 'string' && m.id.startsWith('command:')) {
      const id = m.id.slice(8);
      await this.saveLaunchSettings({ ...this.launchSettings, commands: this.launchSettings.commands.filter(item => item.id !== id), commandId: this.launchSettings.commandId === id ? undefined : this.launchSettings.commandId });
      return;
    }
    if (m.type === 'settings') { await vscode.commands.executeCommand('muxdock.settings', m.fontsOnly === true); return; }
    if (m.type === 'showUnavailable') {
      await vscode.workspace.getConfiguration('muxdock').update('showUnavailable', !!m.value, vscode.ConfigurationTarget.Global);
      this.publish(); return;
    }
    if (m.type === 'openLink' && typeof m.key === 'string' && typeof m.url === 'string') { await this.openTerminalLink(m.key, m.url); return; }
    if (m.type === 'resolveLinks' && typeof m.key === 'string' && Number.isSafeInteger(m.request) && Array.isArray(m.targets) && this.connections.list().some(info => info.key === m.key)) {
      const targets = m.targets.filter((value): value is string => typeof value === 'string').slice(0, 32);
      const directories = await this.linkDirectories(m.key);
      const links = await Promise.all(targets.map(async input => {
        const file = await resolveFileLink(input, directories);
        return file ? { input, target: vscode.Uri.file(file.path).toString() + (file.line ? `#L${file.line}${file.column ? `C${file.column}` : ''}` : '') } : undefined;
      }));
      this.post({ type: 'resolvedLinks', key: m.key, request: m.request, links: links.filter(Boolean) }); return;
    }
    if (m.type === 'terminalCwd' && typeof m.key === 'string' && typeof m.url === 'string') {
      const target = parseTerminalLink(m.url);
      if (target?.kind === 'file' && path.isAbsolute(target.path)) this.connections.setCwd(m.key, target.path);
      return;
    }
    if (m.type === 'copy' && typeof m.text === 'string') { await vscode.env.clipboard.writeText(m.text); return; }
    if (m.type === 'terminalCopy' && typeof m.key === 'string' && typeof m.text === 'string') {
      if (m.key === this.connections.activeKey && Buffer.byteLength(m.text, 'utf8') <= MAX_TERMINAL_CLIPBOARD_BYTES && this.connections.list().some(info => info.key === m.key && !info.closed)) await vscode.env.clipboard.writeText(m.text);
      return;
    }
    if (m.type === 'paste' && typeof m.key === 'string' && m.key === this.connections.activeKey) { this.post({ type: 'paste', key: m.key, text: await vscode.env.clipboard.readText() }); return; }
    if ((m.type === 'disconnect' || m.type === 'closeTab') && typeof m.key === 'string') {
      await this.queueConnections(() => this.closeConnection(m.key as string, m.type === 'disconnect'));
      this.publish(); await this.refresh(); return;
    }
    if (m.type === 'activate' && typeof m.key === 'string') {
      const revision = ++this.activationRevision;
      await this.queueConnections(async () => {
        if (revision !== this.activationRevision) return;
        this.connections.select(m.key as string);
        if (m.focus !== false && m.key === this.connections.activeKey) this.post({ type: 'focus', key: m.key });
      });
      return;
    }
    if (m.type === 'attach' || m.type === 'rename' || m.type === 'kill' || m.type === 'window') {
      const revision = m.type === 'attach' || (m.type === 'window' && m.action === 'select') ? ++this.activationRevision : undefined;
      await this.refresh();
      if (revision !== undefined && revision !== this.activationRevision) return;
      const { adapter, session } = this.resolveSession(m.manager, m.session);
      if (m.type === 'attach') { await this.connect(adapter.id, session, false, revision); return; }
      if (m.type === 'rename') {
        const name = await vscode.window.showInputBox({ title: '重命名会话', value: session.name, ignoreFocusOut: true, validateInput: value => validateName(value) || (value.includes('.') ? 'tmux 会话名请使用下划线代替点。' : undefined) });
        if (name && name !== session.name) await adapter.rename(session, name);
      } else if (m.type === 'kill') {
        const confirm = await vscode.window.showWarningMessage(`结束会话“${session.name}”？其中运行的程序也会结束。`, { modal: true }, '结束会话');
        if (confirm === '结束会话') {
          await this.queueConnections(async () => {
            await adapter.kill(session);
            this.connections.closeSession(adapter.id, session.id);
          });
        }
      } else if (m.type === 'window') {
        if (adapter.id !== 'tmux') return;
        if (!['select', 'new', 'rename', 'kill'].includes(String(m.action))) return;
        const action = m.action as 'select' | 'new' | 'rename' | 'kill';
        const window = action !== 'new' ? this.resolveWindow(session, m.window) : undefined;
        if (action === 'select') { await this.connect(adapter.id, session, false, revision); if (revision === this.activationRevision) await adapter.windowAction(action, session, window); }
        if (action === 'new' || action === 'rename') {
          const name = await vscode.window.showInputBox({ title: action === 'new' ? '新建 tmux window' : '重命名 tmux window', value: window?.name, ignoreFocusOut: true, validateInput: validateName });
          if (name) await adapter.windowAction(action, session, window, name);
        }
        if (action === 'kill') {
          const confirm = await vscode.window.showWarningMessage(`关闭 window“${window!.name}”？其中的程序也会结束。`, { modal: true }, '关闭 window');
          if (confirm === '关闭 window') await adapter.windowAction(action, session, window);
        }
      }
      await this.refresh();
    }
  }
  private error(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    this.log.appendLine(message);
    this.post({ type: 'error', message });
    void vscode.window.showErrorMessage(`MuxDock：${message}`);
  }
  async shutdown() {
    await this.connectionTask;
    await Promise.all(this.connections.list().filter(info => info.manager === 'shpool' && !info.closed).map(info => this.adapters.get('shpool')!.detach({ id: info.sessionId, name: info.name }).catch(() => {})));
    this.dispose();
  }
  dispose() { this.disposed = true; if (this.timer) clearInterval(this.timer); this.connections.dispose(); }
}
