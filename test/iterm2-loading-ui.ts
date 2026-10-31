import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ITermClient } from '../src/iterm2/client';
import { ITermService } from '../src/iterm2/service';
import { SshTransport } from '../src/iterm2/ssh';
import { MANAGER_IDS } from '../src/model';
import type { Runner } from '../src/runner';

function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
class Native extends ITermClient {
  get connected() { return true; } async connect() {} close() {} async registerTool() {} async subscribe() {} async sessions() { return []; } async focus() { return {}; }
}
class Remote extends SshTransport {
  infoGate = gate(); listGate?: Promise<void>; offline = false;
  async info() { await this.infoGate.promise; if (this.offline) throw new Error('SSH connection unavailable'); return { home: '/remote', shell: '/bin/bash', platform: 'linux' as const }; }
  async executable(name: string) { return this.target !== 'empty' && name === 'tmux' ? '/remote/tmux' : undefined; }
  run: Runner = async cmd => {
    if (cmd.args.includes('list-sessions')) await this.listGate;
    return { code: 0, stderr: '', stdout: cmd.args.includes('-V') ? 'tmux 3.5' : cmd.args.includes('list-sessions') ? '$1|1|remote-session' : cmd.args.includes('list-windows') ? '$1|@1|0|1|1|remote' : '' };
  };
}
async function main() {
  await mkdir('.test-results/iterm2', { recursive: true });
  const checks: string[] = [];
  for (const [name, engine] of Object.entries({ chromium, webkit })) {
    const root = await mkdtemp('/tmp/md-loading-ui-'), remotes = new Map<string, Remote>();
    await writeFile(path.join(root, 'config.json'), JSON.stringify({ language: 'zh-cn', executables: Object.fromEntries(MANAGER_IDS.map(id => [id, '/missing'])), sshHosts: ['slow', 'empty', 'offline'].map(target => ({ target })) }));
    const service = new ITermService(root, path.resolve('artifacts/iterm2/dist'), new Native(), (target, dir) => { const remote = new Remote(target, dir); remote.offline = target === 'offline'; remotes.set(target, remote); return remote; }, async () => []);
    const browser = await engine.launch({ headless: true });
    try {
      await service.start(0); const config = JSON.parse(await readFile(path.join(root, 'config.json'), 'utf8'));
      const page = await browser.newPage({ viewport: { width: 300, height: 700 }, colorScheme: 'dark' });
      const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
      await page.goto(`http://127.0.0.1:${service.port}/${config.token}/`);
      const loading = page.locator('.tree-loading'), tree = page.locator('.tree'), rows = page.locator('.tree-row[data-node="tmux/$1"]');
      const select = async (target: string) => { await page.locator('.host-button').click(); await page.getByRole('menuitemradio', { name: target === 'local' ? '本机' : `SSH · ${target}`, exact: true }).click(); };
      await page.locator('.host-button').getByText('本机', { exact: true }).waitFor();
      await select('slow'); await loading.getByText('正在加载远程会话…', { exact: true }).waitFor();
      assert.equal(service.snapshot().hostLoading, true); assert.doesNotMatch(await tree.innerText(), /未发现/);
      await page.reload(); await loading.waitFor(); assert.equal(await tree.getAttribute('aria-busy'), 'true');
      for (const width of [220, 300, 420]) {
        await page.setViewportSize({ width, height: 700 });
        const box = await loading.boundingBox(), host = await page.locator('.host-bar').boundingBox();
        assert.ok(box && host && box.y >= host.y + host.height - 1 && box.x >= 0 && box.x + box.width <= width);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        checks.push(`${name} ${width}`);
      }
      await page.setViewportSize({ width: 300, height: 700 });
      await page.screenshot({ path: `.test-results/iterm2/ssh-loading-${name}.png` });
      remotes.get('slow')!.infoGate.release(); await rows.waitFor(); await loading.waitFor({ state: 'hidden' });
      await page.waitForFunction(() => document.querySelector('.tree')?.getAttribute('aria-busy') === 'false');
      const refreshGate = gate(); remotes.get('slow')!.listGate = refreshGate.promise;
      await page.locator('.sidebar-actions button:has(.icon-refresh)').click();
      await page.waitForFunction(() => document.querySelector('.tree')?.getAttribute('aria-busy') === 'true');
      assert.equal(await loading.count(), 0); assert.ok(await rows.isVisible()); // existing rows stay usable while refreshing
      refreshGate.release(); await page.waitForFunction(() => document.querySelector('.tree')?.getAttribute('aria-busy') === 'false');
      await select('empty'); await loading.waitFor(); assert.doesNotMatch(await tree.innerText(), /未发现/);
      remotes.get('empty')!.infoGate.release(); await tree.getByText('未发现所选终端管理器。', { exact: false }).waitFor(); assert.equal(await loading.count(), 0);
      await select('offline'); await loading.waitFor(); remotes.get('offline')!.infoGate.release(); await page.locator('.host-error').waitFor();
      assert.equal(await loading.count(), 0); assert.equal(service.snapshot().hostLoading, false); assert.doesNotMatch(await tree.innerText(), /未发现/);
      const offline = remotes.get('offline')!; offline.offline = false; offline.infoGate = gate();
      await page.locator('.sidebar-actions button:has(.icon-refresh)').click(); await loading.waitFor(); assert.equal(await page.locator('.host-error').isVisible(), false);
      offline.infoGate.release(); await rows.waitFor(); await page.waitForFunction(() => document.querySelector('.tree')?.getAttribute('aria-busy') === 'false');
      await select('local'); await page.locator('.host-button').getByText('本机', { exact: true }).waitFor(); assert.equal(await loading.count(), 0);
      assert.deepEqual(errors, []);
    } finally { for (const remote of remotes.values()) remote.infoGate.release(); await browser.close(); await service.stop(); await rm(root, { recursive: true, force: true }); }
  }
  await writeFile('.test-results/iterm2/ssh-loading-ui-result.json', JSON.stringify({ checks, behavior: ['initial SSH loading replaces empty state', 'reload during pending request', 'existing rows retained during refresh', 'empty result only after completion', 'failure clears loading', 'retry recovers', 'local host unchanged'] }, null, 2));
  console.log('SSH loading UI PASS', checks.length, 'layout checks and lifecycle checks in Chromium/WebKit');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
