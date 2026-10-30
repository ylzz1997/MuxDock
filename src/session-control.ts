import { t } from './i18n';
import net from 'node:net';

function varint(value: number): number[] {
  const bytes: number[] = [];
  do { const byte = value & 127; value >>>= 7; bytes.push(byte | (value ? 128 : 0)); } while (value);
  return bytes;
}
// Zellij contract v1: ClientToServerMsg.detach_session (field 1), whose
// DetachSessionMsg contains packed uint32 client_ids (field 1). Only this
// versioned contract is accepted; legacy sockets use verified client processes.
// https://github.com/zellij-org/zellij/blob/v0.45.1/zellij-utils/src/client_server_contract/client_to_server.proto
export async function detachZellijClients(socketPath: string, clientIds: number[], platform = process.platform): Promise<void> {
  if (!socketPath.replaceAll('\\', '/').includes('/contract_version_1/')) throw new Error(t('zellijProtocol'));
  if (!clientIds.length) return;
  if (clientIds.some(id => !Number.isSafeInteger(id) || id <= 0 || id > 65535)) throw new Error(t('zellijClientId'));
  const ids = clientIds.flatMap(varint);
  const detach = [10, ...varint(ids.length), ...ids];
  const payload = Buffer.from([10, ...varint(detach.length), ...detach]);
  const prefix = Buffer.alloc(4); prefix.writeUInt32LE(payload.length);
  if (platform === 'win32') {
    // Windows Zellij opens its reply pipe even for commands with no response.
    // Both connections must be established and drained before sending a frame.
    await new Promise<void>((resolve, reject) => {
      const address = `\\\\.\\pipe\\${socketPath}`;
      const sockets = [net.createConnection(address), net.createConnection(`${address}-reply`)];
      let connected = 0, finished = false;
      const finish = (error?: Error) => {
        if (finished) return; finished = true;
        clearTimeout(timer); for (const socket of sockets) socket.destroy();
        if (error) reject(error); else resolve();
      };
      const timer = setTimeout(() => finish(new Error(t('zellijTimeout'))), 3000);
      for (const socket of sockets) {
        socket.on('error', finish); socket.on('data', () => {});
        socket.once('connect', () => {
          if (++connected === 2) sockets[0].write(Buffer.concat([prefix, payload]), error => {
            if (error) finish(error); else setTimeout(() => finish(), 100);
          });
        });
      }
    });
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    const timer = setTimeout(() => { socket.destroy(); reject(new Error(t('zellijTimeout'))); }, 3000);
    socket.once('error', error => { clearTimeout(timer); reject(error); });
    socket.once('connect', () => socket.end(Buffer.concat([prefix, payload]), () => { clearTimeout(timer); resolve(); }));
  });
}
