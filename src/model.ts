import { t } from './i18n';
export const MANAGER_IDS = ['tmux', 'psmux', 'zmx', 'screen', 'zellij', 'shpool', 'abduco', 'a4'] as const;
export type ManagerId = typeof MANAGER_IDS[number];
export interface WindowInfo { id: string; index: number; name: string; active: boolean; panes: number }
export interface SessionInfo {
  id: string;
  name: string;
  attached?: number;
  windows?: WindowInfo[];
  detail?: string;
}
export interface DetailField { kind?: 'timestamp'; label: import('./i18n').MessageKey; value?: string | number }
export interface DetailSection { title?: string; fields: DetailField[] }
export interface SessionDetails { title: string; sections: DetailSection[]; note?: string }
export interface ManagerInfo {
  id: ManagerId;
  name: string;
  available: boolean;
  version?: string;
  error?: string;
  sessions: SessionInfo[];
  capabilities: { rename: boolean; kill: boolean; windows: boolean; detachAll: boolean };
}
export interface Command { file: string; args: string[]; env?: Record<string, string> }
export type ShellDialect = 'posix' | 'powershell' | 'cmd';
export interface ConnectionInfo { key: string; manager: ManagerId; sessionId: string; name: string; closed?: boolean; cwd?: string }
export interface Appearance { fontSize: number; fontFamily: string; scrollback: number; minimumContrastRatio: number }
export interface LaunchProfile { id: string; name: string; detail: string; kind: 'shell' | 'command' }
export interface Snapshot {
  locale: import('./i18n').Locale;
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
  if (!value.trim()) return t('nameRequired');
  if (value.length > 120) return t('nameTooLong');
  if (!/^[\p{L}\p{N}_][\p{L}\p{N}_.-]*$/u.test(value)) return t('nameInvalid');
  return undefined;
}
