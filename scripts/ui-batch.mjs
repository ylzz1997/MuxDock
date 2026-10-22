import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import pty from 'node-pty';

export async function checkBatchSessions({ frame, page, cli, until, delay, updateSettings, resizePanel, editor, zmx }) {
  const prefix = `batch-${process.pid}`;
  const first = `${prefix}-a`, second = `${prefix}-b`, keep = `${prefix}-keep`;
  const names = [first, second, keep];
  const checks = [];
  const external = [];
  let zmxClient;
  const row = name => frame.getByRole('treeitem', { name, exact: true }).filter({ has: frame.locator('.icon-terminal') });
  const checkbox = (name, manager = 'tmux') => frame.getByRole('checkbox', { name: `选择会话 ${name} (${manager})`, exact: true });
  const tab = (name, manager = 'tmux') => frame.getByRole('tab', { name: `${name} (${manager})`, exact: true });
  const clients = name => Number(cli(['display-message', '-p', '-t', name, '#{session_attached}']).trim());
  const count = frame.locator('.batch-count');
  const toolbar = frame.getByRole('group', { name: '批量操作', exact: true });
  const selectAll = frame.getByRole('checkbox', { name: '全选当前显示的会话', exact: true });
  const refresh = () => frame.getByRole('button', { name: '刷新', exact: true }).click();
  const enter = async () => {
    await frame.getByRole('button', { name: '更多操作', exact: true }).click();
    await frame.getByRole('menuitem', { name: '批量操作', exact: true }).click();
    await toolbar.waitFor();
  };
  const kill = async confirm => {
    await frame.getByRole('button', { name: '批量结束', exact: true }).click();
    const dialog = page.getByRole('dialog'); await dialog.waitFor();
    assert.ok((await dialog.textContent()).includes('2 个会话'));
    assert.ok((await dialog.textContent()).includes(first));
    await dialog.getByRole('button', { name: confirm ? '批量结束' : /Cancel|取消/, exact: true }).click();
  };
  try {
    await updateSettings({ 'muxdock.visibleManagers': ['tmux', ...(zmx ? ['zmx'] : [])], 'muxdock.refreshInterval': 1 });
    await resizePanel(420);
    for (const name of names) cli(['new-session', '-d', '-s', name, '/bin/sh']);
    await refresh(); await row(first).waitFor();
    for (const name of names) { await row(name).click(); await until(async () => clients(name) === 1); }
    const socket = cli(['display-message', '-p', '-t', first, '#{socket_path}']).trim();
    external.push(spawn(process.env.MUXDOCK_TMUX || '/opt/homebrew/bin/tmux', ['-S', socket, '-C', 'attach-session', '-t', first], { env: { ...process.env, TMUX: '', TMUX_PANE: '' }, stdio: ['pipe', 'ignore', 'ignore'] }));
    await until(async () => clients(first) === 2);
    if (zmx) {
      const env = { ...process.env, TERM: 'xterm-256color' };
      for (const key of ['ZMX_SESSION', 'ZMX_SESSION_PREFIX', 'TMUX', 'TMUX_PANE']) delete env[key];
      zmxClient = pty.spawn(zmx, ['attach', first, '/bin/sh'], { cwd: process.cwd(), env, cols: 80, rows: 24 });
      zmxClient.onData(() => {});
      await until(async () => frame.locator('.tree-row').filter({ hasText: first }).count().then(count => count === 2));
      const zmxRow = frame.locator('.tree-row').filter({ hasText: first }).filter({ has: frame.locator('.other-client') });
      await zmxRow.click(); await tab(first, 'zmx').waitFor();
    }
    await enter();
    assert.equal(await frame.getByRole('button', { name: '批量断开', exact: true }).isDisabled(), true);
    assert.equal(await frame.getByRole('button', { name: '批量结束', exact: true }).isDisabled(), true);
    await checkbox(first).check();
    await frame.getByRole('treeitem', { name: second, exact: true }).click();
    assert.equal(await checkbox(second).isChecked(), true);
    await until(async () => count.textContent().then(text => text === '已选 2 项'));
    assert.equal(clients(first), 2); assert.equal(clients(second), 1);
    await refresh(); await delay(1200);
    assert.equal(await checkbox(first).isChecked(), true);
    assert.equal(await checkbox(second).isChecked(), true);
    await frame.getByRole('treeitem', { name: second, exact: true }).focus();
    await page.keyboard.press('Space'); assert.equal(await checkbox(second).isChecked(), false);
    await page.keyboard.press('Space'); assert.equal(await checkbox(second).isChecked(), true);
    checks.push('row clicks, native checkboxes and Space toggle selection without attaching; periodic refresh preserves selection');

    await frame.getByRole('button', { name: '筛选会话', exact: true }).click();
    await frame.locator('.filter').fill(prefix);
    await selectAll.check();
    assert.equal(await checkbox(keep).isChecked(), true);
    await selectAll.uncheck();
    assert.equal(await count.textContent(), '已选 0 项');
    await checkbox(first).check();
    await frame.locator('.filter').fill(second);
    assert.equal(await count.textContent(), '已选 1 项');
    assert.equal(await selectAll.isChecked(), false);
    await selectAll.check();
    assert.equal(await count.textContent(), '已选 2 项');
    await frame.locator('.filter').fill(prefix);
    assert.equal(await selectAll.evaluate(input => input.indeterminate), true);
    await kill(false);
    await until(async () => count.textContent().then(text => text === '已选 2 项'));
    for (const name of names) cli(['has-session', '-t', name]);
    assert.equal(await checkbox(first).isChecked(), true);
    checks.push('filter-scoped select-all preserves hidden selections; one cancelled batch confirmation preserves all sessions and selected items');

    if (zmx) { await checkbox(second).uncheck(); await checkbox(first, 'zmx').check(); }
    await frame.getByRole('button', { name: '批量断开', exact: true }).click();
    await until(async () => clients(first) === 0 && (zmx || clients(second) === 0) && await count.textContent() === '已选 0 项');
    assert.equal(clients(keep), 1);
    assert.equal(await tab(first).evaluate(element => element.classList.contains('closed')), true);
    if (zmx) assert.equal(await tab(first, 'zmx').evaluate(element => element.classList.contains('closed')), true);
    else assert.equal(await tab(second).evaluate(element => element.classList.contains('closed')), true);
    for (const name of names) cli(['has-session', '-t', name]);
    checks.push('batch disconnect releases selected local and external clients across managers, retains closed tabs and background sessions, and preserves unrelated clients');

    // Selection is bound to IDs: a newly created session cannot inherit a removed selection.
    const vanished = `${prefix}-vanished`;
    cli(['new-session', '-d', '-s', vanished, '/bin/sh']); await refresh(); await checkbox(vanished).waitFor();
    await checkbox(vanished).check(); cli(['kill-session', '-t', vanished]); await refresh();
    await until(async () => count.textContent().then(text => text === '已选 0 项'));
    checks.push('removed sessions are pruned from selection');

    await checkbox(first).check(); await checkbox(second).check();
    await frame.locator('.dock').screenshot({ path: `.test-results/batch-selected-${editor}.png` });
    await updateSettings({ 'workbench.colorTheme': 'Default Light Modern' });
    await until(async () => frame.locator('body').getAttribute('class').then(value => value.includes('vscode-light')));
    await frame.locator('.dock').screenshot({ path: `.test-results/batch-selected-light-${editor}.png` });
    const splitter = frame.getByRole('separator', { name: '调整会话树宽度', exact: true });
    await splitter.focus(); for (let i = 0; i < 15; i++) await page.keyboard.press('ArrowRight');
    const layout = await toolbar.evaluate(element => {
      const outer = element.getBoundingClientRect();
      return { width: outer.width, overflow: element.scrollWidth > element.clientWidth, buttonsFit: [...element.querySelectorAll('button')].every(button => { const box = button.getBoundingClientRect(); return box.x >= outer.x && box.right <= outer.right; }) };
    });
    assert.equal(layout.overflow, false); assert.equal(layout.buttonsFit, true);
    await splitter.focus(); for (let i = 0; i < 8; i++) await page.keyboard.press('ArrowLeft');
    await kill(true);
    await until(async () => row(first).count().then(value => value === (zmx ? 1 : 0)));
    await until(async () => !await tab(first).count() && !await tab(second).count());
    assert.equal(clients(keep), 1); assert.equal(await tab(keep).count(), 1);
    await until(async () => count.textContent().then(text => text === '已选 0 项'));
    checks.push('confirmed batch ending removes exactly the selected backend sessions and tabs while unrelated sessions stay connected; toolbar fits narrow sidebar and both themes');

    await frame.getByRole('button', { name: '退出批量操作', exact: true }).click();
    assert.equal(await toolbar.isVisible(), false);
    assert.equal(await frame.locator('.session-checkbox').count(), 0);
    await enter(); await page.keyboard.press('Escape'); assert.equal(await toolbar.isVisible(), false);
    checks.push('exit button and Escape restore normal session interaction');
  } finally {
    if (await toolbar.isVisible()) await frame.getByRole('button', { name: '退出批量操作', exact: true }).click();
    if (await frame.locator('.filter').isVisible()) await frame.getByRole('button', { name: '筛选会话', exact: true }).click();
    for (const process of external) { process.stdin.destroy(); process.kill('SIGTERM'); }
    zmxClient?.kill();
    if (zmx) { try { execFileSync(zmx, ['kill', first], { stdio: 'ignore' }); } catch {} }
    for (const name of names) {
      const close = frame.getByRole('button', { name: `关闭标签页 ${name} (tmux)`, exact: true });
      if (await close.count()) await close.click();
      try { cli(['kill-session', '-t', name]); } catch {}
    }
    await updateSettings({ 'workbench.colorTheme': 'Default Dark Modern' });
    await resizePanel(350);
  }
  return checks;
}
