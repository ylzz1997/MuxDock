// Minimal protobuf wire codec for iTerm2's public API. Field numbers are defined at
// https://github.com/gnachman/iTerm2/blob/master/proto/api.proto. Unknown fields are ignored.
export type Fields = { [field: number]: number | boolean | string | Buffer | Fields | (number | string | Fields)[] };
export type Wire = Map<number, (number | Buffer)[]>;
function varint(value: number): Buffer {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid protobuf integer');
  const bytes: number[] = [];
  do { const byte = value % 128; value = Math.floor(value / 128); bytes.push(byte | (value ? 128 : 0)); } while (value);
  return Buffer.from(bytes);
}
export function encode(fields: Fields): Buffer {
  const chunks: Buffer[] = [];
  for (const [key, values] of Object.entries(fields)) for (const value of Array.isArray(values) ? values : [values]) {
    const field = Number(key);
    if (!Number.isInteger(field) || field < 1) throw new Error('Invalid protobuf field');
    if (typeof value === 'number' || typeof value === 'boolean') chunks.push(varint(field * 8), varint(Number(value)));
    else {
      const bytes = typeof value === 'string' ? Buffer.from(value) : Buffer.isBuffer(value) ? value : encode(value);
      chunks.push(varint(field * 8 + 2), varint(bytes.length), bytes);
    }
  }
  return Buffer.concat(chunks);
}
export function decode(bytes: Buffer): Wire {
  let offset = 0;
  const read = () => {
    let value = 0;
    for (let i = 0; i < 10; i++) {
      if (offset >= bytes.length) throw new Error('Truncated protobuf integer');
      const byte = bytes[offset++]; value += (byte & 127) * 2 ** (7 * i);
      if (!(byte & 128)) { if (!Number.isSafeInteger(value)) throw new Error('Oversized protobuf integer'); return value; }
    }
    throw new Error('Malformed protobuf integer');
  };
  const result: Wire = new Map();
  while (offset < bytes.length) {
    const tag = read(), field = Math.floor(tag / 8), type = tag % 8;
    if (!field) throw new Error('Invalid protobuf tag');
    let value: number | Buffer;
    if (type === 0) value = read();
    else if ([1, 2, 5].includes(type)) {
      const length = type === 2 ? read() : type === 1 ? 8 : 4;
      if (length > bytes.length - offset) throw new Error('Truncated protobuf field');
      value = bytes.subarray(offset, offset + length); offset += length;
    } else throw new Error('Unsupported protobuf wire type');
    result.set(field, [...(result.get(field) || []), value]);
  }
  return result;
}
export const number = (wire: Wire, field: number): number => typeof wire.get(field)?.[0] === 'number' ? wire.get(field)![0] as number : 0;
export const string = (wire: Wire, field: number): string => Buffer.isBuffer(wire.get(field)?.[0]) ? (wire.get(field)![0] as Buffer).toString('utf8') : '';
export const messages = (wire: Wire, field: number): Wire[] => (wire.get(field) || []).filter(Buffer.isBuffer).map(decode);
export function checkStatus(wire: Wire, operation: string) {
  if (number(wire, 1) !== 0) throw new Error(`iTerm2 ${operation}: status ${number(wire, 1)}`);
}
