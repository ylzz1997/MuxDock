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

On Windows, run `npm run test:windows:integration` for the production adapters, launchers and connection lifecycle with installed psmux, Zellij, PowerShell 7, Windows PowerShell and CMD. It isolates backend namespaces/configuration and exercises Unicode/space paths, commands running once, interactive input, detach/reattach, native details, windows/tabs, rename gating, two-client disconnect-all and targeted cleanup. `MUXDOCK_TEST_BACKEND=psmux` or `zellij` narrows a diagnostic run. Evidence is saved under `.test-results/md_integration_*`.

Run `npm run test:windows:new-backends` for native tmux-windows and Herdr. Set `MUXDOCK_TEST_BACKEND=tmux` or `herdr` to narrow the run; Herdr-only runs also exercise Unicode startup paths. This suite verifies three shells, saved commands once, Ctrl+C after reconnect, a surviving heartbeat/PID, tab operations, capability guards and scoped cleanup. It saves evidence under `.test-results/md_new_*`. Native tmux uses ASCII startup paths because the tested port cannot reliably pass Unicode CLI arguments.

After `npm run package`, run `npm run test:ui:windows` for a VSIX installed into an isolated VS Code profile; set `MUXDOCK_TEST_EDITOR=cursor` for Cursor. This harness reads `.test-tools/executables.windows.json` with absolute `psmux`, `zellij`, `pwsh`, `powershell` and `cmd` paths. Override `MUXDOCK_USE_VSIX` to test another package, or `MUXDOCK_EDITOR_DIRECTORY` for a portable editor. It checks discovery, creation, terminal input, simulated file drops, details, capability menus, tab navigation, reattachment, and interactive input after editor reload. It cleans only its own editor process tree and backend namespaces.

Set `MUXDOCK_TEST_MANAGERS=tmux,herdr` to test the new backends in either editor. Their optional executable overrides use `tmux` and `herdr` keys in the same JSON file; fallback locations are `%LOCALAPPDATA%/Programs/tmux-windows/tmux.exe` and `%LOCALAPPDATA%/Programs/Herdr/bin/herdr.exe`. The reload check compares the shell PID and an in-memory value before and after reload, so a restarted shell cannot pass as a surviving session. To test unpublished changes without replacing a release artifact, package with `npx vsce package --no-dependencies --out artifacts/muxdock-development.vsix` and set `MUXDOCK_USE_VSIX` to that path.

The bundled `node-pty` is pinned at 1.1.0. Windows uses its ConPTY DLL in one helper process per PTY (`windows-pty-host.cjs`). This isolates the upstream global-handle race during concurrent exits and releases workers/native handles when the helper exits. The extension exchanges input, output, resize and flow-control messages over IPC. Disconnect terminates only the spawned client; loss of the parent IPC connection also releases it. Recheck natural exit, rapid close and host shutdown when updating this path. The Windows package contains both architectures' `.node` files and the `conpty` DLL/executable directory; physical ARM64 testing remains separate from packaging checks.

`test:links` runs browser interaction checks for macOS and Linux modifier keys, OSC 8 and plain URLs, wrapped URLs, file locations, hover actions, selection and application mouse tracking. Install its browser with `npx playwright install chromium --only-shell`. Live editor tests also open real files from OSC 8/relative links and verify their line and column. `webview/links.ts` contains a guarded workaround for xterm 6 retaining stale link replies after mouseleave; keep the redraw/re-entry interaction coverage when updating xterm.

Live paste checks record exact input bytes, covering shortcut, native event and context-menu paste, bracketed multiline input and two intentional consecutive pastes. Find-widget checks cover real match counts, highlighting, case/word/regex options, errors, incoming output, active-tab changes, keyboard navigation and compact-panel layout.

Terminal theme checks measure rendered text contrast on default, ANSI, 256-color and truecolor backgrounds in light and dark themes. They also change `terminal.integrated.minimumContrastRatio` on an open terminal to verify immediate updates, including disabling adjustment. Per-editor color measurements and screenshots are saved under `.test-results/terminal-theme-*`.

Session-status checks deliberately delay a real tmux list response while closing a client, then verify the indicator clears without waiting for periodic polling. They also cover retained tabs, native detachment, real external clients and current-window markers scrolling with their rows in a short panel.

Session-details checks verify native tmux IDs, creation times, paths with Unicode and spaces, per-window pane scope, refreshing a running command, copying details and compact dialog layout. They exercise disconnect-all with two external clients, preserve unrelated sessions and verify closed-tab indicators and reconnection in both editors. Backend integration tests cover details and disconnect-all across all seven managers, including external clients and an unrelated connected session. `src/session-processes.py` inspects exact executable/argv identities and excludes the socket-owning server and its descendants before releasing abduco/a4 clients. Zellij contract v1 uses its native session detach message with explicit client IDs; legacy sockets use verified local clients and report any remaining attachments.

Run `python3 test/process-inspection.py /path/to/abduco` on macOS or Linux to verify process isolation, refusal on executable mismatch, preservation of shell/background jobs and same-name sessions in different socket directories. Use `MUXDOCK_UI_FOCUS=session-details npm run test:ui` for the focused details/disconnect regression.

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

## Native Windows backend capability audit

Run `npm run test:windows` on a Windows host with psmux, Zellij, PowerShell 7,
Windows PowerShell and CMD installed. This is the standalone capability audit
used before integration, separate from the production acceptance suite.
It exercises the real binaries through MuxDock's PTY wrapper and headless xterm.

Executables are found on PATH. Optional absolute overrides can be supplied in
`.test-tools/executables.windows.json`, keyed by `psmux`, `zellij`, `pwsh`,
`powershell`, and `cmd`. Reopen the shell after installing the tools so that it
receives PATH changes. Set `MUXDOCK_TEST_MANAGERS=psmux` or `zellij` to audit one
backend. The default uses node-pty's bundled ConPTY DLL; set
`MUXDOCK_TEST_CONPTY_DLL=0` to compare the system ConPTY implementation.

Each run gets its own psmux namespace, Zellij socket/config/cache directories,
and generated session names. Cleanup targets only that run's sessions and the
test psmux namespace. Test artifacts are retained under
`.test-results/windows-capabilities/`, with a latest-result pointer at
`.test-results/windows-capabilities-latest.json`. Reports include individual
checks, native command output, terminal ANSI transcripts, and rendered terminal
text. A failed capability makes the audit exit nonzero; known backend limitations
remain visible instead of becoming skipped or passing tests.

The suite verifies live heartbeat progress and shell identity across detach,
PTY close, reattach, and the death of a separate PTY host process. It also covers
multiple clients, unrelated-session isolation, window/tab operations, pane
operations, Unicode paths/names/output, bracketed paste, resize, startup-once
behavior, shell selection, and directory metadata. Windows PowerShell uses
command text for its test bootstrap without changing execution policy.

See [Windows capability findings](WINDOWS-CAPABILITIES.md) for the measured
support matrix, limitations and integration requirements. These checks do not
replace packaged VSIX/editor UI checks, physical IME testing, or ARM64 testing.
