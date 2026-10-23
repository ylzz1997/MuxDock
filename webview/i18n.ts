import { t, type MessageKey, type Parameters } from '../src/i18n';

type Binding = { key: MessageKey; parameters?: Parameters; attribute?: string };
const bindings = new WeakMap<HTMLElement, Binding[]>();
/** Bind only extension-owned text; never translate terminal output or user content. */
export function bind(element: HTMLElement, key: MessageKey, attribute?: string, parameters?: Parameters) {
  const entries = (bindings.get(element) || []).filter(entry => entry.attribute !== attribute);
  entries.push({ key, attribute, parameters }); bindings.set(element, entries);
  element.dataset.localized = '';
  apply(element);
}
function apply(element: HTMLElement) {
  for (const { key, attribute, parameters } of bindings.get(element) || []) {
    if (attribute) element.setAttribute(attribute, t(key, parameters));
    else element.textContent = t(key, parameters);
  }
}
export function localize(root: ParentNode = document) {
  for (const element of root.querySelectorAll<HTMLElement>('[data-i18n]')) {
    bind(element, element.dataset.i18n as MessageKey);
  }
  for (const attribute of ['aria-label', 'title', 'placeholder']) {
    for (const element of root.querySelectorAll<HTMLElement>(`[data-i18n-${attribute}]`)) {
      bind(element, element.getAttribute(`data-i18n-${attribute}`) as MessageKey, attribute);
    }
  }
  for (const element of root.querySelectorAll<HTMLElement>('[data-localized]')) apply(element);
}
