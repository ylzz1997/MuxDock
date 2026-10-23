import { t, type MessageKey } from '../src/i18n';
import type { Terminal, IDisposable } from '@xterm/xterm';
import type { SearchAddon, ISearchOptions, ISearchResultChangeEvent } from '@xterm/addon-search';

export interface SearchFlags { caseSensitive: boolean; wholeWord: boolean; regex: boolean }
export const SEARCH_MATCH_LIMIT = 1000;
interface SearchEntry { terminal: Terminal; addon: SearchAddon; listener: IDisposable }
export class TerminalSearch {
  readonly element = document.createElement('div');
  readonly input: HTMLInputElement;
  private readonly counter: HTMLElement;
  private readonly error: HTMLElement;
  private readonly previous: HTMLButtonElement;
  private readonly next: HTMLButtonElement;
  private readonly toggles = new Map<keyof SearchFlags, HTMLButtonElement>();
  private readonly entries = new Map<string, SearchEntry>();
  private activeKey?: string;
  private valid = true;
  private lastResult = { resultIndex: -1, resultCount: 0 };
  private regexError = '';
  private readonly flags: SearchFlags;
  constructor(container: HTMLElement, saved: Partial<SearchFlags> | undefined, private readonly changed: () => void, private readonly restoreFocus: () => void) {
    this.flags = { caseSensitive: saved?.caseSensitive === true, wholeWord: saved?.wholeWord === true, regex: saved?.regex === true };
    this.element.className = 'search-bar'; this.element.hidden = true;
    this.element.setAttribute('role', 'search'); this.element.setAttribute('aria-label', t('search'));
    const field = document.createElement('div'); field.className = 'search-field';
    this.input = document.createElement('input'); this.input.type = 'text'; this.input.className = 'search-input'; this.input.placeholder = t('find');
    this.input.setAttribute('aria-label', t('searchContent')); this.input.setAttribute('aria-controls', 'terminal-panel'); this.input.spellcheck = false; this.input.maxLength = 1000;
    field.append(this.input);
    for (const [key, label, text, shortcut] of [
      ['caseSensitive', t('caseSensitive'), 'Aa', 'C'], ['wholeWord', t('wholeWord'), 'ab', 'W'], ['regex', t('regex'), '.*', 'R']
    ] as const) {
      const toggle = this.button(label, text, `search-option search-${key}`, () => this.toggle(key));
      toggle.title = `${label} (Alt+${shortcut})`; toggle.setAttribute('aria-pressed', String(this.flags[key])); field.append(toggle); this.toggles.set(key, toggle);
    }
    this.counter = document.createElement('span'); this.counter.className = 'search-count'; this.counter.setAttribute('role', 'status'); this.counter.setAttribute('aria-live', 'polite'); this.counter.setAttribute('aria-atomic', 'true');
    this.previous = this.button(t('previousMatch'), '', 'search-previous icon-button', () => this.find('previous'));
    this.previous.title = `${t('previousMatch')} (Shift+Enter)`; this.previous.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 13V3M3.5 7.5 8 3l4.5 4.5"/></svg>';
    this.next = this.button(t('nextMatch'), '', 'search-next icon-button', () => this.find('next'));
    this.next.title = `${t('nextMatch')} (Enter)`; this.next.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v10m-4.5-4.5L8 13l4.5-4.5"/></svg>';
    const close = this.button(t('closeSearch'), '', 'search-close icon-button', () => this.close()); close.title = `${t('closeSearch')} (Escape)`;
    close.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3 3 10 10M13 3 3 13"/></svg>';
    this.error = document.createElement('div'); this.error.className = 'search-error'; this.error.id = 'terminal-search-error'; this.error.hidden = true; this.error.setAttribute('role', 'alert');
    this.element.append(field, this.counter, this.previous, this.next, close, this.error); container.append(this.element);
    this.input.addEventListener('input', () => this.find('refresh'));
    this.element.addEventListener('keydown', event => {
      if (event.isComposing || event.keyCode === 229) return;
      if (this.handleKey(event)) return;
      if (event.key === 'Escape') { this.consume(event); this.close(); }
      else if (event.key === 'Enter') { this.consume(event); this.find(event.shiftKey ? 'previous' : 'next'); }
      else if (event.altKey && !event.metaKey && !event.ctrlKey) {
        const key = ({ KeyC: 'caseSensitive', KeyW: 'wholeWord', KeyR: 'regex' } as const)[event.code as 'KeyC' | 'KeyW' | 'KeyR'];
        if (key) { this.consume(event); this.toggle(key); }
      }
    });
    this.localize();
    this.results({ resultIndex: -1, resultCount: 0 });
  }
  localize() {
    this.element.setAttribute('aria-label', t('search'));
    this.input.placeholder = t('find'); this.input.setAttribute('aria-label', t('searchContent'));
    const labels: [string, MessageKey, string][] = [
      ['caseSensitive', 'caseSensitive', 'Alt+C'], ['wholeWord', 'wholeWord', 'Alt+W'], ['regex', 'regex', 'Alt+R'],
      ['previous', 'previousMatch', 'Shift+Enter'], ['next', 'nextMatch', 'Enter'], ['close', 'closeSearch', 'Escape']
    ];
    for (const [selector, key, shortcut] of labels) {
      const button = this.element.querySelector<HTMLButtonElement>(`.search-${selector}`)!;
      button.setAttribute('aria-label', t(key)); button.title = `${t(key)} (${shortcut})`;
    }
    if (!this.valid) this.error.textContent = t('invalidRegexError', { error: this.regexError });
    this.results(this.lastResult);
  }
  private button(label: string, text: string, className: string, action: () => void): HTMLButtonElement {
    const button = document.createElement('button'); button.type = 'button'; button.className = className; button.textContent = text; button.title = label; button.setAttribute('aria-label', label);
    button.addEventListener('mousedown', event => event.preventDefault());
    button.addEventListener('click', event => { event.stopPropagation(); action(); }); return button;
  }
  private consume(event: KeyboardEvent) { event.preventDefault(); event.stopPropagation(); }
  private get active() { return this.activeKey ? this.entries.get(this.activeKey) : undefined; }
  get options(): SearchFlags { return { ...this.flags }; }
  register(key: string, terminal: Terminal, addon: SearchAddon) {
    const listener = addon.onDidChangeResults(result => { if (key === this.activeKey && !this.element.hidden && this.valid) this.results(result); });
    this.entries.set(key, { terminal, addon, listener });
  }
  unregister(key: string) { this.entries.get(key)?.listener.dispose(); this.entries.delete(key); }
  setActive(key: string | undefined) {
    if (key === this.activeKey) return;
    this.active?.addon.clearDecorations(); this.active?.terminal.clearSelection(); this.activeKey = key;
    if (!this.element.hidden) this.find('refresh');
  }
  open() {
    const selection = this.active?.terminal.getSelection();
    if (selection && selection.length <= 1000 && !/[\r\n]/.test(selection)) this.input.value = selection;
    this.element.hidden = false; this.find('refresh'); this.input.focus(); this.input.select();
  }
  close() {
    this.element.hidden = true; this.active?.addon.clearDecorations(); this.active?.terminal.clearSelection(); this.restoreFocus();
  }
  handleKey(event: KeyboardEvent): boolean {
    if ((/Mac/i.test(navigator.platform) ? event.metaKey : event.ctrlKey) && event.key.toLowerCase() === 'f') {
      this.consume(event); this.open(); return true;
    }
    if (event.key === 'F3') {
      this.consume(event); if (this.element.hidden) this.open(); else this.find(event.shiftKey ? 'previous' : 'next'); return true;
    }
    return false;
  }
  private toggle(key: keyof SearchFlags) {
    this.flags[key] = !this.flags[key]; this.toggles.get(key)!.setAttribute('aria-pressed', String(this.flags[key])); this.changed(); this.find('refresh'); this.input.focus();
  }
  private decorations(): NonNullable<ISearchOptions['decorations']> {
    const style = getComputedStyle(document.body);
    const color = (name: string, fallback: string) => style.getPropertyValue(`--vscode-terminal-${name}`).trim() || fallback;
    return { matchBackground: color('findMatchHighlightBackground', '#4a3d12'), matchBorder: color('findMatchHighlightBorder', '#88712b'), matchOverviewRuler: color('findMatchHighlightBackground', '#88712b'), activeMatchBackground: color('findMatchBackground', '#735c0f'), activeMatchBorder: color('findMatchBorder', '#f2c55c'), activeMatchColorOverviewRuler: color('findMatchBorder', '#f2c55c') };
  }
  private find(direction: 'refresh' | 'next' | 'previous') {
    this.valid = true; this.error.hidden = true; this.input.removeAttribute('aria-invalid'); this.input.removeAttribute('aria-describedby');
    if (this.flags.regex && this.input.value) try { new RegExp(this.input.value); } catch (error) {
      this.valid = false; this.active?.addon.clearDecorations(); this.active?.terminal.clearSelection();
      this.regexError = error instanceof Error ? error.message : String(error);
      this.error.textContent = t('invalidRegexError', { error: this.regexError }); this.error.hidden = false;
      this.input.setAttribute('aria-invalid', 'true'); this.input.setAttribute('aria-describedby', this.error.id);
      this.results({ resultIndex: -1, resultCount: 0 }); return;
    }
    if (!this.active || !this.input.value) {
      this.active?.addon.clearDecorations(); this.active?.terminal.clearSelection(); this.results({ resultIndex: -1, resultCount: 0 }); return;
    }
    if (direction === 'refresh') this.active.addon.clearDecorations();
    const options = { ...this.flags, incremental: direction === 'refresh', decorations: this.decorations() };
    if (direction === 'previous') this.active.addon.findPrevious(this.input.value, options);
    else this.active.addon.findNext(this.input.value, options);
  }
  private results({ resultIndex, resultCount }: ISearchResultChangeEvent) {
    this.lastResult = { resultIndex, resultCount };
    const total = `${resultCount}${resultCount >= SEARCH_MATCH_LIMIT ? '+' : ''}`;
    this.counter.textContent = !this.valid ? t('invalidRegex') : !this.input.value ? '' : resultCount === 0 ? t('noResults') : resultIndex < 0 ? t('matchCount', { count: total }) : t('matchPosition', { index: resultIndex + 1, count: total });
    this.element.dataset.resultCount = String(resultCount); this.element.dataset.resultIndex = String(resultIndex);
    this.element.classList.toggle('no-results', !!this.input.value && resultCount === 0);
    this.previous.disabled = this.next.disabled = !this.valid || resultCount === 0;
  }
}
