import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, rm, writeFile } from 'node:fs/promises';

export async function checkSessionStatus({ frame, page, cli, until, delay, updateSettings, resizePanel }) {
  const name = 'status-check';
  const hold = '.test-results/ui-tmux-hold';
  const refresh = frame.getByRole('button', { name: '刷新', exact: true });
  const session = frame.getByRole('treeitem', { name, exact: true });
  const tab = frame.getByRole('tab', { name: `${name} (tmux)`, exact: true });
  const clients = () => Number(cli(['display-message', '-p', '-t', name, '#{session_attached}']).trim());
  const checks = [];
  let external;
  const refreshDone = async () => until(async () => !await refresh.evaluate(button => button.classList.contains('spinning')));
  const attach = async () => {
    await session.click();
    await until(async () => await tab.getAttribute('aria-selected') === 'true' && clients() === 1);
    await until(async () => await session.locator('.connection-dot').count() === 1);
    await refreshDone(); await delay(650); await refreshDone();
  };
  await rm(hold, { force: true }); await rm(`${hold}-captured`, { force: true });
  await updateSettings({ 'muxdock.refreshInterval': 60 });
  try {
    cli(['new-session', '-d', '-s', name, '-n', 'window-00', '/bin/sh']);
    for (let index = 1; index < 20; index++) cli(['new-window', '-d', '-t', name, '-n', `window-${String(index).padStart(2, '0')}`, '/bin/sh']);
    await refresh.click(); await session.waitFor(); await refreshDone();
    await attach();
    // Freeze a real list response containing this client, then close it while
    // the host is still refreshing. The next snapshot must query again.
    await writeFile(hold, ''); await refresh.click();
    await until(async () => access(`${hold}-captured`).then(() => true, () => false));
    await frame.getByRole('button', { name: `关闭标签页 ${name} (tmux)`, exact: true }).click();
    await until(async () => clients() === 0);
    await delay(2200); await refreshDone();
    const remaining = await session.locator('.other-client, .connection-dot').count();
    await writeFile('.test-results/session-status-race.json', JSON.stringify({ clients: clients(), remainingIndicators: remaining }, null, 2));
    assert.equal(remaining, 0, 'A stale in-flight refresh must not leave a hollow client indicator after closing the tab');
    checks.push('closing during an in-flight refresh clears stale client status without waiting for the polling interval');
    cli(['has-session', '-t', name]);
    await attach();
    await session.click({ button: 'right' });
    await frame.getByRole('menuitem', { name: '断开此连接', exact: true }).click();
    await until(async () => clients() === 0 && await tab.evaluate(element => element.classList.contains('closed')));
    await until(async () => await session.locator('.other-client, .connection-dot').count() === 0, 5000);
    checks.push('disconnecting a retained tab clears its indicator and preserves the backend session');
    await attach();
    cli(['detach-client', '-s', name]);
    await until(async () => await tab.evaluate(element => element.classList.contains('closed')));
    await until(async () => await session.locator('.other-client, .connection-dot').count() === 0, 5000);
    checks.push('native tmux detachment clears status while retaining terminal output');
    const socket = cli(['display-message', '-p', '-t', name, '#{socket_path}']).trim();
    external = spawn(process.env.MUXDOCK_TMUX || '/opt/homebrew/bin/tmux', ['-S', socket, '-C', 'attach-session', '-t', name], {
      env: { ...process.env, TMUX: '', TMUX_PANE: '' }, stdio: ['pipe', 'ignore', 'ignore']
    });
    await until(async () => clients() === 1);
    await refresh.click(); await refreshDone();
    assert.equal(await session.locator('.other-client').count(), 1, 'A real external client must retain its hollow indicator');
    await session.click();
    await until(async () => clients() === 2 && await session.locator('.connection-dot').count() === 1);
    await frame.getByRole('button', { name: `关闭标签页 ${name} (tmux)`, exact: true }).click();
    await until(async () => clients() === 1 && await session.locator('.other-client').count() === 1);
    await updateSettings({ 'muxdock.refreshInterval': 1 });
    external.stdin.end();
    await until(async () => clients() === 0 && await session.locator('.other-client, .connection-dot').count() === 0, 5000);
    external = undefined;
    await updateSettings({ 'muxdock.refreshInterval': 60 });
    await refreshDone();
    checks.push('real external clients remain indicated after closing MuxDock and clear after the final external client exits');
    // The current-window marker must use the icon as its containing block.
    // A viewport containing block lets it escape the scrolling tree's clip.
    const tree = frame.getByRole('tree', { name: '终端管理器', exact: true });
    await attach();
    await resizePanel(220);
    await tree.evaluate(element => { element.scrollTop = 0; });
    const node = await session.getAttribute('data-node');
    const marker = frame.locator(`[data-node^="${node}/"].active-window > .icon-window`);
    const readMarker = () => marker.evaluate(element => {
      const icon = element.getBoundingClientRect();
      const row = element.parentElement.getBoundingClientRect();
      const pseudo = getComputedStyle(element, '::after');
      let container = element;
      while (container && getComputedStyle(container).position === 'static') container = container.parentElement;
      return { iconTop: icon.top, rowTop: row.top, local: container === element, right: pseudo.right, bottom: pseudo.bottom };
    });
    const before = await readMarker();
    assert.equal(before.local, true, 'The green window marker must be positioned relative to its own icon');
    assert.equal(before.right, '2px'); assert.equal(before.bottom, '3px');
    await frame.locator('.dock').screenshot({ path: '.test-results/status-scroll-before.png' });
    const delta = await tree.evaluate(element => { const old = element.scrollTop; element.scrollTop += 90; return element.scrollTop - old; });
    assert.ok(delta > 50);
    const after = await readMarker();
    assert.ok(Math.abs(before.iconTop - after.iconTop - delta) <= 1);
    assert.ok(Math.abs((before.iconTop - before.rowTop) - (after.iconTop - after.rowTop)) <= 1);
    await frame.locator('.dock').screenshot({ path: '.test-results/status-scroll-after.png' });
    checks.push('current-window green marker stays with its row and inside the tree clip while scrolling');
  } finally {
    external?.kill('SIGTERM');
    await rm(hold, { force: true }); await rm(`${hold}-captured`, { force: true });
    const close = frame.getByRole('button', { name: `关闭标签页 ${name} (tmux)`, exact: true });
    if (await close.count()) await close.click();
    cli(['kill-session', '-t', name]);
    await resizePanel(350);
    await updateSettings({ 'muxdock.refreshInterval': 1 });
    await until(async () => await session.count() === 0);
  }
  return checks;
}
