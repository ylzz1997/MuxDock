import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const json = async file => JSON.parse(await readFile(file, 'utf8'));
const root = await json('package.json');
const directory = path.resolve(process.argv[2] || 'artifacts');
const files = [`muxdock-${root.version}.vsix`, `muxdock-iterm2-${root.version}.tgz`];
const temporary = await mkdtemp(path.join(os.tmpdir(), 'muxdock-release-'));

async function requireFile(file, executable = false) {
  const info = await stat(file);
  assert.ok(info.isFile() && info.size > 0, `Missing or empty file: ${file}`);
  if (executable) assert.ok(info.mode & 0o111, `Missing executable permission: ${file}`);
}

try {
  execFileSync('unzip', ['-q', path.join(directory, files[0]), '-d', path.join(temporary, 'vsix')]);
  const extension = path.join(temporary, 'vsix/extension');
  const packaged = await json(path.join(extension, 'package.json'));
  for (const key of ['name', 'publisher', 'version']) assert.equal(packaged[key], root[key], `VSIX ${key} mismatch`);
  const manifest = await readFile(path.join(temporary, 'vsix/extension.vsixmanifest'), 'utf8');
  const identity = manifest.match(/<Identity\b[^>]*>/)?.[0] || '';
  for (const [key, expected] of Object.entries({ Id: root.name, Publisher: root.publisher, Version: root.version })) {
    assert.equal(identity.match(new RegExp(`\\b${key}="([^"]+)"`))?.[1], expected, `VSIX manifest ${key} mismatch`);
  }
  // vsce normalizes these documentation filenames inside the VSIX.
  for (const file of [root.main, root.icon, 'dist/webview.js', 'dist/webview.css', 'dist/windows-pty-host.cjs', 'dist/pty-host.py', 'dist/session-processes.py', 'LICENSE.txt', 'readme.md']) await requireFile(path.join(extension, file));
  for (const file of (await readdir('.')).filter(name => /^package\.nls(?:\.[\w-]+)?\.json$/.test(name))) await requireFile(path.join(extension, file));
  for (const arch of ['arm64', 'x64']) {
    const prebuilds = path.join(extension, 'dist/node_modules/node-pty/prebuilds');
    await requireFile(path.join(prebuilds, `darwin-${arch}/pty.node`));
    await requireFile(path.join(prebuilds, `darwin-${arch}/spawn-helper`), true);
    for (const file of ['pty.node', 'conpty.node', 'conpty_console_list.node', 'conpty/conpty.dll', 'conpty/OpenConsole.exe']) await requireFile(path.join(prebuilds, `win32-${arch}`, file));
  }

  const archive = path.join(directory, files[1]);
  const contents = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' });
  assert.doesNotMatch(contents, /\.py(?:c|o)?$/m, 'The iTerm2 package must not contain Python files');
  execFileSync('tar', ['-xzf', archive, '-C', temporary]);
  const iterm = path.join(temporary, 'package'), metadata = await json(path.join(iterm, 'package.json'));
  assert.equal(metadata.name, 'muxdock-iterm2'); assert.equal(metadata.version, root.version);
  assert.equal(metadata.publishConfig?.access, 'public'); assert.equal(metadata.publishConfig?.registry, 'https://registry.npmjs.org');
  assert.deepEqual(metadata.os, ['darwin']); assert.equal(metadata.bin['muxdock-iterm2'], 'dist/cli.cjs');
  await requireFile(path.join(iterm, 'dist/cli.cjs'), true);
  for (const file of ['dist/sidebar.js', 'dist/sidebar.css', 'dist/iterm2.css', 'README.md', 'LICENSE', 'THIRD-PARTY-NOTICES.txt']) await requireFile(path.join(iterm, file));
  for (const arch of ['arm64', 'x64']) await requireFile(path.join(iterm, `node_modules/@koromix/koffi-darwin-${arch}/darwin_${arch}/koffi.node`));
  // Exercise the extracted package, including its bundled native dependency.
  assert.match(execFileSync(process.execPath, [path.join(iterm, 'dist/cli.cjs'), 'help'], { encoding: 'utf8' }), /MuxDock for iTerm2/);
  if (process.platform === 'darwin') execFileSync(process.execPath, ['-e', 'require(process.argv[1])', path.join(iterm, 'node_modules/koffi')]);

  const checksums = await Promise.all(files.map(async file => `${createHash('sha256').update(await readFile(path.join(directory, file))).digest('hex')}  ${file}`));
  await writeFile(path.join(directory, 'SHA256SUMS.txt'), checksums.join('\n') + '\n');
  console.log(`Verified VSIX and iTerm2 ${root.version}: manifests, assets, native binaries, permissions and checksums.`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
