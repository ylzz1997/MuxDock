import path from 'node:path';
import { readlink } from 'node:fs/promises';
import type { DetailField, SessionDetails, WindowInfo } from './model';
import type { Runner } from './runner';

// tmux renders ASCII control separators as octal escapes, so use a printable marker.
export const DETAIL_SEPARATOR = '|:MUXDOCK:|';
export const tmuxSessionFormat = ['session_id', 'session_name', 'session_created', 'session_attached', 'session_windows', 'session_path', 'pid'].map(key => `#{${key}}`).join(DETAIL_SEPARATOR);
export const tmuxPaneFormat = ['pane_id', 'window_id', 'window_index', 'window_name', 'window_active', 'pane_index', 'pane_active', 'pane_pid', 'pane_current_path', 'pane_current_command', 'pane_start_command'].map(key => `#{${key}}`).join(DETAIL_SEPARATOR);
export function positiveNumber(value: string | undefined): number | undefined {
  const number = Number(value); return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}
export function timestamp(value: string | undefined): string | undefined {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return;
  const date = new Date(seconds * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}
export function sessionPath(value: string | undefined): string | undefined {
  if (!value) return;
  if (!value.startsWith('file://')) return value;
  try { return decodeURIComponent(new URL(value).pathname); } catch { return value; }
}
export function zmxRecords(text: string): Record<string, string>[] {
  return text.split(/\r?\n/).filter(line => line.trim()).map(line => Object.fromEntries(line.trimStart().split('\t').flatMap(field => {
    const at = field.indexOf('='); return at > 0 ? [[field.slice(0, at), field.slice(at + 1)]] : [];
  })));
}
export function tmuxDetails(sessionOutput: string, paneOutput: string, window?: WindowInfo): SessionDetails {
  const [id, name, created, attached, windows, startPath, serverPid] = sessionOutput.trimEnd().split(DETAIL_SEPARATOR);
  if (!/^\$\d+$/.test(id)) throw new Error('会话已不存在，请刷新列表。');
  const sections: SessionDetails['sections'] = [{ fields: [
    { label: '管理器', value: 'tmux' }, { label: '会话名称', value: name }, { label: '会话 ID', value: id },
    ...(window ? [{ label: 'Window', value: `${window.index}: ${window.name}` }, { label: 'Window ID', value: window.id }] : []),
    { label: '会话创建时间', value: timestamp(created) }, { label: '客户端连接数', value: attached },
    { label: 'Window 数量', value: windows }, { label: '会话初始路径', value: startPath }, { label: '服务端 PID', value: positiveNumber(serverPid) }
  ] }];
  for (const line of paneOutput.trimEnd().split('\n')) {
    const [paneId, windowId, index, windowName, windowActive, paneIndex, active, pid, cwd, command, startCommand] = line.split(DETAIL_SEPARATOR);
    if (!/^%\d+$/.test(paneId)) continue;
    sections.push({ title: `Window ${index}: ${windowName} · Pane ${paneIndex}${windowActive === '1' && active === '1' ? ' · 当前' : ''}`, fields: [
      { label: 'Pane ID', value: paneId }, { label: 'Window ID', value: windowId }, { label: '进程 PID', value: positiveNumber(pid) },
      { label: '工作路径', value: cwd }, { label: '正在执行', value: command }, { label: '启动命令', value: startCommand || '默认 shell' }
    ] });
  }
  return { title: window ? 'Window 详情' : '会话详情', sections, note: 'tmux 的会话共用服务端进程；每个 pane 单独列出进程 PID、当前工作路径和正在执行的程序。' };
}

// Read process data only on demand. Never run commands inside the user's shell.
export async function processDetails(pid: number, execute: Runner, foreground = false): Promise<DetailField[]> {
  let commandPid = pid;
  if (foreground) {
    const group = await execute({ file: 'ps', args: ['-p', String(pid), '-o', 'tpgid='] });
    const foregroundPid = !group.code && positiveNumber(group.stdout.trim());
    if (foregroundPid) commandPid = foregroundPid;
  }
  const [result, directory] = await Promise.all([
    execute({ file: 'ps', args: ['-p', String(commandPid), '-o', 'args='] }),
    process.platform === 'linux'
      ? readlink(`/proc/${commandPid}/cwd`).catch(() => undefined)
      : execute({ file: '/usr/sbin/lsof', args: ['-a', '-p', String(commandPid), '-d', 'cwd', '-Fn'] }).then(result => !result.code ? result.stdout.split('\n').find(line => line.startsWith('n'))?.slice(1) : undefined)
  ]);
  const fields: DetailField[] = [];
  if (commandPid !== pid) fields.push({ label: '前台进程 PID', value: commandPid });
  if (!result.code && result.stdout.trim()) fields.push({ label: '正在执行', value: result.stdout.trim() });
  if (directory && path.isAbsolute(directory)) fields.push({ label: '工作路径', value: directory });
  return fields;
}
