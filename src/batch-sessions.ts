import { t } from './i18n';
import { isManagerId, type ManagerId } from './model';

export interface SessionTarget { manager: ManagerId; session: string }
export type BatchAction = 'disconnect' | 'kill';
export function parseSessionBatch(value: Record<string, unknown>): { action: BatchAction; targets: SessionTarget[] } {
  if (value.action !== 'disconnect' && value.action !== 'kill') throw new Error(t('invalidBatch'));
  if (!Array.isArray(value.targets) || !value.targets.length) throw new Error(t('selectFirst'));
  const targets = new Map<string, SessionTarget>();
  for (const target of value.targets) {
    if (!target || !isManagerId(target.manager) || typeof target.session !== 'string' || !target.session) throw new Error(t('invalidSession'));
    targets.set(JSON.stringify([target.manager, target.session]), { manager: target.manager, session: target.session });
  }
  return { action: value.action, targets: [...targets.values()] };
}
export async function runSessionBatch(targets: SessionTarget[], action: (target: SessionTarget) => Promise<void>) {
  const succeeded: SessionTarget[] = [];
  const failed: { target: SessionTarget; error: string }[] = [];
  for (const target of targets) {
    try { await action(target); succeeded.push(target); }
    catch (error) { failed.push({ target, error: error instanceof Error ? error.message : String(error) }); }
  }
  return { succeeded, failed };
}
