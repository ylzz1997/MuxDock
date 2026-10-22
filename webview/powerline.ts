import type { ITerminalAddon, Terminal } from '@xterm/xterm';

const separators = /([\ue0b0-\ue0b3])/u;
const paths = new Map([
  ['\ue0b0', 'M0 0L100 50L0 100Z'],
  ['\ue0b1', 'M0 0L100 50L0 100'],
  ['\ue0b2', 'M100 0L0 50L100 100Z'],
  ['\ue0b3', 'M100 0L0 50L100 100']
]);

// The DOM renderer uses the font's ink bounds for separators, which leave gaps
// beside full-height cell backgrounds. Draw these four shapes at the cell size.
export class PowerlineAddon implements ITerminalAddon {
  private observer?: MutationObserver;
  activate(terminal: Terminal) {
    const rows = terminal.element?.querySelector<HTMLElement>('.xterm-rows');
    if (!rows) return;
    const render = (row: HTMLElement) => {
      const cellWidth = Number.parseFloat(row.style.width) / terminal.cols;
      if (!Number.isFinite(cellWidth) || cellWidth <= 0) return;
      for (const span of row.children) {
        // xterm replaces its row spans on redraw. Leave already enhanced spans
        // alone, including observer notifications caused by our own children.
        if (span.childElementCount || !separators.test(span.textContent || '')) continue;
        const content = document.createDocumentFragment();
        for (const part of (span.textContent || '').split(separators)) {
          const pathData = paths.get(part);
          if (!pathData) { content.append(document.createTextNode(part)); continue; }
          const glyph = document.createElement('span'); glyph.className = 'muxdock-powerline';
          glyph.style.width = `${cellWidth}px`;
          glyph.append(document.createTextNode(part)); // Preserve DOM text and terminal copy.
          const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
          svg.setAttribute('viewBox', '0 0 100 100'); svg.setAttribute('preserveAspectRatio', 'none');
          svg.setAttribute('aria-hidden', 'true');
          const path = document.createElementNS(svg.namespaceURI, 'path');
          path.setAttribute('d', pathData);
          const outline = part === '\ue0b1' || part === '\ue0b3';
          path.setAttribute('fill', outline ? 'none' : 'currentColor');
          if (outline) {
            path.setAttribute('stroke', 'currentColor'); path.setAttribute('stroke-width', '1');
            path.setAttribute('vector-effect', 'non-scaling-stroke');
          }
          svg.append(path); glyph.append(svg); content.append(glyph);
        }
        span.replaceChildren(content);
      }
    };
    // Also covers xterm's direct redraws on selection, focus and link hover,
    // which do not all emit terminal.onRender. Observe only changed rows.
    this.observer = new MutationObserver(records => {
      const changed = new Set<HTMLElement>();
      for (const record of records) {
        if (record.target === rows) {
          for (const node of record.addedNodes) if (node instanceof HTMLElement) changed.add(node);
        } else if (record.target instanceof HTMLElement && record.target.parentElement === rows) changed.add(record.target);
      }
      for (const row of changed) render(row);
    });
    this.observer.observe(rows, { childList: true, subtree: true });
    for (const row of rows.children) render(row as HTMLElement);
  }
  dispose() { this.observer?.disconnect(); }
}
