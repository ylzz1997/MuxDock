import { build } from 'esbuild';
import { chmod, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const output = path.resolve('artifacts/iterm2');
await rm(output, { recursive: true, force: true });
await mkdir(`${output}/dist`, { recursive: true });
await build({ entryPoints: ['src/iterm2/cli.ts'], outfile: `${output}/dist/cli.cjs`, bundle: true, platform: 'node', format: 'cjs', target: 'node20', external: ['koffi', 'bufferutil', 'utf-8-validate'] });
await build({ entryPoints: ['webview/main.ts'], outfile: `${output}/dist/sidebar.js`, bundle: true, platform: 'browser', format: 'iife', target: 'es2022', loader: { '.otf': 'file' } });
await cp('webview/iterm2.css', `${output}/dist/iterm2.css`);
await cp('media/fonts/LICENSE-Powerline.txt', `${output}/dist/LICENSE-Powerline.txt`);
await mkdir(`${output}/node_modules`, { recursive: true });
const koffi = JSON.parse(await readFile('node_modules/koffi/package.json', 'utf8'));
await mkdir(`${output}/node_modules/koffi/src/koffi`, { recursive: true });
for (const name of ['index.cjs', 'index.js', 'LICENSE.txt']) if (existsSync(`node_modules/koffi/${name}`)) await cp(`node_modules/koffi/${name}`, `${output}/node_modules/koffi/${name}`);
for (const name of ['index.cjs', 'index.js']) if (existsSync(`node_modules/koffi/src/koffi/${name}`)) await cp(`node_modules/koffi/src/koffi/${name}`, `${output}/node_modules/koffi/src/koffi/${name}`);
await mkdir(`${output}/node_modules/koffi/src/koffi/src`, { recursive: true });
for (const name of ['static.cjs', 'static.js']) if (existsSync(`node_modules/koffi/src/koffi/src/${name}`)) await cp(`node_modules/koffi/src/koffi/src/${name}`, `${output}/node_modules/koffi/src/koffi/src/${name}`);
delete koffi.scripts; delete koffi.optionalDependencies;
await writeFile(`${output}/node_modules/koffi/package.json`, JSON.stringify(koffi, null, 2));
for (const arch of ['arm64', 'x64']) {
  const name = `@koromix/koffi-darwin-${arch}`, destination = `${output}/node_modules/${name}`;
  await mkdir(destination, { recursive: true });
  if (existsSync(`node_modules/${name}`)) await cp(`node_modules/${name}`, destination, { recursive: true });
  else {
    await mkdir('.test-tools/iterm2', { recursive: true });
    const info = JSON.parse(execFileSync('npm', ['pack', `${name}@${koffi.version}`, '--pack-destination', '.test-tools/iterm2', '--json'], { encoding: 'utf8' }))[0];
    execFileSync('tar', ['-xzf', path.resolve('.test-tools/iterm2', info.filename), '--strip-components=1', '-C', destination]);
  }
}
const root = JSON.parse(await readFile('package.json', 'utf8'));
await writeFile(`${output}/package.json`, JSON.stringify({ name: '@muxdock/iterm2', version: root.version, description: 'MuxDock session sidebar for iTerm2 — no Python required', license: 'MIT', repository: root.repository, os: ['darwin'], engines: { node: '>=20' }, bin: { 'muxdock-iterm2': 'dist/cli.cjs' }, dependencies: { koffi: koffi.version }, optionalDependencies: { '@koromix/koffi-darwin-arm64': koffi.version, '@koromix/koffi-darwin-x64': koffi.version }, bundledDependencies: ['koffi', '@koromix/koffi-darwin-arm64', '@koromix/koffi-darwin-x64'], files: ['dist', 'README.md', 'LICENSE', 'THIRD-PARTY-NOTICES.txt'] }, null, 2));
await cp('docs/ITERM2.md', `${output}/README.md`); await cp('LICENSE', `${output}/LICENSE`);
let notices = '';
for (const dependency of ['ws', 'smol-toml', '@xterm/xterm', '@xterm/addon-fit', '@xterm/addon-search', '@xterm/addon-unicode11', 'koffi']) {
  const folder = `node_modules/${dependency}`;
  const file = ['LICENSE', 'LICENSE.txt', 'LICENSE.md'].find(name => existsSync(`${folder}/${name}`));
  if (file) notices += `\n${dependency}\n${await readFile(`${folder}/${file}`, 'utf8')}\n`;
}
await writeFile(`${output}/THIRD-PARTY-NOTICES.txt`, notices);
await chmod(`${output}/dist/cli.cjs`, 0o755);
console.log(`Built ${output}`);
