import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnPty } from '../src/pty';
import { cleanEnvironment } from '../src/runner';

for (const driver of ['native', 'python']) {
  test(`${driver} PTY handles Unicode, interactive input, resize and process exit`, { timeout: 15000, skip: process.platform === 'win32' && driver === 'python' }, async () => {
    const previous = process.env.MUXDOCK_PTY_DRIVER;
    process.env.MUXDOCK_PTY_DRIVER = driver;
    const processPty = spawnPty(process.execPath, ['-e', 'console.log("READY"); process.stdin.once("data", () => { const size = []; process.stdout._handle.getWindowSize(size); console.log("PTY_RESULT 中文", ...size); process.exit(0); });'], { cols: 90, rows: 25, cwd: process.cwd(), env: cleanEnvironment() });
    let output = '';
    const finished = new Promise<number>(resolve => processPty.onExit(({ exitCode }) => resolve(exitCode)));
    const ready = new Promise<void>(resolve => processPty.onData(data => { output += data; if (output.includes('READY')) resolve(); }));
    await ready;
    processPty.resize(111, 33);
    await new Promise(resolve => setTimeout(resolve, 150));
    processPty.write('input\r');
    const exitCode = await finished;
    assert.equal(exitCode, 0); assert.match(output, /PTY_RESULT 中文/); assert.match(output, /111 33/);
    if (previous === undefined) delete process.env.MUXDOCK_PTY_DRIVER; else process.env.MUXDOCK_PTY_DRIVER = previous;
  });
}
