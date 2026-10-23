import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { discoverShells, launchExecutable, launchProfiles, readLaunchSettings, shellQuote, systemShell, validateLaunchCommand } from '../src/launch';
import { Adapter } from '../src/adapters';
import { MANAGER_IDS } from '../src/model';

test('new launch settings select the account default shell and recover missing selections', async () => {
  const shell = systemShell();
  assert.ok(path.isAbsolute(shell));
  const settings = readLaunchSettings(undefined);
  const profiles = launchProfiles(settings, [shell, '/bin/sh'], shell);
  assert.equal(profiles.selectedLaunchProfile, 'system');
  assert.equal(profiles.launchProfiles[0].name, path.basename(shell));
  assert.match(profiles.launchProfiles[0].detail, /System default/);
  assert.equal(launchProfiles({ shell: '/missing/shell', commands: [] }, [shell], shell).selectedLaunchProfile, 'system');
  assert.ok((await discoverShells('/bin/sh')).includes('/bin/sh'));
});

test('saved launch commands keep valid entries and a selected command keeps its base shell', () => {
  const settings = readLaunchSettings({ shell: '/bin/sh', commandId: 'one', commands: [{ id: 'one', command: ' codex --resume ' }, { id: 'one', command: 'duplicate' }, { id: 'bad', command: 'line\nbreak' }, { id: 42, command: 'wrong' }] });
  assert.deepEqual(settings.commands, [{ id: 'one', command: 'codex --resume' }]);
  assert.equal(settings.shell, '/bin/sh');
  assert.equal(launchProfiles(settings, ['/bin/zsh', '/bin/sh'], '/bin/zsh').selectedLaunchProfile, 'command:one');
  assert.equal(readLaunchSettings({ commandId: 'missing', commands: [] }).commandId, undefined);
  for (const value of ['', '  ', 'a\0b', 'a\rb', 'a\nb', 'a'.repeat(4097)]) assert.ok(validateLaunchCommand(value));
  assert.equal(validateLaunchCommand('FOO=bar codex --resume && echo done'), undefined);
});

test('launch wrappers execute commands with quotes once and leave a usable shell', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'muxdock-launch-'));
  try {
    const marker = path.join(root, "a b's output");
    const command = `printf '%s' "$SHELL" > ${shellQuote(marker)}`;
    const file = await launchExecutable('/bin/sh', command, path.join(root, "launcher's cache"));
    execFileSync(file, [], { input: 'exit\n', encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    assert.equal(await readFile(marker, 'utf8'), '/bin/sh');
    assert.ok((await stat(file)).mode & 0o100);
    assert.equal(await launchExecutable('/bin/sh', command, path.join(root, "launcher's cache")), file);
    assert.equal(await launchExecutable('/bin/sh', undefined, root), '/bin/sh');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('every manager applies the chosen shell when creating and preserves native attachment', async () => {
  const shell = "/tmp/a b's shell";
  for (const id of MANAGER_IDS) {
    const adapter = new Adapter(id, { executable: '/bin/echo' }, async () => ({ code: 0, stdout: '', stderr: '' }));
    await adapter.probe();
    const create = adapter.create('profile-test', shell);
    assert.equal(create.env?.SHELL, shell, id);
    if (id !== 'a4' && id !== 'shpool') assert.ok(create.args.includes(shell), id);
    if (id === 'shpool') assert.ok(create.args.includes('--cmd'));
    assert.ok(!JSON.stringify(adapter.attach({ id: 'session', name: 'profile-test' })).includes(shell), id);
  }
});

test('csh startup commands support its distinct login option rules', async context => {
  if (!(await discoverShells('/bin/sh')).includes('/bin/csh')) { context.skip('csh is not installed'); return; }
  const root = await mkdtemp(path.join(os.tmpdir(), 'muxdock-csh-'));
  try {
    const file = await launchExecutable('/bin/csh', 'printf CSH_COMMAND_READY', root);
    const output = execFileSync(file, [], { input: 'exit\n', encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    assert.ok(output.includes('CSH_COMMAND_READY'));
  } finally { await rm(root, { recursive: true, force: true }); }
});
