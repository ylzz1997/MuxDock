import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parse, stringify } from 'smol-toml';
import { t } from './i18n';
import type { Command, SessionInfo, WindowInfo } from './model';
import { cleanEnvironment, requireSuccess, type Runner } from './runner';
import { spawnPty } from './pty';

export interface HerdrSession { name: string; running: boolean; error?: string; socket_path?: string }
export interface HerdrPane { pane_id: string; tab_id: string; workspace_id: string; terminal_id: string; cwd?: string; foreground_cwd?: string; focused: boolean; agent_status?: string; terminal_title_stripped?: string }
export interface HerdrSnapshot {
  focused_pane_id?: string; focused_tab_id?: string;
  panes: HerdrPane[];
  tabs: { tab_id: string; workspace_id: string; number: number; label: string; pane_count: number; focused: boolean }[];
  workspaces: { workspace_id: string; label: string }[];
}
export function herdrResult(text: string): Record<string, any> {
  const reply = JSON.parse(text);
  if (reply?.error) throw new Error(typeof reply.error === 'string' ? reply.error : reply.error.message || JSON.stringify(reply.error));
  if (!reply?.result || typeof reply.result !== 'object') throw new Error(t('readDetailsFailed'));
  return reply.result;
}
export function herdrSessions(text: string): HerdrSession[] {
  const reply = JSON.parse(text);
  if (!Array.isArray(reply?.sessions)) throw new Error(t('readSessionsFailed'));
  if (reply.sessions.some((row: HerdrSession) => row.error)) throw new Error(reply.sessions.find((row: HerdrSession) => row.error).error);
  return reply.sessions.filter((row: HerdrSession) => typeof row.name === 'string' && typeof row.running === 'boolean');
}
export function parseHerdrSessions(text: string): SessionInfo[] {
  return herdrSessions(text).filter(row => row.running).map(row => ({ id: row.name, name: row.name }));
}
export function herdrSnapshot(text: string): HerdrSnapshot {
  const snapshot = herdrResult(text).snapshot;
  if (!snapshot || !Array.isArray(snapshot.tabs) || !Array.isArray(snapshot.panes) || !Array.isArray(snapshot.workspaces)) throw new Error(t('readDetailsFailed'));
  return snapshot;
}
export function herdrWindows(snapshot: HerdrSnapshot): WindowInfo[] {
  return snapshot.tabs.map(tab => ({ id: tab.tab_id, index: tab.number, panes: tab.pane_count, active: tab.tab_id === snapshot.focused_tab_id, renameName: tab.label,
    name: snapshot.workspaces.length > 1 ? `${snapshot.workspaces.find(workspace => workspace.workspace_id === tab.workspace_id)?.label || tab.workspace_id} / ${tab.label}` : tab.label }));
}
export function validateHerdrName(name: string): string | undefined {
  return /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/.test(name) ? undefined : t('herdrName');
}

/** Let Herdr daemonize itself before attaching. Startup commands target its fresh pane. */
export async function createHerdrSession(command: (args: string[]) => Command, execute: Runner, name: string, shell: string, startup: string | undefined, cwd: string, storage: string): Promise<Command> {
  const error = validateHerdrName(name); if (error) throw new Error(error);
  const sessions = herdrSessions(requireSuccess(await execute(command(['session', 'list', '--json'])), t('readSessionsFailed')));
  // Stopped sessions have saved layouts too. Never restore one as a new session.
  if (sessions.some(session => session.name === name)) throw new Error(t('nameTaken'));
  const configRoot = process.env.XDG_CONFIG_HOME ? path.join(process.env.XDG_CONFIG_HOME, 'herdr')
    : process.platform === 'win32' ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'herdr') : path.join(os.homedir(), '.config', 'herdr');
  const source = process.env.HERDR_CONFIG_PATH || path.join(configRoot, 'config.toml');
  const original = await readFile(source, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
  const config = parse(original);
  const terminal = config.terminal;
  config.terminal = { ...(terminal && typeof terminal === 'object' && !Array.isArray(terminal) && !(terminal instanceof Date) ? terminal : {}), default_shell: shell };
  config.onboarding = false;
  await mkdir(storage, { recursive: true });
  const configPath = path.join(storage, `herdr-${randomUUID()}.toml`);
  await writeFile(configPath, stringify(config), { mode: 0o600 });
  const attach = command(['--session', name]);
  const env = { ...attach.env, HERDR_CONFIG_PATH: configPath };
  // Herdr's native launcher escapes Windows kill-on-close jobs and preserves
  // console control handling. Direct child_process.spawn either dies on editor
  // reload or, with detached:true, makes descendant shells ignore Ctrl+C.
  const client = spawnPty(attach.file, attach.args, { name: 'xterm-256color', cols: 100, rows: 28, cwd, env: { ...cleanEnvironment(), ...env }, encoding: 'utf8' });
  let exited = false;
  const exit = client.onExit(() => { exited = true; });
  const output = client.onData(() => {});
  try {
    let paneId: string | undefined;
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      if (exited) throw new Error(t('herdrNotReady'));
      const result = await execute(command(['--session', name, 'api', 'snapshot']));
      if (!result.code) {
        const snapshot = herdrSnapshot(result.stdout);
        paneId = snapshot.panes.find(pane => pane.pane_id === snapshot.focused_pane_id)?.pane_id || snapshot.panes[0]?.pane_id;
        if (paneId) break;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!paneId) throw new Error(t('herdrNotReady'));
    if (startup) {
      // pane run waits for an interactive shell and submits once. Never retry a write:
      // a lost acknowledgement must not execute the user's command a second time.
      requireSuccess(await execute(command(['--session', name, 'pane', 'run', paneId, startup])), t('commandFailed'));
    }
    return { ...attach, env };
  } finally {
    // Preserve server and work even after a lost startup acknowledgement.
    client.kill(); output.dispose(); exit.dispose();
  }
}
