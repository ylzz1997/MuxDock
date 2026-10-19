import type { Terminal, IBufferRange, ILink, ILinkHandler, ILinkProvider } from '@xterm/xterm';
import { findFileLinks, parseTerminalLink } from '../src/links';

/** Map UTF-16 offsets to terminal cells, including wrapped lines and wide characters. */
export function fileLinksForLine(terminal: Pick<Terminal, 'buffer'>, y: number): { target: string; range: IBufferRange }[] {
  const buffer = terminal.buffer.active;
  let start = y - 1;
  while (start > 0 && y - start < 50 && buffer.getLine(start)?.isWrapped) start--;
  let content = '';
  const cells: { x: number; endX: number; y: number }[] = [];
  for (let row = start; row < buffer.length && row - start < 50; row++) {
    const line = buffer.getLine(row);
    if (!line || row > start && !line.isWrapped) break;
    const length = line.translateToString(true).length;
    let offset = 0;
    for (let x = 0; x < line.length && offset < length; x++) {
      const cell = line.getCell(x)!;
      if (!cell.getWidth()) continue;
      const chars = cell.getChars() || ' ';
      content += chars; offset += chars.length;
      for (let i = 0; i < chars.length; i++) cells.push({ x: x + 1, endX: x + cell.getWidth(), y: row + 1 });
    }
    if (content.length > 8192) return [];
  }
  return findFileLinks(content).flatMap(match => {
    const first = cells[match.start]; const last = cells[match.end - 1];
    return first && last && first.y <= y && last.y >= y ? [{ target: match.target, range: { start: { x: first.x, y: first.y }, end: { x: last.endX, y: last.y } } }] : [];
  });
}

