import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

export async function checkTerminalClipboard({ frame, page, cli, until, delay }) {
  const clipboard = () => execFileSync('/usr/bin/pbpaste', [], { encoding: 'utf8' });
  const setClipboard = value => execFileSync('/usr/bin/pbcopy', [], { input: value });
  const previous = clipboard();
  const checks = [];
  const marker = 'COPY_中文_🙂_OK';
  const input = frame.locator('.terminal-instance:not([hidden]) .xterm-helper-textarea');
  const rows = frame.locator('.terminal-instance:not([hidden]) .xterm-rows > div');
  const dragMarker = async modifier => {
    // Locator coordinates include the webview's nested iframe offsets.
    const row = rows.filter({ hasText: /^COPY_/ }).last();
    const bounds = await row.boundingBox();
    const size = await row.evaluate(row => {
      const range = document.createRange(); range.selectNodeContents(row);
      const rect = range.getBoundingClientRect();
      return { width: rect.width, height: rect.height };
    });
    assert.ok(bounds, 'Clipboard marker must be rendered');
    const box = { ...bounds, ...size };
    if (modifier) await page.keyboard.down(modifier);
    try {
      await page.mouse.move(box.x + 1, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width + 1, box.y + box.height / 2, { steps: 12 });
      await page.mouse.up();
    } finally { if (modifier) await page.keyboard.up(modifier); }
  };
  const expectCopy = async (scenario, action) => {
    setClipboard('MUXDOCK_CLIPBOARD_SENTINEL');
    await action();
    await until(async () => clipboard() === marker, 5000).catch(() => assert.equal(clipboard(), marker, scenario));
    checks.push(scenario);
  };
  try {
    await input.focus();
    cli(['send-keys', '-t', 'my-project:logs', '-l', `printf '${marker}\\n'`]);
    cli(['send-keys', '-t', 'my-project:logs', 'Enter']);
    await until(async () => rows.evaluateAll(rows => rows.some(row => row.textContent.trim().startsWith('COPY_'))));
    await dragMarker();
    await expectCopy('plain drag and Cmd+C', () => page.keyboard.press('Meta+c'));
    await dragMarker();
    await expectCopy('toolbar preserves selection and copies', () => frame.getByRole('button', { name: '复制选中内容', exact: true }).click());
    await dragMarker();
    const markerBox = await rows.filter({ hasText: /^COPY_/ }).last().boundingBox();
    await page.mouse.click(markerBox.x + 8, markerBox.y + markerBox.height / 2, { button: 'right' });
    await expectCopy('context menu copies selection', () => frame.getByRole('menuitem', { name: '复制', exact: true }).click());
    cli(['set-option', '-t', 'my-project', 'mouse', 'on']);
    await until(async () => frame.locator('.terminal-instance:not([hidden]) .xterm').evaluate(element => element.classList.contains('enable-mouse-events')));
    await dragMarker('Alt');
    await expectCopy('Option drag and Cmd+C with mouse tracking', () => page.keyboard.press('Meta+c'));
    await dragMarker('Alt');
    await expectCopy('Ctrl+Shift+C with mouse tracking', () => page.keyboard.press('Control+Shift+c'));
    cli(['set-option', '-t', 'my-project', 'mouse', 'off']);
    await until(async () => frame.locator('.terminal-instance:not([hidden]) .xterm').evaluate(element => !element.classList.contains('enable-mouse-events')));
    const screen = await frame.locator('.terminal-instance:not([hidden]) .xterm-screen').boundingBox();
    await page.mouse.click(screen.x + 2, screen.y + 2);
    setClipboard('MUXDOCK_CLIPBOARD_SENTINEL');
    await page.keyboard.press('Meta+c'); await delay(250);
    assert.equal(clipboard(), 'MUXDOCK_CLIPBOARD_SENTINEL', 'Copy without a selection must preserve clipboard contents');
    checks.push('copy without a selection preserves clipboard');
  } finally {
    cli(['set-option', '-t', 'my-project', 'mouse', 'off']);
    setClipboard(previous);
    await writeFile('.test-results/terminal-clipboard.json', JSON.stringify({ checks }, null, 2));
  }
  return checks;
}

export async function checkSessionScroll({ frame, page, cli, until, delay, updateSettings }) {
  const names = Array.from({ length: 18 }, (_, index) => `scroll-${String(index).padStart(2, '0')}`);
  const tree = frame.getByRole('tree', { name: '终端管理器', exact: true });
  const scrollTop = () => tree.evaluate(element => element.scrollTop);
  const checks = [];
  await updateSettings({ 'muxdock.refreshInterval': 60 });
  try {
    for (const name of names) cli(['new-session', '-d', '-s', name, '/bin/sh']);
    await frame.getByRole('button', { name: '刷新', exact: true }).click();
    const last = frame.getByRole('treeitem', { name: names.at(-1), exact: true });
    await last.waitFor();
    await until(async () => !await frame.getByRole('button', { name: '刷新', exact: true }).evaluate(button => button.classList.contains('spinning')));
    await delay(250);
    await last.evaluate(element => element.scrollIntoView({ block: 'nearest' }));
    const before = await scrollTop();
    assert.ok(before > 200, 'Session tree must be scrolled to reproduce jumping');
    await last.click();
    await until(async () => await frame.getByRole('tab', { name: `${names.at(-1)} (tmux)`, exact: true }).getAttribute('aria-selected') === 'true');
    await delay(250);
    assert.ok(Math.abs(await scrollTop() - before) <= 1, `Clicking a session changed scrollTop from ${before} to ${await scrollTop()}`);
    checks.push('clicking a low session preserves tree scroll');
    await frame.getByRole('button', { name: '刷新', exact: true }).click();
    await delay(1500);
    assert.ok(Math.abs(await scrollTop() - before) <= 1, 'Refreshing must preserve tree scroll');
    checks.push('refresh preserves tree scroll');
    await updateSettings({ 'muxdock.refreshInterval': 1 });
    await delay(2200);
    assert.ok(Math.abs(await scrollTop() - before) <= 1, 'Automatic refresh must preserve tree scroll');
    checks.push('automatic refresh preserves tree scroll');
    await updateSettings({ 'muxdock.refreshInterval': 60 });
    await frame.getByRole('tab', { name: 'my-project (tmux)', exact: true }).click();
    await until(async () => await frame.getByRole('tab', { name: 'my-project (tmux)', exact: true }).getAttribute('aria-selected') === 'true');
    assert.ok(Math.abs(await scrollTop() - before) <= 1, 'Switching tabs must preserve tree scroll');
    checks.push('switching terminal tabs preserves tree scroll');
    await last.focus();
    await page.keyboard.press('ArrowUp');
    await until(async () => frame.evaluate(name => document.activeElement?.getAttribute('aria-label') === name, names.at(-2)));
    checks.push('tree keyboard navigation still works');
  } finally {
    const close = frame.getByRole('button', { name: `关闭标签页 ${names.at(-1)} (tmux)`, exact: true });
    if (await close.count()) await close.click();
    for (const name of names) cli(['kill-session', '-t', name]);
    await updateSettings({ 'muxdock.refreshInterval': 1 });
    await until(async () => await frame.getByRole('treeitem', { name: names.at(-1), exact: true }).count() === 0);
    await frame.getByRole('treeitem', { name: 'my-project', exact: true }).click();
    await until(async () => await frame.getByRole('tab', { name: 'my-project (tmux)', exact: true }).getAttribute('aria-selected') === 'true');
    await writeFile('.test-results/session-scroll.json', JSON.stringify({ checks }, null, 2));
  }
  return checks;
}
