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
```

`test:integration` exercises real backends: creation, terminal input/output, detach persistence, reattachment and cleanup. Missing tools are skipped. Optional executable paths can be supplied in `.test-tools/executables.json`. It uses isolated backend resources rather than terminating existing user sessions.

`test:ui` uses a separate editor profile and tmux server. It checks terminal input, colors, fitting at different panel sizes, window navigation, tab switching/limits, immediate settings updates and ending sessions from the tree. Screenshots and reports are saved under `.test-results/`.

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
