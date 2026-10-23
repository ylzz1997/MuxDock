# Localization

MuxDock ships English (`en`), Simplified Chinese (`zh-cn`), Traditional Chinese (`zh-tw`), Japanese (`ja`), Korean (`ko`), German (`de`), French (`fr`), Spanish (`es`), Brazilian Portuguese (`pt-br`) and Russian (`ru`).

`muxdock.language` defaults to `auto`, resolved from `vscode.env.language` on the workspace extension host. Regional tags use their supported base language; Chinese script/region variants distinguish simplified and traditional text. Portuguese variants use Brazilian Portuguese. Unsupported locales fall back to English. A manual selection persists in the current workspace setting when it already overrides the language, otherwise in the editor's global settings and updates the existing webview without recreating terminal clients.

## Translation files

- `l10n/en.json` defines the typed runtime message keys. The other files in `l10n/` must provide the same keys. `src/i18n.ts` bundles these catalogs into both extension and webview builds; no network request or additional runtime package is needed.
- `package.nls.json` is the English catalog for manifest contributions. `package.nls.<locale>.json` contains translated command titles, extension descriptions and setting descriptions. These files must be included in the VSIX. See [Microsoft's localization documentation](https://github.com/microsoft/vscode-l10n/blob/main/README.md#packagejson).
- Static contributions always follow the **editor's display language**, independently of `muxdock.language`. Changing the editor display language uses the editor's normal restart flow.

Use named placeholders such as `{name}` and `{count}`, keeping the exact same placeholder names in every translation. Translate complete sentences rather than concatenating grammar-dependent fragments. Count labels use forms such as “Selected: {count}” so they work at zero, one and many without incorrect singular/plural endings. Values are interpolated once and inserted as text, never as HTML. Do not translate terminal output, user names, file paths, commands, manager identifiers or tool diagnostics.

Details carry stable field IDs and an explicit timestamp type; formatting dates or identifying fields must never depend on translated labels. Helper-owned errors from Python use stable codes translated by the extension. External tool errors retain their original diagnostic text.

## Adding a language or message

1. Add the runtime JSON catalog and import/register it in `src/i18n.ts`. Use the language's native name in `languages`.
2. Add the locale to the `muxdock.language` enum and native label in `package.json`. Update `resolveLocale` only if a region or script needs special mapping.
3. Add a complete `package.nls.<locale>.json` file. Keep all keys aligned with the English manifest catalog.
4. For new messages, add the same key and placeholders to all runtime catalogs. Use `t()` in extension code; use `bind()` or `data-i18n-*` for persistent webview elements so they update live. Use stable CSS classes for behavior, not translated text selectors.
5. Update the locale list/count in the tests, this document and README. Run `npm run check`, `npm test`, and the live UI checks below.

## Validation

`test/i18n.test.ts` verifies catalog completeness, placeholders, manifest coverage, locale fallback, interpolation, stable detail IDs, Python error translation and the absence of hardcoded Chinese labels in runtime modules.

The existing UI harness runs isolated editor profiles and its own tmux socket:

```sh
MUXDOCK_UI_FOCUS=i18n npm run test:ui
MUXDOCK_TEST_EDITOR=cursor \
MUXDOCK_CODE='/Applications/Cursor.app/Contents/MacOS/Cursor' \
MUXDOCK_UI_FOCUS=i18n npm run test:ui
```

The test switches through all ten languages with a live terminal, search and details dialog open; verifies that the backend client PID does not change; checks narrow layouts, native confirmation, the language picker, editor auto mode, fallback and webview reload. Reports and screenshots are saved in `.test-results/`.
