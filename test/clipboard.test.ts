import test from 'node:test';
import assert from 'node:assert/strict';
import { Terminal } from '@xterm/headless';
import { decodeTerminalClipboard, MAX_TERMINAL_CLIPBOARD_BYTES } from '../src/clipboard';

const encode = (value: string) => Buffer.from(value).toString('base64');

test('OSC 52 decodes Unicode clipboard writes and standard selection targets', () => {
  const value = '\ufeffCodex 中文 🙂\nsecond line';
  for (const selection of ['', 'c', 'p', 's', 'cp', '01234567']) assert.equal(decodeTerminalClipboard(`${selection};${encode(value)}`), value);
  assert.equal(decodeTerminalClipboard('c;'), '');
  assert.equal(decodeTerminalClipboard('c;YQ'), 'a');
});

test('OSC 52 ignores clipboard queries, malformed payloads and invalid UTF-8', () => {
  for (const value of ['c;?', ';?', '?', 'c', 'x;YQ==', 'c;YQ===', 'c;Y', 'c;not base64', 'c;/w==']) assert.equal(decodeTerminalClipboard(value), undefined, value);
});

test('OSC 52 bounds clipboard writes before decoding', () => {
  assert.equal(decodeTerminalClipboard(`c;${encode('a'.repeat(MAX_TERMINAL_CLIPBOARD_BYTES))}`)?.length, MAX_TERMINAL_CLIPBOARD_BYTES);
  assert.equal(decodeTerminalClipboard(`c;${encode('a'.repeat(MAX_TERMINAL_CLIPBOARD_BYTES + 1))}`), undefined);
});

test('xterm handles split OSC 52 sequences with BEL and ST terminators', async () => {
  const terminal = new Terminal({ allowProposedApi: true });
  const copied: string[] = [];
  terminal.parser.registerOscHandler(52, data => {
    const value = decodeTerminalClipboard(data);
    if (value !== undefined) copied.push(value);
    return true;
  });
  const write = (value: string) => new Promise<void>(resolve => terminal.write(value, resolve));
  try {
    const encoded = encode('复制 🙂');
    await write(`\x1b]52;c;${encoded.slice(0, 3)}`);
    assert.deepEqual(copied, []);
    await write(`${encoded.slice(3)}\x07`);
    await write(`\x1b]52;;${encoded}\x1b`);
    await write('\\');
    await write('\x1b]52;c;?\x07');
    await write('\x1b]52;c;/w==\x07');
    assert.deepEqual(copied, ['复制 🙂', '复制 🙂']);
  } finally { terminal.dispose(); }
});
