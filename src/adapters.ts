import type { Command, DetailField, ManagerId, ManagerInfo, SessionDetails, SessionInfo, WindowInfo } from './model';
import { findExecutable, requireSuccess, run, type Runner } from './runner';
import { shellQuote } from './launch';
import { positiveNumber, processDetails, sessionPath, timestamp, tmuxDetails, tmuxPaneFormat, tmuxSessionFormat, zmxRecords } from './session-details';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { detachZellijClients } from './session-control';

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
    this.capabilities = { rename: id === 'tmux', kill: ['tmux', 'zmx', 'screen', 'zellij', 'shpool'].includes(id), windows: id === 'tmux', detachAll: true };
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
      tmux: ['-u', 'list-sessions', '-F', '#{session_id}|#{session_attached}|#{session_name}'],
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
      const windowResult = await this.execute(this.command(['-u', 'list-windows', '-a', '-F', '#{session_id}|#{window_id}|#{window_index}|#{window_active}|#{window_panes}|#{window_name}']));
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
  async detachAll(session: SessionInfo): Promise<void> {
    if (!this.capabilities.detachAll) throw new Error('此管理器不提供断开全部客户端的命令。');
    if (this.id === 'shpool') { await this.detach(session); return; }
    if (this.id === 'abduco' || this.id === 'a4') {
      await this.sessionProcesses(session, true);
      return;
    }
    if (this.id === 'zellij') {
      const processes = await this.sessionProcesses(session);
      for (let attempt = 0; attempt < 10; attempt++) {
        const clients = requireSuccess(await this.execute(this.command(['--session', session.name, 'action', 'list-clients'])), '读取 Zellij 客户端失败');
        const ids = clients.split('\n').flatMap(line => { const match = /^\s*(\d+)\s/.exec(line); return match ? [Number(match[1])] : []; });
        if (!ids.length) return;
        if (processes.socket.includes('/contract_version_1/')) await detachZellijClients(processes.socket, ids);
        else await this.sessionProcesses(session, true);
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw new Error('Zellij 仍有客户端连接，请刷新后重试。');
    }
    const command = this.id === 'tmux' ? this.command(['detach-client', '-s', session.id])
      : this.id === 'screen' ? this.command(['-S', session.id, '-X', 'at', '%', 'detach'])
      : { ...this.command(['detach']), env: { ZMX_SESSION: session.name } };
    requireSuccess(await this.execute(command), '断开所有连接失败');
  }
  private async sessionProcesses(session: SessionInfo, detach = false): Promise<{ serverPid: number; shellPid?: number; terminalPids: number[]; clients: number[]; createdAt?: string; socket: string }> {
    const python = await findExecutable('python3');
    const script = [path.join(__dirname, 'session-processes.py'), path.join(__dirname, '../src/session-processes.py')].find(existsSync);
    if (!python || !script) throw new Error('读取此管理器的会话进程需要 Python 3，请安装后重试。');
    const output = requireSuccess(await this.execute({ file: python, args: [script, JSON.stringify({ manager: this.id, name: session.name, file: this.command([]).file, detach })] }), '读取会话进程失败');
    return JSON.parse(output);
  }
  async details(session: SessionInfo, window?: WindowInfo): Promise<SessionDetails> {
    if (this.id === 'tmux') {
      const target = window ? `${session.id}:${window.id}` : session.id;
      const [info, panes] = await Promise.all([
        this.execute(this.command(['-u', 'display-message', '-p', '-t', target, tmuxSessionFormat])),
        this.execute(this.command(['-u', 'list-panes', ...(window ? [] : ['-s']), '-t', target, '-F', tmuxPaneFormat]))
      ]);
      return tmuxDetails(requireSuccess(info, '读取详情失败'), requireSuccess(panes, '读取 pane 详情失败'), window);
    }
    if (this.id !== 'zmx') {
      const current = (await this.listSessions()).find(item => item.id === session.id);
      if (!current) throw new Error('会话已不存在，请刷新列表。');
      session = current;
    }
    const fields: DetailField[] = [
      { label: '管理器', value: LABELS[this.id] }, { label: '会话名称', value: session.name }, { label: '会话 ID', value: session.id },
      { label: '客户端连接数', value: session.attached }
    ];
    let pid: number | undefined, shellPid: number | undefined, cwd: string | undefined, created: string | undefined;
    const sections: SessionDetails['sections'] = [{ fields }];
    if (this.id === 'zmx') {
      const records = zmxRecords(requireSuccess(await this.execute(this.command(['list'])), '读取详情失败'));
      const record = records.find(record => record.name === session.name);
      if (!record) throw new Error('会话已不存在，请刷新列表。');
      pid = positiveNumber(record.pid); cwd = sessionPath(record.cwd || record.dir); created = timestamp(record.created);
      fields.find(field => field.label === '客户端连接数')!.value = record.clients;
    } else if (this.id === 'screen') {
      const attachment = fields.find(field => field.label === '客户端连接数')!;
      attachment.label = '客户端连接状态'; attachment.value = session.attached ? '已连接' : '未连接';
      pid = positiveNumber(session.id.split('.')[0]);
      const processes = await this.execute({ file: 'ps', args: ['-axo', 'pid=,ppid='] });
      const children = processes.stdout.split('\n').flatMap(line => {
        const [child, parent] = line.trim().split(/\s+/).map(Number);
        return parent === pid && child > 1 ? [child] : [];
      });
      for (const child of children) sections.push({ title: `终端进程 ${child}`, fields: [{ label: '进程 PID', value: child }, ...await processDetails(child, this.execute, true)] });
      const started = pid && await this.execute({ file: 'ps', args: ['-p', String(pid), '-o', 'lstart='] });
      if (started && !started.code && Number.isFinite(Date.parse(started.stdout.trim()))) created = new Date(started.stdout.trim()).toISOString();
    } else if (this.id === 'shpool') {
      const output = JSON.parse(requireSuccess(await this.execute(this.command(['list', '--json'])), '读取详情失败'));
      const record = (Array.isArray(output) ? output : output.sessions)?.find((row: { name?: string }) => row.name === session.name);
      if (!record) throw new Error('会话已不存在，请刷新列表。');
      pid = positiveNumber(String(record.shell_pid));
      created = timestamp(String(Number(record.started_at_unix_ms) / 1000));
      fields.find(field => field.label === '客户端连接数')!.value = String(record.status).toLowerCase() === 'attached' ? 1 : 0;
    } else if (this.id === 'zellij') {
      const processes = await this.sessionProcesses(session);
      pid = processes.serverPid; created = processes.createdAt;
      fields.push({ label: 'Socket', value: processes.socket });
      for (const terminal of processes.terminalPids) sections.push({ title: `终端进程 ${terminal}`, fields: [{ label: '进程 PID', value: terminal }, ...await processDetails(terminal, this.execute, true)] });
      const result = await this.execute(this.command(['--session', session.name, 'action', 'list-panes', '--all', '--json']));
      if (!result.code) {
        const panes: unknown = JSON.parse(result.stdout);
        if (Array.isArray(panes)) for (const pane of panes) {
          if (pane.is_plugin) continue;
          sections.push({ title: `Tab ${pane.tab_position}: ${pane.tab_name} · Pane ${pane.id}${pane.is_focused ? ' · 当前' : ''}`, fields: [
            { label: '标题', value: pane.title }, { label: '工作路径', value: pane.pane_cwd }, { label: '正在执行', value: pane.pane_command || pane.terminal_command }
          ] });
        }
      }
      const clients = await this.execute(this.command(['--session', session.name, 'action', 'list-clients']));
      if (!clients.code) fields.find(field => field.label === '客户端连接数')!.value = clients.stdout.split('\n').filter(line => /^\s*\d+\s/.test(line)).length;
    } else if (this.id === 'abduco' || this.id === 'a4') {
      const processes = await this.sessionProcesses(session);
      pid = processes.serverPid; shellPid = processes.shellPid; created = processes.createdAt;
      fields.find(field => field.label === '客户端连接数')!.value = processes.clients.length;
      fields.push({ label: 'Socket', value: processes.socket });
      if (this.id === 'a4') for (const terminal of processes.terminalPids) sections.push({ title: `终端进程 ${terminal}`, fields: [{ label: '进程 PID', value: terminal }, ...await processDetails(terminal, this.execute, true)] });
    }
    const processPid = shellPid || (this.id === 'zmx' || this.id === 'shpool' ? pid : undefined);
    const extra = processPid ? await processDetails(processPid, this.execute, true) : [];
    const paneFields = sections.slice(1).flatMap(section => section.fields);
    cwd = String(extra.find(field => field.label === '工作路径')?.value || cwd || paneFields.find(field => field.label === '工作路径')?.value || '');
    fields.push({ label: '工作路径', value: cwd }, { label: ['screen', 'abduco', 'a4', 'zellij'].includes(this.id) ? '服务端 PID' : '进程 PID', value: pid },
      { label: '创建时间', value: created }, { label: '正在执行', value: extra.find(field => field.label === '正在执行')?.value || paneFields.find(field => field.label === '正在执行')?.value },
      ...(shellPid ? [{ label: '终端进程 PID', value: shellPid }] : []),
      ...extra.filter(field => field.label === '前台进程 PID'));
    return { title: '会话详情', sections, note: this.id === 'zmx'
      ? '正在执行的命令来自会话前台进程；工作路径优先读取该进程，无法读取时使用管理器最近报告的路径。'
      : '仅显示管理器和主机能够提供的数据；未提供的字段表示当前管理器或版本无法读取。' };
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
