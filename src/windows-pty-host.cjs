// One native PTY per process: node-pty 1.1.0's global Windows handle vector is
// mutated by unsynchronized native exit threads (microsoft/node-pty#921).
// Keeping it out of the extension host also releases all native handles on EOF.
const { spawn } = require('node-pty');
let pty, finished = false, stopping = false, paused = false;
let forceExit;
function finish(code) {
  if (finished) return;
  finished = true; clearTimeout(forceExit);
  if (process.connected) process.send({ type: 'exit', code }, () => process.exit(0));
  else process.exit(0);
}
function stop() {
  if (stopping || finished) return;
  stopping = true;
  if (!pty) { finish(0); return; }
  pty.resume();
  // Terminate only the attached client we spawned. Avoid native PtyKill's
  // concurrent handle access; the multiplexer server is an independent process.
  try { process.kill(pty.pid); } catch (error) { if (error.code !== 'ESRCH') finish(1); }
  forceExit = setTimeout(() => finish(1), 5000);
}
process.on('disconnect', stop);
process.on('message', message => {
  if (!message || finished) return;
  if (message.type === 'start' && !pty && !stopping) {
    try {
      const { encoding, ...options } = message.options;
      pty = spawn(message.file, message.args, { ...options, useConptyDll: options.useConptyDll ?? true });
      pty.onData(data => {
        if (!process.connected) { stop(); return; }
        const accepted = process.send({ type: 'data', data }, error => {
          if (error) stop(); else if (!paused && !finished) pty.resume();
        });
        if (!accepted) pty.pause();
      });
      pty.onExit(({ exitCode }) => finish(exitCode));
    } catch (error) {
      if (process.connected) process.send({ type: 'data', data: `${error.message}\r\n` });
      finish(127);
    }
    return;
  }
  if (message.type === 'kill') { stop(); return; }
  if (!pty || stopping) return;
  if (message.type === 'write') pty.write(message.data);
  else if (message.type === 'resize') { try { pty.resize(message.cols, message.rows); } catch { /* Client exited during resize. */ } }
  else if (message.type === 'pause') { paused = true; pty.pause(); }
  else if (message.type === 'resume') { paused = false; pty.resume(); }
});
