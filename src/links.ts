export type TerminalLink = { kind: 'web'; uri: string } | { kind: 'file'; path: string; authority?: string; line?: number; column?: number };

/** Terminal output may supply labels unrelated to their destinations. Parse the destination. */
export function parseTerminalLink(value: string): TerminalLink | undefined {
  if (value.length > 8192 || /[\x00-\x1f\x7f]/.test(value)) return;
  let target = value.trim();
  if (!target) return;
  if (/^https?:\/\//i.test(target)) {
    try { const url = new URL(target); if (url.hostname) return { kind: 'web', uri: url.href }; } catch { }
    return;
  }
  let authority: string | undefined;
  let fragment: string | undefined;
  if (/^file:/i.test(target)) {
    try {
      const url = new URL(target);
      authority = url.hostname;
      target = decodeURIComponent(url.pathname); fragment = url.hash;
      if (!target.startsWith('/') || url.search || /[\x00-\x1f\x7f]/.test(target)) return;
    } catch { return; }
  }
  let line: number | undefined; let column: number | undefined;
  const location = /(?:#L?(\d+)(?:[C:](\d+))?(?:-L?\d+(?:C\d+)?)?|:(\d+)(?::(\d+))?|\((\d+)(?:,\s*(\d+))?\))$/.exec(fragment ?? target);
  if (location) {
    line = Number(location[1] || location[3] || location[5]);
    column = location[2] || location[4] || location[6] ? Number(location[2] || location[4] || location[6]) : undefined;
    if (!Number.isSafeInteger(line) || line < 1 || column !== undefined && (!Number.isSafeInteger(column) || column < 1)) return;
    if (fragment === undefined) target = target.slice(0, location.index);
  }
  // Never interpret executable/editor URI schemes as paths.
  if (!target || /^[a-z][\da-z+.-]*:/i.test(target) || target.includes('://')) return;
  if (!target.includes('/') && !/^[^/]+\.[\p{L}\p{N}_-]+$/u.test(target)) return;
  return { kind: 'file', path: target, ...(authority ? { authority } : {}), ...(line ? { line } : {}), ...(column ? { column } : {}) };
}

export interface TerminalLinkMatch { target: string; start: number; end: number }
export function findWebLinks(text: string): TerminalLinkMatch[] {
  // Keep the punctuation boundaries used by xterm's web-links addon.
  const pattern = /(https?|HTTPS?):[/]{2}[^\s"'!*(){}|\\\^<>`]*[^\s"':,.!?{}|\\\^~\[\]`()<>]/g;
  const result: TerminalLinkMatch[] = [];
  for (const match of text.matchAll(pattern)) {
    if (parseTerminalLink(match[0])?.kind === 'web') result.push({ target: match[0], start: match.index!, end: match.index! + match[0].length });
    if (result.length >= 32) break;
  }
  return result;
}
export function findFileLinks(text: string): TerminalLinkMatch[] {
  const result: TerminalLinkMatch[] = [];
  // Consume web URLs as whole tokens so their path segments cannot become file links.
  const tokens = /https?:\/\/[^\s<>"'`]+|file:\/\/[^\s<>"'`]+|["'][^"'\r\n]+["']|(?:~\/|\/|\.\.?\/)[^\s<>"'`()\[\]{};,]+(?:\(\d+(?:,\s*\d+)?\))?|(?:[\p{L}\p{N}_@.-]+\/)+[^\s<>"'`()\[\]{};,]+(?:\(\d+(?:,\s*\d+)?\))?|[\p{L}\p{N}_@.-]+\.[\p{L}\p{N}_-]+(?:(?::\d+){1,2}|#L?\d+(?:C\d+)?(?:-L?\d+)?)?/giu;
  for (const match of text.matchAll(tokens)) {
    let target = match[0]; let start = match.index!;
    if (target[0] === '"' || target[0] === "'") { target = target.slice(1, -1); start++; }
    else {
      target = target.replace(/[,;.!\]}]+$/, '');
      while (target.endsWith(')') && (target.match(/\)/g)?.length || 0) > (target.match(/\(/g)?.length || 0)) target = target.slice(0, -1);
    }
    if (parseTerminalLink(target)?.kind === 'file') result.push({ target, start, end: start + target.length });
    if (result.length >= 32) break;
  }
  return result;
}
