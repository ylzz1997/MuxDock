import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';

const browser = await chromium.launch(process.env.MUXDOCK_BROWSER_CHANNEL ? { channel: process.env.MUXDOCK_BROWSER_CHANNEL } : {});
try {
  const page = await browser.newPage({ viewport: { width: 512, height: 512 }, deviceScaleFactor: 1 });
  await page.setContent(`<html><head><style>html,body{margin:0;width:512px;height:512px;background:transparent}svg{display:block}</style></head><body>${await readFile('media/icon.svg', 'utf8')}</body></html>`);
  await page.locator('svg').screenshot({ path: 'media/icon.png', omitBackground: true });
  console.log('Generated media/icon.png (512 × 512)');
} finally { await browser.close(); }
