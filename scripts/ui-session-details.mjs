import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, realpath } from 'node:fs/promises';

export async function checkSessionDetails({ frame, page, cli, until, delay, resizePanel, updateSettings, editor }) {
  const name = 'details-check';
  const keep = 'details-keep';
  const directory = await realpath(await mkdir('.test-results/详情 path', { recursive: true }).then(() => '.test-results/详情 path'));
  const session = frame.getByRole('treeitem', { name, exact: true });
  const dialog = frame.getByRole('dialog');
  const clients = () => Number(cli(['display-message', '-p', '-t', name, '#{session_attached}']).trim());
  const tab = frame.getByRole('tab', { name: `${name} (tmux)`, exact: true });
  const checks = [];
  const previousClipboard = execFileSync('/usr/bin/pbpaste', { encoding: 'utf8' });
  const external = [];
  const menu = async (row, item) => { await row.click({ button: 'right' }); await frame.getByRole('menuitem', { name: item, exact: true }).click(); };
  const field = label => dialog.locator('dt').filter({ hasText: new RegExp(`^${label}$`) }).first().evaluate(element => element.nextElementSibling.textContent);
  const attachExternal = () => {
    const socket = cli(['display-message', '-p', '-t', name, '#{socket_path}']).trim();
    const client = spawn(process.env.MUXDOCK_TMUX || '/opt/homebrew/bin/tmux', ['-S', socket, '-C', 'attach-session', '-t', name], { env: { ...process.env, TMUX: '', TMUX_PANE: '' }, stdio: ['pipe', 'ignore', 'ignore'] });
    external.push(client); return client;
  };
  try {
    cli(['new-session', '-d', '-s', name, '-n', 'inspect', '-c', directory, '/bin/sh']);
    cli(['new-window', '-d', '-t', name, '-n', 'second', '/bin/sh']);
    cli(['new-session', '-d', '-s', keep, '/bin/sh']);
    await frame.getByRole('button', { name: '刷新', exact: true }).click(); await session.waitFor();
    await session.click(); await until(async () => clients() === 1 && await tab.getAttribute('aria-selected') === 'true');
    const pid = cli(['display-message', '-p', '-t', `${name}:inspect`, '#{pane_pid}']).trim();
    const pane = cli(['display-message', '-p', '-t', `${name}:inspect`, '#{pane_id}']).trim();
    await menu(session, '会话详情');
    await until(async () => await dialog.locator('dd').filter({ hasText: new RegExp(`^${name}$`) }).count() === 1);
    assert.equal(await field('会话名称'), name);
    assert.equal(await field('客户端连接数'), '1');
    assert.equal(clients(), 1, 'Opening details must not attach another client');
    assert.ok((await dialog.textContent()).includes(directory));
    assert.ok((await dialog.textContent()).includes(pid));
    assert.notEqual(await field('会话创建时间'), '未提供');
    assert.equal(await dialog.locator('h3').count(), 2);
    await dialog.getByRole('button', { name: '复制详情', exact: true }).click();
    await until(async () => execFileSync('/usr/bin/pbpaste', { encoding: 'utf8' }).includes(directory));
    await dialog.screenshot({ path: `.test-results/session-details-${editor}.png` });
    cli(['send-keys', '-t', pane, 'sleep 30', 'Enter']);
    await until(async () => cli(['display-message', '-p', '-t', pane, '#{pane_current_command}']).trim() === 'sleep');
    await dialog.getByRole('button', { name: '刷新详情', exact: true }).click();
    await until(async () => (await dialog.textContent()).includes('sleep'));
    await resizePanel(170);
    await dialog.getByRole('button', { name: '关闭详情', exact: true }).click();
    cli(['send-keys', '-t', pane, 'C-c']);
    await resizePanel(350);
    checks.push('session details show native PID, creation time, Unicode/space-containing path and both windows without attaching; refresh reads the current command; copy exports the details');

    const window = frame.getByRole('treeitem', { name: '0: inspect', exact: true });
    await menu(window, 'Window 详情');
    await until(async () => await dialog.locator('h3').count() === 1);
    assert.equal(await field('Window'), '0: inspect');
    assert.equal(await field('进程 PID'), pid);
    assert.ok(!(await dialog.textContent()).includes('second'));
    await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' });
    checks.push('tmux window details are limited to the selected window and Escape closes the dialog');

    attachExternal(); attachExternal();
    await until(async () => clients() === 3);
    await frame.getByRole('button', { name: `关闭标签页 ${name} (tmux)`, exact: true }).click();
    await until(async () => clients() === 2 && await session.locator('.other-client').count() === 1);
    await menu(session, '断开所有连接');
    await until(async () => clients() === 0 && await session.locator('.other-client, .connection-dot').count() === 0);
    cli(['has-session', '-t', name]); cli(['has-session', '-t', keep]);
    checks.push('disconnect all from a hollow-circle session releases both real external clients and preserves both backend sessions');

    await session.click(); await until(async () => clients() === 1 && await tab.getAttribute('aria-selected') === 'true');
    attachExternal(); await until(async () => clients() === 2);
    await menu(session, '断开所有连接');
    await until(async () => clients() === 0 && await tab.evaluate(element => element.classList.contains('closed')));
    await until(async () => await frame.locator('.connection-status.closed').textContent() === '连接已关闭');
    const marker = await tab.evaluate(element => {
      const underline = getComputedStyle(element, '::after');
      const status = getComputedStyle(document.querySelector('.connection-status'), '::before');
      return { height: underline.height, color: underline.backgroundColor, circle: status.borderTopColor, radius: status.borderRadius };
    });
    assert.equal(marker.height, '3px'); assert.equal(marker.color, 'rgb(196, 119, 119)');
    assert.equal(marker.circle, marker.color); assert.equal(marker.radius, '50%');
    await delay(250);
    assert.ok(!(await frame.locator('.terminal-instance:not([hidden]) .xterm-rows').textContent()).includes('server exited unexpectedly'), 'Native detachment must drain without racing another termination signal');
    await frame.locator('.dock').screenshot({ path: `.test-results/disconnected-tabs-${editor}.png` });
    await frame.getByRole('treeitem', { name: keep, exact: true }).click();
    await until(async () => await tab.getAttribute('aria-selected') === 'false');
    assert.equal(await tab.evaluate(element => getComputedStyle(element, '::after').backgroundColor), marker.color);
    await tab.click();
    await updateSettings({ 'muxdock.showTabs': false });
    await until(async () => !await frame.getByRole('tablist').isVisible());
    assert.equal(await frame.locator('.connection-status.closed').count(), 1);
    await updateSettings({ 'muxdock.showTabs': true });
    await until(async () => await frame.getByRole('tablist').isVisible());
    await session.click();
    await until(async () => clients() === 1 && !await tab.evaluate(element => element.classList.contains('closed')));
    assert.equal(await frame.locator('.connection-status.closed').count(), 0);
    checks.push('closed tabs retain output and use a muted red underline in active/inactive states; the matching red status circle also works with tabs hidden; reconnect clears both markers');
  } finally {
    execFileSync('/usr/bin/pbcopy', { input: previousClipboard, encoding: 'utf8' });
    if (await dialog.isVisible()) await dialog.getByRole('button', { name: '关闭详情', exact: true }).click();
    for (const process of external) { process.stdin.destroy(); process.kill('SIGTERM'); }
    for (const target of [name, keep]) {
      const close = frame.getByRole('button', { name: `关闭标签页 ${target} (tmux)`, exact: true });
      if (await close.count()) await close.click();
      cli(['kill-session', '-t', target]);
    }
    await resizePanel(350);
  }
  return checks;
}
