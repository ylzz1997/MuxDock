// Explicit live check against a running iTerm2 sidebar. Only our uniquely named
// zmx session is created/closed; its backend is removed in finally.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ITermClient } from '../src/iterm2/client';
import { parseZmx } from '../src/adapters';
import type { Wire } from '../src/iterm2/protocol';

const exec = promisify(execFile), sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function main() {
  const config = JSON.parse(await readFile(path.join(os.homedir(), 'Library/Application Support/MuxDock/iTerm2/config.json'), 'utf8'));
  const name = `muxdock_zmx_refresh_${process.pid}`, zmx = config.executables?.zmx || '/opt/homebrew/bin/zmx';
  const client = new ITermClient(); await client.connect(); await client.subscribe();
  const before = await client.sessions();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 300, height: 760 } });
  const results: object[] = [];
  let closing = 0;
  client.on('notification', (wire: Wire) => { if (closing && (wire.has(7) || wire.has(8))) results.push({ ms: Date.now() - closing, notification: [...wire.keys()] }); });
  const until = async (fn: () => Promise<boolean>) => {
    const end = Date.now() + 20000;
    while (!await fn()) { if (Date.now() > end) throw new Error('Native refresh timed out'); await sleep(50); }
  };
  const backend = async () => parseZmx((await exec(zmx, ['list'])).stdout).find(item => item.name === name);
  try {
    await page.goto(`http://127.0.0.1:${config.port}/${config.token}/`);
    await page.locator('.manager-row[data-node="zmx"] button:has(.icon-plus)').click();
    await page.locator('.native-dialog input').fill(name); await page.locator('.native-dialog [type=submit]').click();
    const row = page.locator(`.tree-row[data-node="zmx/${name}"]`);
    await row.locator('.connection-dot').waitFor();
    for (let round = 0; round < 2; round++) {
      if (round) { await row.click(); await row.locator('.connection-dot').waitFor(); }
      const candidates = (await client.sessions()).filter(item => !before.some(old => old.id === item.id));
      let native: (typeof candidates)[number] | undefined;
      for (const item of candidates) {
        const metadata = await client.variable(item.id);
        if (metadata && JSON.parse(metadata).name === name) { native = item; break; }
      }
      assert.ok(native, 'owned native session exists');
      closing = Date.now();
      const close = client.closeSession(native.id);
      let previous = '', backendDetached: number | undefined, markerCleared: number | undefined;
      await until(async () => {
        const item = await backend();
        const marker = await row.evaluate(element => element.querySelector('.connection-dot') ? 'solid' : element.querySelector('.other-client') ? 'hollow' : 'none');
        const ms = Date.now() - closing, state = `${item?.attached}/${marker}`;
        if (state !== previous) { results.push({ round, ms, clients: item?.attached, marker }); previous = state; }
        if (item?.attached === 0) backendDetached ??= ms;
        if (marker === 'none') markerCleared ??= ms;
        return backendDetached !== undefined && markerCleared !== undefined;
      });
      await close;
      results.push({ round, backendDetached, markerCleared }); closing = 0;
      assert.ok(await backend(), 'closing the native tab preserves the zmx backend');
    }
    const after = await client.sessions();
    assert.ok(before.every(item => after.some(current => current.id === item.id)), 'existing terminals preserved');
    console.log(JSON.stringify(results, null, 2));
    await writeFile(path.resolve(`.test-results/iterm2/refresh-${process.env.MUXDOCK_REFRESH_PHASE || 'result'}.json`), JSON.stringify(results, null, 2));
  } finally {
    await exec(zmx, ['kill', name]).catch(() => {});
    client.close(); await browser.close();
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