type Send = (message: unknown) => void;
type Candidate = ReturnType<typeof fileLinksForLine>[number];
let requestId = 0;
export class TerminalLinks implements ILinkProvider {
  private active = false;
  private hovered?: string;
  private tooltip?: HTMLDivElement;
  private hideTimer?: ReturnType<typeof setTimeout>;
  private pressed?: { target: string; x: number; y: number };
  private pending = new Map<number, { candidates: Candidate[]; callback: (links: ILink[] | undefined) => void; timer: ReturnType<typeof setTimeout> }>();
  private disposables: { dispose(): void }[] = [];
  private readonly isMac = /Mac/i.test(navigator.platform);
  constructor(private readonly terminal: Terminal, private readonly element: HTMLElement, private readonly key: string, private readonly send: Send) {
    this.disposables.push(terminal.registerLinkProvider(this), terminal.onScroll(() => this.hide()), terminal.onResize(() => this.hide()));
    this.listen(element, 'mouseenter', () => this.invalidateHoverCache());
    this.listen(element, 'mousedown', event => {
      const mouse = event as MouseEvent;
      if (mouse.button === 0 && this.modified(mouse) && this.hovered && parseTerminalLink(this.hovered)) {
        this.pressed = { target: this.hovered, x: mouse.clientX, y: mouse.clientY };
        mouse.preventDefault(); mouse.stopPropagation();
      }
    }, true);
    this.listen(document, 'mouseup', event => {
      if (!this.pressed) return;
      const press = this.pressed; this.pressed = undefined;
      const mouse = event as MouseEvent;
      mouse.preventDefault(); mouse.stopPropagation();
      if (mouse.button === 0 && this.modified(mouse) && this.hovered === press.target && Math.hypot(mouse.clientX - press.x, mouse.clientY - press.y) < 5) this.open(press.target);
    }, true);
    this.listen(window, 'blur', () => { this.pressed = undefined; this.hide(); });
    this.listen(document, 'keydown', event => { if ((event as KeyboardEvent).key === 'Escape') this.hide(); });
  }
  private listen(target: EventTarget, name: string, listener: EventListener, capture = false) {
    target.addEventListener(name, listener, capture);
    this.disposables.push({ dispose: () => target.removeEventListener(name, listener, capture) });
  }
  private modified(event: MouseEvent) { return this.isMac ? event.metaKey : event.ctrlKey; }
  private invalidateHoverCache() {
    // xterm 6 retains a row's provider replies after mouseleave. Re-entering the
    // same row after a TUI redraw can otherwise activate its previous URL.
    // Isolate this guarded compatibility fix; linkHandler has no invalidation API.
    const cache = (this.terminal as unknown as { _core?: { linkifier?: {
      _clearCurrentLink?: () => void; _activeLine?: number; _lastBufferCell?: unknown;
      _activeProviderReplies?: Map<unknown, unknown>;
    } } })._core?.linkifier;
    if (!cache?._clearCurrentLink || !cache._activeProviderReplies) return;
    cache._clearCurrentLink(); cache._activeProviderReplies.clear();
    cache._activeLine = -1; cache._lastBufferCell = undefined;
    this.hide();
  }
  setActive(active: boolean) { this.active = active; if (!active) this.hide(); }
  target(): string | undefined { return this.hovered; }
  open(target: string) { if (this.active && parseTerminalLink(target)) this.send({ type: 'openLink', key: this.key, url: target }); this.hide(); }
  activate = (event: MouseEvent, target: string) => {
    event.preventDefault();
    if (event.button === 0 && this.modified(event) && !this.terminal.hasSelection()) this.open(target);
  };
  hover = (event: MouseEvent, target: string) => {
    if (!this.active || !parseTerminalLink(target) || event.buttons) return;
    this.hide(); this.hovered = target;
    const tooltip = document.createElement('div'); this.tooltip = tooltip;
    tooltip.className = 'terminal-link-hover xterm-hover'; tooltip.setAttribute('role', 'tooltip');
    const destination = document.createElement('div'); destination.className = 'link-destination'; destination.textContent = target; tooltip.append(destination);
    const hint = document.createElement('div'); hint.className = 'link-hint'; hint.textContent = `${this.isMac ? '⌘' : 'Ctrl'}+单击打开链接`; tooltip.append(hint);
    const actions = document.createElement('div'); actions.className = 'link-actions';
    for (const [label, action] of [
      ['打开链接', () => this.open(target)],
      ['复制链接地址', () => { this.send({ type: 'copy', text: target }); this.hide(); }]
    ] as const) {
      const button = document.createElement('button'); button.textContent = label;
      button.addEventListener('click', action); actions.append(button);
    }
    tooltip.append(actions);
    tooltip.addEventListener('mouseenter', () => { clearTimeout(this.hideTimer); });
    tooltip.addEventListener('mouseleave', () => this.leave());
    document.body.append(tooltip);
    tooltip.style.left = `${Math.max(4, Math.min(event.clientX, innerWidth - tooltip.offsetWidth - 4))}px`;
    const above = event.clientY - tooltip.offsetHeight - 12;
    tooltip.style.top = `${Math.max(4, Math.min(above >= 4 ? above : event.clientY + 20, innerHeight - tooltip.offsetHeight - 4))}px`;
  };
  leave = () => { clearTimeout(this.hideTimer); this.hideTimer = setTimeout(() => this.hide(), 200); };
  handler: ILinkHandler = { allowNonHttpProtocols: true, activate: this.activate, hover: this.hover, leave: this.leave };
  hide() { clearTimeout(this.hideTimer); this.tooltip?.remove(); this.tooltip = undefined; this.hovered = undefined; }
  provideLinks(y: number, callback: (links: ILink[] | undefined) => void) {
    const candidates = fileLinksForLine(this.terminal, y);
    if (!candidates.length || !this.active) { callback(undefined); return; }
    const request = ++requestId;
    const timer = setTimeout(() => { this.pending.delete(request); callback(undefined); }, 6000);
    this.pending.set(request, { candidates, callback, timer });
    this.send({ type: 'resolveLinks', key: this.key, request, targets: candidates.map(candidate => candidate.target) });
  }
  receive(message: { request: number; links: { input: string; target: string }[] }) {
    const pending = this.pending.get(message.request);
    if (!pending) return;
    this.pending.delete(message.request); clearTimeout(pending.timer);
    const links = pending.candidates.flatMap(candidate => {
      const current = fileLinksForLine(this.terminal, candidate.range.start.y);
      if (!current.some(link => link.target === candidate.target && JSON.stringify(link.range) === JSON.stringify(candidate.range))) return [];
      const match = message.links.find(link => link.input === candidate.target && parseTerminalLink(link.target)?.kind === 'file');
      return match ? [{ text: match.target, range: candidate.range, activate: this.activate, hover: this.hover, leave: this.leave }] : [];
    });
    pending.callback(links);
  }
  dispose() {
    this.hide(); this.pressed = undefined;
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.callback(undefined); }
    this.pending.clear(); this.disposables.forEach(disposable => disposable.dispose());
  }
}
