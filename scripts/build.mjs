import { build, context } from 'esbuild';
import { chmod, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

await mkdir('dist', { recursive: true });
await mkdir('artifacts', { recursive: true });
const options = [
  { entryPoints: ['src/extension.ts'], outfile: 'dist/extension.cjs', bundle: true, platform: 'node', format: 'cjs', target: 'node20', external: ['vscode', 'node-pty'], sourcemap: true },
  { entryPoints: ['webview/main.ts'], outfile: 'dist/webview.js', bundle: true, platform: 'browser', format: 'iife', target: 'es2022', sourcemap: true, loader: { '.otf': 'file' } }
];
// Keep the native module adjacent to the extension; do not load VS Code's private dependencies.
const nativeRoot = path.resolve('dist/node_modules/node-pty');
if (!nativeRoot.startsWith(path.resolve('dist') + path.sep)) throw new Error('Invalid native module output directory');
await mkdir(path.dirname(nativeRoot), { recursive: true });
await rm(nativeRoot, { recursive: true, force: true });
await mkdir(nativeRoot, { recursive: true });
for (const file of ['package.json', 'LICENSE']) await cp(`node_modules/node-pty/${file}`, `${nativeRoot}/${file}`);
await cp('node_modules/node-pty/lib', `${nativeRoot}/lib`, { recursive: true, filter: source => !/\.test\./.test(source) });
for (const architecture of ['arm64', 'x64']) {
  await cp(`node_modules/node-pty/prebuilds/darwin-${architecture}`, `${nativeRoot}/prebuilds/darwin-${architecture}`, { recursive: true });
  await cp(`node_modules/node-pty/prebuilds/win32-${architecture}`, `${nativeRoot}/prebuilds/win32-${architecture}`, { recursive: true, filter: source => !source.endsWith('.pdb') });
}
if (process.platform === 'linux' && existsSync('node_modules/node-pty/build/Release')) {
  await cp('node_modules/node-pty/build/Release', `${nativeRoot}/build/Release`, { recursive: true, filter: source => !/\/obj(?:\.target)?(?:\/|$)/.test(source) });
}
const nativePackage = JSON.parse(await readFile('node_modules/node-pty/package.json', 'utf8'));
delete nativePackage.dependencies;
delete nativePackage.devDependencies;
delete nativePackage.scripts;
await writeFile(`${nativeRoot}/package.json`, JSON.stringify(nativePackage, null, 2));
for (const architecture of ['arm64', 'x64']) {
  await chmod(`${nativeRoot}/prebuilds/darwin-${architecture}/spawn-helper`, 0o755);
}
await cp('src/pty-host.py', 'dist/pty-host.py');
await cp('src/windows-pty-host.cjs', 'dist/windows-pty-host.cjs');
await cp('src/session-processes.py', 'dist/session-processes.py');
await cp('media/fonts/LICENSE-Powerline.txt', 'dist/LICENSE-Powerline.txt');
await cp('node_modules/smol-toml/LICENSE', 'dist/LICENSE-smol-toml.txt');
if (process.argv.includes('--watch')) {
  for (const option of options) { const ctx = await context(option); await ctx.watch(); }
} else {
  for (const option of options) await build(option);
}
