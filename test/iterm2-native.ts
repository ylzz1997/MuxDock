// Explicit integration test: requires a running MuxDock iTerm2 service. Only the
// uniquely named sessions created here are modified; existing terminals are kept.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ITermClient } from '../src/iterm2/client';

const exec = promisify(execFile);
async function main() {
const root = path.resolve('.test-results/iterm2');
await mkdir(root, { recursive: true });
const configuration = JSON.parse(await readFile(path.join(os.homedir(), 'Library/Application Support/MuxDock/iTerm2/config.json'), 'utf8'));
const url = `http://127.0.0.1:${configuration.port}/${configuration.token}/`;
const client = new ITermClient();
await client.connect();
const before = await client.sessions();
const name = `muxdock_iterm_qa_${process.pid}`;
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 300, height: 760 }, colorScheme: 'dark' });
const errors: string[] = [];
page.on('pageerror', error => errors.push(error.message));
const until = async (fn: () => Promise<boolean>, label: string) => {
  const end = Date.now() + 20000;
  while (!await fn()) { if (Date.now() > end) throw new Error(`Timed out: ${label}`); await new Promise(resolve => setTimeout(resolve, 100)); }
};
let sessionId: string | undefined, nativeId: string | undefined;
try {
  await page.goto(url);
  console.log('sidebar loaded');
  const manager = page.locator('.manager-row[data-node="tmux"]'); await manager.waitFor();
  await manager.locator('button:has(.icon-plus)').click();
  const dialog = page.locator('.native-dialog'); await dialog.locator('input').fill(name); await dialog.locator('[type=submit]').click();
  await until(async () => { try { const { stdout } = await exec('/opt/homebrew/bin/tmux', ['list-sessions', '-F', '#{session_id}|#{session_name}']); sessionId = stdout.split('\n').find(line => line.endsWith(`|${name}`))?.split('|')[0]; return !!sessionId; } catch { return false; } }, 'native tab creates tmux session');
  await until(async () => { nativeId = (await client.sessions()).find(item => !before.some(previous => previous.id === item.id))?.id; return !!nativeId; }, 'native iTerm2 session');
  console.log('native session created');
  const row = () => page.locator(`.tree-row[data-node="tmux/${sessionId}"]`);
  await row().waitFor(); await row().click(); await row().click();
  assert.equal((await client.sessions()).filter(item => !before.some(previous => previous.id === item.id)).length, 1, 'duplicate clicks reuse the existing native tab');
  await exec('/opt/homebrew/bin/tmux', ['send-keys', '-t', sessionId!, '-l', 'printf "MUXDOCK_NATIVE_OK\\n"']);
  await exec('/opt/homebrew/bin/tmux', ['send-keys', '-t', sessionId!, 'Enter']);
  await until(async () => (await exec('/opt/homebrew/bin/tmux', ['capture-pane', '-p', '-t', sessionId!])).stdout.includes('MUXDOCK_NATIVE_OK'), 'native shell output');
  await row().locator('.row-action').click(); await page.locator('.menu-item').nth(1).click();
  await page.locator('.details-body dl').first().waitFor();
  assert.ok((await page.locator('.details-body').textContent())?.includes(name));
  await page.screenshot({ path: path.join(root, 'native-sidebar-details.png') });
  console.log('details rendered');
  await page.locator('.details-header button:has(.icon-close)').click();
  await row().locator('.row-action').click(); await page.locator('.menu-item.danger').click();
  await dialog.waitFor(); await dialog.locator('button[type=button]').click();
  await exec('/opt/homebrew/bin/tmux', ['has-session', '-t', sessionId!]);
  console.log('destructive dialog cancelled');
  await row().locator('.row-action').click(); await page.locator('.menu-item').nth(2).click();
  await until(async () => !(await client.sessions()).some(item => item.id === nativeId), 'disconnect closes only the managed client');
  console.log('native client disconnected');
  await exec('/opt/homebrew/bin/tmux', ['has-session', '-t', sessionId!]);
  await row().click();
  await until(async () => (await client.sessions()).some(item => !before.some(previous => previous.id === item.id)), 'reattach');
  for (const width of [220, 300, 420]) {
    await page.setViewportSize({ width, height: 760 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `no horizontal overflow at ${width}px`);
    assert.equal(await page.locator('.terminal-area').isVisible(), false, 'native sidebar does not display an embedded terminal');
    await page.screenshot({ path: path.join(root, `native-sidebar-${width}.png`) });
  }
  await page.emulateMedia({ colorScheme: 'light' }); await page.screenshot({ path: path.join(root, 'native-sidebar-light.png') });
  assert.deepEqual(errors, []);
  const after = await client.sessions(); assert.ok(before.every(item => after.some(current => current.id === item.id)), 'existing iTerm2 sessions are preserved');
  await writeFile(path.join(root, 'native-result.json'), JSON.stringify({ checks: ['sidebar creates native tab', 'reuses existing tab', 'live shell output', 'details', 'cancel kill preserves session', 'disconnect preserves backend', 'reattach', '220/300/420px', 'light mode', 'existing terminals preserved'], browserErrors: errors }, null, 2));
  console.log('iTerm2 native API + sidebar integration: PASS');
} catch (error) {
  console.error('Native integration failed:', error);
  await page.screenshot({ path: path.join(root, 'native-failure.png') }).catch(() => {});
  throw error;
} finally {
  try {
  if (sessionId) await exec('/opt/homebrew/bin/tmux', ['kill-session', '-t', sessionId]).catch(() => {});
  // The profile closes its tab when the tmux client exits. Do not race iTerm2's
  // own close handling by closing the same session a second time here.
  } finally { client.close(); await browser.close(); }
}
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
