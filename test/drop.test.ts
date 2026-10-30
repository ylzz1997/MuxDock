import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { droppedPaths, droppedPathText } from '../webview/drop';

const transfer = (data: Record<string, string>) => ({ types: Object.keys(data), getData: (type: string) => data[type] || '' });

test('Explorer drops preserve local/remote paths, Unicode, selection order and unique resources', () => {
  assert.deepEqual(droppedPaths(transfer({
    resourceurls: JSON.stringify(['file:///tmp/a.ts', 'file:///tmp/%E4%B8%AD%20a.ts', 'vscode-remote://ssh-remote+host/home/me/a%23b', 'file:///tmp/a.ts']),
    'text/uri-list': 'file:///wrong-fallback'
  })), ['/tmp/a.ts', '/tmp/中 a.ts', '/home/me/a#b']);
  assert.deepEqual(droppedPaths(transfer({ CodeFiles: JSON.stringify(['/tmp/a b', '/tmp/folder']) })), ['/tmp/a b', '/tmp/folder']);
});

test('URI list fallbacks accept file resources and ignore comments and unrelated content', () => {
  assert.deepEqual(droppedPaths(transfer({ ResourceURLs: '{bad', 'text/uri-list': '# comment\r\nfile:///tmp/a%20b\r\nhttps://example.org\r\n' })), ['/tmp/a b']);
  assert.deepEqual(droppedPaths(transfer({ 'application/vnd.code.uri-list': 'vscode-remote://dev-container+id/workspaces/project/file.ts' })), ['/workspaces/project/file.ts']);
  assert.deepEqual(droppedPaths(transfer({ 'text/plain': '/tmp/arbitrary text' })), []);
});

test('the most complete Explorer transfer preserves mixed selections across editor versions', () => {
  assert.deepEqual(droppedPaths(transfer({
    resourceurls: JSON.stringify(['file:///tmp/file.txt']),
    'text/uri-list': 'file:///tmp/file.txt',
    'application/vnd.code.uri-list': 'file:///tmp/file.txt\r\nfile:///tmp/folder\r\nfile:///tmp/another.txt'
  })), ['/tmp/file.txt', '/tmp/folder', '/tmp/another.txt']);
  assert.deepEqual(droppedPaths(transfer({
    resourceurls: JSON.stringify(['file:///tmp/file.txt', 'file:///tmp/folder']),
    'application/vnd.code.uri-list': 'file:///tmp/file.txt'
  })), ['/tmp/file.txt', '/tmp/folder']);
});

test('malformed, relative and control-character paths cannot introduce terminal commands', () => {
  const resources = ['https://example.org/a', 'untitled:Untitled-1', 'file:///tmp/%ZZ', 'file:///tmp/a%0Ab', 'file:///tmp/a%0Db', 'file:///tmp/a%00b', 'file:///tmp/a%1Bb', 'file://other-host/tmp/a'];
  assert.deepEqual(droppedPaths(transfer({ resourceurls: JSON.stringify(resources) })), []);
  assert.deepEqual(droppedPaths(transfer({ codefiles: JSON.stringify(['relative', '/tmp/a\nb', '/tmp/a\x1bb', 7, null]) })), []);
  for (const raw of ['null', '{}', '[null,7,{}]', 'x'.repeat(1024 * 1024 + 1)]) assert.deepEqual(droppedPaths(transfer({ resourceurls: raw })), []);
});

test('shell quoting round-trips every dropped path as one argument without expansion', { skip: process.platform === 'win32' }, () => {
  const paths = ['/tmp/plain.ts', '/tmp/中文 路径', "/tmp/it's a file", '/tmp/$HOME;$(echo BAD)`echo BAD`"*?[abc]\\end', '/tmp/#hash&name(1)'];
  const text = droppedPathText(paths);
  assert.equal(droppedPathText(['/tmp/plain.ts']), '/tmp/plain.ts');
  assert.equal(/[\r\n]/.test(text), false);
  const received = execFileSync('/bin/sh', ['-c', `printf '%s\\0' ${text}`], { encoding: 'utf8' }).split('\0').slice(0, -1);
  assert.deepEqual(received, paths);
});
