import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

assert.equal(process.platform, 'win32');
const exec = promisify(execFile);
const root = process.cwd();
const editor = process.env.MUXDOCK_TEST_EDITOR || 'vscode';
assert.ok(['vscode', 'cursor'].includes(editor));
const token = `md_ui_${editor}_${Date.now()}`;
const evidence = path.join(root, '.test-results', token);
const user = path.join(root, '.vscode-test', token, 'user');
const extensions = path.join(root, '.vscode-test', token, 'extensions');
const editorDir = process.env.MUXDOCK_EDITOR_DIRECTORY || path.join(process.env.LOCALAPPDATA, 'Programs', editor === 'cursor' ? 'cursor' : 'Microsoft VS Code');
const executable = path.join(editorDir, editor === 'cursor' ? 'Cursor.exe' : 'Code.exe');
const appDirs = [editorDir, ...(await readdir(editorDir)).map(name => path.join(editorDir, name))];
const cli = appDirs.map(dir => path.join(dir, 'resources/app/out/cli.js')).find(existsSync);
assert.ok(cli, 'editor CLI found');
const binaries = JSON.parse(await readFile('.test-tools/executables.windows.json', 'utf8'));
binaries.tmux ||= path.join(process.env.LOCALAPPDATA, 'Programs/tmux-windows/tmux.exe');
binaries.herdr ||= path.join(process.env.LOCALAPPDATA, 'Programs/Herdr/bin/herdr.exe');
const managers = (process.env.MUXDOCK_TEST_MANAGERS || 'psmux,zellij').split(',');
assert.ok(managers.every(id => ['tmux', 'psmux', 'zellij', 'herdr'].includes(id)));
const tmuxLike = id => ['tmux', 'psmux'].includes(id);
const vsix = path.resolve(process.env.MUXDOCK_USE_VSIX || 'artifacts/muxdock-0.0.16.vsix');
const config = { psmux: path.join(evidence, 'psmux.conf'), tmux: path.join(evidence, 'tmux.conf'), zellij: path.join(evidence, 'zellij.kdl'), herdr: path.join(evidence, 'herdr.toml') };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (fn, label, timeout = 30000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const result = await fn(); if (result) return result; await delay(200); }
  throw new Error(`UI timed out: ${label}`);
};
const quote = value => `'${value.replaceAll("'", "''")}'`;
await mkdir(evidence, { recursive: true }); await mkdir(path.join(user, 'User'), { recursive: true });
await writeFile(config.psmux, `set -g default-shell ${JSON.stringify(binaries.pwsh.replaceAll('\\', '/'))}\nset -g automatic-rename off\n`);
await writeFile(config.zellij, `show_release_notes false\nshow_startup_tips false\nsession_serialization false\ndefault_shell ${JSON.stringify(binaries.pwsh)}\n`);
await writeFile(config.tmux, await readFile(config.psmux));
await writeFile(config.herdr, 'onboarding = false\n[update]\nversion_check = false\nmanifest_check = false\n');
const env = { ...process.env, APPDATA: path.join(evidence, 'roaming'), HERDR_CONFIG_PATH: config.herdr, PSMUX_DATA_DIR: path.join(evidence, 'psmux-data'), ZELLIJ_SOCKET_DIR: path.join(evidence, 'zellij-sockets') };
delete env.ELECTRON_RUN_AS_NODE;
await writeFile(path.join(user, 'User/settings.json'), JSON.stringify({
  'security.workspace.trust.enabled': false, 'workbench.startupEditor': 'none', 'window.dialogStyle': 'custom',
  'chat.disableAIFeatures': true, 'muxdock.language': 'en', 'muxdock.refreshInterval': 1,
  'muxdock.executables': { psmux: binaries.psmux, zellij: binaries.zellij, tmux: binaries.tmux, herdr: binaries.herdr },
  'muxdock.arguments': { tmux: ['-L', token, '-f', config.tmux], psmux: ['-L', token, '-f', config.psmux], zellij: ['--config', config.zellij] }
}, null, 2));
const installation = await exec(executable, [cli, '--user-data-dir', user, '--extensions-dir', extensions, '--install-extension', vsix, '--force'], { env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, timeout: 60000 });
await writeFile(path.join(evidence, 'installation.txt'), installation.stdout + installation.stderr);
const port = editor === 'cursor' ? 19339 : 19338;
const child = spawn(executable, ['--user-data-dir', user, '--extensions-dir', extensions, '--locale=en', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust', ...(editor === 'cursor' ? ['--skip-onboarding'] : []), `--remote-debugging-port=${port}`, '--new-window', root], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let log = ''; child.stdout.on('data', data => { log += data; }); child.stderr.on('data', data => { log += data; });
let browser, page, frame;
const names = [];
const checks = [];
const backend = (id, args) => exec(binaries[id], [...(tmuxLike(id) ? ['-L', token, '-f', config[id]] : id === 'zellij' ? ['--config', config[id]] : []), ...args], { env, windowsHide: true, timeout: 10000 });
try {
  await until(async () => { try { return (await fetch(`http://127.0.0.1:${port}/json/version`)).ok; } catch { return false; } }, 'debug port', 45000);
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  page = await until(async () => browser.contexts()[0]?.pages().find(page => page.url().includes('workbench')), 'workbench', 60000);
  await page.waitForLoadState('domcontentloaded');
  await page.locator('.monaco-workbench .part.titlebar').waitFor();
  await page.bringToFront(); await delay(2000);
  const command = async name => {
    // F1 is terminal input while the extension's iframe owns focus.
    await page.locator('.part.sidebar').click({ position: { x: 10, y: 10 } });
    await page.keyboard.press('F1');
    const input = page.locator('.quick-input-widget input[type="text"]');
    await input.waitFor({ state: 'visible' }); await input.fill(`>${name}`); await delay(400); await input.press('Enter');
  };
  const dock = async () => {
    await command('MuxDock: Open Terminal Dock');
    return until(async () => { for (const frame of page.frames()) if (await frame.locator('.dock').count().catch(() => 0)) return frame; }, 'dock');
  };
  frame = await dock();
  await frame.evaluate(() => window.addEventListener('message', event => { if (event.data.type === 'snapshot') window.muxdockTestSnapshot = event.data.state; }));
  for (const id of managers) await frame.locator(`[data-node="${id}"]`).waitFor();
  checks.push('installed VSIX loads bundled dependencies and discovers selected managers');
  const input = page.locator('.quick-input-widget input[type="text"]');
  for (const id of managers) {
    const name = `${token}_${id}${tmuxLike(id) && id !== 'psmux' || id === 'herdr' ? '' : '_中'}`; names.push({ id, name });
    await frame.locator(`[data-node="${id}"]`).getByRole('button', { name: 'New session', exact: true }).click();
    await input.waitFor({ state: 'visible' }); await input.fill(name); await input.press('Enter');
    const row = frame.getByRole('treeitem', { name, exact: true }); await row.waitFor();
    const terminal = frame.locator('.terminal-instance:not([hidden]) .xterm-helper-textarea');
    await terminal.waitFor({ state: 'attached' });
    const marker = path.join(evidence, `${id}-input.txt`);
    await delay(4000); await terminal.focus();
    await page.keyboard.insertText(`[IO.File]::WriteAllText(${quote(marker)}, 'UI_中文')`); await page.keyboard.press('Enter');
    await until(async () => (await readFile(marker, 'utf8').catch(() => '')) === 'UI_中文', `${id} input`);
    const dropped = path.join(evidence, `${id} 中 it's & [x] $literal.txt`);
    const dropResult = path.join(evidence, `${id}-drop.txt`);
    await writeFile(dropped, 'file drop fixture');
    await terminal.focus(); await page.keyboard.insertText(`[IO.File]::WriteAllText(${quote(dropResult)}, `);
    await frame.locator('.terminal-area').evaluate((element, uri) => {
      const transfer = new DataTransfer(); transfer.setData('resourceurls', JSON.stringify([uri]));
      for (const type of ['dragenter', 'dragover', 'drop']) element.dispatchEvent(new DragEvent(type, { dataTransfer: transfer, bubbles: true, cancelable: true, shiftKey: true }));
    }, pathToFileURL(dropped).href);
    await delay(1500); await terminal.focus(); await page.keyboard.insertText(')'); await page.keyboard.press('Enter');
    await until(async () => (await readFile(dropResult, 'utf8').catch(() => '')) === dropped.replaceAll('\\', '/'), `${id} literal file drop`);
    checks.push(`${id}: simulated Explorer drop preserves spaces, Unicode, apostrophe, &, brackets and $ literally`);
    await row.click({ button: 'right' }); await frame.getByRole('menuitem', { name: 'Session details', exact: true }).click();
    await until(async () => (await frame.locator('.session-details').textContent()).includes(id === 'herdr' ? 'Agent status' : 'initial directory'), `${id} native details`);
    await frame.getByRole('button', { name: 'Close details', exact: true }).click();
    await row.click({ button: 'right' });
    assert.equal(await frame.getByRole('menuitem', { name: 'Rename session', exact: true }).count(), tmuxLike(id) ? 1 : 0);
    await frame.getByRole('menuitem', { name: 'New window', exact: true }).click();
    await input.waitFor({ state: 'visible' }); await input.fill('ui_window'); await input.press('Enter');
    const windowRow = frame.getByRole('treeitem', { name: /\d+: ui_window/ }); await windowRow.waitFor(); await windowRow.click();
    await until(async () => await windowRow.getAttribute('aria-current') === 'true', `${id} window selected`);
    await frame.locator('.terminal-tab[aria-selected="true"] .tab-close').click();
    await until(async () => await frame.locator(`.terminal-tab[aria-label="${name} (${id})"]`).count() === 0, `${id} tab removed`);
    await row.click();
    await until(async () => (await row.getAttribute('class')).includes('is-connected'), `${id} reattached`);
    await delay(4000);
    const continuity = path.join(evidence, `${id}-continuity.txt`);
    await terminal.focus();
    await page.keyboard.insertText(`$global:MuxDockReloadProof = '${token}_${id}'; [IO.File]::WriteAllText(${quote(continuity)}, ('{0}:{1}' -f $PID, $global:MuxDockReloadProof))`);
    await page.keyboard.press('Enter');
    await until(async () => (await readFile(continuity, 'utf8').catch(() => '')).includes(`${token}_${id}`), `${id} continuity marker`);
    await writeFile(path.join(evidence, `${id}-snapshot.json`), JSON.stringify(await frame.evaluate(() => window.muxdockTestSnapshot), null, 2));
    assert.ok(await row.getAttribute('class').then(value => value.includes('is-connected')));
    checks.push(`${id}: UI create, Unicode input, native details, capability menu, new/select window, close/reattach`);
  }
  await frame.locator('.dock').screenshot({ path: path.join(evidence, 'dock.png') });
  await command('Developer: Reload Window'); await delay(2500); frame = await dock();
  for (const { id, name } of names) {
    const row = frame.getByRole('treeitem', { name, exact: true }); await row.waitFor(); await row.click(); await delay(3500);
    await frame.locator('.connection-status.connected').waitFor();
    const reloaded = path.join(evidence, `${id}-reloaded.txt`);
    await frame.locator('.terminal-instance:not([hidden]) .xterm-helper-textarea').focus();
    await page.keyboard.insertText(`[IO.File]::WriteAllText(${quote(reloaded)}, ('{0}:{1}' -f $PID, $global:MuxDockReloadProof))`); await page.keyboard.press('Enter');
    const expected = await readFile(path.join(evidence, `${id}-continuity.txt`), 'utf8');
    await until(async () => (await readFile(reloaded, 'utf8').catch(() => '')) === expected, `${id} same shell PID and memory after editor reload`);
    checks.push(`${id}: same shell PID and in-memory value survive editor reload and reconnect`);
  }
  await writeFile(path.join(evidence, 'result.json'), JSON.stringify({ editor, status: 'PASS', vsix, checks }, null, 2));
  console.log(`${editor}: PASS ${checks.length} checks; ${evidence}`);
} catch (error) {
  if (frame) await writeFile(path.join(evidence, 'failure-snapshot.json'), JSON.stringify(await frame.evaluate(() => window.muxdockTestSnapshot).catch(() => null), null, 2) || 'null');
  for (const id of managers) {
    const result = await backend(id, tmuxLike(id) ? ['list-sessions', '-F', '#{session_id}|#{session_name}|#{session_attached}'] : id === 'herdr' ? ['session', 'list', '--json'] : ['list-sessions', '--no-formatting']).catch(error => ({ stdout: error.stdout || '', stderr: error.stderr || error.message }));
    await writeFile(path.join(evidence, `${id}-failure-state.txt`), result.stdout + result.stderr);
  }
  if (page) await page.screenshot({ path: path.join(evidence, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  await writeFile(path.join(evidence, 'editor.log'), log);
  await browser?.close().catch(() => {});
  // Only this isolated editor process and its descendants are owned by this test.
  const script = `$all = @(Get-CimInstance Win32_Process); $roots = @($all | Where-Object { $_.CommandLine -and $_.CommandLine.Contains(${quote(user)}) } | Select-Object -ExpandProperty ProcessId); $ids = [System.Collections.Generic.HashSet[int]]::new(); foreach ($p in $roots) { [void]$ids.Add($p) }; do { $added = $false; foreach ($p in $all) { if ($ids.Contains([int]$p.ParentProcessId) -and $ids.Add([int]$p.ProcessId)) { $added = $true } } } while ($added); foreach ($p in $ids) { Stop-Process -Id $p -Force -ErrorAction SilentlyContinue }`;
  await exec(binaries.powershell, ['-NoProfile', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true }).catch(() => {});
  for (const { id, name } of names) await backend(id, tmuxLike(id) ? ['kill-session', '-t', name] : id === 'herdr' ? ['session', 'stop', name, '--json'] : ['kill-session', name]).catch(() => {});
  for (const id of managers.filter(tmuxLike)) await backend(id, ['kill-server']).catch(() => {});
}
