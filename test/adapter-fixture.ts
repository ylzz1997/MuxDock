import { Adapter, type AdapterSettings } from '../src/adapters';
import type { ManagerId } from '../src/model';
import { run, type Runner } from '../src/runner';

/** Exercise Unix command construction on every CI host using a real executable path. */
export class UnixAdapter extends Adapter {
  constructor(id: ManagerId, settings: AdapterSettings = {}, execute: Runner = run) {
    super(id, { ...settings, ...(settings.executable === '/bin/echo' ? { executable: process.execPath } : {}) }, execute, 'linux');
  }
}
