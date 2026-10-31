#!/usr/bin/env node
import os from 'node:os';
import path from 'node:path';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ITermService } from './service';

const exec = promisify(execFile);
const args = process.argv.slice(2), action = args[0] && !args[0].startsWith('--') ? args.shift() : 'start';
function option(name: string) { const index = args.indexOf(name); if (index < 0) return; if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Missing value for ${name}`); return args[index + 1]; }
const directory = path.resolve(option('--config-dir') || path.join(os.homedir(), 'Library/Application Support/MuxDock/iTerm2'));
const label = 'com.muxdock.iterm2';
const plist = path.join(os.homedir(), 'Library/LaunchAgents', `${label}.plist`);
const domain = `gui/${process.getuid?.()}`;
const escape = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
async function main() {
  if (action === 'help' || args.includes('--help')) {
    console.log('MuxDock for iTerm2\n\n  muxdock-iterm2 start [--config-dir PATH] [--port NUMBER]\n  muxdock-iterm2 install      Start automatically at login\n  muxdock-iterm2 uninstall    Remove the login service (keeps sessions/config)\n  muxdock-iterm2 doctor       Check local prerequisites\n\nRequires macOS, Node.js 20+, and iTerm2 with its API enabled. No Python required.'); return;
  }
  if (process.platform !== 'darwin') throw new Error('MuxDock for iTerm2 requires macOS.');
  if (action === 'doctor') {
    console.log(`Node: ${process.version}\niTerm2: ${existsSync('/Applications/iTerm.app') ? 'installed' : 'not found in /Applications'}\nAPI socket: ${existsSync(path.join(os.homedir(), 'Library/Application Support/iTerm2/private/socket')) ? 'ready' : 'not found — open iTerm2 and enable Settings > General > Magic > Python API'}\nPython: not required\nConfig: ${directory}`); return;
  }
  if (action === 'uninstall') { await exec('/bin/launchctl', ['bootout', `${domain}/${label}`]).catch(() => {}); await rm(plist, { force: true }); console.log('MuxDock login service removed. Terminal sessions and configuration were kept.'); return; }
  if (action === 'install') {
    await mkdir(path.dirname(plist), { recursive: true }); await mkdir(directory, { recursive: true, mode: 0o700 });
    const program = [process.execPath, path.resolve(__filename), 'start', '--config-dir', directory];
    const xml = `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array>${program.map(value => `<string>${escape(value)}</string>`).join('')}</array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>30</integer><key>StandardOutPath</key><string>${escape(path.join(directory, 'service.log'))}</string><key>StandardErrorPath</key><string>${escape(path.join(directory, 'service.log'))}</string></dict></plist>`;
    await writeFile(plist, xml, { mode: 0o600 }); await exec('/bin/launchctl', ['bootout', `${domain}/${label}`]).catch(() => {}); await exec('/bin/launchctl', ['bootstrap', domain, plist]);
    console.log(`MuxDock login service installed. Logs: ${path.join(directory, 'service.log')}`); return;
  }
  if (action !== 'start') throw new Error(`Unknown command: ${action}`);
  const portValue = option('--port'), port = portValue === undefined ? undefined : Number(portValue);
  if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535)) throw new Error('Invalid port');
  const service = new ITermService(directory, __dirname);
  let quitting = false;
  const stop = async () => { if (quitting) return; quitting = true; await service.stop(); process.exit(0); };
  process.once('SIGINT', () => { void stop(); }); process.once('SIGTERM', () => { void stop(); });
  await service.start(port);
  console.log(`MuxDock for iTerm2 is ready (127.0.0.1:${service.port}). Open View > Toolbelt > Show Toolbelt, then enable View > Toolbelt > MuxDock. Python is not required.`);
}
void main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
