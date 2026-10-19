import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function checkTerminalPaste({ frame, page, cli, until, delay }) {
  const clipboard = () => execFileSync('/usr/bin/pbpaste', [], { encoding: 'utf8' });
  const previous = clipboard();
  const trace = path.resolve('.test-results/paste-input.bin');
  const script = path.resolve('.test-results/paste-input.py');
  const input = frame.locator('.terminal-instance:not([hidden]) .xterm-helper-textarea');
  const rows = frame.locator('.terminal-instance:not([hidden]) .xterm-rows');
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  const checks = [];
  await writeFile(trace, '');
  await writeFile(script, String.raw`import os,sys,termios,tty
fd=sys.stdin.fileno()
old=termios.tcgetattr(fd)
try:
 tty.setraw(fd)
 sys.stdout.write('\x1b[?2004hPASTE_INPUT_READY\r\n');sys.stdout.flush()
 while True:
  data=os.read(fd,4096)
  if b'\x1d' in data: break
  with open(${JSON.stringify(trace)},'ab') as f: f.write(data)
finally:
 termios.tcsetattr(fd,termios.TCSADRAIN,old)
 sys.stdout.write('\x1b[?2004lPASTE_INPUT_DONE\r\n');sys.stdout.flush()
`);
  cli(['send-keys', '-t', 'my-project:logs', '-l', `python3 ${quote(script)}`]); cli(['send-keys', '-t', 'my-project:logs', 'Enter']);
  const payload = '/tmp/测试 paste/address';
  const bracketed = text => `\x1b[200~${text.replace(/\r?\n/g, '\r')}\x1b[201~`;
  const check = async (scenario, action, text = payload, count = 1) => {
    execFileSync('/usr/bin/pbcopy', [], { input: text });
    await writeFile(trace, ''); await input.focus(); await action();
    const expected = bracketed(text).repeat(count);
    await until(async () => (await readFile(trace, 'utf8')).length >= expected.length, 5000);
    await delay(300);
    const received = await readFile(trace, 'utf8');
    await writeFile('.test-results/paste-observation.json', JSON.stringify({ scenario, expected, received }, null, 2));
    assert.equal(received, expected, scenario);
    checks.push(scenario);
  };
  try {
    await until(async () => (await rows.textContent()).includes('PASTE_INPUT_READY'));
    await check('Cmd+V pastes exactly once', () => page.keyboard.press('Meta+v'));
    await check('Cmd+Shift+V pastes exactly once', () => page.keyboard.press('Meta+Shift+v'));
    await check('Ctrl+Shift+V pastes exactly once', () => page.keyboard.press('Control+Shift+v'));
    await check('two deliberate pastes of identical text remain two pastes', async () => {
      await page.keyboard.down('Meta'); await page.keyboard.press('v'); await page.keyboard.press('v'); await page.keyboard.up('Meta');
    }, payload, 2);
    await check('multiline paste preserves one bracketed payload', () => page.keyboard.press('Meta+v'), 'first 中文\nsecond line');
    await check('context menu paste pastes exactly once', async () => {
      await frame.locator('.terminal-instance:not([hidden]) .xterm-screen').click({ button: 'right' });
      await frame.getByRole('menuitem', { name: '粘贴', exact: true }).click();
    });
    await check('native paste event pastes exactly once', () => input.evaluate((element, text) => {
      const clipboard = new DataTransfer(); clipboard.setData('text/plain', text);
      element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: clipboard, bubbles: true, cancelable: true }));
    }, payload));
  } finally {
    cli(['send-keys', '-t', 'my-project:logs', 'C-]']);
    await until(async () => (await rows.textContent()).includes('PASTE_INPUT_DONE'));
    execFileSync('/usr/bin/pbcopy', [], { input: previous });
    await writeFile('.test-results/terminal-paste.json', JSON.stringify({ checks }, null, 2));
  }
  return checks;
}
