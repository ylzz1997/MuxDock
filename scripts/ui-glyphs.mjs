import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function checkTerminalGlyphs({ frame, page, cli, until, updateSettings, editor }) {
  const symbols = '\ue0a0\ue0a1\ue0a2\ue0b0\ue0b1\ue0b2\ue0b3';
  const prompt = 'GLYPH_PROMPT (base) hyl@MacBook-Pro \ue0b0 ~ \ue0b0';
  const output = `\x1b[0mGLYPH_PROMPT (base) \x1b[40mhyl@MacBook-Pro \x1b[34m\ue0b0\x1b[37;44m ~ \x1b[0;34m\ue0b0\x1b[0m\r\nGLYPH_SYMBOLS ${symbols}\r\nGLYPH_TEXT 中文 😀 café\r\n`;
  const script = path.resolve('.test-results/glyph-output.py');
  await writeFile(script, `import sys\nsys.stdout.write(${JSON.stringify(output)})\nsys.stdout.flush()\n`);
  cli(['send-keys', '-t', 'my-project:logs', '-l', `python3 '${script.replaceAll("'", "'\\''")}'`]);
  cli(['send-keys', '-t', 'my-project:logs', 'Enter']);
  const rows = frame.locator('.terminal-instance:not([hidden]) .xterm-rows > div');
  await until(async () => (await rows.allTextContents()).includes(prompt));
  assert.ok((await rows.allTextContents()).includes(`GLYPH_SYMBOLS ${symbols}`), 'PTY and terminal buffer must preserve the original symbol code points');
  assert.ok((await rows.allTextContents()).includes('GLYPH_TEXT 中文 😀 café'), 'Mixed Unicode output must stay intact');

  const reports = [];
  const record = async label => {
    const report = await frame.evaluate(symbols => {
      const style = getComputedStyle(document.querySelector('.terminal-instance:not([hidden]) .xterm-rows'));
      const primary = style.fontFamily.replace(/,\s*"MuxDock Powerline"$/, '');
      const canvas = document.createElement('canvas'); canvas.width = 96; canvas.height = 64;
      const context = canvas.getContext('2d');
      const draw = (family, text, variant = '') => {
        context.clearRect(0, 0, canvas.width, canvas.height);
        context.font = `${variant} ${style.fontSize} ${family}`;
        context.fillText(text, 4, 40);
        return canvas.toDataURL();
      };
      return {
        fontFamily: style.fontFamily, fontSize: style.fontSize,
        loaded: [...document.fonts].some(face => face.family === 'MuxDock Powerline' && face.status === 'loaded'),
        symbols: [...symbols].map(char => ({
          codepoint: char.codePointAt(0).toString(16),
          usesFallback: ['', 'bold', 'italic', 'bold italic'].every(variant => draw(style.fontFamily, char, variant) === draw('"MuxDock Powerline"', char, variant))
        })),
        ordinaryTextUnchanged: ['MuxDock 123', '中文', '😀', 'café', '█'].every(text => draw(style.fontFamily, text) === draw(primary, text)),
        fixesMissingArrow: draw(style.fontFamily, '\ue0b0') !== draw(primary, '\ue0b0')
      };
    }, symbols);
    reports.push({ label, ...report });
    assert.ok(report.loaded, 'The packaged symbol font must load inside the editor webview');
    assert.ok(report.symbols.every(symbol => symbol.usesFallback), 'Each Powerline symbol must render from the real font, including bold/italic');
    assert.ok(report.ordinaryTextUnchanged, 'The fallback must preserve ordinary text, Unicode and block glyphs');
    assert.ok(report.fixesMissingArrow, 'Powerline arrows must differ from the missing glyph rendered by ordinary fonts');
    return report;
  };
  try {
    await record('default terminal font');
    await frame.locator('.dock').screenshot({ path: `.test-results/terminal-glyphs-${editor}.png` });
    for (const [label, patch, family, size] of [
      ['custom font and size', { 'muxdock.fontFamily': '"Courier New", monospace', 'muxdock.fontSize': 22 }, 'Courier New', '22px'],
      ['editor terminal font inheritance', { 'muxdock.fontFamily': '', 'muxdock.fontSize': 12, 'terminal.integrated.fontFamily': 'Monaco, monospace' }, 'Monaco', '12px'],
      ['missing configured font', { 'muxdock.fontFamily': '"MuxDock nonexistent font", monospace' }, 'MuxDock nonexistent font', '12px']
    ]) {
      await updateSettings(patch);
      await until(async () => frame.locator('.terminal-instance:not([hidden]) .xterm-rows').evaluate((element, expected) => {
        const style = getComputedStyle(element);
        return style.fontFamily.includes(expected.family) && style.fontSize === expected.size;
      }, { family, size }));
      await record(label);
    }

    const previous = execFileSync('/usr/bin/pbpaste', [], { encoding: 'utf8' });
    try {
      const row = rows.filter({ hasText: /^GLYPH_SYMBOLS / }).last();
      const box = await row.boundingBox();
      const width = await row.evaluate(row => { const range = document.createRange(); range.selectNodeContents(row); return range.getBoundingClientRect().width; });
      await page.mouse.move(box.x + 1, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + width + 1, box.y + box.height / 2, { steps: 12 });
      await page.mouse.up();
      await page.keyboard.press('Meta+c');
      await until(async () => execFileSync('/usr/bin/pbpaste', [], { encoding: 'utf8' }).trimEnd() === `GLYPH_SYMBOLS ${symbols}`, 5000);
      reports.push({ label: 'select and copy', originalSymbolCodepointsPreserved: true });
    } finally { execFileSync('/usr/bin/pbcopy', [], { input: previous }); }
  } finally {
    await updateSettings({ 'muxdock.fontFamily': '', 'muxdock.fontSize': 12, 'terminal.integrated.fontFamily': '' });
    await until(async () => frame.locator('.terminal-instance:not([hidden]) .xterm-rows').evaluate(element => getComputedStyle(element).fontSize === '12px'));
    await writeFile(`.test-results/terminal-glyphs-${editor}.json`, JSON.stringify(reports, null, 2));
  }
  console.log(`${editor} terminal glyphs: PASS`);
  return reports;
}
