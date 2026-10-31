import { t } from './i18n';
import type { Command, DetailField, ManagerId, ManagerInfo, SessionDetails, SessionInfo, WindowInfo } from './model';
import { findExecutable, requireSuccess, run, type Runner } from './runner';
import { shellQuote } from './launch';
import { positiveNumber, processDetails, sessionPath, timestamp, tmuxDetails, tmuxPaneFormat, tmuxSessionFormat, zmxRecords } from './session-details';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { detachZellijClients } from './session-control';
import { createHerdrSession, herdrResult, herdrSnapshot, herdrWindows, parseHerdrSessions } from './herdr';
export { parseHerdrSessions } from './herdr';

export const LABELS: Record<ManagerId, string> = { tmux: 'tmux', psmux: 'psmux', zmx: 'zmx', screen: 'screen', zellij: 'Zellij', herdr: 'Herdr', shpool: 'shpool', abduco: 'abduco', a4: 'a4' };
export const stripAnsi = (text: string) => text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
// The Windows tmux port joins argv with spaces before CreateProcessW.
// Supply its missing quoting layer, separately from Node's CLI argv quoting.
export const windowsTmuxArg = (value: string) => {
  if (/[^\x20-\x7e]/.test(value)) throw new Error(t('tmuxWindowsText'));
  return !/[\s"]/.test(value) && value ? value : `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
};

export function parseTmuxSessions(text: string): SessionInfo[] {
  return text.trim().split(/\r?\n/).flatMap(line => {
    const [id, attached, ...nameParts] = line.split('|');
    const name = nameParts.join('|');
    return /^\$\d+$/.test(id) && name ? [{ id, name, attached: Number(attached) || 0, windows: [] }] : [];
  });
}
export function parseTmuxWindows(text: string): Map<string, WindowInfo[]> {
  const result = new Map<string, WindowInfo[]>();
  for (const line of text.trim().split(/\r?\n/)) {
    const [session, id, index, active, panes, ...nameParts] = line.split('|');
    const name = nameParts.join('|');
    if (!/^\$\d+$/.test(session) || !/^@\d+$/.test(id) || !name) continue;
    const windows = result.get(session) || [];
    windows.push({ id, index: Number(index), name, active: active === '1', panes: Number(panes) || 1 });
    result.set(session, windows);
  }
  return result;
}
export function parseZmx(text: string): SessionInfo[] {
  return zmxRecords(text).flatMap(fields => {
    if (!fields.name) return [];
    return [{ id: fields.name, name: fields.name, attached: Number(fields.clients) || 0, detail: sessionPath(fields.cwd || fields.dir) }];
  });
}
export function parseScreen(text: string): SessionInfo[] {
  return text.split('\n').flatMap(line => {
    const state = line.match(/\((Attached|Detached|Multi[^)]*)\)\s*$/i)?.[1];
    if (!state) return [];
    const socket = line.trimStart().split('\t')[0].replace(/\s+\([^)]*\)(?:\s+\([^)]*\))?\s*$/, '').trim();
    if (!/^\d+\..+/.test(socket)) return [];
    return [{ id: socket, name: socket.replace(/^\d+\./, ''), attached: /^(Attached|Multi.*attached)/i.test(state) ? 1 : 0 }];
  });
}
export function parseZellij(text: string): SessionInfo[] {
  return stripAnsi(text).split('\n').flatMap(line => {
    const value = line.trim();
    if (!value || /EXITED|no active|no sessions/i.test(value)) return [];
    const name = value.replace(/\s+\[(?:Created|created)[\s\S]*$/, '').replace(/\s+\(current\).*$/, '');
    return [{ id: name, name }];
  });
}
export function parseShpool(text: string): SessionInfo[] {
  if (!text.trim()) return [];
  const parsed: unknown = JSON.parse(text);
  const rows = Array.isArray(parsed) ? parsed : (parsed as { sessions?: unknown[] }).sessions;
  if (!Array.isArray(rows)) throw new Error(t('shpoolJson'));
  return rows.flatMap(row => {
    if (!row || typeof row !== 'object' || typeof row.name !== 'string') return [];
    return [{ id: row.name, name: row.name, attached: String(row.status).toLowerCase() === 'attached' ? 1 : 0 }];
  });
}
export function parseAbduco(text: string): SessionInfo[] {
  return text.split('\n').flatMap(line => {
    if (/^\s*\+/.test(line) || !/\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}/.test(line)) return [];
    const fields = line.split('\t');
    // abduco 0.6 has date + name; newer builds also include the server PID.
    const name = fields.at(-1)?.trim();
    return name ? [{ id: name, name, attached: line.trimStart().startsWith('*') ? 1 : 0 }] : [];
  });
}
export function parseA4(text: string): SessionInfo[] {
  return text.split('\n').flatMap(line => {
    if (!/\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}/.test(line)) return [];
    const name = line.split('\t').at(-1)?.trim();
    return name ? [{ id: name, name }] : [];
  });
}

