import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function checkTerminalDrop({ frame, page, cli, until, delay, command, editor }) {
  const directory = path.resolve(`.test-results/drop-fixture-${process.pid}`);
  const folder = path.join(directory, 'drag 中文 folder');
  const files = ['drag-plain.txt', "drag 中文 'quote' $file.txt"].map(name => path.join(directory, name));
  await mkdir(folder, { recursive: true });
  for (const file of files) await writeFile(file, 'Drag this file into MuxDock.\n');
  const trace = path.join(directory, 'input.bin');
  const script = path.join(directory, 'input.py');
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  const expectedPaths = paths => paths.map(value => /^[\w/.:@%+=,-]+$/.test(value) ? value : quote(value)).join(' ');
  const target = frame.locator('.terminal-instance:not([hidden])');
  const input = target.locator('.xterm-helper-textarea');
  const rows = target.locator('.xterm-rows');
  const checks = [];
  await writeFile(trace, '');
  await writeFile(script, String.raw`import os,sys,termios,tty
fd=sys.stdin.fileno()
old=termios.tcgetattr(fd)
try:
 tty.setraw(fd)
 sys.stdout.write('\x1b[?2004hDROP_INPUT_READY\r\n');sys.stdout.flush()
 while True:
  data=os.read(fd,4096)
  if b'\x1d' in data: break
  with open(${JSON.stringify(trace)},'ab') as f: f.write(data)
finally:
 termios.tcsetattr(fd,termios.TCSADRAIN,old)
 sys.stdout.write('\x1b[?2004lDROP_INPUT_DONE\r\n');sys.stdout.flush()
`);
  cli(['send-keys', '-t', 'my-project:logs', '-l', `python3 ${quote(script)}`]); cli(['send-keys', '-t', 'my-project:logs', 'Enter']);
  const verify = async (name, action, paths) => {
    await writeFile(trace, '');
    await action();
    const text = expectedPaths(paths);
    const expected = `\x1b[200~${text}\x1b[201~`;
    await until(async () => (await readFile(trace, 'utf8')).length >= expected.length, 5000);
    await delay(300);
    const received = await readFile(trace, 'utf8');
    await writeFile(`.test-results/drop-observation-${editor}.json`, JSON.stringify({ name, paths, expected, received }, null, 2));
    assert.equal(received, expected, name);
    assert.equal(await input.evaluate(element => document.activeElement === element), true, 'Drop focuses the terminal');
    checks.push(name);
  };
  const reveal = async file => {
    await page.keyboard.press('Meta+p');
    const quick = page.locator('.quick-input-widget input[type="text"]');
    await quick.waitFor({ state: 'visible' }); await quick.fill(file); await delay(300); await quick.press('Enter');
    await command('File: Reveal Active File in Explorer');
    await page.getByText(path.basename(file), { exact: true }).last().waitFor({ state: 'visible' });
  };
  const source = file => page.locator('.explorer-folders-view .monaco-list-row').filter({ has: page.locator(`[aria-label="${file.replace(process.env.HOME, '~').replaceAll('"', '\\"')}"]`) }).first();
  const drag = async (file, preserveSelection = false) => {
    await source(file).scrollIntoViewIfNeeded();
    if (!preserveSelection) await source(file).click();
    // Obtain the real Explorer transfer data. Playwright mouse drags lose events
    // across Electron's process boundary, so bridge that boundary in the test.
    const items = await source(file).evaluate(element => {
      const dataTransfer = new DataTransfer();
      element.dispatchEvent(new DragEvent('dragstart', { dataTransfer, bubbles: true, cancelable: true }));
      const items = [...dataTransfer.types].map(type => [type, dataTransfer.getData(type)]);
      element.dispatchEvent(new DragEvent('dragend', { dataTransfer, bubbles: true }));
      return items;
    });
    await writeFile(`.test-results/drop-explorer-payload-${editor}.json`, JSON.stringify({ file, items }, null, 2));
    assert.ok(items.some(([type]) => ['resourceurls', 'codefiles', 'text/uri-list', 'application/vnd.code.uri-list'].includes(type)), 'Use the actual Explorer drag payload');
    await target.evaluate((element, items) => {
      const dataTransfer = new DataTransfer();
      for (const [type, value] of items) dataTransfer.setData(type, value);
      for (const type of ['dragenter', 'dragover', 'drop']) element.dispatchEvent(new DragEvent(type, { dataTransfer, shiftKey: true, bubbles: true, cancelable: true }));
    }, items);
  };
  try {
    await until(async () => (await rows.textContent()).includes('DROP_INPUT_READY'));
    await reveal(files[0]);
    await verify('Explorer file drag inserts its path once without Enter', () => drag(files[0]), [files[0]]);
    await verify('Explorer Unicode/space/quote/dollar file drag preserves one shell argument', () => drag(files[1]), [files[1]]);
    await verify('Explorer folder drag inserts its path', () => drag(folder), [folder]);
    await source(files[0]).click(); await source(files[1]).click({ modifiers: ['Meta'] });
    await verify('Explorer multiple selection inserts each path once in selection order', () => drag(files[0], true), files);
    await source(files[0]).click(); await source(folder).click({ modifiers: ['Meta'] });
    await verify('Explorer mixed file/folder selection preserves both paths', () => drag(files[0], true), [files[0], folder]);
    await target.screenshot({ path: `.test-results/terminal-drop-${editor}.png` });
    for (const [type, value, paths] of [
      ['text/uri-list', '# comment\r\nfile:///tmp/%E4%B8%AD%20file.txt\r\n', ['/tmp/中 file.txt']],
      ['resourceurls', JSON.stringify(['vscode-remote://ssh-remote+test/home/me/remote%20file.txt']), ['/home/me/remote file.txt']]
    ]) await verify(`${type} fallback inserts a decoded host path`, () => target.evaluate((element, { type, value }) => {
      const dataTransfer = new DataTransfer(); dataTransfer.setData(type, value);
      element.dispatchEvent(new DragEvent('drop', { dataTransfer, bubbles: true, cancelable: true }));
    }, { type, value }), paths);
    await writeFile(trace, '');
    await target.evaluate(element => {
      const dataTransfer = new DataTransfer(); dataTransfer.setData('resourceurls', JSON.stringify(['file:///tmp/invalid%0Acommand']));
      element.dispatchEvent(new DragEvent('drop', { dataTransfer, bubbles: true, cancelable: true }));
    });
    await delay(300); assert.equal(await readFile(trace, 'utf8'), '');
    checks.push('Invalid control-character path produces no terminal input');
  } finally {
    cli(['send-keys', '-t', 'my-project:logs', 'C-]']);
    await until(async () => (await rows.textContent()).includes('DROP_INPUT_DONE'));
    await writeFile(`.test-results/terminal-drop-${editor}.json`, JSON.stringify({ editor, checks }, null, 2));
  }
  return checks;
}
