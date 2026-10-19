import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { Terminal } from '@xterm/headless';
import { parseTerminalLink, findFileLinks } from '../src/links';
import { resolveFileLink } from '../src/file-links';
import { fileLinksForLine } from '../webview/links';

test('terminal destinations accept web and file locations without accepting executable URI schemes', () => {
  assert.deepEqual(parseTerminalLink('https://example.com/a?q=中文#part'), { kind: 'web', uri: 'https://example.com/a?q=%E4%B8%AD%E6%96%87#part' });
  for (const target of ['src/main.ts:12:3', 'src/main.ts#L12C3', 'src/main.ts(12,3)']) assert.deepEqual(parseTerminalLink(target), { kind: 'file', path: 'src/main.ts', line: 12, column: 3 });
  assert.deepEqual(parseTerminalLink('file:///tmp/a%20b.ts#L42-L46'), { kind: 'file', path: '/tmp/a b.ts', line: 42 });
  for (const target of ['command:workbench.action.terminal.sendSequence', 'javascript:alert(1)', 'data:text/html,hi', 'vscode://file/tmp/a', 'https://', 'file:///tmp/a%00b', 'file:///tmp/%ZZ', 'https://example.com\n', 'x.ts:0', 'x.ts:1:0', 'a'.repeat(8193)]) assert.equal(parseTerminalLink(target), undefined, target);
});

test('plain file detection preserves punctuation and does not detect paths inside web URLs', () => {
  const text = '中文 [src/main.ts:12:3](https://example.test/src/no.ts) "./a b/中文.ts:4" /tmp/foo.ts#L7-L9, file:///tmp/a%20b.ts#L8';
  const links = findFileLinks(text);
  assert.deepEqual(links.map(link => link.target), ['src/main.ts:12:3', './a b/中文.ts:4', '/tmp/foo.ts#L7-L9', 'file:///tmp/a%20b.ts#L8']);
  for (const link of links) assert.equal(text.slice(link.start, link.end), link.target);
});

test('file resolution checks the workspace host, current directory, spaces and line positions', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'muxdock-files-'));
  try {
    const child = path.join(root, 'nested'); await mkdir(child);
    const file = path.join(child, '中 a.ts'); await writeFile(file, 'one\ntwo\n');
    const expected = { path: file, line: 2, column: 3, directory: false };
    assert.deepEqual(await resolveFileLink('nested/中 a.ts:2:3', [root]), expected);
    assert.deepEqual(await resolveFileLink('中 a.ts#L2C3', [child, root]), expected);
    assert.deepEqual(await resolveFileLink(pathToFileURL(file).href + '#L2C3', [root]), expected);
    assert.equal((await resolveFileLink(child, [root]))?.directory, true);
    assert.equal(await resolveFileLink('missing.ts:2', [root]), undefined);
    assert.equal(await resolveFileLink('file://another-host/tmp/a.ts', [root]), undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('file link ranges survive terminal wrapping and Unicode before a path', async () => {
  const terminal = new Terminal({ cols: 24, rows: 12, allowProposedApi: true });
  try {
    const prefix = '中文 🙂 ';
    const target = './src/very-long-file-name.ts:12:4';
    await new Promise<void>(resolve => terminal.write(prefix + target, resolve));
    const links = fileLinksForLine(terminal, 2);
    const link = links.find(link => link.target === target)!;
    assert.ok(link);
    assert.equal(link.range.start.y, 1);
    assert.equal(link.range.end.y, 2);
    const startCell = terminal.buffer.active.getLine(0)!.getCell(link.range.start.x - 1)!;
    assert.equal(startCell.getChars(), '.');
    const endCell = terminal.buffer.active.getLine(1)!.getCell(link.range.end.x - 1)!;
    assert.equal(endCell.getChars(), '4');
  } finally { terminal.dispose(); }
});
