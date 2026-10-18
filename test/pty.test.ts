import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnPty } from '../src/pty';
import { cleanEnvironment } from '../src/runner';

for (const driver of ['native', 'python']) {
  test(`${driver} PTY handles Unicode, interactive input, resize and process exit`, { timeout: 15000 }, async () => {
    const previous = process.env.MUXDOCK_PTY_DRIVER;
    process.env.MUXDOCK_PTY_DRIVER = driver;
    const processPty = spawnPty('/bin/sh', [], { cols: 90, rows: 25, cwd: '/tmp', env: cleanEnvironment() });
    let output = '';
    const finished = new Promise<number>(resolve => processPty.onExit(({ exitCode }) => resolve(exitCode)));
    processPty.onData(data => { output += data; });
    processPty.resize(111, 33);
    processPty.write("printf 'PTY_%s 中文\\n' 'RESULT'; stty size; exit 0\n");
    const exitCode = await finished;
    assert.equal(exitCode, 0); assert.match(output, /PTY_RESULT 中文/); assert.match(output, /33 111/);
    if (previous === undefined) delete process.env.MUXDOCK_PTY_DRIVER; else process.env.MUXDOCK_PTY_DRIVER = previous;
  });
}
