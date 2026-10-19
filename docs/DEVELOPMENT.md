# Development

Use Node.js 22 or later. The project pins the Node major version in `.nvmrc`.

```sh
npm ci
npm run check
npm test
npm run build
```

Press F5 to open an Extension Development Host, then search for **MuxDock** in the Command Palette and open the dock.

## Tests

```sh
npm run test:integration
npm run test:ui
npm run test:links
```

`test:integration` exercises real backends: creation, terminal input/output, detach persistence, reattachment and cleanup. Missing tools are skipped. Optional executable paths can be supplied in `.test-tools/executables.json`. It uses isolated backend resources rather than terminating existing user sessions.

`test:links` runs browser interaction checks for macOS and Linux modifier keys, OSC 8 and plain URLs, wrapped URLs, file locations, hover actions, selection and application mouse tracking. Install its browser with `npx playwright install chromium --only-shell`. Live editor tests also open real files from OSC 8/relative links and verify their line and column. `webview/links.ts` contains a guarded workaround for xterm 6 retaining stale link replies after mouseleave; keep the redraw/re-entry interaction coverage when updating xterm.

Live paste checks record exact input bytes, covering shortcut, native event and context-menu paste, bracketed multiline input and two intentional consecutive pastes. Find-widget checks cover real match counts, highlighting, case/word/regex options, errors, incoming output, active-tab changes, keyboard navigation and compact-panel layout.

Session-status checks deliberately delay a real tmux list response while closing a client, then verify the indicator clears without waiting for periodic polling. They also cover retained tabs, native detachment, real external clients and current-window markers scrolling with their rows in a short panel.

`test:ui` uses a separate editor profile and tmux server with a plain shell. It checks the shell/command picker, command execution and reattachment, saved launch settings, short-panel menu keyboard access, terminal input, colors, fitting at different panel sizes, window navigation, tab switching/limits, session tree scroll retention, clipboard actions with Unicode and mouse tracking, direct and tmux-wrapped OSC 52 application copying, immediate settings updates and ending sessions from the tree. The macOS clipboard checks restore the previous clipboard text after running. They also check that replaying history and background terminal output do not overwrite the clipboard. Backend integration tests execute a startup command on all seven managers and verify it is not repeated on reattachment. Screenshots and reports are saved under `.test-results/`.

The UI test defaults to the standard macOS VS Code and Homebrew tmux paths. Override `MUXDOCK_CODE`, `MUXDOCK_CODE_CLI` and `MUXDOCK_TMUX` for other installations. Set `MUXDOCK_USE_VSIX` to a VSIX path to test an installed package instead of a development extension. When testing Cursor, also set `MUXDOCK_TEST_EDITOR=cursor` to use a separate profile and extension directory.

## Icon assets

- `media/icon.svg`: editable Marketplace icon source.
- `media/icon.png`: checked-in 512 × 512 Marketplace icon.
- `media/muxdock.svg`: monochrome icon used by the dock view container.

To regenerate the PNG with Playwright's Chromium:

```sh
npx playwright install chromium --only-shell
npm run icon:build
```

Alternatively, use an installed Google Chrome:

```sh
MUXDOCK_BROWSER_CHANNEL=chrome npm run icon:build
```

The icon build is optional when packaging; `npm run package` uses the checked-in PNG.

## Packaging

```sh
npm run package
```

The build bundles the extension, webview, PTY helper and supported native binaries. `.vscodeignore` limits the package to runtime files, the icon, README, changelog and license. Tests, local profiles and development tools are excluded.
