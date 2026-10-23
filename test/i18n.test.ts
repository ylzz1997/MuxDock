import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { catalogs, languages, resolveLocale, setLocale, translate, t, type Locale } from '../src/i18n';
import { tmuxDetails, DETAIL_SEPARATOR } from '../src/session-details';
import { requireSuccess } from '../src/runner';

const placeholders = (value: string) => [...value.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();
test('all ten runtime and manifest catalogs have complete keys and matching placeholders', () => {
  const base = catalogs.en;
  const nls = JSON.parse(readFileSync('package.nls.json', 'utf8'));
  assert.equal(Object.keys(languages).length, 10);
  for (const locale of Object.keys(languages) as Locale[]) {
    const translated = catalogs[locale];
    assert.deepEqual(Object.keys(translated).sort(), Object.keys(base).sort(), locale);
    for (const key of Object.keys(base) as (keyof typeof base)[]) {
      assert.ok(translated[key].trim(), `${locale}/${key}`);
      assert.deepEqual(placeholders(translated[key]), placeholders(base[key]), `${locale}/${key}`);
    }
    const manifest = JSON.parse(readFileSync(`package.nls${locale === 'en' ? '' : '.' + locale}.json`, 'utf8'));
    assert.deepEqual(Object.keys(manifest).sort(), Object.keys(nls).sort(), locale);
    for (const key of Object.keys(nls)) assert.ok(typeof manifest[key] === 'string' && manifest[key].trim(), `${locale}/${key}`);
  }
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  for (const match of JSON.stringify(pkg.contributes).matchAll(/%([^%]+)%/g)) assert.ok(nls[match[1]], match[1]);
  assert.ok(nls[pkg.description.slice(1, -1)]);
  assert.deepEqual(pkg.contributes.configuration.properties['muxdock.language'].enum, ['auto', ...Object.keys(languages)]);
  assert.ok(readFileSync('.vscodeignore', 'utf8').includes('!package.nls*.json'));
});
test('locale resolution handles editor auto, regional variants, Chinese scripts and unknown values', () => {
  for (const [input, expected] of [['en-US', 'en'], ['ZH_cn', 'zh-cn'], ['zh-Hans-SG', 'zh-cn'], ['zh-Hans-HK', 'zh-cn'], ['zh-Hant', 'zh-tw'], ['zh-HK', 'zh-tw'], ['zh-MO', 'zh-tw'], ['ja-JP', 'ja'], ['pt-PT', 'pt-br'], ['pt_BR', 'pt-br'], ['de-AT', 'de'], ['fr-CA', 'fr'], ['es-MX', 'es'], ['ar', 'en'], ['constructor', 'en'], ['', 'en']] as const) assert.equal(resolveLocale(input), expected, input);
  assert.equal(resolveLocale('auto', 'ko-KR'), 'ko');
  assert.equal(resolveLocale(undefined, 'ru'), 'ru');
  assert.equal(resolveLocale('en', 'zh-cn'), 'en');
});
test('interpolation preserves user text literally and falls back to English for a missing translation', () => {
  const name = '<b>训练</b> $& {manager}';
  assert.equal(translate('en', 'closeTab', { name, manager: 'tmux' }), `Close tab ${name} (tmux)`);
  assert.equal(translate('ru', 'selectedCount', { count: 0 }), 'Выбрано: 0');
  assert.equal(translate('unknown' as Locale, 'newSession'), 'New session');
  const incomplete = Object.create(catalogs.de);
  incomplete.newSession = '';
  const original = catalogs.de; catalogs.de = incomplete;
  try { assert.equal(translate('de', 'newSession'), 'New session'); } finally { catalogs.de = original; }
});
test('detail field IDs and timestamp types stay stable across languages; helper errors are localized', () => {
  const session = ['$7', '用户.name', '1792374522', '1', '1', '/tmp/路径', '321'].join(DETAIL_SEPARATOR);
  try {
    for (const locale of Object.keys(languages)) {
      setLocale(locale);
      const details = tmuxDetails(session, '');
      assert.equal(details.title, t('sessionDetails'));
      assert.equal(details.sections[0].fields.find(field => field.label === 'sessionName')?.value, '用户.name');
      assert.equal(details.sections[0].fields.find(field => field.kind === 'timestamp')?.value, '2026-10-19T01:48:42.000Z');
      assert.throws(() => requireSuccess({ code: 1, stdout: '', stderr: 'RuntimeError: MUXDOCK_ERROR:serverUnverified' }, 'test'), error => error instanceof Error && error.message === `test: ${t('serverUnverified')}`);
    }
  } finally { setLocale('en'); }
});
test('runtime modules and styles do not depend on hardcoded Chinese UI labels', () => {
  for (const directory of ['src', 'webview']) for (const file of readdirSync(directory).filter(name => /\.(ts|css|py)$/.test(name) && name !== 'i18n.ts')) {
    assert.doesNotMatch(readFileSync(`${directory}/${file}`, 'utf8'), /\p{Script=Han}/u, `${directory}/${file}`);
  }
});
