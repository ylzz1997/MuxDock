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
export async function detachZellijClients(socketPath: string, clientIds: number[]): Promise<void> {
  if (!socketPath.includes('/contract_version_1/')) throw new Error('不支持此 Zellij socket 协议。');
  if (!clientIds.length) return;
  if (clientIds.some(id => !Number.isSafeInteger(id) || id <= 0 || id > 65535)) throw new Error('无效的 Zellij 客户端 ID。');
  const ids = clientIds.flatMap(varint);
  const detach = [10, ...varint(ids.length), ...ids];
  const payload = Buffer.from([10, ...varint(detach.length), ...detach]);
  const prefix = Buffer.alloc(4); prefix.writeUInt32LE(payload.length);
  await new Promise<void>((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('Zellij 断开请求超时。')); }, 3000);
    socket.once('error', error => { clearTimeout(timer); reject(error); });
    socket.once('connect', () => socket.end(Buffer.concat([prefix, payload]), () => { clearTimeout(timer); resolve(); }));
  });
}
