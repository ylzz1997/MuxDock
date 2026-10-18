import { chromium } from 'playwright';
import { spawn, execFileSync } from 'node:child_process';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = process.cwd();
const installed = !!process.env.MUXDOCK_USE_VSIX;
const testEditor = process.env.MUXDOCK_TEST_EDITOR || 'vscode';
if (!['vscode', 'cursor'].includes(testEditor)) throw new Error('MUXDOCK_TEST_EDITOR must be vscode or cursor');
const editorSuffix = testEditor === 'vscode' ? '' : `-${testEditor}`;
const userData = path.join(root, (installed ? '.vscode-test/ui-installed-user' : '.vscode-test/ui-user') + editorSuffix);
const extensionsDirectory = path.join(root, (installed ? '.vscode-test/installed-extensions' : '.vscode-test/extensions') + editorSuffix);
const socket = `/tmp/muxdock-ui-${process.pid}.sock`;
const port = 19337;
const code = process.env.MUXDOCK_CODE || '/Applications/Visual Studio Code.app/Contents/MacOS/Code';
const tmux = process.env.MUXDOCK_TMUX || '/opt/homebrew/bin/tmux';
const cli = args => execFileSync(tmux, ['-S', socket, '-f', '/dev/null', ...args], { encoding: 'utf8' });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (fn, timeout = 30000) => { const end = Date.now() + timeout; while (Date.now() < end) { const value = await fn(); if (value) return value; await delay(200); } throw new Error('UI wait timed out'); };
const settingsPath = path.join(userData, 'User/settings.json');
const updateSettings = async patch => {
  const settings = JSON.parse(await readFile(settingsPath, 'utf8'));
  await writeFile(settingsPath, JSON.stringify({ ...settings, ...patch }, null, 2));
};
await mkdir(path.join(userData, 'User'), { recursive: true });
await mkdir('.test-results', { recursive: true });
let executables = {};
try { executables = JSON.parse(await readFile('.test-tools/executables.json', 'utf8')); } catch { }
const wrapper = path.join(root, '.test-results/ui-tmux');
await writeFile(wrapper, `#!/usr/bin/python3\nimport os,sys,json,subprocess\nlog=${JSON.stringify(path.join(root, '.test-results/ui-tmux-calls.jsonl'))}\nwith open(log,'a') as f: f.write(json.dumps(sys.argv[1:])+'\\n')\nif 'list-sessions' in sys.argv:\n r=subprocess.run([${JSON.stringify(tmux)}]+sys.argv[1:],capture_output=True)\n with open(log,'a') as f: f.write(json.dumps({'out':r.stdout.decode(),'err':r.stderr.decode(),'code':r.returncode})+'\\n')\n sys.stdout.buffer.write(r.stdout)\n sys.stderr.buffer.write(r.stderr)\n sys.exit(r.returncode)\nos.execv(${JSON.stringify(tmux)},[${JSON.stringify(tmux)}]+sys.argv[1:])\n`);
await chmod(wrapper, 0o755);
executables.tmux = wrapper;
await writeFile(path.join(userData, 'User/settings.json'), JSON.stringify({
  'workbench.startupEditor': 'none', 'workbench.colorTheme': 'Default Dark Modern',
  'chat.disableAIFeatures': true,
  'security.workspace.trust.enabled': false, 'window.zoomLevel': 0,
  'muxdock.arguments': { tmux: ['-S', socket, '-f', '/dev/null'] },
  'muxdock.executables': executables, 'muxdock.refreshInterval': 1,
  'window.titleBarStyle': 'custom', 'workbench.panel.defaultLocation': 'bottom',
  'window.dialogStyle': 'custom'
}, null, 2));
cli(['new-session', '-d', '-s', 'my-project', '-n', 'api', '/bin/sh']);
cli(['new-window', '-d', '-t', 'my-project', '-n', 'logs', '/bin/sh']);
cli(['set-option', '-as', 'terminal-features', ',xterm-256color:RGB']);
await writeFile('.test-results/ui-server-before.txt', cli(['list-sessions']));
if (installed) {
  const cliPath = process.env.MUXDOCK_CODE_CLI || '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code';
  console.log(execFileSync(cliPath, ['--user-data-dir', userData, '--extensions-dir', extensionsDirectory, '--install-extension', path.resolve(process.env.MUXDOCK_USE_VSIX), '--force'], { encoding: 'utf8' }));
}
const processCode = spawn(code, ['--user-data-dir', userData, '--extensions-dir', extensionsDirectory, ...(installed ? [] : ['--extensionDevelopmentPath', root]), '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust', `--remote-debugging-port=${port}`, '--new-window', root], { stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
processCode.stdout.on('data', data => { log += data; }); processCode.stderr.on('data', data => { log += data; });
let browser;
try {
  await until(async () => { try { return (await fetch(`http://127.0.0.1:${port}/json/version`)).ok; } catch { return false; } }, 45000);
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const page = await until(async () => {
    for (const candidate of browser.contexts()[0]?.pages() || []) {
      if (candidate.url().includes('workbench') && await candidate.locator('.monaco-workbench .part.titlebar').count().catch(() => 0)) return candidate;
    }
    return false;
  }, 60000);
  await page.waitForLoadState('domcontentloaded');
  await page.bringToFront();
  const command = async name => {
    await page.keyboard.press('Meta+Shift+P');
    const input = page.locator('.quick-input-widget input[type="text"]'); await input.waitFor({ state: 'visible' });
    await input.fill(`>${name}`); await delay(400); await input.press('Enter');
  };
  await delay(1500);
  await writeFile('.test-results/ui-server-after.txt', cli(['list-sessions']));
  await command('MuxDock: 打开终端面板');
  const frame = await until(async () => {
    for (const frame of page.frames()) { try { if (await frame.locator('.dock').count()) return frame; } catch { } }
    return false;
  });
  await frame.evaluate(() => {
    window.styleViolations = [];
    document.addEventListener('securitypolicyviolation', event => {
      if (event.effectiveDirective.startsWith('style-src')) window.styleViolations.push({ directive: event.effectiveDirective, blockedURI: event.blockedURI });
    });
  });
  await frame.getByRole('treeitem', { name: 'my-project', exact: true }).waitFor({ timeout: 30000 });
  const filterToggle = frame.getByRole('button', { name: '筛选会话', exact: true });
  const filterInput = frame.locator('input.filter');
  if (await filterInput.isVisible()) await filterToggle.click();
  assert.equal(await filterInput.isVisible(), false);
  const panel = page.locator('.part.panel');
  const resizePanel = async height => {
    const box = await panel.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y - 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height - height - 2, { steps: 12 });
    await page.mouse.up();
    await delay(250);
  };
  const layoutChecks = [];
  for (const height of [420, 300, 220, 170, 120]) {
    await resizePanel(height);
    const layout = await frame.evaluate(() => {
      const content = document.querySelector('.terminal-content').getBoundingClientRect();
      const collisions = [];
      for (const selector of ['.terminal-header', '.terminal-footer']) {
        const box = document.querySelector(selector).getBoundingClientRect();
        for (const x of [.1, .5, .9]) for (const y of [.25, .5, .75]) {
          if (document.elementsFromPoint(box.x + box.width * x, box.y + box.height * y).some(element => element.closest('.welcome'))) collisions.push(selector);
        }
      }
      return { contentHeight: content.height, collisions };
    });
    layoutChecks.push({ requestedHeight: height, ...layout });
    assert.deepEqual(layout.collisions, [], `Welcome paints over header/footer at panel height ${height}`);
    await frame.locator('.welcome .new-session').focus();
    const buttonReachable = await frame.locator('.welcome .new-session').evaluate(button => {
      const box = button.getBoundingClientRect();
      return document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)?.closest('button') === button;
    });
    assert.ok(buttonReachable, `New session button is unreachable at panel height ${height}`);
    if (height === 170) await frame.locator('.dock').screenshot({ path: '.test-results/muxdock-empty-compact.png' });
  }
  await resizePanel(350);
  assert.equal(await frame.locator('.connection-status').textContent(), '未打开会话');
  await page.screenshot({ path: '.test-results/vscode-empty.png' });
  await frame.getByRole('treeitem', { name: 'my-project', exact: true }).click();
  await frame.locator('.connection-status.connected').waitFor();
  await frame.getByRole('treeitem', { name: '1: logs', exact: true }).waitFor();
  await frame.getByRole('treeitem', { name: '1: logs', exact: true }).click();
  await until(async () => cli(['display-message', '-p', '-t', 'my-project', '#{window_name}']).trim() === 'logs');
  const input = frame.locator('.terminal-instance:not([hidden]) .xterm-helper-textarea');
  await input.focus();
  await page.keyboard.type("printf 'MUXDOCK_%s\\n' 'UI_OK'"); await page.keyboard.press('Enter');
  await until(async () => cli(['capture-pane', '-p', '-t', 'my-project:logs']).includes('MUXDOCK_UI_OK'));
  await page.keyboard.type("printf '\\033[31mANSI_RED\\033[0m \\033[32mANSI_GREEN\\033[0m \\033[42mANSI_GREEN_BG\\033[0m \\033[38;5;196mANSI_256\\033[0m \\033[38;2;18;171;205mANSI_RGB\\033[0m\\n'");
  await page.keyboard.press('Enter');
  const rendering = await until(async () => frame.evaluate(() => {
    const terminal = document.querySelector('.terminal-instance:not([hidden])');
    const spans = [...terminal.querySelectorAll('.xterm-rows span')];
    const colors = {};
    for (const marker of ['ANSI_RED', 'ANSI_GREEN', 'ANSI_GREEN_BG', 'ANSI_256', 'ANSI_RGB']) {
      const span = spans.find(element => element.textContent === marker);
      if (!span) return false;
      const style = getComputedStyle(span);
      colors[marker] = { foreground: style.color, background: style.backgroundColor };
    }
    const styles = [...terminal.querySelectorAll('style')];
    return { colors, styleSheets: styles.map(style => !!style.sheet), violations: window.styleViolations };
  }));
  await writeFile('.test-results/terminal-rendering.json', JSON.stringify(rendering, null, 2));
  assert.ok(rendering.styleSheets.length > 0 && rendering.styleSheets.every(Boolean), 'xterm dynamic color and cell-size styles must apply');
  assert.deepEqual(rendering.violations, [], 'Terminal styles must not be blocked by CSP');
  assert.notEqual(rendering.colors.ANSI_RED.foreground, rendering.colors.ANSI_GREEN.foreground, 'ANSI foreground colors must render differently');
  assert.notEqual(rendering.colors.ANSI_GREEN_BG.background, 'rgba(0, 0, 0, 0)', 'ANSI background colors must be visible');
  assert.equal(rendering.colors.ANSI_256.foreground, 'rgb(255, 0, 0)');
  assert.equal(rendering.colors.ANSI_RGB.foreground, 'rgb(18, 171, 205)');
  const terminalLayoutChecks = [];
  const readTerminalLayout = () => frame.evaluate(() => {
    const terminal = document.querySelector('.terminal-instance:not([hidden])');
    const rect = element => {
      const box = element.getBoundingClientRect();
      return { top: box.top, bottom: box.bottom, left: box.left, right: box.right, width: box.width, height: box.height };
    };
    const rows = [...terminal.querySelectorAll('.xterm-rows > div')].filter(row => row.textContent);
    const cursor = terminal.querySelector('.xterm-cursor');
    const viewport = terminal.querySelector('.xterm-viewport');
    return {
      content: rect(document.querySelector('.terminal-content')),
      footer: rect(document.querySelector('.terminal-footer')),
      grid: rect(terminal.querySelector('.xterm-screen')),
      lastRow: rect(rows[rows.length - 1]),
      cursor: cursor ? rect(cursor) : undefined,
      horizontalOverflow: viewport.scrollWidth - viewport.clientWidth
    };
  });
  const assertTerminalFits = async scenario => {
    const layout = await readTerminalLayout();
    terminalLayoutChecks.push({ scenario, ...layout });
    await writeFile('.test-results/terminal-layout.json', JSON.stringify(terminalLayoutChecks, null, 2));
    assert.ok(layout.grid.bottom <= layout.footer.top + .5, `Terminal grid is clipped by footer: ${scenario}`);
    assert.ok(layout.lastRow.bottom <= layout.footer.top + .5, `Last terminal row is clipped: ${scenario}`);
    assert.ok(layout.grid.right <= layout.content.right + .5, `Terminal grid exceeds available width: ${scenario}`);
    assert.equal(layout.horizontalOverflow, 0, `Terminal has a horizontal scrollbar: ${scenario}`);
    assert.ok(layout.cursor && layout.cursor.bottom <= layout.footer.top + .5, `Terminal cursor is clipped: ${scenario}`);
  };
  const fillTerminal = async marker => {
    await input.focus();
    cli(['send-keys', '-t', 'my-project:logs', '-l', `i=0; while [ $i -lt 60 ]; do printf 'FILL_%s\\n' $i; i=$((i+1)); done; printf 'FIT_%s\\n' '${marker}'`]);
    cli(['send-keys', '-t', 'my-project:logs', 'Enter']);
    await until(async () => (await frame.locator('.terminal-instance:not([hidden]) .xterm-rows').textContent()).includes(`FIT_${marker}`));
    await delay(100);
  };
  cli(['set-option', '-t', 'my-project', 'status', 'off']);
  for (const fontSize of [14, 22]) {
    await updateSettings({ 'muxdock.fontSize': fontSize });
    await until(async () => await frame.locator('.terminal-instance:not([hidden]) .xterm-rows').evaluate(element => getComputedStyle(element).fontSize) === `${fontSize}px`);
    for (const height of [420, 300, 220, 180]) {
      await resizePanel(height);
      await fillTerminal(`${fontSize}_${height}`);
      await assertTerminalFits(`font ${fontSize}, panel ${height}, prompt at bottom`);
    }
  }
  await updateSettings({ 'muxdock.fontSize': 14 });
  await until(async () => await frame.locator('.terminal-instance:not([hidden]) .xterm-rows').evaluate(element => getComputedStyle(element).fontSize) === '14px');
  await resizePanel(350);
  await frame.getByRole('button', { name: '搜索终端', exact: true }).click();
  await delay(250);
  await assertTerminalFits('terminal search expanded');
  await frame.locator('.search-close').click();
  await delay(250);
  await fillTerminal('FINAL');
  await assertTerminalFits('normal prompt at bottom after restoring panel size');
  await frame.locator('.dock').screenshot({ path: '.test-results/muxdock-prompt-bottom.png' });
  cli(['set-option', '-t', 'my-project', 'status', 'on']);
  await delay(300);
  await assertTerminalFits('tmux status bar visible');
  await frame.locator('.dock').screenshot({ path: '.test-results/muxdock-terminal-bottom.png' });
  await frame.getByRole('button', { name: '断开连接，保留后台会话', exact: true }).click();
  cli(['has-session', '-t', 'my-project']);
  await until(async () => await frame.locator('.terminal-tab.closed').count() === 1);
  await frame.getByRole('treeitem', { name: 'my-project', exact: true }).click();
  await frame.locator('.connection-status.connected').waitFor();
  await until(async () => cli(['list-clients', '-F', '#{session_name}']).trim().split('\n').includes('my-project'));
  await delay(350);
  await input.focus(); await page.keyboard.press('Control+b'); await page.keyboard.press('c');
  await until(async () => cli(['list-windows', '-t', 'my-project']).trim().split('\n').length === 3);
  await until(async () => await frame.locator('.level-2').count() === 3);
  await frame.getByRole('treeitem', { name: '1: logs', exact: true }).click({ button: 'right' });
  await frame.getByRole('menuitem', { name: '重命名 window', exact: true }).click();
  const rename = page.locator('.quick-input-widget input[type="text"]'); await rename.waitFor({ state: 'visible' }); await rename.fill('server-logs'); await rename.press('Enter');
  await frame.getByRole('treeitem', { name: '1: server-logs', exact: true }).waitFor();
  await frame.getByRole('treeitem', { name: '1: server-logs', exact: true }).click();
  assert.ok(cli(['list-windows', '-t', 'my-project']).includes('server-logs'));
  await filterToggle.click();
  await filterInput.fill('server-logs');
  assert.equal(await frame.locator('.level-2').count(), 1);
  await filterToggle.click();
  assert.equal(await filterInput.isVisible(), false);
  assert.equal(await filterInput.inputValue(), '');
  assert.equal(await frame.locator('.level-2').count(), 3);
  await filterToggle.click();
  await filterInput.fill('not-a-session');
  await filterInput.press('Escape');
  assert.equal(await filterInput.isVisible(), false);
  await frame.getByRole('treeitem', { name: 'tmux', exact: true }).getByRole('button', { name: '新建会话', exact: true }).click();
  const newName = page.locator('.quick-input-widget input[type="text"]'); await newName.waitFor({ state: 'visible' }); await delay(1400); await newName.fill('secondary'); await newName.press('Enter');
  await frame.getByRole('treeitem', { name: 'secondary', exact: true }).waitFor();
  await frame.getByRole('treeitem', { name: 'my-project', exact: true }).click();
  await until(async () => cli(['list-clients', '-F', '#{session_name}']).trim().split('\n').filter(name => name === 'my-project').length === 1);
  const tabNames = () => frame.getByRole('tab').evaluateAll(tabs => tabs.map(tab => tab.getAttribute('aria-label')));
  assert.deepEqual(await tabNames(), ['my-project (tmux)', 'secondary (tmux)']);
  await frame.getByRole('tab', { name: 'secondary (tmux)', exact: true }).click();
  await until(async () => await frame.getByRole('tab', { name: 'secondary (tmux)', exact: true }).getAttribute('aria-selected') === 'true');
  assert.equal(cli(['list-clients', '-F', '#{session_name}']).trim().split('\n').length, 2);
  await frame.getByRole('tab', { name: 'secondary (tmux)', exact: true }).focus();
  await page.keyboard.press('ArrowLeft');
  await until(async () => await frame.getByRole('tab', { name: 'my-project (tmux)', exact: true }).getAttribute('aria-selected') === 'true');
  await until(async () => frame.evaluate(() => document.activeElement?.getAttribute('role') === 'tab' && document.activeElement?.getAttribute('aria-selected') === 'true'));
  await page.keyboard.press('ArrowRight');
  await until(async () => await frame.getByRole('tab', { name: 'secondary (tmux)', exact: true }).getAttribute('aria-selected') === 'true');
  await updateSettings({ 'muxdock.maxTabs': 2, 'muxdock.showTabs': false });
  await until(async () => !await frame.getByRole('tablist').isVisible());
  assert.equal(await frame.locator('.terminal-heading').isVisible(), true);
  await updateSettings({ 'muxdock.showTabs': true });
  await until(async () => await frame.getByRole('tablist').isVisible());
  const sidebar = frame.locator('#session-sidebar');
  const splitter = frame.getByRole('separator', { name: '调整会话树宽度', exact: true });
  await splitter.focus(); await splitter.press('ArrowLeft');
  const sidebarWidth = (await sidebar.boundingBox()).width;
  const terminalWidth = (await frame.locator('.terminal-content').boundingBox()).width;
  const clientsBeforeCollapse = cli(['list-clients', '-F', '#{client_pid}:#{session_name}']).trim().split('\n').sort();
  const tabsBeforeCollapse = await tabNames();
  await filterToggle.click(); await filterInput.fill('server-logs');
  await frame.getByRole('button', { name: '收起会话面板', exact: true }).click();
  assert.equal(await sidebar.isVisible(), false);
  assert.equal(await splitter.isVisible(), false);
  const expandSidebar = frame.getByRole('button', { name: '展开会话面板', exact: true });
  assert.equal(await expandSidebar.getAttribute('aria-expanded'), 'false');
  await until(async () => (await frame.locator('.terminal-content').boundingBox()).width >= terminalWidth + sidebarWidth);
  assert.deepEqual(await tabNames(), tabsBeforeCollapse);
  assert.deepEqual(cli(['list-clients', '-F', '#{client_pid}:#{session_name}']).trim().split('\n').sort(), clientsBeforeCollapse);
  await input.focus(); await page.keyboard.type("printf 'COLLAPSED_PANEL_%s\\n' 'OK'"); await page.keyboard.press('Enter');
  await until(async () => cli(['capture-pane', '-p', '-t', 'secondary']).includes('COLLAPSED_PANEL_OK'));
  await frame.getByRole('tab', { name: 'my-project (tmux)', exact: true }).click();
  await until(async () => await frame.getByRole('tab', { name: 'my-project (tmux)', exact: true }).getAttribute('aria-selected') === 'true');
  assert.equal(await sidebar.isVisible(), false);
  await delay(250); await assertTerminalFits('session panel collapsed');
  await frame.locator('.dock').screenshot({ path: '.test-results/muxdock-sidebar-collapsed.png' });
  await expandSidebar.focus(); await expandSidebar.press('Enter');
  assert.equal(await sidebar.isVisible(), true);
  assert.equal(await splitter.isVisible(), true);
  assert.equal((await sidebar.boundingBox()).width, sidebarWidth);
  assert.equal(await filterInput.inputValue(), 'server-logs');
  assert.equal(await filterInput.isVisible(), true);
  await filterToggle.click();
  await frame.getByRole('tab', { name: 'secondary (tmux)', exact: true }).click();
  await until(async () => await frame.getByRole('tab', { name: 'secondary (tmux)', exact: true }).getAttribute('aria-selected') === 'true');
  const openExternal = async name => {
    cli(['new-session', '-d', '-s', name, '/bin/sh']);
    await frame.getByRole('treeitem', { name, exact: true }).waitFor();
    await frame.getByRole('treeitem', { name, exact: true }).click();
    await until(async () => await frame.getByRole('tab', { name: `${name} (tmux)`, exact: true }).getAttribute('aria-selected') === 'true');
  };
  await openExternal('third');
  await until(async () => (await tabNames()).join('|') === 'secondary (tmux)|third (tmux)');
  cli(['has-session', '-t', 'my-project']);
  assert.ok(!cli(['list-clients', '-F', '#{session_name}']).includes('my-project'));
  await frame.getByRole('tab', { name: 'secondary (tmux)', exact: true }).click();
  await openExternal('fourth');
  await until(async () => (await tabNames()).join('|') === 'third (tmux)|fourth (tmux)');
  cli(['has-session', '-t', 'secondary']);
  await updateSettings({ 'muxdock.maxTabs': 1 });
  await until(async () => (await tabNames()).join('|') === 'fourth (tmux)');
  cli(['has-session', '-t', 'third']);
  await frame.getByRole('button', { name: '关闭标签页 fourth (tmux)', exact: true }).click();
  await until(async () => await frame.locator('.welcome').isVisible());
  cli(['has-session', '-t', 'fourth']);
  await frame.getByRole('treeitem', { name: 'third', exact: true }).click();
  await frame.getByRole('tab', { name: 'third (tmux)', exact: true }).waitFor();
  await updateSettings({ 'muxdock.visibleManagers': ['screen', 'tmux'] });
  await until(async () => (await frame.locator('.manager-row').evaluateAll(rows => rows.map(row => row.dataset.node))).join('|') === 'screen|tmux');
  await updateSettings({ 'muxdock.visibleManagers': [] });
  await until(async () => await frame.locator('.manager-row').count() === 0);
  assert.ok((await frame.locator('.tree-empty').textContent()).includes('未选择显示的管理器'));
  await input.focus(); await page.keyboard.type("printf 'HIDDEN_MANAGER_%s\\n' 'OK'"); await page.keyboard.press('Enter');
  await until(async () => cli(['capture-pane', '-p', '-t', 'third']).includes('HIDDEN_MANAGER_OK'));
  await page.keyboard.type('exit'); await page.keyboard.press('Enter');
  await until(async () => await frame.locator('.terminal-tab.closed').count() === 1);
  assert.equal(await frame.locator('.connection-status').textContent(), '连接已关闭');
  await until(async () => (await frame.locator('.terminal-instance:not([hidden]) .xterm-rows').textContent()).includes('[exited]'));
  await updateSettings({ 'muxdock.maxTabs': 8, 'muxdock.visibleManagers': ['tmux', 'zmx', 'screen', 'zellij', 'shpool', 'abduco', 'a4'] });
  await frame.getByRole('treeitem', { name: 'my-project', exact: true }).waitFor();
  await frame.getByRole('treeitem', { name: 'my-project', exact: true }).click();
  await frame.getByRole('tab', { name: 'my-project (tmux)', exact: true }).waitFor();
  await frame.getByRole('treeitem', { name: 'secondary', exact: true }).click();
  await frame.getByRole('tab', { name: 'secondary (tmux)', exact: true }).waitFor();
  await frame.getByRole('button', { name: '关闭标签页 third (tmux)', exact: true }).click();
  await until(async () => await frame.getByRole('tab').count() === 2);
  // Use the panel's real resize sash; this also verifies fitting the terminal after layout changes.
  const before = await panel.boundingBox();
  if (before.height < 550) {
    await page.mouse.move(before.x + before.width / 2, before.y - 2);
    await page.mouse.down(); await page.mouse.move(before.x + before.width / 2, 100, { steps: 15 }); await page.mouse.up();
  }
  await delay(600);
  await page.screenshot({ path: '.test-results/vscode-muxdock.png' });
  await frame.locator('.dock').screenshot({ path: '.test-results/muxdock-panel.png' });
  await frame.getByRole('treeitem', { name: 'secondary', exact: true }).click();
  await until(async () => cli(['display-message', '-p', '-t', 'secondary', '#{pane_current_command}']).trim() === path.basename(process.env.SHELL || '/bin/sh'));
  await resizePanel(420);
  await delay(600);
  await frame.locator('.dock').screenshot({ path: '.test-results/muxdock-zsh.png' });
  const endFromTree = async (name, confirm = true) => {
    await frame.getByRole('treeitem', { name, exact: true }).click({ button: 'right' });
    await frame.getByRole('menuitem', { name: '结束会话…', exact: true }).click();
    const dialog = page.locator('.monaco-dialog-box');
    await dialog.waitFor({ state: 'visible' });
    await dialog.getByRole('button', { name: confirm ? '结束会话' : /Cancel|取消/, exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
  };
  await endFromTree('secondary', false);
  cli(['has-session', '-t', 'secondary']);
  assert.equal(await frame.getByRole('tab', { name: 'secondary (tmux)', exact: true }).getAttribute('aria-selected'), 'true');
  await endFromTree('my-project');
  await until(async () => await frame.getByRole('tab', { name: 'my-project (tmux)', exact: true }).count() === 0);
  assert.equal(await frame.getByRole('tab', { name: 'secondary (tmux)', exact: true }).getAttribute('aria-selected'), 'true');
  assert.ok(!cli(['list-sessions', '-F', '#{session_name}']).trim().split('\n').includes('my-project'));
  await frame.getByRole('treeitem', { name: 'fourth', exact: true }).click();
  await frame.getByRole('tab', { name: 'fourth (tmux)', exact: true }).waitFor();
  await endFromTree('fourth');
  await until(async () => await frame.getByRole('tab', { name: 'fourth (tmux)', exact: true }).count() === 0);
  assert.equal(await frame.getByRole('tab', { name: 'secondary (tmux)', exact: true }).getAttribute('aria-selected'), 'true');
  await endFromTree('secondary');
  await until(async () => await frame.locator('.welcome').isVisible());
  assert.equal(await frame.getByRole('tab').count(), 0);
  assert.equal(await frame.locator('.terminal-instance').count(), 0);
  const widthBeforeReload = (await sidebar.boundingBox()).width;
  await frame.getByRole('button', { name: '收起会话面板', exact: true }).click();
  await command('Developer: Reload Webviews');
  const restoredFrame = await until(async () => {
    for (const candidate of page.frames()) if (candidate !== frame && await candidate.locator('.dock').count().catch(() => 0)) return candidate;
    return false;
  });
  const restoredToggle = restoredFrame.getByRole('button', { name: '展开会话面板', exact: true });
  await restoredToggle.waitFor({ state: 'visible' });
  assert.equal(await restoredFrame.locator('#session-sidebar').isVisible(), false);
  await restoredToggle.click();
  assert.equal((await restoredFrame.locator('#session-sidebar').boundingBox()).width, widthBeforeReload);
  await writeFile('.test-results/ui.json', JSON.stringify({ status: 'PASS', editor: testEditor, installedVsix: installed, layoutChecks, terminalLayoutChecks, rendering, checks: ['session panel collapse expands terminal without disconnecting clients', 'terminal input and tab switching work with the session panel hidden', 'session panel restores width and filter with keyboard toggle', 'session panel visibility and width survive webview reload', 'cancel ending a session preserves backend and active tab', 'ending an inactive session removes only its tab', 'ending the active session selects a remaining tab', 'ending the last session clears terminal and shows welcome', 'terminal last row and cursor fit at four heights and two font sizes', 'no horizontal terminal overflow', 'terminal fits with search expanded and tmux status bar', 'filter toggles below header and clears on close/Escape', 'tabs switch existing clients', 'tab keyboard navigation', 'hide/show tabs applies immediately', 'FIFO tab eviction preserves backend sessions', 'lower maxTabs applies immediately', 'closing last tab shows welcome', 'manager visibility and order apply immediately', 'hidden manager terminal remains usable', 'exited tab retains last output', 'ANSI foreground and background colors', '256-color and truecolor rendering', 'xterm dynamic styles permitted by CSP', 'welcome stays inside content at five panel heights', 'new session button reachable at five panel heights', 'clear empty connection status', 'extension activation', 'real webview tree', 'tmux window click', 'terminal input verified by capture-pane', 'detach preserves session', 'reattach', 'Ctrl+B c passthrough', 'external window sync', 'window rename menu', 'create from manager row', 'reuse existing session connection'], screenshot: 'vscode-muxdock.png' }, null, 2));
  console.log(`${testEditor === 'cursor' ? 'Cursor' : 'VS Code'} UI: PASS`);
} catch (error) {
  if (browser) for (const page of browser.contexts()[0].pages()) if (page.url().includes('workbench')) {
    await page.screenshot({ path: '.test-results/vscode-failure.png' }).catch(() => {});
    for (const frame of page.frames()) if (await frame.locator('.dock').count().catch(() => 0)) await writeFile('.test-results/ui-failure.json', JSON.stringify(await frame.evaluate(() => ({ activeElement: document.activeElement?.outerHTML.slice(0, 700), hasFocus: document.hasFocus(), tabs: [...document.querySelectorAll('[role=tab]')].map(tab => ({ key: tab.getAttribute('aria-label'), selected: tab.getAttribute('aria-selected') })) })), null, 2));
  }
  await writeFile('.test-results/vscode-process.log', log);
  throw error;
} finally {
  await browser?.close(); processCode.kill('SIGTERM');
  processCode.stdout.destroy(); processCode.stderr.destroy(); processCode.unref();
  try { cli(['kill-server']); } catch { }
}
