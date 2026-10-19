import { Terminal, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import '@xterm/xterm/css/xterm.css';
import './style.css';
import { MANAGER_IDS, type ConnectionInfo, type ManagerInfo, type SessionInfo, type Snapshot, type WindowInfo } from '../src/model';

declare function acquireVsCodeApi(): { postMessage(message: unknown): void; getState(): Saved | undefined; setState(state: Saved): void };
interface Saved { width: number; expanded: string[]; filter?: string; filterOpen?: boolean; sidebarCollapsed?: boolean }
const vscode = acquireVsCodeApi();
const send = (message: unknown) => vscode.postMessage(message);
const saved = vscode.getState();
const expanded = new Set(saved?.expanded || ['tmux', 'zmx', 'screen', 'zellij', 'shpool', 'abduco', 'a4']);
let width = saved?.width || 258;
let sidebarCollapsed = saved?.sidebarCollapsed === true;
let snapshot: Snapshot = { managers: [], connections: [], host: '', showUnavailable: false, visibleManagers: [...MANAGER_IDS], showTabs: true, maxTabs: 8, appearance: { fontSize: 14, fontFamily: 'Menlo, Monaco, monospace', scrollback: 10000 } };
let displayedKey: string | undefined;
let lastActiveTarget: string | undefined;
let focusGeneration = 0;
const terminals = new Map<string, { terminal: Terminal; fit: FitAddon; search: SearchAddon; element: HTMLElement; seq: number; info: ConnectionInfo; closed: boolean }>();
const paths: Record<string, string> = {
  terminal: '<path d="m4 5 4 3-4 3m6 1h3"/>', plus: '<path d="M8 3v10M3 8h10"/>',
  refresh: '<path d="M13 6a5 5 0 1 0 .1 4M13 2v4H9"/>', chevron: '<path d="m6 4 4 4-4 4"/>',
  search: '<circle cx="7" cy="7" r="4"/><path d="m10 10 4 4"/>', close: '<path d="m4 4 8 8M12 4l-8 8"/>',
  more: '<circle cx="3" cy="8" r=".7"/><circle cx="8" cy="8" r=".7"/><circle cx="13" cy="8" r=".7"/>',
  copy: '<rect x="5" y="5" width="8" height="9" rx="1"/><path d="M10 5V2H2v9h3"/>',
  disconnect: '<path d="m3 3 10 10M5 2v4m6-4v4M4 6h8v2a4 4 0 0 1-4 4v2"/>',
  window: '<rect x="2" y="3" width="12" height="10" rx="1"/><path d="M2 6h12"/>',
  layers: '<path d="m8 2 6 3-6 3-6-3 6-3ZM2 8l6 3 6-3M2 11l6 3 6-3"/>',
  check: '<path d="m3 8 3 3 7-7"/>', gear: '<path d="M8 1v2m0 10v2M1 8h2m10 0h2M3 3l1 1m8 8 1 1M3 13l1-1m8-8 1-1"/><circle cx="8" cy="8" r="4"/><circle cx="8" cy="8" r="1"/>',
  warning: '<path d="m8 2 7 12H1L8 2Zm0 4v4m0 1.5v.5"/>',
  collapseSidebar: '<rect x="1.5" y="2.5" width="13" height="11" rx="1"/><path d="M10 2.5v11M4 5.5l2.5 2.5L4 10.5"/>',
  expandSidebar: '<rect x="1.5" y="2.5" width="13" height="11" rx="1"/><path d="M10 2.5v11M7 5.5 4.5 8 7 10.5"/>'
};
function icon(name: string): HTMLElement {
  const element = document.createElement('span');
  element.className = `icon icon-${name}`;
  element.innerHTML = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.terminal}</svg>`;
  return element;
}
function button(label: string, image: string, action: () => void, className = 'icon-button'): HTMLButtonElement {
  const element = document.createElement('button');
  element.type = 'button'; element.className = className; element.title = label; element.setAttribute('aria-label', label);
  element.append(icon(image)); element.addEventListener('click', event => { event.stopPropagation(); action(); });
  return element;
}
function text(tag: string, value: string, className = ''): HTMLElement {
  const element = document.createElement(tag); element.textContent = value; element.className = className; return element;
}
const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = `<main class="dock">
<section class="terminal-area" aria-label="终端">
  <header class="terminal-header"><div class="terminal-heading"></div><div class="terminal-tabs" role="tablist" aria-label="已打开的终端" hidden></div><div class="terminal-actions"></div></header>
  <div class="search-bar" hidden><input aria-label="搜索终端内容" placeholder="搜索终端内容"><button class="search-next" title="下一个">↓</button><button class="search-close" title="关闭搜索">×</button></div>
  <div class="terminal-content"><div class="welcome"><div class="welcome-symbol"></div><h1>选择一个会话</h1><p>从右侧连接已有会话，<br>或创建一个新的终端会话。</p><button class="primary new-session">新建会话</button><span class="welcome-note">断开连接后，任务继续运行</span></div><div class="terminal-hosts" role="tabpanel" aria-label="终端内容"></div></div>
  <footer class="terminal-footer"><span class="connection-status">未打开会话</span><span class="host-name"></span></footer>
</section>
<div class="splitter" role="separator" aria-label="调整会话树宽度" aria-orientation="vertical" tabindex="0"></div>
<aside class="sidebar" id="session-sidebar" aria-label="管理器和会话"><header class="sidebar-header"><div class="sidebar-heading"><span class="sidebar-title">会话</span></div><div class="sidebar-actions"></div></header><div class="filter-wrap" id="session-filter" hidden><input class="filter" aria-label="筛选会话" placeholder="筛选会话…" spellcheck="false"></div><div class="tree" role="tree" aria-label="终端管理器"></div><footer class="sidebar-footer"></footer></aside>
</main>`;
const get = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const tree = get('.tree');
const terminalHosts = get('.terminal-hosts');
const filter = get<HTMLInputElement>('.filter');
const searchInput = get<HTMLInputElement>('.search-bar input');
const sidebar = get('.sidebar');
const splitter = get('.splitter');
const tabList = get('.terminal-tabs');
tabList.addEventListener('wheel', event => {
  if (!event.ctrlKey && tabList.scrollWidth > tabList.clientWidth && Math.abs(event.deltaY) > Math.abs(event.deltaX)) { tabList.scrollLeft += event.deltaY; event.preventDefault(); }
}, { passive: false });
const filterWrap = get('.filter-wrap');
let filterOpen = saved?.filterOpen ?? !!saved?.filter;
const filterToggle = button('筛选会话', 'search', () => setFilterOpen(!filterOpen));
filterToggle.setAttribute('aria-controls', 'session-filter');
get('.sidebar-heading').append(filterToggle);
filterWrap.hidden = !filterOpen;
filterToggle.setAttribute('aria-expanded', String(filterOpen));
get('.welcome-symbol').append(icon('terminal'));
get('.new-session').addEventListener('click', () => send({ type: 'newSession' }));
get('.sidebar-actions').append(
  button('新建会话', 'plus', () => send({ type: 'newSession' })),
  button('刷新', 'refresh', () => send({ type: 'refresh' })),
  button('更多操作', 'more', () => showMenu(get('.sidebar-actions').getBoundingClientRect().right, 32, [
    { label: snapshot.showUnavailable ? '隐藏未安装的管理器' : '显示未安装的管理器', action: () => send({ type: 'showUnavailable', value: !snapshot.showUnavailable }) },
    { label: 'MuxDock 设置', action: () => send({ type: 'settings' }) }
  ]))
);
const sidebarToggle = button('收起会话面板', 'collapseSidebar', () => {
  sidebarCollapsed = !sidebarCollapsed;
  closeMenu(); updateSidebarVisibility(); persist();
  sidebarToggle.focus();
}, 'icon-button sidebar-toggle');
sidebarToggle.setAttribute('aria-controls', 'session-sidebar');
get('.terminal-actions').append(
  button('搜索终端', 'search', () => openSearch()),
  button('复制选中内容', 'copy', () => { const value = current()?.terminal.getSelection(); if (value) send({ type: 'copy', text: value }); }),
  button('断开连接，保留后台会话', 'disconnect', () => { if (displayedKey) send({ type: 'disconnect', key: displayedKey }); }),
  sidebarToggle
);
function persist() { vscode.setState({ width, expanded: [...expanded], filter: filter.value, filterOpen, sidebarCollapsed }); }
function updateSidebarVisibility() {
  sidebar.hidden = sidebarCollapsed; splitter.hidden = sidebarCollapsed;
  const label = sidebarCollapsed ? '展开会话面板' : '收起会话面板';
  sidebarToggle.title = label; sidebarToggle.setAttribute('aria-label', label);
  sidebarToggle.setAttribute('aria-expanded', String(!sidebarCollapsed));
  sidebarToggle.replaceChildren(icon(sidebarCollapsed ? 'expandSidebar' : 'collapseSidebar'));
  fitCurrent();
}
function setFilterOpen(open: boolean) {
  filterOpen = open; filterWrap.hidden = !open;
  filterToggle.setAttribute('aria-expanded', String(open));
  if (open) { filter.focus(); filter.select(); }
  else { filter.value = ''; renderTree(); filterToggle.focus(); }
  persist();
}
function fitCurrent() {
  const entry = current();
  if (!entry || entry.element.clientWidth < 10 || entry.element.clientHeight < 10) return;
  try { entry.fit.fit(); } catch { /* The view may be transitioning between visible and hidden. */ }
}
function setWidth(value: number) {
  width = Math.max(170, Math.min(value, Math.max(170, app.clientWidth * .6)));
  sidebar.style.width = `${width}px`; splitter.setAttribute('aria-valuenow', String(Math.round(width))); fitCurrent();
}
setWidth(width);
updateSidebarVisibility();
splitter.addEventListener('pointerdown', event => {
  splitter.setPointerCapture(event.pointerId); document.body.classList.add('resizing');
  const move = (event: PointerEvent) => setWidth(window.innerWidth - event.clientX);
  const end = () => { splitter.removeEventListener('pointermove', move); splitter.removeEventListener('pointerup', end); document.body.classList.remove('resizing'); persist(); };
  splitter.addEventListener('pointermove', move); splitter.addEventListener('pointerup', end);
});
splitter.addEventListener('keydown', event => {
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); setWidth(width + (event.key === 'ArrowLeft' ? 16 : -16)); persist(); }
});
new ResizeObserver(() => fitCurrent()).observe(get('.terminal-content'));
filter.value = saved?.filter || '';
filter.addEventListener('input', () => { renderTree(); persist(); });
filter.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); setFilterOpen(false); } });

function current() { return displayedKey ? terminals.get(displayedKey) : undefined; }
function theme(): ITheme {
  const style = getComputedStyle(document.body);
  const color = (name: string, fallback: string) => style.getPropertyValue(`--vscode-terminal-${name}`).trim() || fallback;
  const result: ITheme = { background: color('background', style.getPropertyValue('--vscode-panel-background').trim() || '#181818'), foreground: color('foreground', '#cccccc'), cursor: style.getPropertyValue('--vscode-terminalCursor-foreground').trim() || '#cccccc', selectionBackground: style.getPropertyValue('--vscode-terminal-selectionBackground').trim() || '#264f78' };
  const palette = ['Black', 'Red', 'Green', 'Yellow', 'Blue', 'Magenta', 'Cyan', 'White', 'BrightBlack', 'BrightRed', 'BrightGreen', 'BrightYellow', 'BrightBlue', 'BrightMagenta', 'BrightCyan', 'BrightWhite'];
  const defaults = ['#000000', '#cd3131', '#0dbc79', '#e5e510', '#2472c8', '#bc3fbc', '#11a8cd', '#e5e5e5', '#666666', '#f14c4c', '#23d18b', '#f5f543', '#3b8eea', '#d670d6', '#29b8db', '#ffffff'];
  palette.forEach((name, index) => { (result as Record<string, string>)[name[0].toLowerCase() + name.slice(1)] = color(`ansi${name}`, defaults[index]); });
  return result;
}
new MutationObserver(() => { for (const entry of terminals.values()) entry.terminal.options.theme = theme(); }).observe(document.body, { attributes: true, attributeFilter: ['class', 'data-vscode-theme-kind'] });
function ensureTerminal(info: ConnectionInfo) {
  let entry = terminals.get(info.key);
  if (entry) { entry.info = info; entry.closed = !!info.closed; entry.terminal.options.disableStdin = !!info.closed; return entry; }
  const element = document.createElement('div'); element.className = 'terminal-instance'; element.hidden = true;
  terminalHosts.append(element);
  // Unicode11Addon needs the Unicode API so emoji widths match modern backends.
  const terminal = new Terminal({ ...snapshot.appearance, cursorBlink: true, lineHeight: 1.16, theme: theme(), allowProposedApi: true, macOptionIsMeta: true, macOptionClickForcesSelection: true });
  const fit = new FitAddon(); const search = new SearchAddon();
  terminal.loadAddon(new Unicode11Addon()); terminal.unicode.activeVersion = '11';
  terminal.loadAddon(fit); terminal.loadAddon(search);
  terminal.loadAddon(new WebLinksAddon((event, url) => { event.preventDefault(); send({ type: 'openLink', url }); }));
  terminal.open(element);
  terminal.options.disableStdin = !!info.closed;
  entry = { terminal, fit, search, element, seq: 0, info, closed: !!info.closed }; terminals.set(info.key, entry);
  terminal.onData(data => { if (!entry!.closed) send({ type: 'input', key: info.key, data }); });
  terminal.onResize(({ cols, rows }) => send({ type: 'resize', key: info.key, cols, rows }));
  terminal.attachCustomKeyEventHandler(event => {
    if (event.type !== 'keydown') return true;
    const shortcut = event.metaKey || (event.ctrlKey && event.shiftKey);
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') { event.preventDefault(); openSearch(); return false; }
    if ((shortcut || (event.ctrlKey && event.key.toLowerCase() === 'c' && terminal.hasSelection())) && event.key.toLowerCase() === 'c') { event.preventDefault(); const value = terminal.getSelection(); if (value) send({ type: 'copy', text: value }); return false; }
    if (shortcut && event.key.toLowerCase() === 'v') { event.preventDefault(); send({ type: 'paste', key: info.key }); return false; }
    if (event.metaKey && event.key.toLowerCase() === 'a') { event.preventDefault(); terminal.selectAll(); return false; }
    return true;
  });
  element.addEventListener('contextmenu', event => {
    event.preventDefault();
    showMenu(event.clientX, event.clientY, [
      { label: '复制', disabled: !terminal.hasSelection(), action: () => send({ type: 'copy', text: terminal.getSelection() }) },
      { label: '粘贴', disabled: entry!.closed, action: () => send({ type: 'paste', key: info.key }) },
      { label: '全选', action: () => terminal.selectAll() }, { label: '清空终端显示', action: () => terminal.clear() }
    ]);
  });
  return entry;
}
function updateTerminal() {
  for (const info of snapshot.connections) ensureTerminal(info);
  for (const [key, entry] of terminals) if (!snapshot.connections.some(info => info.key === key)) { entry.terminal.dispose(); entry.element.remove(); terminals.delete(key); }
  displayedKey = snapshot.activeKey;
  const entry = current();
  for (const [key, terminal] of terminals) {
    terminal.element.hidden = key !== displayedKey;
  }
  get('.welcome').hidden = !!entry;
  terminalHosts.hidden = !entry;
  get('.terminal-heading').replaceChildren(icon('terminal'), text('span', entry?.info.name || 'MuxDock', 'terminal-title'));
  if (entry) get('.terminal-heading').append(text('span', entry.info.manager, 'manager-badge'));
  renderTabs();
  get('.connection-status').textContent = entry ? entry.closed ? '连接已关闭' : '已连接' : '未打开会话';
  get('.connection-status').classList.toggle('connected', !!entry && !entry.closed);
  get('.host-name').textContent = snapshot.host;
  get<HTMLButtonElement>('[aria-label="断开连接，保留后台会话"]').disabled = !entry || entry.closed;
  for (const terminal of terminals.values()) { Object.assign(terminal.terminal.options, snapshot.appearance); }
  requestAnimationFrame(fitCurrent);
}
let tabSignature = '';
function renderTabs() {
  const visible = snapshot.showTabs && snapshot.connections.length > 0;
  tabList.hidden = !visible;
  get('.terminal-heading').hidden = visible;
  const signature = JSON.stringify([visible, snapshot.activeKey, snapshot.connections]);
  if (signature === tabSignature) return;
  tabSignature = signature;
  const focused = document.hasFocus() && tabList.contains(document.activeElement) ? (document.activeElement as HTMLElement)?.closest<HTMLElement>('.terminal-tab')?.dataset.key : undefined;
  const focusedClose = focused && document.activeElement?.classList.contains('tab-close');
  const oldActive = tabList.querySelector<HTMLElement>('[aria-selected="true"]')?.dataset.key;
  const fragment = document.createDocumentFragment();
  for (const info of snapshot.connections) {
    const active = info.key === snapshot.activeKey;
    const tab = text('div', '', 'terminal-tab'); tab.dataset.key = info.key; tab.id = `tab-${info.key}`;
    tab.setAttribute('role', 'tab'); tab.setAttribute('aria-label', `${info.name} (${info.manager})`);
    tab.setAttribute('aria-selected', String(active)); tab.setAttribute('aria-controls', 'terminal-panel'); tab.tabIndex = active ? 0 : -1;
    tab.classList.toggle('closed', !!info.closed);
    tab.title = `${info.manager} · ${info.name}${info.closed ? ' · 连接已关闭' : ''}`;
    tab.append(icon('terminal'), text('span', info.name, 'tab-label'), text('span', info.manager, 'tab-manager'));
    tab.append(button(`关闭标签页 ${info.name} (${info.manager})`, 'close', () => send({ type: 'closeTab', key: info.key }), 'icon-button tab-close'));
    tab.addEventListener('click', () => send({ type: 'activate', key: info.key }));
    tab.addEventListener('auxclick', event => { if (event.button === 1) { event.preventDefault(); send({ type: 'closeTab', key: info.key }); } });
    tab.addEventListener('keydown', event => {
      if (event.target !== tab) return;
      const index = snapshot.connections.findIndex(item => item.key === info.key);
      const key = event.key;
      if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(key)) {
        focusGeneration++;
        const count = snapshot.connections.length;
        const next = key === 'Home' ? 0 : key === 'End' ? count - 1 : (index + (key === 'ArrowRight' ? 1 : count - 1)) % count;
        (tabList.children[next] as HTMLElement)?.focus({ preventScroll: true });
        send({ type: 'activate', key: snapshot.connections[next].key, focus: false });
        event.preventDefault(); event.stopPropagation();
      } else if (key === 'Enter' || key === ' ') { event.preventDefault(); send({ type: 'activate', key: info.key }); }
      else if (key === 'Delete') { event.preventDefault(); send({ type: 'closeTab', key: info.key }); }
    });
    fragment.append(tab);
  }
  tabList.replaceChildren(fragment);
  terminalHosts.id = 'terminal-panel';
  if (snapshot.activeKey) terminalHosts.setAttribute('aria-labelledby', `tab-${snapshot.activeKey}`);
  else terminalHosts.removeAttribute('aria-labelledby');
  const activeTab = tabList.querySelector<HTMLElement>('[aria-selected="true"]');
  if (focused) {
    const target = focused !== oldActive ? [...tabList.children].find(tab => (tab as HTMLElement).dataset.key === focused) as HTMLElement | undefined : activeTab;
    (focusedClose ? target?.querySelector<HTMLButtonElement>('.tab-close') || target : target)?.focus({ preventScroll: true });
  }
  if (visible && oldActive !== snapshot.activeKey) activeTab?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}
function openSearch() { get('.search-bar').hidden = false; searchInput.focus(); searchInput.select(); fitCurrent(); }
function closeSearch() { get('.search-bar').hidden = true; current()?.search.clearDecorations(); current()?.terminal.focus(); fitCurrent(); }
searchInput.addEventListener('input', () => current()?.search.findNext(searchInput.value, { incremental: true }));
searchInput.addEventListener('keydown', event => { if (event.key === 'Escape') closeSearch(); if (event.key === 'Enter') event.shiftKey ? current()?.search.findPrevious(searchInput.value) : current()?.search.findNext(searchInput.value); });
get('.search-next').addEventListener('click', () => current()?.search.findNext(searchInput.value));
get('.search-close').addEventListener('click', closeSearch);

type MenuItem = { label: string; action: () => void; danger?: boolean; disabled?: boolean };
let menu: HTMLElement | undefined;
function closeMenu() { menu?.remove(); menu = undefined; }
function showMenu(x: number, y: number, items: MenuItem[]) {
  closeMenu(); menu = document.createElement('div'); menu.className = 'context-menu'; menu.setAttribute('role', 'menu');
  for (const item of items) {
    const row = document.createElement('button'); row.setAttribute('role', 'menuitem'); row.textContent = item.label; row.disabled = !!item.disabled; row.classList.toggle('danger', !!item.danger);
    row.addEventListener('click', () => { closeMenu(); item.action(); }); menu.append(row);
  }
  document.body.append(menu);
  menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - menu.offsetWidth - 4))}px`;
  menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - menu.offsetHeight - 4))}px`;
  menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
}
document.addEventListener('pointerdown', event => { if (menu && !menu.contains(event.target as Node)) closeMenu(); });
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && menu) { closeMenu(); event.preventDefault(); }
  if (menu && ['ArrowDown', 'ArrowUp'].includes(event.key)) {
    const buttons = [...menu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]; const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    buttons[(index + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length]?.focus(); event.preventDefault();
  }
});
function toggle(id: string) { expanded.has(id) ? expanded.delete(id) : expanded.add(id); persist(); renderTree(); }
function row(id: string, level: number, label: string, image: string, expandable: boolean, activate: () => void): HTMLElement {
  const element = document.createElement('div'); element.className = `tree-row level-${level}`; element.dataset.node = id; element.tabIndex = -1;
  element.setAttribute('role', 'treeitem'); element.setAttribute('aria-level', String(level + 1)); element.setAttribute('aria-label', label);
  if (expandable) element.setAttribute('aria-expanded', String(expanded.has(id)));
  const chevron = expandable ? button('展开或折叠', 'chevron', () => toggle(id), 'chevron icon-button') : document.createElement('span');
  chevron.classList.add('chevron-space'); chevron.tabIndex = -1;
  element.append(chevron, icon(image), text('span', label, 'row-label'));
  element.addEventListener('click', activate); return element;
}
function sessionMenu(manager: ManagerInfo, session: SessionInfo): MenuItem[] {
  const connection = snapshot.connections.find(info => !info.closed && info.manager === manager.id && info.sessionId === session.id);
  return [
    { label: '连接会话', action: () => send({ type: 'attach', manager: manager.id, session: session.id }) },
    ...(connection ? [{ label: '断开此连接', action: () => send({ type: 'disconnect', key: connection.key }) }] : []),
    ...(manager.capabilities.windows ? [{ label: '新建 window', action: () => send({ type: 'window', action: 'new', manager: manager.id, session: session.id }) }] : []),
    ...(manager.capabilities.rename ? [{ label: '重命名会话', action: () => send({ type: 'rename', manager: manager.id, session: session.id }) }] : []),
    ...(manager.capabilities.kill ? [{ label: '结束会话…', danger: true, action: () => send({ type: 'kill', manager: manager.id, session: session.id }) }] : [])
  ];
}
function addMenu(element: HTMLElement, items: MenuItem[]) {
  element.append(button('会话操作', 'more', () => { const rect = element.getBoundingClientRect(); showMenu(rect.right, rect.bottom, items); }, 'icon-button row-action'));
  element.addEventListener('contextmenu', event => { event.preventDefault(); showMenu(event.clientX, event.clientY, items); });
}
function renderTree() {
  const { scrollTop, scrollLeft } = tree;
  // An iframe retains activeElement while a VS Code Quick Input has focus.
  // Restoring it unconditionally dismisses the host's input dialog.
  const hadTreeFocus = document.hasFocus() && tree.contains(document.activeElement);
  const focused = hadTreeFocus ? (document.activeElement as HTMLElement)?.closest<HTMLElement>('.tree-row')?.dataset.node : undefined;
  const needle = filter.value.trim().toLocaleLowerCase();
  const fragment = document.createDocumentFragment(); let shown = 0;
  const visibleManagers = snapshot.visibleManagers.flatMap(id => snapshot.managers.filter(manager => manager.id === id));
  for (const manager of visibleManagers) {
    if (!manager.available && !snapshot.showUnavailable) continue;
    const managerMatches = manager.name.toLocaleLowerCase().includes(needle);
    const sessions = manager.sessions.filter(session => managerMatches || session.name.toLocaleLowerCase().includes(needle) || session.windows?.some(window => window.name.toLocaleLowerCase().includes(needle)));
    if (needle && !managerMatches && !sessions.length) continue;
    shown++;
    const managerRow = row(manager.id, 0, manager.name, 'layers', manager.available, () => manager.available && toggle(manager.id));
    managerRow.classList.add('manager-row');
    managerRow.title = manager.version || '未安装 · 可在设置中指定路径';
    if (!manager.available) { managerRow.classList.add('unavailable'); managerRow.append(text('span', '未安装', 'count')); }
    else {
      managerRow.append(text('span', String(manager.sessions.length), 'count'));
      managerRow.append(button('新建会话', 'plus', () => send({ type: 'newSession', manager: manager.id }), 'icon-button row-action'));
    }
    fragment.append(managerRow);
    if (!manager.available || (!expanded.has(manager.id) && !needle)) continue;
    if (manager.error) { const error = text('div', manager.error, 'manager-error'); error.title = manager.error; fragment.append(error); }
    for (const session of sessions) {
      const node = `${manager.id}/${session.id}`;
      const connection = snapshot.connections.find(info => !info.closed && info.manager === manager.id && info.sessionId === session.id);
      const active = !!connection && connection.key === snapshot.activeKey;
      const sessionRow = row(node, 1, session.name, 'terminal', manager.capabilities.windows, () => send({ type: 'attach', manager: manager.id, session: session.id }));
      sessionRow.classList.toggle('selected', active); sessionRow.classList.toggle('is-connected', !!connection);
      sessionRow.setAttribute('aria-selected', String(active)); sessionRow.title = session.detail || `${session.name}${session.attached ? ' · 有客户端连接' : ''}`;
      if (connection) sessionRow.append(text('span', '●', 'connection-dot'));
      else if (session.attached) sessionRow.append(text('span', '○', 'other-client'));
      addMenu(sessionRow, sessionMenu(manager, session)); fragment.append(sessionRow);
      if (manager.capabilities.windows && (expanded.has(node) || needle)) {
        for (const window of session.windows || []) {
          if (needle && !managerMatches && !session.name.toLocaleLowerCase().includes(needle) && !window.name.toLocaleLowerCase().includes(needle)) continue;
          const action = (action: string) => send({ type: 'window', action, manager: manager.id, session: session.id, window: window.id });
          const windowRow = row(`${node}/${window.id}`, 2, `${window.index}: ${window.name}`, 'window', false, () => action('select'));
          windowRow.classList.toggle('active-window', window.active); windowRow.title = `${window.panes} 个 pane${window.active ? ' · 当前 window' : ''}`;
          windowRow.setAttribute('aria-current', window.active ? 'true' : 'false');
          addMenu(windowRow, [{ label: '切换到此 window', action: () => action('select') }, { label: '重命名 window', action: () => action('rename') }, { label: '关闭 window…', danger: true, action: () => action('kill') }]);
          fragment.append(windowRow);
        }
      }
    }
    if (!sessions.length && !manager.error) {
      const empty = text('button', '＋ 新建会话', 'empty-manager'); empty.addEventListener('click', () => send({ type: 'newSession', manager: manager.id })); fragment.append(empty);
    }
  }
  if (!shown) fragment.append(text('div', needle ? '没有匹配的会话' : !snapshot.visibleManagers.length ? '未选择显示的管理器。\n请在 MuxDock 设置中选择。' : '未发现所选终端管理器。\n安装后点击刷新，或在设置中指定路径。', 'tree-empty'));
  tree.replaceChildren(fragment);
  const rows = [...tree.querySelectorAll<HTMLElement>('.tree-row')];
  const focusRow = rows.find(row => row.dataset.node === focused) || rows.find(row => row.classList.contains('selected')) || rows[0];
  if (focusRow) { focusRow.tabIndex = 0; if (focused) focusRow.focus({ preventScroll: true }); }
  // Keep scrolling independent of row replacement and focus restoration.
  tree.scrollTop = scrollTop; tree.scrollLeft = scrollLeft;
  const available = visibleManagers.filter(manager => manager.available).length;
  get('.sidebar-footer').textContent = `${available} 个可用管理器`;
}
tree.addEventListener('keydown', event => {
  if (!(event.target instanceof HTMLElement) || !event.target.classList.contains('tree-row')) return;
  const rows = [...tree.querySelectorAll<HTMLElement>('.tree-row')]; const row = event.target; const index = rows.indexOf(row); const id = row.dataset.node!;
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)));
    row.tabIndex = -1; rows[next].tabIndex = 0; rows[next].focus(); event.preventDefault();
  }
  if (event.key === 'ArrowRight' && row.hasAttribute('aria-expanded') && !expanded.has(id)) { toggle(id); event.preventDefault(); }
  if (event.key === 'ArrowLeft') { if (expanded.has(id)) toggle(id); else rows.slice(0, index).reverse().find(parent => Number(parent.getAttribute('aria-level')) < Number(row.getAttribute('aria-level')))?.focus(); event.preventDefault(); }
  if (event.key === 'Enter' || event.key === ' ') { row.click(); event.preventDefault(); }
});
window.addEventListener('message', event => {
  const message = event.data;
  if (message.type === 'snapshot') {
    snapshot = message.state;
    const connection = snapshot.connections.find(info => info.key === snapshot.activeKey);
    const target = connection && `${connection.key}/${connection.sessionId}`;
    if (target && target !== lastActiveTarget) {
      if (connection) { expanded.add(connection.manager); expanded.add(`${connection.manager}/${connection.sessionId}`); }
    }
    lastActiveTarget = target; updateTerminal(); renderTree();
  } else if (message.type === 'output') {
    const entry = terminals.get(message.key);
    if (!entry) return;
    if (message.replay) { entry.terminal.reset(); entry.seq = 0; }
    if (!message.replay && message.seq <= entry.seq) return;
    entry.seq = message.seq; entry.terminal.write(message.data, () => send({ type: 'ack', key: message.key, seq: message.seq }));
  } else if (message.type === 'focus' && message.key === snapshot.activeKey) {
    const generation = ++focusGeneration;
    requestAnimationFrame(() => { if (generation === focusGeneration && message.key === snapshot.activeKey) current()?.terminal.focus(); });
  }
  else if (message.type === 'visible') requestAnimationFrame(fitCurrent);
  else if (message.type === 'paste') terminals.get(message.key)?.terminal.paste(message.text);
  else if (message.type === 'refreshing') get('[aria-label="刷新"]').classList.toggle('spinning', message.value);
  else if (message.type === 'error') get('.connection-status').textContent = message.message;
});
send({ type: 'ready' });
