// Opt-in live integration. MUXDOCK_TEST_SSH_TARGET must identify an authorized
// test host. Only uniquely named sessions created by this test are mutated.
import assert from 'node:assert/strict';
import { webkit } from 'playwright';
import { readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ITermClient } from '../src/iterm2/client';
import { SshTransport, sshHostId, validSshTarget } from '../src/iterm2/ssh';
import { Adapter } from '../src/adapters';
import type { Snapshot, SessionInfo } from '../src/model';

async function main() {
  const target = process.env.MUXDOCK_TEST_SSH_TARGET; assert.ok(validSshTarget(target), 'Set MUXDOCK_TEST_SSH_TARGET');
  const directory = path.join(os.homedir(), 'Library/Application Support/MuxDock/iTerm2');
  const config = JSON.parse(await readFile(path.join(directory, 'config.json'), 'utf8'));
  const ssh = new SshTransport(target, directory), info = await ssh.info();
  const client = new ITermClient(); await client.connect(); const before = await client.sessions();
  const browser = await webkit.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 300, height: 760 }, colorScheme: 'dark' });
  const errors: string[] = [], checks: string[] = [], owned: { adapter: Adapter; session: SessionInfo }[] = [];
  page.on('pageerror', error => errors.push(error.message));
  if (process.env.MUXDOCK_TEST_TRACE) {
    page.on('console', message => console.log('browser', message.text()));
    await page.addInitScript(() => {
      const original = WebSocket.prototype.send;
      WebSocket.prototype.send = function(data) { console.log('sidebar send', String(data)); return original.call(this, data); };
    });
  }
  let state: Snapshot | undefined;
  await page.exposeFunction('qaSnapshot', (value: Snapshot) => { state = value; });
  await page.addInitScript(() => window.addEventListener('message', event => { if (event.data?.type === 'snapshot') (window as any).qaSnapshot(event.data.state); }));
  const until = async (fn: () => Promise<boolean> | boolean, label: string) => {
    const end = Date.now() + 30000;
    while (!await fn()) { if (Date.now() > end) throw new Error(`Timed out: ${label}`); await new Promise(resolve => setTimeout(resolve, 100)); }
  };
  const switchHost = async (id: string) => {
    await page.locator('.host-button').click();
    const label = state!.hosts!.find(item => item.id === id)!.label;
    await page.getByRole('menuitemradio', { name: label, exact: true }).click();
    await until(() => state?.selectedHost === id && !!state.managers.length, 'host switch');
  };
  try {
    await page.goto(`http://127.0.0.1:${config.port}/${config.token}/`); await until(() => !!state?.hosts, 'initial snapshot');
    if (!state!.hosts!.some(host => host.id === sshHostId(target))) {
      await page.locator('.host-button').click(); await page.locator('.context-menu .menu-item:has(.icon-plus)').click();
      await page.locator('.native-dialog input').fill(target); await page.locator('.native-dialog [type=submit]').click();
    } else if (state!.selectedHost !== sshHostId(target)) await switchHost(sshHostId(target));
    await until(() => state?.selectedHost === sshHostId(target) && state.managers.length === 2, 'remote managers');
    console.log('remote managers ready');
    assert.equal(state!.hostError, undefined); checks.push('saved SSH target connects using system SSH configuration');
    for (const manager of ['tmux', 'zmx'] as const) {
      const adapter = new Adapter(manager, {}, ssh.run, info.platform, undefined, name => ssh.executable(name));
      const baseline = await adapter.list(true); assert.ok(baseline.available);
      const name = `muxdock_ssh_qa_${process.pid}_${manager}`;
      owned.push({ adapter, session: { id: name, name } });
      await page.locator(`.manager-row[data-node="${manager}"] button:has(.icon-plus)`).click();
      await page.locator('.native-dialog input').fill(name); await page.locator('.native-dialog [type=submit]').click();
      await until(() => !!state!.managers.find(item => item.id === manager)?.sessions.some(item => item.name === name), 'remote session created');
      const session = state!.managers.find(item => item.id === manager)!.sessions.find(item => item.name === name)!; owned.at(-1)!.session = session;
      await until(() => !!state!.connections.find(item => item.manager === manager && item.sessionId === session.id), 'native SSH connection tagged');
      console.log(manager, 'native session created');
      const nativeId = state!.connections.find(item => item.manager === manager && item.sessionId === session.id)!.key;
      assert.equal(JSON.parse((await client.variable(nativeId))!).hostId, sshHostId(target));
      const row = page.locator(`.tree-row[data-node="${manager}/${session.id}"]`);
      await row.click(); await row.click();
      assert.equal(state!.connections.filter(item => item.manager === manager && item.sessionId === session.id).length, 1);
      if (manager === 'tmux') {
        const cwd = await ssh.run(adapter.command(['display-message', '-p', '-t', session.id, '#{pane_current_path}']));
        assert.equal(cwd.code, 0); assert.equal(cwd.stdout.trim(), info.home);
      }
      await row.locator('.row-action').click(); await page.locator('.menu-item').nth(1).click();
      await page.locator('.details-body dl').first().waitFor(); assert.match(await page.locator('.details-body').innerText(), new RegExp(name));
      await page.locator('.details-header button:has(.icon-close)').click();
      console.log(manager, 'details verified');
      await switchHost('local');
      assert.ok(state!.managers.every(item => item.sessions.every(item => item.name !== name)), 'remote session absent from local list');
      assert.ok((await client.sessions()).some(item => item.id === nativeId), 'switching preserves remote terminal');
      await switchHost(sshHostId(target)); await until(() => state!.connections.some(item => item.key === nativeId), 'remote connection restored');
      console.log(manager, 'host switching verified');
      await row.locator('.row-action').click(); await page.locator('.menu-item').nth(2).click();
      await until(async () => (await adapter.list()).sessions.find(item => item.id === session.id)?.attached === 0, 'native disconnect settles');
      assert.ok((await adapter.list()).sessions.some(item => item.id === session.id), 'disconnect preserves remote backend');
      await row.click(); await until(() => state!.connections.some(item => item.manager === manager && item.sessionId === session.id), 'reattach');
      await row.locator('.row-action').click(); await page.locator('.context-menu .menu-item.danger').click();
      await page.locator('.native-dialog [type=submit]').click();
      await until(async () => !(await adapter.list()).sessions.some(item => item.name === name), 'end owned session');
      console.log(manager, 'disconnect, reattach and end verified');
      const remaining = await adapter.list(); assert.ok(baseline.sessions.every(item => remaining.sessions.some(current => current.id === item.id)), 'existing remote sessions preserved');
      checks.push(`${manager}: create, remote directory, native attach/reuse, details, host switch, disconnect/reattach, confirmed end, existing sessions preserved`);
    }
    for (const width of [220, 300, 420]) {
      await page.setViewportSize({ width, height: 760 });
      await page.locator('.host-button').click();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      const box = await page.locator('.context-menu').boundingBox(); assert.ok(box && box.x >= 0 && box.x + box.width <= width);
      await page.screenshot({ path: `.test-results/iterm2/ssh-sidebar-${width}.png` }); await page.keyboard.press('Escape');
    }
    const after = await client.sessions(); assert.ok(before.every(item => after.some(current => current.id === item.id)), 'existing native terminals preserved');
    assert.deepEqual(errors, []); checks.push('220/300/420px host selector, existing native terminals preserved');
    await writeFile('.test-results/iterm2/ssh-native-result.json', JSON.stringify({ checks, browserErrors: errors }, null, 2));
    console.log('Native SSH integration: PASS', checks);
  } catch (error) { await page.screenshot({ path: '.test-results/iterm2/ssh-native-failure.png' }).catch(() => {}); throw error; }
  finally {
    for (const { adapter, session } of owned) await adapter.kill(session).catch(() => {});
    client.close(); await browser.close();
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
