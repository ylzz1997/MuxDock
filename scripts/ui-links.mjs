import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';

export async function checkWrappedTerminalLinks({ frame, page, cli, until, delay }) {
  const directory = path.resolve(`.test-results/wrapped-links-${process.pid}`, ...Array.from({ length: 6 }, (_, i) => `long-directory-${i}-abcdefghijklmnopqrstuvwxyz`));
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, 'wrapped-target.ts');
  await writeFile(file, Array.from({ length: 30 }, (_, i) => `WRAPPED_TARGET_LINE_${i + 1}_abcdefghijklmnopqrstuvwxyz`).join('\n'));
  const fileText = file + ':12:3';
  const fileTarget = pathToFileURL(file).href + '#L12C3';
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(request.url);
    response.setHeader('Connection', 'close');
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end('<title>MuxDock wrapped link test</title>Wrapped link opened successfully.');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const webPath = '/' + 'long-segment/'.repeat(24) + 'end?complete=1';
  const web = `http://127.0.0.1:${server.address().port}${webPath}`;
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  const rows = frame.locator('.terminal-instance:not([hidden]) .xterm-rows > div');
  const cols = Number(cli(['display-message', '-p', '-t', 'my-project:logs', '#{pane_width}']).trim());
  const checks = [];
  const render = async (value, replay) => {
    await page.bringToFront();
    await page.mouse.move(10, 10);
    const chunks = value.match(new RegExp(`.{1,${cols}}`, 'g'));
    const output = '\x1b[2J\x1b[H' + (replay ? '\x1b[?7l' + chunks.map((chunk, i) => `\x1b[${i + 1};1H${chunk}`).join('') + '\x1b[?7h' : value) + '\r\n';
    const script = path.resolve('.test-results/wrapped-link-output.py');
    await writeFile(script, `import sys\nsys.stdout.write(${JSON.stringify(output)})\nsys.stdout.flush()\n`);
    cli(['send-keys', '-t', 'my-project:logs', '-l', `python3 ${quote(script)}`]);
    cli(['send-keys', '-t', 'my-project:logs', 'Enter']);
    await until(async () => (await rows.allTextContents())[0] === chunks[0]);
    await delay(250);
    return chunks;
  };
  const hover = async row => {
    await page.mouse.move(10, 10);
    const box = await rows.nth(row).boundingBox();
    const point = { x: box.x + box.width / cols * 3.5, y: box.y + box.height / 2 };
    await page.mouse.move(point.x, point.y);
    await frame.getByRole('tooltip').waitFor({ state: 'visible' });
    return point;
  };
  const click = async point => {
    await page.keyboard.down('Meta'); await page.mouse.click(point.x, point.y); await page.keyboard.up('Meta');
  };
  try {
    for (const replay of [false, true]) {
      const label = replay ? 'multiplexer replay' : 'soft wrap';
      const fileRows = await render(fileText, replay);
      for (let row = 0; row < fileRows.length; row++) {
        const point = await hover(row);
        assert.equal(await frame.locator('.link-destination').textContent(), fileTarget, `${label} file row ${row + 1}`);
        await click(point);
        await until(async () => (await page.locator('.tab.active').allTextContents()).some(text => text.includes('wrapped-target.ts')));
        await until(async () => /12\D+3/.test(await page.locator('[id="status.editor.selection"]').textContent()));
      }
      checks.push(`${label}: every file row opens the complete path at line 12 column 3`);
      const webRows = await render(web, replay);
      for (let row = 0; row < webRows.length; row++) {
        await hover(row);
        assert.equal(await frame.locator('.link-destination').textContent(), web, `${label} web row ${row + 1}`);
      }
      const count = requests.filter(url => url === webPath).length;
      await click(await hover(webRows.length - 1));
      await until(() => requests.filter(url => url === webPath).length > count);
      await page.bringToFront();
      checks.push(`${label}: every web row previews the complete URL and clicking the final row requests its complete path and query`);
    }
    await frame.locator('.dock').screenshot({ path: `.test-results/wrapped-links-${process.pid}.png` });
    return checks;
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

export async function checkTerminalLinks({ frame, page, cli, until, delay }) {
  const directory = path.resolve(`.test-results/link-fixture-${process.pid}`);
  await mkdir(directory, { recursive: true });
  const plainFile = path.join(directory, 'link-target.ts');
  const unicodeFile = path.join(directory, '带 空格.ts');
  const projectName = '点击 项目';
  const project = path.join(directory, projectName);
  await mkdir(project, { recursive: true });
  await writeFile(path.join(project, 'project-proof.txt'), 'MuxDock folder link target\n');
  const text = Array.from({ length: 30 }, (_, index) => `LINK_TARGET_${process.pid}_LINE_${index + 1}_abcdefghijklmnopqrstuvwxyz`).join('\n');
  await writeFile(plainFile, text); await writeFile(unicodeFile, text);
  const destination = pathToFileURL(unicodeFile).href + '#L12C3';
  const web = 'https://example.com/muxdock?source=terminal#preview';
  const output = `\x1b]8;;${destination}\x1b\\CODEX_FILE_LINK\x1b]8;;\x1b\\\r\n\x1b]8;;${web}\x07CODEX_WEB_LINK\x1b]8;;\x07\r\nlink-target.ts:12:3\r\n"./${projectName}/"\r\n${web}\r\n`;
  const script = path.resolve('.test-results/link-output.py');
  await writeFile(script, `import sys\nsys.stdout.write(${JSON.stringify(output)})\nsys.stdout.flush()\n`);
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  cli(['send-keys', '-t', 'my-project:logs', '-l', `cd ${quote(directory)}; python3 ${quote(script)}`]);
  cli(['send-keys', '-t', 'my-project:logs', 'Enter']);
  const rows = frame.locator('.terminal-instance:not([hidden]) .xterm-rows > div');
  await until(async () => (await rows.allTextContents()).some(text => text === 'CODEX_FILE_LINK'));
  const hover = async (label, inset = 5) => {
    const row = rows.filter({ hasText: new RegExp(`^${label}`) }).last();
    const box = await row.boundingBox();
    const point = { x: box.x + inset, y: box.y + box.height / 2 };
    await page.mouse.move(point.x + 18, point.y); await page.mouse.move(point.x, point.y);
    await frame.getByRole('tooltip').waitFor({ state: 'visible' });
    return point;
  };
  const checks = [];
  await hover('CODEX_WEB_LINK');
  assert.equal(await frame.locator('.link-destination').textContent(), web);
  const clipboard = () => execFileSync('/usr/bin/pbpaste', [], { encoding: 'utf8' });
  const previous = clipboard();
  try {
    await frame.getByRole('button', { name: '复制链接地址', exact: true }).click();
    await until(async () => clipboard() === web);
  } finally { execFileSync('/usr/bin/pbcopy', [], { input: previous }); }
  checks.push('OSC 8 web link shows its destination and copies the URL rather than its label');
  const link = await hover('CODEX_FILE_LINK');
  assert.equal(await frame.locator('.link-destination').textContent(), destination);
  await frame.locator('.dock').screenshot({ path: '.test-results/muxdock-link-hover.png' });
  const activeTabs = await page.locator('.tab.active').allTextContents();
  await page.mouse.click(link.x, link.y);
  assert.deepEqual(await page.locator('.tab.active').allTextContents(), activeTabs, 'Plain click must not open the linked file');
  await page.keyboard.down('Meta'); await page.mouse.click(link.x, link.y); await page.keyboard.up('Meta');
  await until(async () => (await page.locator('.monaco-editor .view-lines').allTextContents()).some(text => text.includes(`LINK_TARGET_${process.pid}_LINE_12`)));
  await until(async () => /12\D+3/.test(await page.locator('[id="status.editor.selection"]').textContent()));
  checks.push('Cmd-click a Codex-style OSC 8 file link opens the Unicode/space path at line 12 column 3');
  const location = await hover('link-target');
  assert.equal(await frame.locator('.link-destination').textContent(), pathToFileURL(plainFile).href + '#L12C3');
  await page.keyboard.down('Meta'); await page.mouse.click(location.x, location.y); await page.keyboard.up('Meta');
  await until(async () => (await page.locator('.tab.active').allTextContents()).some(text => text.includes('link-target.ts')));
  await until(async () => /12\D+3/.test(await page.locator('[id="status.editor.selection"]').textContent()));
  checks.push('relative file locations resolve against the live tmux pane directory after cd');
  // Hit the path's second cell rather than the opening quote.
  const folder = await hover('"./点击 项目/"', 12);
  assert.equal(await frame.locator('.link-destination').textContent(), pathToFileURL(project).href);
  const existingPages = new Set(page.context().pages());
  await page.mouse.click(folder.x, folder.y);
  assert.equal(page.context().pages().length, existingPages.size, 'Plain click must not open a project window');
  await page.keyboard.down('Meta'); await page.mouse.click(folder.x, folder.y); await page.keyboard.up('Meta');
  const projectWindow = await until(() => page.context().pages().find(candidate => !existingPages.has(candidate) && candidate.url().includes('workbench')));
  try {
    await until(async () => (await projectWindow.title()).includes(projectName));
    await projectWindow.keyboard.press('Meta+Shift+E');
    await projectWindow.getByText('project-proof.txt', { exact: true }).first().waitFor({ state: 'visible' });
    await projectWindow.screenshot({ path: '.test-results/muxdock-folder-project.png' });
    assert.equal(page.isClosed(), false, 'Opening a project must preserve the original editor window');
    checks.push('Cmd-click a relative folder with Unicode and spaces opens that project in a new window of the same editor');
  } finally {
    await projectWindow.close();
    await page.bringToFront();
  }
  cli(['send-keys', '-t', 'my-project:logs', '-l', `cd ${quote(process.cwd())}`]); cli(['send-keys', '-t', 'my-project:logs', 'Enter']);
  await frame.locator('.terminal-instance:not([hidden]) .xterm-helper-textarea').focus();
  await delay(200);
  return checks;
}
