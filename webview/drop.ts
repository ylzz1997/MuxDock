import type { Terminal } from '@xterm/xterm';
import { droppedPathText } from '../src/shell-paths';
export { droppedPathText } from '../src/shell-paths';

type Transfer = Pick<DataTransfer, 'types' | 'getData'>;
const formats = ['resourceurls', 'codefiles', 'application/vnd.code.uri-list', 'text/uri-list'];
const validPath = (value: string) => /^(?:\/|[a-z]:[\\/]|\\\\)/i.test(value) && !/[\x00-\x1f\x7f]/.test(value);

function resourcePath(value: string): string | undefined {
  try {
    if (/[\x00-\x1f\x7f]/.test(value)) return;
    const uri = new URL(value);
    if (uri.protocol !== 'file:' && uri.protocol !== 'vscode-remote:') return;
    if (uri.protocol === 'file:' && uri.hostname && uri.hostname !== 'localhost') return;
    const path = decodeURIComponent(uri.pathname).replace(/^\/(?=[a-z]:\/)/i, '');
    if (validPath(path)) return path;
  } catch { /* Ignore malformed resources and try the remaining transfer formats. */ }
}

/** Prefer editor resources, preserving remote workspace paths and selection order. */
export function droppedPaths(transfer: Transfer): string[] {
  let result: string[] = [];
  for (const format of formats) {
    const type = transfer.types.find(type => type.toLowerCase() === format);
    if (!type) continue;
    const raw = transfer.getData(type);
    if (!raw || raw.length > 1024 * 1024) continue;
    let values: unknown;
    try {
      values = format === 'resourceurls' || format === 'codefiles' ? JSON.parse(raw) : raw.split(/\r?\n/).filter(line => line && !line.startsWith('#'));
    } catch { continue; }
    if (!Array.isArray(values) || values.length > 1024) continue;
    const paths = values.filter((value): value is string => typeof value === 'string').flatMap(value => {
      const path = format === 'codefiles' ? (validPath(value) ? value : undefined) : resourcePath(value);
      return path ? [path] : [];
    });
    // Editor versions differ in which formats include folders/all selections.
    // Keep the most complete representation without merging duplicate formats.
    const unique = [...new Set(paths)];
    if (unique.length > result.length) result = unique;
  }
  return result;
}

export function attachTerminalDrop(element: HTMLElement, current: () => Pick<Terminal, 'paste' | 'focus'> | undefined, pastePaths?: (paths: string[]) => void): () => void {
  const supported = (transfer: DataTransfer | null) => transfer?.types.some(type => formats.includes(type.toLowerCase()));
  const highlight = (accept: boolean) => element.classList.toggle('file-drop-target', accept);
  const clear = () => highlight(false);
  for (const type of ['dragenter', 'dragover'] as const) element.addEventListener(type, event => {
    if (!supported(event.dataTransfer)) return;
    // Let the webview shell observe the drag lifecycle as well.
    event.preventDefault();
    const accept = !!current();
    event.dataTransfer!.dropEffect = accept ? 'copy' : 'none';
    highlight(accept);
  }, true);
  element.addEventListener('dragleave', event => {
    if (!(event.relatedTarget instanceof Node) || !element.contains(event.relatedTarget)) clear();
  });
  element.addEventListener('dragend', clear);
  window.addEventListener('blur', clear);
  element.addEventListener('drop', event => {
    clear();
    if (!supported(event.dataTransfer)) return;
    event.preventDefault();
    const terminal = current();
    if (!terminal) return;
    const paths = droppedPaths(event.dataTransfer!);
    if (!paths.length) return;
    if (pastePaths) pastePaths(paths); else terminal.paste(droppedPathText(paths));
    // Switching focus during drop can interrupt Electron's source cleanup.
    requestAnimationFrame(() => { if (element.isConnected && current() === terminal) terminal.focus(); });
  }, true);
  return clear;
}
