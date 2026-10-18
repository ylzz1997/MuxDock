import { chmod, readdir } from 'node:fs/promises';
const root = 'node_modules/node-pty/prebuilds';
try {
  for (const directory of await readdir(root)) {
    if (directory.startsWith('darwin-')) await chmod(`${root}/${directory}/spawn-helper`, 0o755);
  }
} catch (error) { if (error.code !== 'ENOENT') throw error; }
