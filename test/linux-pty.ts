import assert from 'node:assert/strict';
import { spawnPty } from '../src/pty';
import { cleanEnvironment } from '../src/runner';

async function main() {
  const pty = spawnPty('/bin/sh', [], { cols: 90, rows: 25, cwd: '/tmp', env: cleanEnvironment() });
  let output = '';
  const done = new Promise<number>(resolve => pty.onExit(({ exitCode }) => resolve(exitCode)));
  pty.onData(data => { output += data; });
  pty.resize(111, 33);
  pty.write("printf 'LINUX_%s 中文\\n' 'PTY_OK'; stty size; exit 0\n");
  const code = await done;
  assert.equal(code, 0); assert.match(output, /LINUX_PTY_OK 中文/); assert.match(output, /33 111/);
  console.log(JSON.stringify({ status: 'PASS', platform: process.platform, arch: process.arch, checks: ['automatic Python PTY fallback', 'Unicode', 'input/output', 'resize', 'exit'] }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
