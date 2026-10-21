export const MANAGER_IDS = ['tmux', 'zmx', 'screen', 'zellij', 'shpool', 'abduco', 'a4'] as const;
export type ManagerId = typeof MANAGER_IDS[number];
export interface WindowInfo { id: string; index: number; name: string; active: boolean; panes: number }
export interface SessionInfo {
  id: string;
  name: string;
  attached?: number;
  windows?: WindowInfo[];
  detail?: string;
}
export interface ManagerInfo {
  id: ManagerId;
  name: string;
  available: boolean;
  version?: string;
  error?: string;
  sessions: SessionInfo[];
  capabilities: { rename: boolean; kill: boolean; windows: boolean };
}
export interface Command { file: string; args: string[]; env?: Record<string, string> }
export interface ConnectionInfo { key: string; manager: ManagerId; sessionId: string; name: string; closed?: boolean; cwd?: string }
export interface Appearance { fontSize: number; fontFamily: string; scrollback: number; minimumContrastRatio: number }
export interface LaunchProfile { id: string; name: string; detail: string; kind: 'shell' | 'command' }
export interface Snapshot {
  managers: ManagerInfo[];
  connections: ConnectionInfo[];
  activeKey?: string;
  showUnavailable: boolean;
  visibleManagers: ManagerId[];
  showTabs: boolean;
  maxTabs: number;
  host: string;
  appearance: Appearance;
  launchProfiles: LaunchProfile[];
  selectedLaunchProfile: string;
}
export const connectionKey = (manager: ManagerId, sessionId: string) => `${manager}:${sessionId}`;
export function isManagerId(value: unknown): value is ManagerId { return MANAGER_IDS.includes(value as ManagerId); }
export function validateName(value: string): string | undefined {
  if (!value.trim()) return '请输入会话名称。';
  if (value.length > 120) return '名称不能超过 120 个字符。';
  if (!/^[\p{L}\p{N}_][\p{L}\p{N}_.-]*$/u.test(value)) return '请使用字母、数字、中文、下划线、短横线或点，以字母、数字或下划线开头。';
  return undefined;
}
