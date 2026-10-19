export const MAX_TERMINAL_CLIPBOARD_BYTES = 1024 * 1024;

/** Decode an OSC 52 write. Clipboard queries must never read the local clipboard. */
export function decodeTerminalClipboard(data: string): string | undefined {
  const separator = data.indexOf(';');
  if (separator < 0 || !/^[cps0-7]*$/.test(data.slice(0, separator))) return;
  const encoded = data.slice(separator + 1);
  if (encoded === '?' || encoded.length > Math.ceil(MAX_TERMINAL_CLIPBOARD_BYTES / 3) * 4) return;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) return;
  try {
    const binary = atob(encoded);
    if (binary.length > MAX_TERMINAL_CLIPBOARD_BYTES) return;
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Uint8Array.from(binary, character => character.charCodeAt(0)));
  } catch { return; }
}
