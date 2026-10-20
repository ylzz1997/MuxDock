import { chromium } from 'playwright';
import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

await mkdir('.test-results', { recursive: true });
const bundle = await build({ stdin: { resolveDir: process.cwd(), contents: `
import {Terminal} from '@xterm/xterm';
import {WebLinksAddon} from '@xterm/addon-web-links';
import {TerminalLinks} from './webview/links';
const terminal=new Terminal({cols:50,rows:14,fontSize:14,allowProposedApi:true});
terminal.open(document.querySelector('#terminal'));
window.sent=[]; window.input=[];
const links=new TerminalLinks(terminal,terminal.element,'fixture',message=>{
 if(message.type==='resolveLinks')queueMicrotask(()=>links.receive({request:message.request,links:message.targets.map(input=>({input,target:'file:///workspace/'+input.replace(/:(\\d+):(\\d+)$/,'#L$1C$2')}))}));
 else window.sent.push(message);
});
terminal.options.linkHandler=links.handler;
terminal.loadAddon(new WebLinksAddon(links.activate,{hover:links.hover,leave:links.leave}));
links.setActive(true); terminal.onData(data=>window.input.push(data));
window.write=data=>new Promise(resolve=>terminal.write(data,resolve));
window.select=()=>terminal.select(0,0,5);
window.setActive=active=>links.setActive(active);
` }, bundle: true, write: false, format: 'iife', platform: 'browser' });
const css = await readFile('node_modules/@xterm/xterm/css/xterm.css', 'utf8') + await readFile('webview/style.css', 'utf8');
const browser = await chromium.launch({ headless: true });
const checks = [];
try {
  for (const platform of ['MacIntel', 'Win32', 'Linux x86_64']) {
    const context = await browser.newContext({ viewport: { width: 800, height: 460 } });
    await context.addInitScript(platform => Object.defineProperty(navigator, 'platform', { value: platform }), platform);
    const page = await context.newPage();
    page.on('console', message => { if (message.type() === 'error') console.error(message.text()); });
    await page.goto('about:blank');
    await page.setContent(`<style>${css}body{padding:20px}#terminal{width:650px;height:400px}</style><div id="terminal"></div>`);
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    const modifier = platform === 'MacIntel' ? 'Meta' : 'Control';
    const render = async output => {
      await page.mouse.move(780, 440);
      await page.evaluate(async output => { window.sent=[]; window.input=[]; await window.write('\x1b[2J\x1b[H' + output); }, output);
    };
    const point = async label => {
      const row = page.locator('.xterm-rows > div').filter({ hasText: label }).first();
      const box = await row.boundingBox();
      const position = { x: box.x + 5, y: box.y + box.height / 2 };
      await page.mouse.move(position.x + 18, position.y);
      await page.mouse.move(position.x, position.y);
      await page.locator('.terminal-link-hover').waitFor({ state: 'visible' });
      return position;
    };
    const opened = () => page.evaluate(() => window.sent.filter(message => message.type === 'openLink'));
    const url = 'https://example.test/docs?x=1#part';
    for (const osc of [false, true]) {
      await render(osc ? `\x1b]8;;${url}\x1b\\Codex 文档\x1b]8;;\x1b\\\r\n` : url + '\r\n');
      const pos = await point(osc ? 'Codex' : 'https://');
      assert.equal(await page.locator('.link-destination').textContent(), url);
      await page.mouse.click(pos.x, pos.y);
      assert.deepEqual(await opened(), [], 'Plain click must not open a terminal link');
      await page.keyboard.down(modifier); await page.mouse.click(pos.x, pos.y); await page.keyboard.up(modifier);
      assert.equal((await opened()).at(-1)?.url, url);
      checks.push(`${platform}: ${osc ? 'OSC 8 labeled link' : 'plain URL'} hover and modifier-click`);
    }
    await render(`\x1b]8;;file:///workspace/src/main.ts#L12C3\x07main.ts\x1b]8;;\x07\r\n`);
    const file = await point('main.ts');
    await page.keyboard.down(modifier); await page.mouse.click(file.x, file.y); await page.keyboard.up(modifier);
    assert.equal((await opened()).at(-1)?.url, 'file:///workspace/src/main.ts#L12C3');
    await render('src/main.ts:12:3\r\n');
    await point('src/main');
    assert.equal(await page.locator('.link-destination').textContent(), 'file:///workspace/src/main.ts#L12C3');
    checks.push(`${platform}: OSC 8 file links and plain file locations`);
    await render('./project/\r\n');
    const directory = await point('./project/');
    await page.keyboard.down(modifier); await page.mouse.click(directory.x, directory.y); await page.keyboard.up(modifier);
    assert.equal((await opened()).at(-1)?.url, 'file:///workspace/./project/');
    checks.push(`${platform}: directory paths use the same modifier-click handling as files`);
    const long = 'https://example.test/' + 'segment/'.repeat(15) + 'end';
    await render(long + '\r\n');
    await point('https://');
    assert.equal(await page.locator('.link-destination').textContent(), long);
    checks.push(`${platform}: wrapped URL preview preserves the complete destination`);
    await render(`\x1b[?1000h\x1b[?1006h\x1b]8;;${url}\x07Codex 文档\x1b]8;;\x07\r\n`);
    const tracked = await point('Codex');
    await page.keyboard.down(modifier); await page.mouse.click(tracked.x, tracked.y); await page.keyboard.up(modifier);
    assert.equal((await opened()).at(-1)?.url, url);
    assert.deepEqual(await page.evaluate(() => window.input), [], 'Opening a link must not also click the terminal application');
    checks.push(`${platform}: modifier-click opens links while application mouse tracking is enabled`);
    await render('\x1b[?1000l\x1b[?1006l' + url + '\r\n');
    const drag = await point('https://');
    await page.mouse.move(drag.x, drag.y); await page.mouse.down(); await page.mouse.move(drag.x + 90, drag.y, { steps: 8 }); await page.mouse.up();
    assert.deepEqual(await opened(), [], 'Dragging to select a URL must not open it');
    await page.mouse.move(780, 440); await page.mouse.move(drag.x, drag.y);
    await page.locator('.terminal-link-hover').waitFor({ state: 'visible' });
    await page.getByRole('button', { name: '复制链接地址', exact: true }).click();
    assert.ok(await page.evaluate(url => window.sent.some(message => message.type === 'copy' && message.text === url), url));
    checks.push(`${platform}: dragging selects text; hover actions copy the destination`);
    await render('\x1b]8;;javascript:alert(1)\x07UNSAFE\x1b]8;;\x07\r\n');
    const unsafe = await page.locator('.xterm-rows > div').filter({ hasText: 'UNSAFE' }).boundingBox();
    await page.keyboard.down(modifier); await page.mouse.click(unsafe.x + 4, unsafe.y + 8); await page.keyboard.up(modifier);
    assert.deepEqual(await opened(), []);
    assert.equal(await page.locator('.terminal-link-hover').count(), 0);
    checks.push(`${platform}: executable URI schemes are ignored`);
    await context.close();
  }
  await writeFile('.test-results/link-interactions.json', JSON.stringify({ status: 'PASS', checks }, null, 2));
  console.log(`Terminal links: PASS (${checks.length} interaction checks)`);
} catch (error) {
  for (const context of browser.contexts()) for (const page of context.pages()) {
    await page.screenshot({ path: '.test-results/link-interaction-failure.png' });
    console.error(await page.evaluate(() => ({ sent: window.sent, rows: document.querySelector('.xterm-rows')?.innerHTML.slice(0, 1000), screen: document.querySelector('.xterm-screen')?.getBoundingClientRect().toJSON() })));
  }
  throw error;
} finally { await browser.close(); }
