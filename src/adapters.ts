import type { Command, ManagerId, ManagerInfo, SessionInfo, WindowInfo } from './model';
import { findExecutable, requireSuccess, run, type Runner } from './runner';
import { shellQuote } from './launch';

export const LABELS: Record<ManagerId, string> = { tmux: 'tmux', zmx: 'zmx', screen: 'screen', zellij: 'Zellij', shpool: 'shpool', abduco: 'abduco', a4: 'a4' };
export const stripAnsi = (text: string) => text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');

export function parseTmuxSessions(text: string): SessionInfo[] {
  return text.trim().split('\n').flatMap(line => {
    const [id, attached, ...nameParts] = line.split('|');
    const name = nameParts.join('|');
    return /^\$\d+$/.test(id) && name ? [{ id, name, attached: Number(attached) || 0, windows: [] }] : [];
  });
}
export function parseTmuxWindows(text: string): Map<string, WindowInfo[]> {
  const result = new Map<string, WindowInfo[]>();
  for (const line of text.trim().split('\n')) {
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
  return text.split(/\r?\n/).flatMap(line => {
    if (!line.trim()) return [];
    // zmx indents every row; trimming only the complete output loses all but the first session.
    const fields = Object.fromEntries(line.trimStart().split('\t').flatMap(field => { const at = field.indexOf('='); return at > 0 ? [[field.slice(0, at), field.slice(at + 1)]] : []; }));
    if (!fields.name) return [];
    return [{ id: fields.name, name: fields.name, attached: Number(fields.clients) || 0, detail: fields.dir }];
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
  if (!Array.isArray(rows)) throw new Error('无法识别 shpool 的会话 JSON。');
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
export class Adapter {
  private executable?: string;
  private version?: string;
  private probed = false;
  readonly capabilities: ManagerInfo['capabilities'];
  constructor(readonly id: ManagerId, private settings: AdapterSettings = {}, private execute: Runner = run) {
    this.capabilities = { rename: id === 'tmux', kill: ['tmux', 'zmx', 'screen', 'zellij', 'shpool'].includes(id), windows: id === 'tmux' };
  }
  configure(settings: AdapterSettings) { this.settings = settings; this.probed = false; }
  command(args: string[]): Command {
    if (!this.executable) throw new Error(`${LABELS[this.id]} 未安装或可执行文件路径无效。`);
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
    this.executable = await findExecutable(this.id, this.settings.executable);
    if (!this.executable) return false;
    const flags = this.id === 'tmux' ? ['-V'] : ['zmx', 'shpool'].includes(this.id) ? ['version'] : ['screen', 'abduco', 'a4'].includes(this.id) ? ['-v'] : ['--version'];
    const result = await this.execute(this.command(flags));
    this.version = stripAnsi(result.stdout || result.stderr).trim().split('\n')[0]?.slice(0, 100);
    return true;
  }
  async list(force = false): Promise<ManagerInfo> {
    const base: ManagerInfo = { id: this.id, name: LABELS[this.id], available: await this.probe(force), version: this.version, sessions: [], capabilities: this.capabilities };
    if (!base.available) return base;
    try { base.sessions = await this.listSessions(); }
    catch (error) { base.error = error instanceof Error ? error.message : String(error); }
    return base;
  }
  private async listSessions(): Promise<SessionInfo[]> {
    const commands: Record<ManagerId, string[]> = {
      tmux: ['list-sessions', '-F', '#{session_id}|#{session_attached}|#{session_name}'],
      zmx: ['list'], screen: ['-ls'], zellij: ['list-sessions', '--no-formatting'],
      shpool: ['list', '--json'], abduco: [], a4: ['-l']
    };
    const result = await this.execute(this.command(commands[this.id]));
    // GNU/macOS screen uses the exit status as a socket-count/status code, even for valid lists.
    if (this.id === 'screen' && parseScreen(result.stdout).length) return parseScreen(result.stdout);
    if (result.code && /no server running|no sessions|no sockets found|no active.*sessions|error connecting.*(?:No such file|Connection refused)/i.test(`${result.stderr}\n${result.stdout}`)) return [];
    const output = requireSuccess(result, '读取会话失败');
    if (this.id === 'tmux') {
      const sessions = parseTmuxSessions(output);
      if (!sessions.length) return [];
      const windowResult = await this.execute(this.command(['list-windows', '-a', '-F', '#{session_id}|#{window_id}|#{window_index}|#{window_active}|#{window_panes}|#{window_name}']));
      const windows = parseTmuxWindows(requireSuccess(windowResult, '读取 tmux windows 失败'));
      return sessions.map(session => ({ ...session, windows: windows.get(session.id) || [] }));
    }
    const parsers = { zmx: parseZmx, screen: parseScreen, zellij: parseZellij, shpool: parseShpool, abduco: parseAbduco, a4: parseA4 };
    return parsers[this.id](output);
  }
  attach(session: SessionInfo): Command {
    const commands: Record<ManagerId, string[]> = {
      tmux: ['attach-session', '-t', session.id], zmx: ['attach', session.name],
      screen: ['-x', session.id], zellij: ['attach', session.name], shpool: ['attach', session.name],
      abduco: ['-a', session.name], a4: ['-a', session.name]
    };
    return this.clientCommand(commands[this.id]);
  }
  create(name: string, shell: string, environmentShell = shell): Command {
    const commands: Record<ManagerId, string[]> = {
      tmux: ['new-session', '-s', name, shell, '-l'], zmx: ['attach', name, shell, '-l'], screen: ['-S', name, shell, '-l'],
      zellij: ['--session', name, 'options', '--default-shell', shell],
      shpool: ['attach', '--dir', '.', '--cmd', ['/usr/bin/env', `SHELL=${shell}`, shell, '-l'].map(shellQuote).join(' '), name],
      abduco: ['-c', name, shell, '-l'], a4: ['-a', name]
    };
    return { ...this.clientCommand(commands[this.id]), env: { SHELL: this.id === 'a4' ? shell : environmentShell } };
  }
  async rename(session: SessionInfo, name: string): Promise<void> {
    if (!this.capabilities.rename) throw new Error('此管理器不提供会话重命名。');
    requireSuccess(await this.execute(this.command(['rename-session', '-t', session.id, name])), '重命名失败');
  }
  async kill(session: SessionInfo): Promise<void> {
    if (!this.capabilities.kill) throw new Error('请在会话内使用 exit 结束程序。');
    const commands: Partial<Record<ManagerId, string[]>> = {
      tmux: ['kill-session', '-t', session.id], zmx: ['kill', session.name], screen: ['-S', session.id, '-X', 'quit'],
      zellij: ['kill-session', session.name], shpool: ['kill', session.name]
    };
    requireSuccess(await this.execute(this.command(commands[this.id]!)), '结束会话失败');
  }
  async detach(session: SessionInfo): Promise<void> {
    // shpool can retain a stale attachment after its client receives SIGHUP.
    if (this.id !== 'shpool') return;
    requireSuccess(await this.execute(this.command(['detach', session.name])), '断开 shpool 连接失败');
    for (let attempt = 0; attempt < 30; attempt++) {
      const current = (await this.listSessions()).find(item => item.id === session.id);
      if (!current || !current.attached) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('shpool 尚未释放客户端连接，请稍后重试。');
  }
  async windowAction(action: 'select' | 'new' | 'rename' | 'kill', session: SessionInfo, window?: WindowInfo, name?: string): Promise<void> {
    if (this.id !== 'tmux') throw new Error('此管理器尚未提供 window 导航。');
    const target = window ? `${session.id}:${window.id}` : session.id;
    const args = action === 'select' ? ['select-window', '-t', target]
      : action === 'new' ? ['new-window', '-d', '-t', session.id, '-n', name!]
      : action === 'rename' ? ['rename-window', '-t', target, name!]
      : ['kill-window', '-t', target];
    requireSuccess(await this.execute(this.command(args)), '操作 tmux window 失败');
  }
}