export interface AdapterSettings { executable?: string; args?: string[] }
export function parseZellijTabs(output: string): WindowInfo[] {
  const rows: unknown = JSON.parse(output);
  if (!Array.isArray(rows)) throw new Error(t('readWindowsFailed'));
  return rows.filter(row => Number.isSafeInteger(row.tab_id) && Number.isSafeInteger(row.position) && typeof row.name === 'string')
    .map(row => ({ id: String(row.tab_id), index: row.position, name: row.name, active: !!row.active,
      panes: (Number(row.selectable_tiled_panes_count) || 0) + (Number(row.selectable_floating_panes_count) || 0) }));
}
export class Adapter {
  private executable?: string;
  private version?: string;
  private probed = false;
  private probeError?: string;
  private readonly execute: Runner;
  private get tmuxCompatible() { return this.id === 'tmux' || this.id === 'psmux'; }
  readonly capabilities: ManagerInfo['capabilities'];
  constructor(readonly id: ManagerId, private settings: AdapterSettings = {}, execute: Runner = run, private platform = process.platform,
    private inspectProcesses?: (settings: { manager: string; name: string; file: string; detach?: boolean }) => Promise<{ serverPid: number; shellPid?: number; terminalPids: number[]; clients: number[]; createdAt?: string; socket: string }>,
    private locateExecutable: typeof findExecutable = findExecutable) {
    // Windows Zellij pairs separate command/reply pipes. Keep our CLI clients
    // ordered when a refresh overlaps details, tab actions or file drops.
    let pending: Promise<unknown> = Promise.resolve();
    this.execute = id === 'zellij' && platform === 'win32' ? command => {
      const task = pending.then(() => execute(command)); pending = task.catch(() => {}); return task;
    } : execute;
    this.capabilities = { rename: this.tmuxCompatible, kill: ['tmux', 'psmux', 'zmx', 'screen', 'zellij', 'herdr', 'shpool'].includes(id), windows: this.tmuxCompatible || id === 'herdr', detachAll: id !== 'herdr' && (id !== 'zellij' || platform !== 'win32') };
  }
  configure(settings: AdapterSettings) { this.settings = settings; this.probed = false; }
  command(args: string[]): Command {
    if (!this.executable) throw new Error(t('executableMissing', { manager: LABELS[this.id] }));
    return { file: this.executable, args: [...(this.settings.args || []), ...args] };
  }
  private clientCommand(args: string[]): Command {
    const version = this.id === 'tmux' && /tmux (?:next-)?(\d+)\.(\d+)/.exec(this.version || '');
    if (version) {
      const major = Number(version[1]); const minor = Number(version[2]);
      if (major > 3 || major === 3 && minor >= 4) return this.command(['-T', 'RGB,hyperlinks,osc7', ...args]);
      if (major === 3 && minor >= 2) return this.command(['-T', 'RGB', ...args]);
    }
    return this.command(args);
  }
  async probe(force = false): Promise<boolean> {
    if (this.probed && !force) return !!this.executable;
    this.probed = true;
    this.executable = undefined; this.version = undefined; this.probeError = undefined;
    if (this.platform === 'win32' && !['tmux', 'psmux', 'zellij', 'herdr'].includes(this.id) || this.platform !== 'win32' && this.id === 'psmux') {
      this.probeError = t('managerPlatform'); return false;
    }
    this.executable = await this.locateExecutable(this.id, this.settings.executable, this.id === 'tmux' && this.platform === 'win32' ? async file => {
      const result = await this.execute({ file, args: ['-V'] });
      // psmux also ships a tmux.exe alias. Only the native tmux port belongs here.
      return result.code === 0 && /^tmux .*win32/im.test(result.stdout) && !/psmux/i.test(result.stdout + result.stderr);
    } : undefined);
    if (!this.executable) return false;
    const flags = this.id === 'tmux' ? ['-V'] : ['zmx', 'shpool'].includes(this.id) ? ['version'] : ['screen', 'abduco', 'a4'].includes(this.id) ? ['-v'] : ['--version'];
    const result = await this.execute(this.command(flags));
    const output = stripAnsi(`${result.stdout}\n${result.stderr}`).trim();
    this.version = (this.id === 'psmux' ? output.split(/\r?\n/).find(line => /^psmux /i.test(line)) : output.split(/\r?\n/)[0])?.slice(0, 100);
    if (result.code) { this.probeError = output; this.executable = undefined; return false; }
    if (this.id === 'psmux' && !this.version) { this.probeError = t('psmuxExecutable'); this.executable = undefined; return false; }
    if (this.id === 'herdr') {
      const version = /^herdr\s+(\d+)\.(\d+)\.(\d+)/i.exec(this.version || '');
      if (!version || !(Number(version[1]) > 0 || Number(version[2]) > 9 || Number(version[2]) === 9 && Number(version[3]) >= 5)) {
        this.probeError = t('herdrVersion'); this.executable = undefined; return false;
      }
    }
    if (this.id === 'zellij') {
      const version = /zellij (\d+)\.(\d+)\.(\d+)/i.exec(this.version || '');
      const modern = !!version && (Number(version[1]) > 0 || Number(version[2]) > 45 || Number(version[2]) === 45 && Number(version[3]) >= 1);
      this.capabilities.windows = modern;
      // The Windows dual-pipe contract is verified against this release only.
      this.capabilities.detachAll = this.platform !== 'win32' || version?.[0].toLowerCase() === 'zellij 0.45.1';
      if (this.platform === 'win32' && !modern) { this.probeError = t('zellijWindowsVersion'); this.executable = undefined; return false; }
    }
    return true;
  }
  async list(force = false): Promise<ManagerInfo> {
    const base: ManagerInfo = { id: this.id, name: LABELS[this.id], available: await this.probe(force), version: this.version, sessions: [], capabilities: this.capabilities };
    base.error = this.probeError;
    if (!base.available) return base;
    try { base.sessions = await this.listSessions(); }
    catch (error) { base.error = error instanceof Error ? error.message : String(error); }
    return base;
  }
  private async listSessions(): Promise<SessionInfo[]> {
    const commands: Record<ManagerId, string[]> = {
      tmux: ['-u', 'list-sessions', '-F', '#{session_id}|#{session_attached}|#{session_name}'],
      psmux: ['-u', 'list-sessions', '-F', '#{session_id}|#{session_attached}|#{session_name}'],
      zmx: ['list'], screen: ['-ls'], zellij: ['list-sessions', '--no-formatting'],
      shpool: ['list', '--json'], abduco: [], a4: ['-l'], herdr: ['session', 'list', '--json']
    };
    const result = await this.execute(this.command(commands[this.id]));
    // GNU/macOS screen uses the exit status as a socket-count/status code, even for valid lists.
    if (this.id === 'screen' && parseScreen(result.stdout).length) return parseScreen(result.stdout);
    if (result.code && /no server running|no sessions|no sockets found|no active.*sessions|error connecting.*(?:No such file|Connection refused)/i.test(`${result.stderr}\n${result.stdout}`)) return [];
    const output = requireSuccess(result, t('readSessionsFailed'));
    if (this.tmuxCompatible) {
      const sessions = parseTmuxSessions(output);
      if (!sessions.length) return [];
      const windowResult = await this.execute(this.command(['-u', 'list-windows', '-a', '-F', '#{session_id}|#{window_id}|#{window_index}|#{window_active}|#{window_panes}|#{window_name}']));
      const windows = parseTmuxWindows(requireSuccess(windowResult, t('readWindowsFailed')));
      return sessions.map(session => ({ ...session, windows: windows.get(session.id) || [] }));
    }
    if (this.id === 'herdr') {
      const sessions = parseHerdrSessions(output);
      for (const session of sessions) {
        const snapshot = await this.herdrSnapshot(session);
        session.windows = herdrWindows(snapshot);
        session.detail = snapshot.panes.find(pane => pane.pane_id === snapshot.focused_pane_id)?.cwd;
      }
      return sessions;
    }
    const parsers = { zmx: parseZmx, screen: parseScreen, zellij: parseZellij, shpool: parseShpool, abduco: parseAbduco, a4: parseA4 };
    const sessions = parsers[this.id as keyof typeof parsers](output);
    if (this.id === 'zellij' && this.capabilities.windows) {
      for (const session of sessions) {
        const tabs = await this.execute(this.command(['--session', session.name, 'action', 'list-tabs', '--all', '--json']));
        session.windows = parseZellijTabs(requireSuccess(tabs, t('readWindowsFailed')));
      }
    }
    return sessions;
  }
  attach(session: SessionInfo): Command {
    const commands: Record<ManagerId, string[]> = {
      tmux: ['attach-session', '-t', session.id], zmx: ['attach', session.name],
      psmux: ['attach-session', '-t', session.name],
      screen: ['-x', session.id], zellij: ['attach', session.name], shpool: ['attach', session.name],
      abduco: ['-a', session.name], a4: ['-a', session.name], herdr: ['--session', session.name]
    };
    return this.clientCommand(commands[this.id]);
  }
  async shellDialect(session: SessionInfo): Promise<'powershell' | 'cmd' | undefined> {
    if (this.platform !== 'win32') return;
    if (this.id === 'herdr') {
      const snapshot = await this.herdrSnapshot(session);
      if (!snapshot.focused_pane_id) return;
      const info = herdrResult(requireSuccess(await this.execute(this.command(['--session', session.name, 'pane', 'process-info', '--pane', snapshot.focused_pane_id])), t('readProcessesFailed'))).process_info;
      const shell = info?.foreground_processes?.find((item: { pid: number }) => item.pid === info.shell_pid)?.argv0 || '';
      if (/(?:^|[\\/])(?:pwsh|powershell)(?:\.exe)?$/i.test(shell)) return 'powershell';
      if (/(?:^|[\\/])cmd(?:\.exe)?$/i.test(shell)) return 'cmd';
      return;
    }
    const result = await this.execute(this.command(this.tmuxCompatible
      ? ['display-message', '-p', '-t', session.id, '#{pane_start_command}']
      : ['--session', session.name, 'action', 'list-panes', '--all', '--json']));
    if (result.code) return;
    let command = result.stdout.trim();
    if (this.id === 'zellij') {
      const panes = JSON.parse(command);
      const activeTabs = (await this.listSessions()).find(item => item.id === session.id)?.windows?.filter(item => item.active).map(item => item.id);
      const pane = panes.find((pane: { is_plugin: boolean; is_focused: boolean; tab_id: number }) => !pane.is_plugin && pane.is_focused && activeTabs?.includes(String(pane.tab_id)));
      command = pane?.terminal_command || pane?.pane_command || '';
    }
    if (/(?:^|[\\/"\s])(?:pwsh|powershell)(?:\.exe)?(?:["\s]|$)/i.test(command)) return 'powershell';
    if (/(?:^|[\\/"\s])cmd(?:\.exe)?(?:["\s]|$)/i.test(command)) return 'cmd';
  }
  create(name: string, shell: string, environmentShell = shell, shellArgs?: string[]): Command {
    if (this.id === 'herdr') throw new Error(t('herdrNotReady'));
    if (this.id === 'tmux' && this.platform === 'win32') windowsTmuxArg(name);
    const args = shellArgs || (this.platform === 'win32' ? [] : ['-l']);
    const commands: Record<ManagerId, string[]> = {
      tmux: ['new-session', '-s', name, ...(this.id === 'tmux' && this.platform === 'win32' ? ['--', windowsTmuxArg(shell), ...(args.length ? args.map(windowsTmuxArg) : [''])] : [shell, '-l'])], zmx: ['attach', name, shell, '-l'], screen: ['-S', name, shell, '-l'],
      psmux: ['new-session', '-s', name, '--', shell, ...args],
      zellij: this.platform === 'win32' ? ['attach', '--create', name, '--', shell, ...args] : ['--session', name, 'options', '--default-shell', shell],
      shpool: ['attach', '--dir', '.', '--cmd', ['/usr/bin/env', `SHELL=${shell}`, shell, '-l'].map(shellQuote).join(' '), name],
      abduco: ['-c', name, shell, '-l'], a4: ['-a', name], herdr: []
    };
    return { ...this.clientCommand(commands[this.id]), env: { SHELL: this.id === 'a4' ? shell : environmentShell } };
  }
  async createHerdr(name: string, shell: string, startup: string | undefined, cwd: string, storage: string): Promise<Command> {
    return createHerdrSession(args => this.command(args), this.execute, name, shell, startup, cwd, storage);
  }
  private async herdrSnapshot(session: SessionInfo) {
    return herdrSnapshot(requireSuccess(await this.execute(this.command(['--session', session.name, 'api', 'snapshot'])), t('readDetailsFailed')));
  }
  async rename(session: SessionInfo, name: string): Promise<void> {
    if (!this.capabilities.rename) throw new Error(t('renameUnsupported'));
    if (this.id === 'tmux' && this.platform === 'win32') windowsTmuxArg(name);
    requireSuccess(await this.execute(this.command(['rename-session', '-t', session.id, name])), t('renameFailed'));
  }
  async kill(session: SessionInfo): Promise<void> {
    if (!this.capabilities.kill) throw new Error(t('exitToEnd'));
    const commands: Partial<Record<ManagerId, string[]>> = {
      tmux: ['kill-session', '-t', session.id], zmx: ['kill', session.name], screen: ['-S', session.id, '-X', 'quit'],
      psmux: ['kill-session', '-t', session.id],
      zellij: ['kill-session', session.name], shpool: ['kill', session.name], herdr: ['session', 'stop', session.name, '--json']
    };
    requireSuccess(await this.execute(this.command(commands[this.id]!)), t('killFailed'));
  }
  async detach(session: SessionInfo): Promise<void> {
    // shpool can retain a stale attachment after its client receives SIGHUP.
    if (this.id !== 'shpool') return;
    requireSuccess(await this.execute(this.command(['detach', session.name])), t('shpoolDetachFailed'));
    for (let attempt = 0; attempt < 30; attempt++) {
      const current = (await this.listSessions()).find(item => item.id === session.id);
      if (!current || !current.attached) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(t('shpoolNotReleased'));
  }
  async detachAll(session: SessionInfo): Promise<void> {
    if (!this.capabilities.detachAll) throw new Error(t('detachUnsupported'));
    if (this.id === 'shpool') { await this.detach(session); return; }
    if (this.id === 'abduco' || this.id === 'a4') {
      await this.sessionProcesses(session, true);
      return;
    }
    if (this.id === 'zellij') {
      const processes = this.platform === 'win32' ? { socket: this.zellijSocket(session) } : await this.sessionProcesses(session);
      for (let attempt = 0; attempt < 10; attempt++) {
        const clients = requireSuccess(await this.execute(this.command(['--session', session.name, 'action', 'list-clients'])), t('readClientsFailed'));
        const ids = clients.split('\n').flatMap(line => { const match = /^\s*(\d+)\s/.exec(line); return match ? [Number(match[1])] : []; });
        if (!ids.length) return;
        if (processes.socket.replaceAll('\\', '/').includes('/contract_version_1/')) await detachZellijClients(processes.socket, ids, this.platform);
        else await this.sessionProcesses(session, true);
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw new Error(t('zellijStillAttached'));
    }
    const command = this.tmuxCompatible ? this.command(['detach-client', '-s', this.id === 'psmux' ? session.name : session.id])
      : this.id === 'screen' ? this.command(['-S', session.id, '-X', 'at', '%', 'detach'])
      : { ...this.command(['detach']), env: { ZMX_SESSION: session.name } };
    requireSuccess(await this.execute(command), t('detachFailed'));
    if (this.id === 'psmux') {
      for (let attempt = 0; attempt < 30; attempt++) {
        const clients = requireSuccess(await this.execute(this.command(['display-message', '-p', '-t', session.id, '#{session_attached}'])), t('readClientsFailed')).trim();
        if (clients === '0') return;
        // Under load psmux can leave one client after accepting detach-client.
        // Retry the same session-scoped request, then verify the actual count.
        if (attempt % 3 === 2) requireSuccess(await this.execute(command), t('detachFailed'));
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw new Error(t('detachFailed'));
    }
  }
  private zellijSocket(session: SessionInfo): string {
    if (!session.name || /[\\/\x00-\x1f]/.test(session.name) || session.name === '.' || session.name === '..') throw new Error(t('nameInvalid'));
    const socket = path.join(process.env.ZELLIJ_SOCKET_DIR || path.join(os.tmpdir(), 'zellij'), 'contract_version_1', session.name);
    if (!existsSync(socket)) throw new Error(t('sessionGone'));
    return socket;
  }
  private async sessionProcesses(session: SessionInfo, detach = false): Promise<{ serverPid: number; shellPid?: number; terminalPids: number[]; clients: number[]; createdAt?: string; socket: string }> {
    if (this.inspectProcesses) return this.inspectProcesses({ manager: this.id, name: session.name, file: this.command([]).file, detach });
    const python = await findExecutable('python3');
    const script = [path.join(__dirname, 'session-processes.py'), path.join(__dirname, '../src/session-processes.py')].find(existsSync);
    if (!python || !script) throw new Error(t('pythonRequired'));
    const output = requireSuccess(await this.execute({ file: python, args: [script, JSON.stringify({ manager: this.id, name: session.name, file: this.command([]).file, detach })] }), t('readProcessesFailed'));
    return JSON.parse(output);
  }
  async details(session: SessionInfo, window?: WindowInfo): Promise<SessionDetails> {
    if (this.id === 'herdr') {
      const snapshot = await this.herdrSnapshot(session);
      const sections: SessionDetails['sections'] = [{ fields: [{ label: 'manager', value: 'Herdr' }, { label: 'sessionName', value: session.name },
        { label: 'sessionId', value: session.id }, { label: 'windowCount', value: snapshot.tabs.length }] }];
      for (const pane of snapshot.panes.filter(pane => !window || pane.tab_id === window.id)) {
        const tab = snapshot.tabs.find(tab => tab.tab_id === pane.tab_id);
        const info = herdrResult(requireSuccess(await this.execute(this.command(['--session', session.name, 'pane', 'process-info', '--pane', pane.pane_id])), t('readProcessesFailed'))).process_info;
        sections.push({ title: `${tab?.label || pane.tab_id} · ${pane.pane_id}`, fields: [
          { label: 'paneId', value: pane.pane_id }, { label: 'windowId', value: pane.tab_id }, { label: 'title', value: pane.terminal_title_stripped },
          { label: 'cwd', value: pane.foreground_cwd || pane.cwd }, { label: 'terminalPid', value: info?.shell_pid },
          { label: 'runningCommand', value: info?.foreground_processes?.map((process: { cmdline?: string }) => process.cmdline).filter(Boolean).join('\n') },
          { label: 'agentStatus', value: pane.agent_status }
        ] });
      }
      return { title: window ? t('windowDetails') : t('sessionDetails'), sections, note: t('detailsNote') };
    }
    if (this.tmuxCompatible) {
      const target = window ? `${session.id}:${window.id}` : session.id;
      const [info, panes] = await Promise.all([
        this.execute(this.command(['-u', 'display-message', '-p', '-t', target, tmuxSessionFormat])),
        this.execute(this.command(['-u', 'list-panes', ...(window ? [] : ['-s']), '-t', target, '-F', tmuxPaneFormat]))
      ]);
      const details = tmuxDetails(requireSuccess(info, t('readDetailsFailed')), requireSuccess(panes, t('readPanesFailed')), window);
      details.sections[0].fields.find(field => field.label === 'manager')!.value = LABELS[this.id];
      if (this.platform === 'win32') details.note = t('windowsCwdNote');
      return details;
    }
    if (this.id !== 'zmx') {
      const current = (await this.listSessions()).find(item => item.id === session.id);
      if (!current) throw new Error(t('sessionGone'));
      session = current;
    }
    const fields: DetailField[] = [
      { label: 'manager', value: LABELS[this.id] }, { label: 'sessionName', value: session.name }, { label: 'sessionId', value: session.id },
      { label: 'clientCount', value: session.attached }
    ];
    let pid: number | undefined, shellPid: number | undefined, cwd: string | undefined, created: string | undefined;
    const sections: SessionDetails['sections'] = [{ fields }];
    if (this.id === 'zmx') {
      const records = zmxRecords(requireSuccess(await this.execute(this.command(['list'])), t('readDetailsFailed')));
      const record = records.find(record => record.name === session.name);
      if (!record) throw new Error(t('sessionGone'));
      pid = positiveNumber(record.pid); cwd = sessionPath(record.cwd || record.dir); created = timestamp(record.created);
      fields.find(field => field.label === 'clientCount')!.value = record.clients;
    } else if (this.id === 'screen') {
      const attachment = fields.find(field => field.label === 'clientCount')!;
      attachment.label = 'clientStatus'; attachment.value = session.attached ? t('connected') : t('disconnected');
      pid = positiveNumber(session.id.split('.')[0]);
      const processes = await this.execute({ file: 'ps', args: ['-axo', 'pid=,ppid='] });
      const children = processes.stdout.split('\n').flatMap(line => {
        const [child, parent] = line.trim().split(/\s+/).map(Number);
        return parent === pid && child > 1 ? [child] : [];
      });
      for (const child of children) sections.push({ title: t('terminalProcess', { pid: child }), fields: [{ label: 'processPid', value: child }, ...await processDetails(child, this.execute, true)] });
      const started = pid && await this.execute({ file: 'ps', args: ['-p', String(pid), '-o', 'lstart='] });
      if (started && !started.code && Number.isFinite(Date.parse(started.stdout.trim()))) created = new Date(started.stdout.trim()).toISOString();
    } else if (this.id === 'shpool') {
      const output = JSON.parse(requireSuccess(await this.execute(this.command(['list', '--json'])), t('readDetailsFailed')));
      const record = (Array.isArray(output) ? output : output.sessions)?.find((row: { name?: string }) => row.name === session.name);
      if (!record) throw new Error(t('sessionGone'));
      pid = positiveNumber(String(record.shell_pid));
      created = timestamp(String(Number(record.started_at_unix_ms) / 1000));
      fields.find(field => field.label === 'clientCount')!.value = String(record.status).toLowerCase() === 'attached' ? 1 : 0;
    } else if (this.id === 'zellij') {
      if (this.platform === 'win32') fields.push({ label: 'socket', value: this.zellijSocket(session) });
      else {
        const processes = await this.sessionProcesses(session);
        pid = processes.serverPid; created = processes.createdAt;
        fields.push({ label: 'socket', value: processes.socket });
        for (const terminal of processes.terminalPids) sections.push({ title: t('terminalProcess', { pid: terminal }), fields: [{ label: 'processPid', value: terminal }, ...await processDetails(terminal, this.execute, true)] });
      }
      const result = await this.execute(this.command(['--session', session.name, 'action', 'list-panes', '--all', '--json']));
      if (!result.code) {
        const panes: unknown = JSON.parse(result.stdout);
        if (Array.isArray(panes)) for (const pane of panes) {
          if (pane.is_plugin || window && String(pane.tab_id) !== window.id) continue;
          sections.push({ title: `${t('tabPane', { index: pane.tab_position, name: pane.tab_name, pane: pane.id })}${pane.is_focused ? ` · ${t('current')}` : ''}`, fields: [
            { label: 'title', value: pane.title }, { label: 'cwd', value: pane.pane_cwd }, { label: 'runningCommand', value: pane.pane_command || pane.terminal_command }
          ] });
        }
      }
      const clients = await this.execute(this.command(['--session', session.name, 'action', 'list-clients']));
      if (!clients.code) fields.find(field => field.label === 'clientCount')!.value = clients.stdout.split('\n').filter(line => /^\s*\d+\s/.test(line)).length;
    } else if (this.id === 'abduco' || this.id === 'a4') {
      const processes = await this.sessionProcesses(session);
      pid = processes.serverPid; shellPid = processes.shellPid; created = processes.createdAt;
      fields.find(field => field.label === 'clientCount')!.value = processes.clients.length;
      fields.push({ label: 'socket', value: processes.socket });
      if (this.id === 'a4') for (const terminal of processes.terminalPids) sections.push({ title: t('terminalProcess', { pid: terminal }), fields: [{ label: 'processPid', value: terminal }, ...await processDetails(terminal, this.execute, true)] });
    }
    const processPid = shellPid || (this.id === 'zmx' || this.id === 'shpool' ? pid : undefined);
    const extra = processPid ? await processDetails(processPid, this.execute, true) : [];
    const paneFields = sections.slice(1).flatMap(section => section.fields);
    cwd = String(extra.find(field => field.label === 'cwd')?.value || cwd || paneFields.find(field => field.label === 'cwd')?.value || '');
    fields.push({ label: 'cwd', value: cwd }, { label: ['screen', 'abduco', 'a4', 'zellij'].includes(this.id) ? 'serverPid' : 'processPid', value: pid },
      { kind: 'timestamp', label: 'created', value: created }, { label: 'runningCommand', value: extra.find(field => field.label === 'runningCommand')?.value || paneFields.find(field => field.label === 'runningCommand')?.value },
      ...(shellPid ? [{ label: 'terminalPid' as const, value: shellPid }] : []),
      ...extra.filter(field => field.label === 'foregroundPid'));
    return { title: window ? t('windowDetails') : t('sessionDetails'), sections, note: this.platform === 'win32' ? t('windowsCwdNote') : this.id === 'zmx'
      ? t('zmxDetailsNote')
      : t('detailsNote') };
  }
  async windowAction(action: 'select' | 'new' | 'rename' | 'kill', session: SessionInfo, window?: WindowInfo, name?: string): Promise<void> {
    if (!this.capabilities.windows) throw new Error(t('windowUnsupported'));
    if (action !== 'new' && !window) throw new Error(t('windowUnsupported'));
    if (name && this.id === 'tmux' && this.platform === 'win32') windowsTmuxArg(name);
    if (this.id === 'herdr') {
      const args = action === 'new' ? ['create', '--label', name!, '--no-focus'] : action === 'select' ? ['focus', window!.id]
        : action === 'rename' ? ['rename', window!.id, name!] : ['close', window!.id];
      herdrResult(requireSuccess(await this.execute(this.command(['--session', session.name, 'tab', ...args])), t('windowActionFailed')));
      return;
    }
    if (this.id === 'zellij') {
      if (action === 'new' || action === 'select') {
        // A freshly spawned client takes time to finish terminal negotiation.
        // 0.45.1 can build a zero-sized tab (and later crash on attach) when
        // new-tab runs without an initialized interactive client.
        let ready = false;
        for (let attempt = 0; attempt < 60; attempt++) {
          const clients = requireSuccess(await this.execute(this.command(['--session', session.name, 'action', 'list-clients'])), t('readClientsFailed'));
          if (clients.split(/\r?\n/).some(line => /^\s*\d+\s/.test(line))) { ready = true; break; }
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        if (!ready) throw new Error(t('zellijClientNotReady'));
      }
      const args = action === 'new' ? ['new-tab', '--name', name!]
        : action === 'select' ? ['go-to-tab-by-id', window!.id]
        : action === 'rename' ? ['rename-tab-by-id', window!.id, name!]
        : ['close-tab-by-id', window!.id];
      requireSuccess(await this.execute(this.command(['--session', session.name, 'action', ...args])), t('windowActionFailed'));
      return;
    }
    const target = window ? `${session.id}:${window.id}` : session.id;
    const args = action === 'select' ? ['select-window', '-t', target]
      : action === 'new' ? ['new-window', '-d', '-t', session.id, '-n', name!]
      : action === 'rename' ? ['rename-window', '-t', target, name!]
      : ['kill-window', '-t', target];
    requireSuccess(await this.execute(this.command(args)), t('windowActionFailed'));
  }
}
