import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { readFile, rm } from 'node:fs/promises';

export async function checkLaunchProfiles({ frame, page, cli, until, delay, resizePanel }) {
  const button = frame.getByRole('button', { name: '选择新会话默认启动项', exact: true });
  const menu = frame.getByRole('menu', { name: '新会话默认启动项', exact: true });
  const checks = [];
  const choose = async id => {
    await button.click();
    await menu.locator(`[data-profile="${id}"]`).click();
    await until(async () => await button.getAttribute('data-profile') === id);
  };
  // This isolated profile is reused between runs; remove commands from earlier runs.
  while (true) {
    await button.click();
    if (!await menu.locator('.menu-remove').count()) { await page.keyboard.press('Escape'); break; }
    await menu.locator('.menu-remove').first().click();
    await delay(150);
  }
  await choose('system');
  assert.equal(await button.locator('.launch-name').textContent(), path.basename(os.userInfo().shell));
  assert.equal(await frame.getByRole('button', { name: '断开连接，保留后台会话', exact: true }).count(), 0);
  await button.click();
  assert.equal(await menu.locator('[data-profile="system"]').getAttribute('aria-checked'), 'true');
  assert.equal(await menu.locator('.menu-item').last().getAttribute('aria-label'), '添加命令…');
  await button.click();
  assert.equal(await menu.count(), 0, 'Clicking the launcher twice closes its menu');
  checks.push('toolbar shows account default shell and replaces disconnect with a toggleable launch menu');
  await choose('shell:/bin/sh');
  assert.equal(await button.locator('.launch-name').textContent(), 'sh');
  await resizePanel(170);
  await button.click();
  await page.keyboard.press('End');
  const layout = await menu.evaluate(element => {
    const box = element.getBoundingClientRect();
    const selected = document.activeElement.getBoundingClientRect();
    return { top: box.top, bottom: box.bottom, viewport: innerHeight, selectedTop: selected.top, selectedBottom: selected.bottom };
  });
  assert.ok(layout.top >= 0 && layout.bottom <= layout.viewport, 'Launch menu fits a short panel');
  assert.ok(layout.selectedTop >= layout.top && layout.selectedBottom <= layout.bottom, 'Add command is keyboard reachable in a short panel');
  await frame.locator('.dock').screenshot({ path: '.test-results/muxdock-launch-compact.png' });
  await page.keyboard.press('Escape');
  assert.ok(await button.evaluate(element => document.activeElement === element));
  await resizePanel(350);
  checks.push('short panel menu scrolls, End reaches Add, and Escape restores focus');
  const quickInput = page.locator('.quick-input-widget input[type="text"]');
  const add = async value => {
    await button.click();
    await menu.getByRole('menuitem', { name: '添加命令…', exact: true }).click();
    await quickInput.waitFor({ state: 'visible' });
    await delay(200);
    if (value === undefined) await quickInput.press('Escape');
    else { await quickInput.fill(value); await quickInput.press('Enter'); }
    await quickInput.waitFor({ state: 'hidden' });
  };
  await add(undefined);
  assert.equal(await button.getAttribute('data-profile'), 'shell:/bin/sh');
  const marker = path.resolve('.test-results/ui-launch-marker.txt');
  await rm(marker, { force: true });
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  const command = `printf '%s\\n' 'START_OK' >> ${quote(marker)}`;
  await add(command);
  await until(async () => (await button.getAttribute('data-profile')).startsWith('command:'));
  const commandId = await button.getAttribute('data-profile');
  assert.equal(await button.locator('.launch-name').textContent(), command);
  await button.click();
  assert.equal(await menu.locator(`[data-profile="${commandId}"]`).getAttribute('aria-checked'), 'true');
  await frame.locator('.dock').screenshot({ path: '.test-results/muxdock-launch-menu.png' });
  await page.keyboard.press('Escape');
  // Adding an existing command selects its original entry instead of duplicating it.
  await add(command);
  await button.click();
  assert.equal(await menu.locator('[data-profile^="command:"]').count(), 1);
  await page.keyboard.press('Escape');
  checks.push('commands can be added, selected, cancelled and deduplicated');
  await frame.getByRole('treeitem', { name: 'tmux', exact: true }).getByRole('button', { name: '新建会话', exact: true }).click();
  await quickInput.waitFor({ state: 'visible' });
  await delay(250);
  await quickInput.fill('launch-test'); await quickInput.press('Enter');
  const tab = frame.getByRole('tab', { name: 'launch-test (tmux)', exact: true });
  await until(async () => await tab.getAttribute('aria-selected') === 'true');
  await until(async () => await readFile(marker, 'utf8').catch(() => '') === 'START_OK\n');
  const input = frame.locator('.terminal-instance:not([hidden]) .xterm-helper-textarea');
  await until(async () => ['sh', 'bash', 'dash'].includes(cli(['display-message', '-p', '-t', 'launch-test', '#{pane_current_command}']).trim()));
  await input.focus(); await page.keyboard.type("printf 'SHELL_%s\\n' 'READY'"); await page.keyboard.press('Enter');
  await until(async () => cli(['capture-pane', '-p', '-t', 'launch-test']).includes('SHELL_READY'));
  await frame.getByRole('button', { name: '关闭标签页 launch-test (tmux)', exact: true }).click();
  cli(['has-session', '-t', 'launch-test']);
  await frame.getByRole('treeitem', { name: 'launch-test', exact: true }).click();
  await until(async () => await tab.getAttribute('aria-selected') === 'true');
  await delay(400);
  assert.equal(await readFile(marker, 'utf8'), 'START_OK\n');
  await choose('system');
  assert.equal(await readFile(marker, 'utf8'), 'START_OK\n');
  await frame.getByRole('button', { name: '关闭标签页 launch-test (tmux)', exact: true }).click();
  cli(['kill-session', '-t', 'launch-test']);
  await until(async () => await frame.getByRole('treeitem', { name: 'launch-test', exact: true }).count() === 0);
  await choose('shell:/bin/sh');
  checks.push('new session executes the command once, leaves a usable selected shell, and reattachment does not execute it again');
  return { checks, commandId, command };
}

export async function checkRestoredLaunchProfile({ frame, page, until, commandId, command }) {
  const button = frame.getByRole('button', { name: '选择新会话默认启动项', exact: true });
  assert.equal(await button.getAttribute('data-profile'), 'shell:/bin/sh');
  await button.click();
  const menu = frame.getByRole('menu', { name: '新会话默认启动项', exact: true });
  assert.equal(await menu.locator(`[data-profile="${commandId}"]`).getAttribute('aria-label'), command);
  await menu.locator(`[data-profile="${commandId}"]`).click();
  await until(async () => await button.getAttribute('data-profile') === commandId);
  await button.click();
  await menu.getByRole('button', { name: `删除命令 ${command}`, exact: true }).click();
  await until(async () => await button.getAttribute('data-profile') === 'shell:/bin/sh');
  await button.click();
  assert.equal(await menu.locator(`[data-profile="${commandId}"]`).count(), 0);
  await page.keyboard.press('Escape');
  return 'saved shell and command survive webview reload; deleting the selected command restores the shell';
}
