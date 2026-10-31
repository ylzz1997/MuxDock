import { t, getLocale, setLocale, catalogs, type MessageKey } from '../src/i18n';
import { bind, localize } from './i18n';
import { Terminal, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { PowerlineAddon } from './powerline';
import '@xterm/xterm/css/xterm.css';
import './style.css';
import { MANAGER_IDS, type ConnectionInfo, type ManagerInfo, type SessionDetails, type SessionInfo, type Snapshot, type WindowInfo } from '../src/model';
import { decodeTerminalClipboard } from '../src/clipboard';
import { TerminalLinks } from './links';
import { attachTerminalDrop } from './drop';
import { TerminalSearch, SEARCH_MATCH_LIMIT, type SearchFlags } from './search';
import type { BatchAction, SessionTarget } from '../src/batch-sessions';
import { createHost, nativeTerminal } from './host';

setLocale(document.documentElement.lang);

interface Saved { width: number; expanded: string[]; filter?: string; filterOpen?: boolean; sidebarCollapsed?: boolean; searchOptions?: SearchFlags }
const vscode = createHost<Saved>();
const send = (message: unknown) => vscode.postMessage(nativeTerminal && message && typeof message === 'object' ? { hostId: snapshot.selectedHost || 'local', ...message } : message);
const saved = vscode.getState();
const expanded = new Set(saved?.expanded || MANAGER_IDS);
let width = saved?.width || 258;
let sidebarCollapsed = !nativeTerminal && saved?.sidebarCollapsed === true;
let snapshot: Snapshot = { locale: getLocale(), managers: [], connections: [], host: '', showUnavailable: false, visibleManagers: [...MANAGER_IDS], showTabs: true, maxTabs: 8, appearance: { fontSize: 12, fontFamily: 'Menlo, Monaco, monospace', scrollback: 10000, minimumContrastRatio: 4.5 }, launchProfiles: [], selectedLaunchProfile: 'system' };
let displayedKey: string | undefined;
let lastActiveTarget: string | undefined;
let focusGeneration = 0;
let batchMode = false;
let batchRequest = 0;
let batchPending = false;
const selectedSessions = new Set<string>();
const terminals = new Map<string, { terminal: Terminal; fit: FitAddon; search: SearchAddon; links: TerminalLinks; element: HTMLElement; seq: number; info: ConnectionInfo; closed: boolean; replaying: boolean }>();
const paths: Record<string, string> = {
  terminal: '<path d="m4 5 4 3-4 3m6 1h3"/>', plus: '<path d="M8 3v10M3 8h10"/>',
  refresh: '<path d="M13 6a5 5 0 1 0 .1 4M13 2v4H9"/>', chevron: '<path d="m6 4 4 4-4 4"/>',
  search: '<circle cx="7" cy="7" r="4"/><path d="m10 10 4 4"/>', close: '<path d="m4 4 8 8M12 4l-8 8"/>',
  more: '<circle cx="3" cy="8" r=".7"/><circle cx="8" cy="8" r=".7"/><circle cx="13" cy="8" r=".7"/>',
  copy: '<rect x="5" y="5" width="8" height="9" rx="1"/><path d="M10 5V2H2v9h3"/>',
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
  if (label === 'copySelection') element.dataset.copySelection = '';
  if (Object.hasOwn(catalogs.en, label)) { bind(element, label as MessageKey, 'title'); bind(element, label as MessageKey, 'aria-label'); }
  element.append(icon(image)); element.addEventListener('click', event => { event.stopPropagation(); action(); });
  return element;
}
function text(tag: string, value: string, className = ''): HTMLElement {
  const element = document.createElement(tag); element.textContent = value; element.className = className; return element;
}
const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = `<main class="dock">
<section class="terminal-area" data-i18n-aria-label="terminal">
  <header class="terminal-header"><div class="terminal-heading"></div><div class="terminal-tabs" role="tablist" data-i18n-aria-label="openTerminals" hidden></div><div class="terminal-actions"></div></header>
  <div class="terminal-content"><div class="welcome"><div class="welcome-symbol"></div><h1 data-i18n="chooseSession"></h1><p data-i18n="welcome"></p><button class="primary new-session" data-i18n="newSession"></button><span class="welcome-note" data-i18n="keepRunning"></span></div><div class="terminal-hosts" role="tabpanel" data-i18n-aria-label="terminalContent"></div></div>
  <footer class="terminal-footer"><span class="connection-status" data-i18n="noSession"></span><span class="drop-hint" data-i18n-title="dropHelp" data-i18n="dropHint"></span><span class="host-name"></span></footer>
</section>
<div class="splitter" role="separator" data-i18n-aria-label="resizeTree" aria-orientation="vertical" tabindex="0"></div>
<aside class="sidebar" id="session-sidebar" data-i18n-aria-label="managersAndSessions"><header class="sidebar-header"><div class="sidebar-heading"><span class="sidebar-title" data-i18n="sessions"></span></div><div class="sidebar-actions"></div></header><div class="filter-wrap" id="session-filter" hidden><input class="filter" data-i18n-aria-label="filterSessions" data-i18n-placeholder="filterPlaceholder" spellcheck="false"></div><div class="tree" role="tree" data-i18n-aria-label="terminalManagers"></div><div class="batch-toolbar" role="group" data-i18n-aria-label="batchActions" hidden><div class="batch-selection"><label class="batch-select-all"><input type="checkbox" data-i18n-aria-label="selectVisible"><span data-i18n="selectAll"></span></label><span class="batch-count" role="status"></span></div><div class="batch-actions"></div><div class="batch-note"></div></div><footer class="sidebar-footer"></footer></aside>
</main>`;
localize();
const get = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const tree = get('.tree');
const terminalHosts = get('.terminal-hosts');
// Include the header, footer and padding, rather than only xterm's inner box.
const clearTerminalDrop = attachTerminalDrop(get('.terminal-area'), () => {
  const entry = current();
  return entry && !entry.closed ? entry.terminal : undefined;
}, paths => send({ type: 'dropPaths', key: snapshot.activeKey, paths }));
const filter = get<HTMLInputElement>('.filter');
const searchWidget = new TerminalSearch(get('.terminal-content'), saved?.searchOptions, () => persist(), () => {
  if (current()) current()!.terminal.focus(); else get('.terminal-actions .icon-search').closest<HTMLButtonElement>('button')!.focus();
});
const sidebar = get('.sidebar');
const hostBar = document.createElement('div'); hostBar.className = 'host-bar';
const hostButton = button('switchHost', 'terminal', () => {
  if (menu?.classList.contains('host-menu')) { closeMenu(); return; }
  showHostMenu(); send({ type: 'refreshHosts' });
}, 'host-button');
function showHostMenu() {
  const rect = hostButton.getBoundingClientRect();
  showMenu(rect.left, rect.bottom + 4, [
    ...(snapshot.hosts || []).map(host => ({ id: host.id, label: host.label, tooltip: host.source ? `${host.label}\n${host.source}` : host.label, checked: host.id === snapshot.selectedHost, action: () => send({ type: 'selectHost', id: host.id }),
      ...(host.removable ?? host.id !== 'local' ? { removeLabel: t('removeSshHost'), remove: () => send({ type: 'removeSshHost', id: host.id }) } : {}) })),
    { label: t('addSshHost'), image: 'plus', separator: true, action: () => send({ type: 'addSshHost' }) },
    ...(snapshot.selectedHost && snapshot.selectedHost !== 'local' ? [{ label: t('sshLogin'), image: 'terminal', action: () => send({ type: 'sshLogin' }) }] : [])
  ]);
  menu!.classList.add('host-menu'); hostButton.setAttribute('aria-expanded', 'true');
}
hostButton.setAttribute('aria-haspopup', 'menu');
const hostError = document.createElement('div'); hostError.className = 'host-error'; hostError.hidden = true;
const hostErrorText = text('p', '');
const hostLogin = button('sshLogin', 'terminal', () => send({ type: 'sshLogin' }), 'host-login');
hostError.append(hostErrorText, hostLogin); hostBar.append(hostButton, hostError);
if (nativeTerminal) get('.sidebar-header').after(hostBar);
function updateHost() {
  if (!nativeTerminal) return;
  const label = snapshot.hosts?.find(host => host.id === snapshot.selectedHost)?.label || t('localHost');
  hostButton.replaceChildren(icon('terminal'), text('span', label, 'host-name-label'), icon('chevron'));
  hostButton.title = `${t('switchHost')} · ${label}`;
  hostButton.setAttribute('aria-label', `${t('switchHost')} · ${label}`);
  hostError.hidden = !snapshot.hostError; hostErrorText.textContent = snapshot.hostError || '';
  hostLogin.replaceChildren(text('span', t('sshLogin')));
}
const splitter = get('.splitter');
const tabList = get('.terminal-tabs');
const batchToolbar = get('.batch-toolbar');
const selectAll = get<HTMLInputElement>('.batch-select-all input');
const batchDisconnect = button('batchDisconnect', 'terminal', () => submitBatch('disconnect'), 'batch-button');
const batchDisconnectLabel = text('span', ''); bind(batchDisconnectLabel, 'batchDisconnect'); batchDisconnect.replaceChildren(batchDisconnectLabel);
bind(batchDisconnect, 'batchDisconnectHelp', 'title');
const batchKill = button('batchKill', 'close', () => submitBatch('kill'), 'batch-button danger');
const batchKillLabel = text('span', ''); bind(batchKillLabel, 'batchKillMenu'); batchKill.replaceChildren(batchKillLabel);
const batchExit = button('exitBatch', 'close', () => setBatchMode(false));
get('.batch-selection').append(batchExit);
get('.batch-actions').append(batchDisconnect, batchKill);
selectAll.addEventListener('change', () => {
  for (const checkbox of tree.querySelectorAll<HTMLInputElement>('.session-checkbox')) {
    const node = checkbox.closest<HTMLElement>('.tree-row')!.dataset.node!;
    if (selectAll.checked) selectedSessions.add(node); else selectedSessions.delete(node);
  }
  renderTree();
});
tabList.addEventListener('wheel', event => {
  if (!event.ctrlKey && tabList.scrollWidth > tabList.clientWidth && Math.abs(event.deltaY) > Math.abs(event.deltaX)) { tabList.scrollLeft += event.deltaY; event.preventDefault(); }
}, { passive: false });
const filterWrap = get('.filter-wrap');
let filterOpen = saved?.filterOpen ?? !!saved?.filter;
const filterToggle = button('filterSessions', 'search', () => setFilterOpen(!filterOpen));
filterToggle.setAttribute('aria-controls', 'session-filter');
get('.sidebar-heading').append(filterToggle);
filterWrap.hidden = !filterOpen;
filterToggle.setAttribute('aria-expanded', String(filterOpen));
get('.welcome-symbol').append(icon('terminal'));
get('.new-session').addEventListener('click', () => send({ type: 'newSession' }));
get('.sidebar-actions').append(
  button('newSession', 'plus', () => send({ type: 'newSession' })),
  button('refresh', 'refresh', () => send({ type: 'refresh' })),
  button('moreActions', 'more', () => showMenu(get('.sidebar-actions').getBoundingClientRect().right, 32, [
    { label: batchMode ? t('exitBatch') : t('batchActions'), disabled: batchPending, action: () => setBatchMode(!batchMode) },
    { label: snapshot.showUnavailable ? t('hideUnavailable') : t('showUnavailable'), action: () => send({ type: 'showUnavailable', value: !snapshot.showUnavailable }) },
    ...(!nativeTerminal ? [{ label: t('fontSettings'), action: () => send({ type: 'settings', fontsOnly: true }) }] : []),
    { label: t('language'), action: () => send({ type: 'language' }) },
    { label: t('settings'), action: () => send({ type: 'settings' }) }
  ]))
);
const sidebarToggle = button('collapseSidebar', 'collapseSidebar', () => {
  sidebarCollapsed = !sidebarCollapsed;
  closeMenu(); updateSidebarVisibility(); persist();
  sidebarToggle.focus();
}, 'icon-button sidebar-toggle');
sidebarToggle.setAttribute('aria-controls', 'session-sidebar');
const launchButton = button('chooseLaunch', 'terminal', () => {
  if (menu?.classList.contains('launch-menu')) { closeMenu(); return; }
  const rect = launchButton.getBoundingClientRect();
  showMenu(rect.left, rect.bottom, [
    ...snapshot.launchProfiles.map(profile => ({
      label: profile.name, detail: profile.detail, checked: profile.id === snapshot.selectedLaunchProfile, id: profile.id,
      action: () => send({ type: 'selectLaunchProfile', id: profile.id }),
      ...(profile.kind === 'command' ? { remove: () => send({ type: 'removeLaunchCommand', id: profile.id }) } : {})
    })),
    { label: t('addCommand'), image: 'plus', separator: true, action: () => send({ type: 'addLaunchCommand' }) }
  ]);
  menu!.classList.add('launch-menu'); menu!.setAttribute('aria-label', t('launchProfile'));
  positionLaunchMenu();
  const selected = menu!.querySelector<HTMLElement>('[aria-checked="true"]');
  if (selected) menu!.scrollTop = Math.max(0, selected.offsetTop - menu!.clientHeight / 2 + selected.offsetHeight / 2);
  launchButton.setAttribute('aria-expanded', 'true');
}, 'launch-button');
launchButton.setAttribute('aria-haspopup', 'menu'); launchButton.setAttribute('aria-expanded', 'false');
get('.terminal-actions').append(
  button('searchTerminal', 'search', () => openSearch()),
  button('copySelection', 'copy', () => { const value = current()?.terminal.getSelection(); if (value) send({ type: 'copy', text: value }); }),
  launchButton,
  sidebarToggle
);
if (nativeTerminal) { document.body.classList.add('iterm2'); get('.sidebar-footer').before(launchButton); }
function persist() { vscode.setState({ width, expanded: [...expanded], filter: filter.value, filterOpen, sidebarCollapsed, searchOptions: searchWidget.options }); }
function updateSidebarVisibility() {
  sidebar.hidden = sidebarCollapsed; splitter.hidden = sidebarCollapsed;
  const label = sidebarCollapsed ? t('expandSidebar') : t('collapseSidebar');
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
function setBatchMode(enabled: boolean) {
  if (batchPending) return;
  batchMode = enabled; selectedSessions.clear();
  renderTree();
  if (enabled) tree.querySelector<HTMLElement>('.tree-row.level-1')?.focus();
  else get('.sidebar-actions .icon-more').closest<HTMLButtonElement>('button')!.focus();
}
function selectedTargets(): SessionTarget[] {
  return snapshot.managers.flatMap(manager => manager.sessions.filter(session => selectedSessions.has(`${manager.id}/${session.id}`)).map(session => ({ manager: manager.id, session: session.id })));
}
function updateBatchToolbar() {
  batchToolbar.hidden = !batchMode;
  tree.setAttribute('aria-multiselectable', String(batchMode));
  const targets = selectedTargets();
  const visible = [...tree.querySelectorAll<HTMLInputElement>('.session-checkbox')];
  const checked = visible.filter(checkbox => checkbox.checked).length;
  selectAll.checked = visible.length > 0 && checked === visible.length;
  selectAll.indeterminate = checked > 0 && checked < visible.length;
  selectAll.disabled = batchPending || !visible.length;
  batchExit.disabled = batchPending;
  get('.batch-count').textContent = batchPending ? t('processing') : t('selectedCount', { count: targets.length });
  const supports = (capability: 'kill' | 'detachAll') => targets.every(target => snapshot.managers.find(manager => manager.id === target.manager)?.capabilities[capability]);
  batchDisconnect.disabled = batchPending || !targets.length || !supports('detachAll');
  batchKill.disabled = batchPending || !targets.length || !supports('kill');
  const note = get('.batch-note');
  note.hidden = !targets.length || supports('kill');
  note.textContent = note.hidden ? '' : t('batchUnsupported');
}
function toggleSessionSelection(node: string) {
  if (batchPending) return;
  if (selectedSessions.has(node)) selectedSessions.delete(node); else selectedSessions.add(node);
  renderTree();
}
function submitBatch(action: BatchAction) {
  const targets = selectedTargets();
  if (batchPending || !targets.length) return;
  batchPending = true; ++batchRequest;
  renderTree();
  send({ type: 'batchSessions', action, targets, request: batchRequest });
}
function fitCurrent() {
  const entry = current();
  if (!entry || entry.element.clientWidth < 10 || entry.element.clientHeight < 10) return;
  // Keep the grid's origin fixed as fitting adds or removes complete rows and columns.
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
function appearance() {
  // The DOM renderer needs a font for Powerline's private-use characters.
  // Keep user fonts first, and supply the bundled symbols when they lack them.
  return { ...snapshot.appearance, fontFamily: `${snapshot.appearance.fontFamily}, "MuxDock Powerline"` };
}
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
  const terminal = new Terminal({ ...appearance(), cursorBlink: true, lineHeight: 1.16, theme: theme(), allowProposedApi: true, macOptionIsMeta: true, macOptionClickForcesSelection: true });
  const fit = new FitAddon(); const search = new SearchAddon({ highlightLimit: SEARCH_MATCH_LIMIT });
  terminal.loadAddon(new Unicode11Addon()); terminal.unicode.activeVersion = '11';
  terminal.loadAddon(fit); terminal.loadAddon(search);
  terminal.open(element);
  terminal.loadAddon(new PowerlineAddon());
  const links = new TerminalLinks(terminal, element, info.key, send);
  terminal.options.linkHandler = links.handler;
  terminal.options.disableStdin = !!info.closed;
  entry = { terminal, fit, search, links, element, seq: 0, info, closed: !!info.closed, replaying: false }; terminals.set(info.key, entry);
  searchWidget.register(info.key, terminal, search);
  terminal.parser.registerOscHandler(7, url => { send({ type: 'terminalCwd', key: info.key, url }); return true; });
  terminal.parser.registerOscHandler(52, data => {
    if (info.key === displayedKey && !entry!.closed && !entry!.replaying) {
      const value = decodeTerminalClipboard(data);
      if (value !== undefined) send({ type: 'terminalCopy', key: info.key, text: value });
    }
    return true;
  });
  terminal.onData(data => { if (!entry!.closed) send({ type: 'input', key: info.key, data }); });
  terminal.onResize(({ cols, rows }) => send({ type: 'resize', key: info.key, cols, rows }));
  terminal.attachCustomKeyEventHandler(event => {
    if (event.type !== 'keydown') return true;
    const consume = (action: () => void) => { event.preventDefault(); event.stopPropagation(); action(); return false; };
    if (searchWidget.handleKey(event)) return false;
    const shortcut = event.metaKey || (event.ctrlKey && event.shiftKey);
    if ((shortcut || (event.ctrlKey && event.key.toLowerCase() === 'c' && terminal.hasSelection())) && event.key.toLowerCase() === 'c') return consume(() => { const value = terminal.getSelection(); if (value) send({ type: 'copy', text: value }); });
    if (shortcut && event.key.toLowerCase() === 'v') return consume(() => send({ type: 'paste', key: info.key }));
    if (event.metaKey && event.key.toLowerCase() === 'a') return consume(() => terminal.selectAll());
    return true;
  });
  element.addEventListener('contextmenu', event => {
    event.preventDefault();
    const target = links.target(); links.hide();
    showMenu(event.clientX, event.clientY, [
      ...(target ? [{ label: t('openLink'), action: () => links.open(target) }, { label: t('copyLink'), action: () => send({ type: 'copy', text: target }) }] : []),
      { label: t('copy'), disabled: !terminal.hasSelection(), action: () => send({ type: 'copy', text: terminal.getSelection() }) },
      { label: t('paste'), disabled: entry!.closed, action: () => send({ type: 'paste', key: info.key }) },
      { label: t('selectAll'), action: () => terminal.selectAll() }, { label: t('clearTerminal'), action: () => terminal.clear() },
      { label: t('fontSettings'), separator: true, action: () => send({ type: 'settings', fontsOnly: true }) }
    ]);
  });
  return entry;
}
function updateTerminal() {
  if (nativeTerminal) {
    const profile = snapshot.launchProfiles.find(profile => profile.id === snapshot.selectedLaunchProfile);
    launchButton.replaceChildren(icon('terminal'), text('span', profile?.name || 'shell', 'launch-name'));
    launchButton.title = t('launchDefault', { name: profile?.name || 'shell', detail: profile?.detail || '' });
    launchButton.dataset.profile = snapshot.selectedLaunchProfile;
    return;
  }
  for (const info of snapshot.connections) ensureTerminal(info);
  for (const [key, entry] of terminals) if (!snapshot.connections.some(info => info.key === key)) { searchWidget.unregister(key); entry.links.dispose(); entry.terminal.dispose(); entry.element.remove(); terminals.delete(key); }
  displayedKey = snapshot.activeKey;
  searchWidget.setActive(displayedKey);
  const entry = current();
  for (const [key, terminal] of terminals) {
    terminal.element.hidden = key !== displayedKey;
    terminal.links.setActive(key === displayedKey);
  }
  get('.welcome').hidden = !!entry;
  terminalHosts.hidden = !entry;
  if (!entry || entry.closed) clearTerminalDrop();
  get('.terminal-heading').replaceChildren(icon('terminal'), text('span', entry?.info.name || 'MuxDock', 'terminal-title'));
  if (entry) get('.terminal-heading').append(text('span', entry.info.manager, 'manager-badge'));
  renderTabs();
  get('.connection-status').textContent = entry ? entry.closed ? t('closed') : t('connected') : t('noSession');
  get('.connection-status').classList.toggle('connected', !!entry && !entry.closed);
  get('.connection-status').classList.toggle('closed', !!entry && entry.closed);
  get('.host-name').textContent = snapshot.host;
  const profile = snapshot.launchProfiles.find(profile => profile.id === snapshot.selectedLaunchProfile);
  if (launchButton.dataset.profile !== snapshot.selectedLaunchProfile || launchButton.querySelector('.launch-name')?.textContent !== (profile?.name || 'shell')) launchButton.replaceChildren(icon('terminal'), text('span', profile?.name || 'shell', 'launch-name'));
  launchButton.title = t('launchDefault', { name: profile?.name || 'shell', detail: profile?.detail || '' });
  launchButton.dataset.profile = snapshot.selectedLaunchProfile;
  for (const terminal of terminals.values()) { Object.assign(terminal.terminal.options, appearance()); }
  requestAnimationFrame(fitCurrent);
}
let tabSignature = '';
function renderTabs() {
  const visible = snapshot.showTabs && snapshot.connections.length > 0;
  tabList.hidden = !visible;
  get('.terminal-heading').hidden = visible;
  const signature = JSON.stringify([getLocale(), visible, snapshot.activeKey, snapshot.connections]);
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
    tab.title = `${info.manager} · ${info.name}${info.closed ? ` · ${t('closed')}` : ''}`;
    tab.append(icon('terminal'), text('span', info.name, 'tab-label'), text('span', info.manager, 'tab-manager'));
    tab.append(button(t('closeTab', { name: info.name, manager: info.manager }), 'close', () => send({ type: 'closeTab', key: info.key }), 'icon-button tab-close'));
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
function openSearch() { searchWidget.open(); }

let detailsRequest = 0;
let detailsTarget: { manager: string; session: string; window?: string } | undefined;
let detailsText = '';
let detailsFocus: string | undefined;
const detailsDialog = document.createElement('dialog');
detailsDialog.className = 'session-details'; detailsDialog.setAttribute('aria-labelledby', 'session-details-title');
const detailsHeader = text('header', '', 'details-header');
const detailsTitle = text('h2', t('sessionDetails')); detailsTitle.id = 'session-details-title';
const detailsRefresh = button('refreshDetails', 'refresh', () => requestDetails());
const detailsCopy = button('copyDetails', 'copy', () => send({ type: 'copy', text: detailsText }));
const detailsClose = button('closeDetails', 'close', () => detailsDialog.close());
detailsHeader.append(detailsTitle, detailsRefresh, detailsCopy, detailsClose);
const detailsBody = text('div', '', 'details-body'); detailsBody.setAttribute('aria-live', 'polite');
detailsDialog.append(detailsHeader, detailsBody); document.body.append(detailsDialog);
detailsDialog.addEventListener('close', () => {
  detailsTarget = undefined; detailsRequest++;
  if (detailsFocus) tree.querySelector<HTMLElement>(`[data-node="${CSS.escape(detailsFocus)}"]`)?.focus({ preventScroll: true });
});
detailsDialog.addEventListener('click', event => {
  const box = detailsDialog.getBoundingClientRect();
  if (event.target === detailsDialog && (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom)) detailsDialog.close();
});
function requestDetails() {
  if (!detailsTarget) return;
  detailsCopy.disabled = true; detailsRefresh.disabled = true; detailsText = '';
  detailsBody.replaceChildren(text('p', t('loadingDetails'), 'details-note'));
  send({ type: 'details', request: ++detailsRequest, ...detailsTarget });
}
function showDetails(manager: ManagerInfo, session: SessionInfo, window?: WindowInfo) {
  detailsFocus = `${manager.id}/${session.id}${window ? `/${window.id}` : ''}`;
  detailsTarget = { manager: manager.id, session: session.id, ...(window ? { window: window.id } : {}) };
  detailsTitle.textContent = window ? t('windowDetails') : t('sessionDetails');
  requestDetails(); detailsDialog.showModal(); detailsClose.focus();
}
function renderDetails(details: SessionDetails) {
  detailsTitle.textContent = details.title;
  const fragment = document.createDocumentFragment();
  const copied = [details.title];
  for (const section of details.sections) {
    if (section.title) { fragment.append(text('h3', section.title)); copied.push(`\n${section.title}`); }
    const list = document.createElement('dl');
    for (const field of section.fields) {
      let value = field.value === undefined || field.value === '' ? t('notProvided') : String(field.value);
      if (field.kind === 'timestamp' && /^\d{4}-\d\d-\d\dT/.test(value)) value = new Date(value).toLocaleString(getLocale(), { timeZoneName: 'short' });
      list.append(text('dt', t(field.label)), text('dd', value, value === t('notProvided') ? 'unavailable-value' : ''));
      copied.push(`${t(field.label)}: ${value}`);
    }
    fragment.append(list);
  }
  if (details.note) { fragment.append(text('p', details.note, 'details-note')); copied.push(`\n${details.note}`); }
  detailsBody.replaceChildren(fragment); detailsText = copied.join('\n'); detailsCopy.disabled = false;
}

type MenuItem = { label: string; action: () => void; danger?: boolean; disabled?: boolean; checked?: boolean; detail?: string; id?: string; image?: string; separator?: boolean; remove?: () => void; removeLabel?: string; tooltip?: string };
let menu: HTMLElement | undefined;
function closeMenu() { menu?.remove(); menu = undefined; launchButton.setAttribute('aria-expanded', 'false'); hostButton.setAttribute('aria-expanded', 'false'); }
function positionMenu(x: number, y: number) {
  if (!menu) return;
  menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - menu.offsetWidth - 4))}px`;
  menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - menu.offsetHeight - 4))}px`;
}
function positionLaunchMenu() {
  if (!menu?.classList.contains('launch-menu')) return;
  const rect = launchButton.getBoundingClientRect();
  // The editor launcher is in the header; the native sidebar launcher is at
  // the bottom. Reserve space on the side that can actually fit the list.
  const above = rect.top - 8, below = window.innerHeight - rect.bottom - 8;
  const openAbove = above > below;
  menu.style.maxHeight = `${Math.max(20, openAbove ? above : below)}px`;
  positionMenu(rect.left, openAbove ? rect.top - menu.offsetHeight - 4 : rect.bottom + 4);
}
window.addEventListener('resize', () => {
  positionLaunchMenu();
  if (menu?.classList.contains('host-menu')) { const rect = hostButton.getBoundingClientRect(); positionMenu(rect.left, rect.bottom + 4); }
  if (menu?.classList.contains('launch-menu') && menu.contains(document.activeElement)) {
    (document.activeElement as HTMLElement).scrollIntoView({ block: 'nearest' });
  }
});
function showMenu(x: number, y: number, items: MenuItem[]) {
  closeMenu(); menu = document.createElement('div'); menu.className = 'context-menu'; menu.setAttribute('role', 'menu');
  for (const item of items) {
    if (item.separator) { const separator = text('div', '', 'menu-separator'); separator.setAttribute('role', 'separator'); menu.append(separator); }
    const wrapper = text('div', '', 'menu-row');
    const row = document.createElement('button'); row.className = 'menu-item'; row.setAttribute('role', item.checked === undefined ? 'menuitem' : 'menuitemradio'); row.setAttribute('aria-label', item.label);
    row.title = item.tooltip || item.label;
    if (item.checked !== undefined) { row.setAttribute('aria-checked', String(item.checked)); const check = icon('check'); check.classList.add('menu-check'); row.append(check); }
    else if (item.image) row.append(icon(item.image));
    if (item.id) row.dataset.profile = item.id;
    const label = text('span', '', 'menu-label'); label.append(text('span', item.label)); if (item.detail) label.append(text('span', item.detail, 'menu-detail')); row.append(label);
    row.disabled = !!item.disabled; row.classList.toggle('danger', !!item.danger);
    row.addEventListener('click', () => { closeMenu(); item.action(); }); wrapper.append(row);
    if (item.remove) {
      wrapper.append(button(item.removeLabel || t('removeCommand', { name: item.label }), 'close', () => { closeMenu(); item.remove!(); }, 'menu-remove icon-button'));
      row.addEventListener('keydown', event => { if (event.key === 'Delete') { event.preventDefault(); event.stopPropagation(); closeMenu(); item.remove!(); } });
    }
    menu.append(wrapper);
  }
  document.body.append(menu);
  positionMenu(x, y);
  const selected = menu.querySelector<HTMLButtonElement>('[aria-checked="true"]') || menu.querySelector<HTMLButtonElement>('.menu-item:not(:disabled)');
  selected?.focus({ preventScroll: true });
  if (selected) menu.scrollTop = Math.max(0, selected.offsetTop - menu.clientHeight / 2 + selected.offsetHeight / 2);
}
document.addEventListener('pointerdown', event => { if (menu && !menu.contains(event.target as Node) && !(menu.classList.contains('launch-menu') && launchButton.contains(event.target as Node)) && !(menu.classList.contains('host-menu') && hostButton.contains(event.target as Node))) closeMenu(); });
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && menu) { const trigger = menu.classList.contains('launch-menu') ? launchButton : menu.classList.contains('host-menu') ? hostButton : undefined; closeMenu(); trigger?.focus({ preventScroll: true }); event.preventDefault(); }
  else if (event.key === 'Escape' && batchMode && !batchPending && sidebar.contains(event.target as Node) && !event.defaultPrevented) { setBatchMode(false); event.preventDefault(); }
  if (menu && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
    const buttons = [...menu.querySelectorAll<HTMLButtonElement>('.menu-item:not(:disabled)')]; const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length;
    buttons[next]?.focus(); event.preventDefault();
  }
});
function toggle(id: string) { expanded.has(id) ? expanded.delete(id) : expanded.add(id); persist(); renderTree(); }
function row(id: string, level: number, label: string, image: string, expandable: boolean, activate: () => void): HTMLElement {
  const element = document.createElement('div'); element.className = `tree-row level-${level}`; element.dataset.node = id; element.tabIndex = -1;
  element.setAttribute('role', 'treeitem'); element.setAttribute('aria-level', String(level + 1)); element.setAttribute('aria-label', label);
  if (expandable) element.setAttribute('aria-expanded', String(expanded.has(id)));
  const chevron = expandable ? button('toggleExpanded', 'chevron', () => toggle(id), 'chevron icon-button') : document.createElement('span');
  chevron.classList.add('chevron-space'); chevron.tabIndex = -1;
  element.append(chevron, icon(image), text('span', label, 'row-label'));
  element.addEventListener('click', activate); return element;
}
function sessionMenu(manager: ManagerInfo, session: SessionInfo): MenuItem[] {
  const connection = snapshot.connections.find(info => !info.closed && info.manager === manager.id && info.sessionId === session.id);
  return [
    { label: t('attach'), action: () => send({ type: 'attach', manager: manager.id, session: session.id }) },
    { label: t('sessionDetails'), action: () => showDetails(manager, session) },
    ...(connection ? [{ label: t('disconnect'), action: () => send({ type: 'disconnect', key: connection.key }) }] : []),
    ...(manager.capabilities.detachAll ? [{ label: t('disconnectAll'), disabled: !connection && session.attached === 0, action: () => send({ type: 'disconnectAll', manager: manager.id, session: session.id }) }] : []),
    ...(manager.capabilities.windows ? [{ label: t('newWindow'), action: () => send({ type: 'window', action: 'new', manager: manager.id, session: session.id }) }] : []),
    ...(manager.capabilities.rename ? [{ label: t('renameSession'), action: () => send({ type: 'rename', manager: manager.id, session: session.id }) }] : []),
    ...(manager.capabilities.kill ? [{ label: t('killSessionMenu'), danger: true, action: () => send({ type: 'kill', manager: manager.id, session: session.id }) }] : [])
  ];
}
function addMenu(element: HTMLElement, items: MenuItem[]) {
  element.append(button('sessionActions', 'more', () => { const rect = element.getBoundingClientRect(); showMenu(rect.right, rect.bottom, items); }, 'icon-button row-action'));
  element.addEventListener('contextmenu', event => { event.preventDefault(); showMenu(event.clientX, event.clientY, items); });
}
function renderTree() {
  const { scrollTop, scrollLeft } = tree;
  // An iframe retains activeElement while a VS Code Quick Input has focus.
  // Restoring it unconditionally dismisses the host's input dialog.
  const hadTreeFocus = document.hasFocus() && tree.contains(document.activeElement);
  const focused = hadTreeFocus ? (document.activeElement as HTMLElement)?.closest<HTMLElement>('.tree-row')?.dataset.node : undefined;
  const needle = filter.value.trim().toLocaleLowerCase();
  for (const node of selectedSessions) {
    const manager = snapshot.managers.find(manager => node.startsWith(`${manager.id}/`));
    if (manager?.available && !manager.error && !manager.sessions.some(session => node === `${manager.id}/${session.id}`)) selectedSessions.delete(node);
  }
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
    managerRow.title = manager.error || manager.version || t('notInstalledHelp');
    if (!manager.available) { managerRow.classList.add('unavailable'); managerRow.append(text('span', t('notInstalled'), 'count')); }
    else {
      managerRow.append(text('span', String(manager.sessions.length), 'count'));
      managerRow.append(button('newSession', 'plus', () => send({ type: 'newSession', manager: manager.id }), 'icon-button row-action'));
    }
    fragment.append(managerRow);
    if (!manager.available || (!expanded.has(manager.id) && !needle)) continue;
    if (manager.error) { const error = text('div', manager.error, 'manager-error'); error.title = manager.error; fragment.append(error); }
    for (const session of sessions) {
      const node = `${manager.id}/${session.id}`;
      const connection = snapshot.connections.find(info => !info.closed && info.manager === manager.id && info.sessionId === session.id);
      const active = !!connection && connection.key === snapshot.activeKey;
      const sessionRow = row(node, 1, session.name, 'terminal', !batchMode && manager.capabilities.windows, () => batchMode ? toggleSessionSelection(node) : send({ type: 'attach', manager: manager.id, session: session.id }));
      sessionRow.classList.toggle('selected', active); sessionRow.classList.toggle('is-connected', !!connection);
      sessionRow.setAttribute('aria-selected', String(batchMode ? selectedSessions.has(node) : active)); sessionRow.title = session.detail || `${session.name}${session.attached ? ` · ${t('hasClients')}` : ''}`;
      if (batchMode) {
        sessionRow.classList.toggle('batch-selected', selectedSessions.has(node));
        const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.className = 'session-checkbox'; checkbox.tabIndex = -1;
        checkbox.setAttribute('aria-label', t('selectSession', { name: session.name, manager: manager.id })); checkbox.checked = selectedSessions.has(node); checkbox.disabled = batchPending;
        checkbox.addEventListener('click', event => event.stopPropagation());
        checkbox.addEventListener('change', () => toggleSessionSelection(node));
        sessionRow.querySelector('.chevron-space')!.replaceWith(checkbox);
      }
      if (connection) sessionRow.append(text('span', '●', 'connection-dot'));
      else if (session.attached) sessionRow.append(text('span', '○', 'other-client'));
      if (!batchMode) addMenu(sessionRow, sessionMenu(manager, session)); fragment.append(sessionRow);
      if (!batchMode && manager.capabilities.windows && (expanded.has(node) || needle)) {
        for (const window of session.windows || []) {
          if (needle && !managerMatches && !session.name.toLocaleLowerCase().includes(needle) && !window.name.toLocaleLowerCase().includes(needle)) continue;
          const action = (action: string) => send({ type: 'window', action, manager: manager.id, session: session.id, window: window.id });
          const windowRow = row(`${node}/${window.id}`, 2, `${window.index}: ${window.name}`, 'window', false, () => action('select'));
          windowRow.classList.toggle('active-window', window.active); windowRow.title = `${t('paneCount', { count: window.panes })}${window.active ? ` · ${t('currentWindow')}` : ''}`;
          windowRow.setAttribute('aria-current', window.active ? 'true' : 'false');
          addMenu(windowRow, [{ label: t('selectWindow'), action: () => action('select') }, { label: t('windowDetails'), action: () => showDetails(manager, session, window) }, { label: t('renameWindow'), action: () => action('rename') }, { label: t('closeWindowMenu'), danger: true, action: () => action('kill') }]);
          fragment.append(windowRow);
        }
      }
    }
    if (!sessions.length && !manager.error) {
      const empty = text('button', `＋ ${t('newSession')}`, 'empty-manager'); empty.addEventListener('click', () => send({ type: 'newSession', manager: manager.id })); fragment.append(empty);
    }
  }
  tree.setAttribute('aria-busy', String(!!snapshot.hostLoading));
  if (!shown) {
    if (snapshot.hostLoading) {
      const loading = text('div', '', 'tree-empty tree-loading spinning'); loading.setAttribute('role', 'status');
      loading.append(icon('refresh'), text('span', t('sshLoading'))); fragment.append(loading);
    } else if (!snapshot.hostError) fragment.append(text('div', needle ? t('noMatches') : !snapshot.visibleManagers.length ? t('noManagersSelected') : t('noManagersFound'), 'tree-empty'));
  }
  tree.replaceChildren(fragment);
  const rows = [...tree.querySelectorAll<HTMLElement>('.tree-row')];
  const focusRow = rows.find(row => row.dataset.node === focused) || rows.find(row => row.classList.contains('selected')) || rows[0];
  if (focusRow) { focusRow.tabIndex = 0; if (focused) focusRow.focus({ preventScroll: true }); }
  // Keep scrolling independent of row replacement and focus restoration.
  tree.scrollTop = scrollTop; tree.scrollLeft = scrollLeft;
  const available = visibleManagers.filter(manager => manager.available).length;
  get('.sidebar-footer').textContent = t('managerCount', { count: available });
  updateBatchToolbar();
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
    const previousLocale = getLocale();
    const hostChanged = snapshot.selectedHost !== message.state.selectedHost;
    const hostsChanged = JSON.stringify(snapshot.hosts) !== JSON.stringify(message.state.hosts);
    const refreshHostMenu = menu?.classList.contains('host-menu') && hostsChanged && !hostChanged;
    const focusedHost = (document.activeElement as HTMLElement)?.dataset.profile, hostMenuScroll = menu?.scrollTop || 0;
    snapshot = message.state;
    if (hostChanged && nativeTerminal) { closeMenu(); detailsDialog.close(); detailsRequest++; selectedSessions.clear(); setBatchMode(false); filter.value = ''; }
    setLocale(snapshot.locale);
    if (getLocale() !== previousLocale) {
      document.documentElement.lang = getLocale();
      localize(); updateSidebarVisibility(); searchWidget.localize(); closeMenu();
      for (const entry of terminals.values()) entry.links.hide();
      if (detailsTarget) { detailsTitle.textContent = detailsTarget.window ? t('windowDetails') : t('sessionDetails'); requestDetails(); }
    }
    Terminal.strings.promptLabel = t('xtermInput');
    Terminal.strings.tooMuchOutput = t('xtermTooMuch');
    for (const input of terminalHosts.querySelectorAll<HTMLElement>('.xterm-helper-textarea')) input.setAttribute('aria-label', t('xtermInput'));
    const connection = snapshot.connections.find(info => info.key === snapshot.activeKey);
    const target = connection && `${connection.key}/${connection.sessionId}`;
    if (target && target !== lastActiveTarget) {
      if (connection) { expanded.add(connection.manager); expanded.add(`${connection.manager}/${connection.sessionId}`); }
    }
    lastActiveTarget = target; updateHost(); updateTerminal(); renderTree();
    if (refreshHostMenu) {
      showHostMenu();
      [...menu!.querySelectorAll<HTMLElement>('[data-profile]')].find(item => item.dataset.profile === focusedHost)?.focus({ preventScroll: true });
      menu!.scrollTop = hostMenuScroll;
    }
  } else if (message.type === 'output') {
    const entry = terminals.get(message.key);
    if (!entry) return;
    if (message.replay) { entry.replaying = true; entry.terminal.reset(); entry.seq = 0; }
    if (!message.replay && message.seq <= entry.seq) return;
    entry.seq = message.seq; entry.terminal.write(message.data, () => {
      if (message.replay) entry.replaying = false;
      send({ type: 'ack', key: message.key, seq: message.seq });
    });
  } else if (message.type === 'focus' && message.key === snapshot.activeKey) {
    const generation = ++focusGeneration;
    requestAnimationFrame(() => { if (generation === focusGeneration && message.key === snapshot.activeKey) current()?.terminal.focus(); });
  }
  else if (message.type === 'visible') requestAnimationFrame(fitCurrent);
  else if (message.type === 'paste' && message.key === displayedKey) { const entry = terminals.get(message.key); if (entry && !entry.closed) entry.terminal.paste(message.text); }
  else if (message.type === 'resolvedLinks') terminals.get(message.key)?.links.receive(message);
  else if (message.type === 'details' && message.request === detailsRequest && detailsTarget) {
    detailsRefresh.disabled = false;
    if (message.error) detailsBody.replaceChildren(text('p', message.error, 'details-error'));
    else renderDetails(message.details);
  }
  else if (message.type === 'refreshing') get('.sidebar-actions .icon-refresh').closest<HTMLButtonElement>('button')!.classList.toggle('spinning', message.value);
  else if (message.type === 'batchResult' && message.request === batchRequest) {
    batchPending = false;
    for (const target of message.succeeded as SessionTarget[]) selectedSessions.delete(`${target.manager}/${target.session}`);
    renderTree();
    if (message.error) get('.connection-status').textContent = message.error;
  }
  else if (message.type === 'error') get('.connection-status').textContent = message.message;
});
// Load symbols before any terminal measures them, including history replay.
void document.fonts.load('12px "MuxDock Powerline"', '\ue0b0').catch(error => {
  console.warn('MuxDock could not load its Powerline symbol font', error);
}).then(() => send({ type: 'ready' }));
