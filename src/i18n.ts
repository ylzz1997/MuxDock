import en from '../l10n/en.json';
import zhCN from '../l10n/zh-cn.json';
import zhTW from '../l10n/zh-tw.json';
import ja from '../l10n/ja.json';
import ko from '../l10n/ko.json';
import de from '../l10n/de.json';
import fr from '../l10n/fr.json';
import es from '../l10n/es.json';
import ptBR from '../l10n/pt-br.json';
import ru from '../l10n/ru.json';

export const languages = {
  en: 'English', 'zh-cn': '简体中文', 'zh-tw': '繁體中文', ja: '日本語', ko: '한국어',
  de: 'Deutsch', fr: 'Français', es: 'Español', 'pt-br': 'Português (Brasil)', ru: 'Русский'
} as const;
export type Locale = keyof typeof languages;
export type MessageKey = keyof typeof en;
export type Parameters = Record<string, string | number>;
export const catalogs: Record<Locale, Readonly<Record<MessageKey, string>>> = {
  en, 'zh-cn': zhCN, 'zh-tw': zhTW, ja, ko, de, fr, es, 'pt-br': ptBR, ru
};
let locale: Locale = 'en';
export function resolveLocale(value: unknown, editorLanguage = 'en'): Locale {
  const candidate = typeof value === 'string' && value !== 'auto' ? value : editorLanguage;
  const tag = candidate.toLowerCase().replaceAll('_', '-');
  if (Object.hasOwn(languages, tag)) return tag as Locale;
  if (/^zh(?:-|$)/.test(tag)) {
    if (tag.split('-').includes('hans')) return 'zh-cn';
    return /(?:^|-)(?:hant|tw|hk|mo)(?:-|$)/.test(tag) ? 'zh-tw' : 'zh-cn';
  }
  if (/^pt(?:-|$)/.test(tag)) return 'pt-br';
  const base = tag.split('-')[0];
  return Object.hasOwn(languages, base) ? base as Locale : 'en';
}
export function setLocale(value: unknown, editorLanguage?: string): Locale { return locale = resolveLocale(value, editorLanguage); }
export function getLocale(): Locale { return locale; }
export function translate(language: Locale, key: MessageKey, parameters: Parameters = {}): string {
  const template = catalogs[language]?.[key] || en[key];
  return template.replace(/\{(\w+)\}/g, (token, name: string) => Object.hasOwn(parameters, name) ? String(parameters[name]) : token);
}
export function t(key: MessageKey, parameters?: Parameters): string { return translate(locale, key, parameters); }
