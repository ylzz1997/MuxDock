import type { Terminal } from '@xterm/xterm';

type Transfer = Pick<DataTransfer, 'types' | 'getData'>;
const formats = ['resourceurls', 'codefiles', 'application/vnd.code.uri-list', 'text/uri-list'];
const validPath = (value: string) => value.startsWith('/') && !/[\x00-\x1f\x7f]/.test(value);

function resourcePath(value: string): string | undefined {
  try {
    if (/[\x00-\x1f\x7f]/.test(value)) return;
    const uri = new URL(value);
    if (uri.protocol !== 'file:' && uri.protocol !== 'vscode-remote:') return;
    if (uri.protocol === 'file:' && uri.hostname && uri.hostname !== 'localhost') return;
    const path = decodeURIComponent(uri.pathname);
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

/** MuxDock runs on macOS/Linux hosts, including Remote SSH, WSL and containers. */
export function droppedPathText(paths: string[]): string {
  return paths.map(path => /^[\w/.:@%+=,-]+$/.test(path) ? path : `'${path.replaceAll("'", "'\\''")}'`).join(' ');
}

export function attachTerminalDrop(element: HTMLElement, terminal: Terminal, enabled: () => boolean): void {
  const supported = (transfer: DataTransfer | null) => transfer?.types.some(type => formats.includes(type.toLowerCase()));
  const clear = () => element.classList.remove('file-drop-target');
  for (const type of ['dragenter', 'dragover'] as const) element.addEventListener(type, event => {
    if (!supported(event.dataTransfer)) return;
    event.preventDefault(); event.stopPropagation();
    const accept = enabled();
    event.dataTransfer!.dropEffect = accept ? 'copy' : 'none';
    element.classList.toggle('file-drop-target', accept);
  });
  element.addEventListener('dragleave', event => {
    if (!(event.relatedTarget instanceof Node) || !element.contains(event.relatedTarget)) clear();
  });
  element.addEventListener('dragend', clear);
  element.addEventListener('drop', event => {
    clear();
    if (!supported(event.dataTransfer)) return;
    event.preventDefault(); event.stopPropagation();
    if (!enabled()) return;
    const paths = droppedPaths(event.dataTransfer!);
    if (!paths.length) return;
    terminal.focus();
    terminal.paste(droppedPathText(paths));
  });
}
