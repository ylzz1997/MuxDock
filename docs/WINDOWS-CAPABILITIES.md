# Native Windows backend capability findings

Measured on 2026-10-30 (Asia/Shanghai). The original audit below records backend
behavior before integration. MuxDock 0.0.14 now enables native psmux and Zellij
on Windows, with bundled ConPTY binaries, shell launchers, Windows paths,
session details, window/tab navigation and version-gated operations.

The unreleased Herdr/tmux-windows addition is recorded in the final section.

Production acceptance tests are separate from the intentionally failing
capability probes: `npm run test:windows:integration` exercises the actual
adapters and connection code, and `npm run test:ui:windows` installs the VSIX in
an isolated editor profile. See the validation section below for the tested
scope.

## Environment and installation

| Component | Tested version |
| --- | --- |
| Windows | Windows 11 Pro for Workstations, 10.0.26300, x64 |
| Node.js | 22.12.0 |
| node-pty | 1.1.0 |
| psmux | 3.4.0, commit `20aa1d7` |
| Zellij | 0.45.1 |
| Terminal renderer | Repository's `@xterm/headless` |

Both managers were installed through WinGet and verified using their actual
executables and WinGet's installed-package list:

```powershell
winget install --id marlocarlo.psmux --exact --source winget --scope user
winget install --id Zellij.Zellij --exact --version 0.45.1 --source winget
```

The Zellij user-scope selection returned an older portable package in this
environment. It was removed and replaced with the pinned 0.45.1 MSI. Do not
assume a successful installation selected the requested current version.

Actual executable locations on the tested host:

```text
C:\Users\ylzz1\AppData\Local\Microsoft\WinGet\Packages\marlocarlo.psmux_Microsoft.Winget.Source_8wekyb3d8bbwe\psmux.exe
C:\Users\ylzz1\AppData\Local\Zellij\zellij.exe
```

Open a new shell after installation to pick up PATH changes. psmux also installs
`pmux.exe` and `tmux.exe` aliases; discovery must avoid showing the same backend
twice.

## Reproduction and evidence

```powershell
npm ci
npm run check
npm run test:windows
```

The suite is `test/windows-capabilities.ts`. Its default uses
`useConptyDll: true`. To compare the system ConPTY implementation:

```powershell
$env:MUXDOCK_TEST_CONPTY_DLL = '0'
npm run test:windows
Remove-Item Env:\MUXDOCK_TEST_CONPTY_DLL
```

The initial full audit completed **51 checks: 45 passed, 6 failed**. The six
failures are two cwd probes on each backend, Zellij's single-action
disconnect-all probe, and Zellij's renamed-session probe. The paired-pipe
disconnect-all alternative passed. `npm run check` also passed. The audit
intentionally exits with code 1 while these capabilities remain failing.

After isolating Windows PTYs, the full audit was rerun: **44 passed, 7 failed**.
The additional failure was intermittent psmux behavior under the larger workload:
one `detach-client -s` request left one of two clients attached after five seconds.
The production adapter retries the same session-scoped request and verifies zero
remaining clients; its two-client acceptance test also checks foreground work
continues with the same shell PID. The capability probe deliberately keeps its
single-request result as a failure rather than hiding this backend limitation.

Each run saves `report.json`, `commands.json`, pane/window metadata, `.ansi`
transcripts and rendered `.txt` output under
`.test-results/windows-capabilities/<run-id>/`. The complete latest result is
also copied to `.test-results/windows-capabilities-latest.json`. These generated
files are intentionally ignored by Git.

Tests use a unique psmux `-L` namespace and `PSMUX_DATA_DIR`, a unique Zellij
`ZELLIJ_SOCKET_DIR`, isolated configuration/cache directories and generated
session names. Cleanup never invokes a global Zellij kill or an unqualified
psmux kill-server. It leaves the installed tools available to the user.

## Observed capability matrix

| Capability | psmux 3.4.0 | Zellij 0.45.1 |
| --- | --- | --- |
| Create, list and attach sessions | Pass | Pass |
| PowerShell 7, Windows PowerShell 5.1, CMD | Pass | Pass |
| Unicode session names and paths with spaces, apostrophes, `&`, brackets | Pass | Pass |
| Unicode text input/output and ANSI colors | Pass | Pass |
| Bracketed paste with literal special characters | Pass | Pass |
| PTY resize reaches the pane | Pass | Pass |
| Native keyboard detach preserves a running task | Pass | Pass |
| PTY close preserves a running task | Pass | Pass |
| Separate PTY host process exits; session and task survive | Pass | Pass |
| Reattach to the same shell; startup executes once | Pass | Pass |
| Multiple clients on one session | Pass | Pass |
| Disconnect all using a single CLI action | **Intermittently partial under load; retry and verify client count** | **Partial: `action detach` released one of two clients** |
| Disconnect all using versioned IPC | CLI sufficient | Pass with paired Windows named pipes |
| Machine-readable window/tab listing | Pass | Pass |
| Create, rename, select and close a window/tab by ID | Pass | Pass |
| Split, inspect, capture output and close a pane | Pass | Pass |
| Rename a session and continue querying/reattaching | Pass; session ID retained | **Fail after rename on this release** |
| End a session without ending unrelated sessions | Pass | Pass |
| Initial working directory in pane metadata | Pass | Pass |
| Live PowerShell location after `Set-Location`, no shell integration | **Stale launch directory** | **Stale launch directory** |
| Update native cwd metadata by emitting OSC 7 through this stack | **Not observed** | **Not observed** |

Persistence assertions use a foreground PowerShell loop continuously updating a
heartbeat file, then verify progress while detached and compare shell PIDs after
reattaching. The separate-host test creates a new session from another Node
process, kills that host process, checks continued heartbeat progress and
reattaches. These checks establish live process continuity, not merely saved
layouts or rediscovered session names.

## Integration decisions supported by the audit

### psmux

- Give psmux its own manager ID, executable and settings, while sharing verified
  tmux-compatible command/format code.
- Keep targets qualified by session. Window IDs such as `@1` can appear under
  more than one psmux session. The existing session/window pair is significant.
- Use window/pane target syntax correctly: `session:window.pane`. A target like
  `session:%pane-id` is interpreted as a window target and rejected.
- Normalize CRLF in native output and retain UTF-8 decoding.
- Treat detach as asynchronous: wait for clients to exit and the target's client
  count to reach zero before reporting completion.
- Pass shell argv after `--`; without it psmux reparses quoted command arguments.
  Interactive attach and `detach-client -s` use the current session name; the
  native `$N` ID remains the tree identity and scopes window/detail/kill targets.
  Attaching by ID passed the direct harness but failed in the packaged Cursor
  host after closing a tab; attaching by name passed the editor regression.

### Zellij

- Reuse the existing session adapter for supported operations. The installed
  version also supports tab navigation through `list-tabs --all --json`,
  `new-tab`, `rename-tab-by-id`, `go-to-tab-by-id` and `close-tab-by-id`.
- The tab identifier is JSON field `tab_id`, not `id`. Pane IDs are distinct
  from plugin IDs; retain the `terminal_`/`plugin_` distinction for CLI targets.
- Read pane title, launch/current command and cwd through
  `list-panes --all --json`. Missing fields should stay unavailable rather than
  making the whole details view fail.
- Keep session rename disabled for Windows Zellij 0.45.1. The discovery name
  changes, but subsequent commands addressed to the new name hang. Upstream's
  unreleased changelog lists the Windows renamed-session fix (#5513); require a
  released version and a passing retest before enabling it.
- A session-level `action detach` is not equivalent to disconnect-all. With two
  attached clients, the tested command left one attached.
- Contract v1 disconnect-all works when both Windows pipes are connected:
  `\\.\pipe\<socket-path>` and `\\.\pipe\<socket-path>-reply`. Send the
  length-prefixed protobuf `DetachSession` containing the observed client IDs,
  then verify that those clients exited and unrelated clients remain connected.
  Connecting only the command pipe can desynchronize later CLI replies. This
  must be a Windows-specific transport, gated to the verified contract version.
- Windows socket marker files contain the server PID. Validate ownership and
  identity before using that value; do not port Unix `ps`/`lsof` inspection or
  signal-based client termination without a Windows implementation.
- The production test exposed another 0.45.1 timing limitation: creating a tab
  before a reattaching client finishes terminal negotiation can yield a tab
  with zero dimensions, followed by a server panic when attaching. MuxDock
  connects before creating tabs and waits for `list-clients` to report an
  interactive client. CLI queries from one adapter are serialized on Windows.

### PTY, shell and paths

- `node-pty` 1.1.0 loaded and ran real sessions on this machine. The default
  system-ConPTY close path emitted `AttachConsole failed` from its console-list
  helper during the baseline run. The bundled ConPTY DLL mode passed the tested
  lifecycle operations without that error. Package and test the required native
  binaries/DLLs; this audit does not prove every ConPTY issue is resolved.
- Windows PowerShell's script execution policy prevented the first `.ps1`
  bootstrap. The final shell-selection test uses its supported encoded-command
  argument instead, without changing persistent or process execution policies.
  MuxDock's startup-command design must account for this rather than assuming
  every shell can execute a generated script file.
- PowerShell launchers now use `-NoExit -EncodedCommand`; CMD uses `/k call`
  with a cached UTF-8 `.cmd` file. Quoted paths with spaces, Unicode, apostrophes
  and `&` are covered by the production integration suite. No execution-policy
  setting is changed.
- Rapid concurrent closes reproduced node-pty 1.1.0's native access violation
  in its shared Windows handle vector (upstream #921). It can also retain the
  ConPTY output worker after natural exit. MuxDock now runs one native PTY per
  helper process: concurrent clients do not share that vector, and helper exit
  releases its workers/handles. Parent IPC loss terminates only the attached
  client. The portable unit suite covers natural exit and rapid close; Unix
  keeps its native/Python fallback paths.
- Initial cwd metadata is reliable in these tests; a PowerShell provider
  location change is not automatically reflected in the backend metadata.
  Explicitly distinguish a launch-directory fallback from a confirmed current
  directory when resolving relative links.
- The emitted OSC 7 probe did not reach the outer transcript or update the
  native metadata in the tested stack. Do not advertise automatic cwd tracking
  from that probe. A Windows shell-integration solution needs its own validation.

## Extension validation and remaining coverage

- TypeScript checks and the portable unit suite pass on Windows. The suite
  covers executable discovery, shell commands, version gating, CRLF parsing,
  named-pipe framing, file links, literal quoting, connections and PTY I/O.
  POSIX shell execution and the Unix Python driver are skipped on Windows;
  their command-construction tests run.
- Production integration passes all eight backend/shell groups: three shells
  per backend plus window/tab actions and two-client lifecycle per backend.
  Windows details work without Python. Session rename stays disabled on Zellij.
- The VSIX installs and runs in isolated Windows VS Code 1.144.0 and Cursor
  3.26.16 profiles, including
  native module loading, discovery, creation, Unicode input, details, capability
  menus, window/tab selection, close/reattach, simulated Explorer file drops
  with literal special characters, and editor reload. Each editor passed seven
  grouped checks. The normal VS Code installation was locked by its updater;
  VS Code was tested using an official portable build in `.vscode-test`.
- Physical clipboard shortcuts, actual Explorer drag gestures, complete layout
  regression and all Windows versions still need broader coverage. Synthetic
  drop tests do not replace a physical drag gesture.
- Physical Chinese IME composition. Injected Unicode text is covered; operating
  the IME itself is not.
- Windows ARM64 and other supported Windows versions.
- Unix adapters retain portable parser/command tests. Actual macOS/Linux backend
  and editor execution was not rerun on this Windows host.

Sources: [psmux compatibility](https://github.com/psmux/psmux/blob/master/docs/compatibility.md),
[Zellij CLI actions](https://zellij.dev/documentation/cli-actions),
[Zellij v0.45.1 Windows transport](https://github.com/zellij-org/zellij/blob/v0.45.1/zellij-client/src/os_input_output_windows.rs),
[Zellij contract v1](https://github.com/zellij-org/zellij/blob/v0.45.1/zellij-utils/src/client_server_contract/client_to_server.proto),
[Zellij changelog](https://github.com/zellij-org/zellij/blob/main/CHANGELOG.md),
[node-pty Windows handle race](https://github.com/microsoft/node-pty/issues/921),
[node-pty natural-exit resource lifetime](https://github.com/microsoft/node-pty/issues/965).

## Herdr and tmux-windows addition (unreleased)

Measured on the same Windows x64 host on 2026-10-30. The working tree adds
Herdr as a manager and enables native tmux-windows under the existing `tmux`
manager. These changes are not part of the published 0.0.14 package.

Official release archives were downloaded and their published SHA-256 digests
verified before extraction into user-local directories. Both directories were
added to the user PATH:

| Backend | Tested release | Executable |
| --- | --- | --- |
| Herdr | 0.9.5 | `%LOCALAPPDATA%/Programs/Herdr/bin/herdr.exe` |
| tmux-windows | v3.6a-win32.7 (`tmux 3.6a-win32`) | `%LOCALAPPDATA%/Programs/tmux-windows/tmux.exe` |

| Capability | Herdr 0.9.5 | tmux-windows 3.6a-win32.7 |
| --- | --- | --- |
| Discover, create, list and attach | Pass; running sessions only | Pass; psmux's `tmux.exe` alias excluded |
| PowerShell 7, Windows PowerShell 5.1, CMD | Pass | Pass |
| Saved startup command executes once | Pass | Pass |
| Interactive input and resize | Pass | Pass |
| Client close, heartbeat progress and same shell PID on reconnect | Pass | Pass |
| Ctrl+C in PowerShell 7 and further input after reconnect | Pass | Pass |
| Create, rename, select and close tabs/windows by stable ID | Pass; workspace-qualified tab IDs | Pass; native window IDs |
| Session details | Pane cwd, shell PID, processes, Agent status | Native session and pane metadata |
| Rename session | Disabled; no supported CLI operation | Pass; session ID retained |
| Disconnect all clients | Disabled; no verified session-wide operation | Pass with two clients |
| Stop only the requested session | Pass; saved layout retained | Pass |
| Unicode session/window names | ASCII session names; Unicode tab labels pass | Unsupported in tested CLI; guarded before mutations |
| Unicode startup directory | Pass, including spaces, apostrophe, `&`, brackets | Unsupported in tested port; guarded before creation |
| Unicode input and simulated literal Explorer file drops | Pass | Pass |
| Editor reload and reconnect | Pass in VS Code and Cursor | Pass in VS Code and Cursor |

### Implementation findings

- Herdr session discovery includes a stopped `default` placeholder and saved
  stopped sessions. MuxDock shows running sessions and rejects creation with
  any already-known name, including a saved stopped session. Names use
  `[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}`.
- New Herdr sessions copy the existing TOML configuration into extension
  storage, setting `terminal.default_shell` and disabling onboarding in that
  copy. User configuration is preserved. The native launcher creates the
  initial workspace in the requested directory; `pane run` submits the saved
  startup command once. It is never retried after a lost acknowledgement.
- Herdr must daemonize through its own launcher. Direct Node child processes
  died on editor reload; `detached: true` instead caused descendant shells to
  ignore Ctrl+C. A temporary PTY client now uses Herdr's own Windows daemon
  startup, including its escape from kill-on-close jobs, and is released after
  initialization. Backend and editor acceptance tests pass with this path.
- Herdr attaches its full TUI. MuxDock exposes its sessions and tabs, including
  workspace labels when multiple workspaces exist. It does not implement the
  native browser interface, direct pane rendering or Agent notifications.
- Native tmux discovery checks the version banner and continues past psmux's
  `tmux.exe` alias. Both managers can coexist without duplicate discovery.
- tmux-windows joins pane shell argv with spaces before `CreateProcessW`.
  MuxDock supplies the missing Windows argument quoting. A shell with no args
  needs an empty extra argv to avoid the port's single-argument `/c` path.
- The tested tmux port corrupts Unicode CLI names and fails Unicode startup
  directories. This differs from Unicode terminal input, which passed. MuxDock
  rejects affected names, shell argv and startup directories with a localized
  explanation. Native tmux also does not supply trusted live Windows cwd
  tracking; relative file links use the extension's existing fallback paths.

### Reproduction and acceptance results

```powershell
npm run check
npm test
npm run test:windows:new-backends
$env:MUXDOCK_TEST_BACKEND = 'herdr'
npm run test:windows:new-backends
Remove-Item Env:\MUXDOCK_TEST_BACKEND
npm run test:windows:integration
npx vsce package --no-dependencies --out artifacts/muxdock-development.vsix
$env:MUXDOCK_USE_VSIX = 'artifacts/muxdock-development.vsix'
$env:MUXDOCK_TEST_MANAGERS = 'tmux,herdr'
npm run test:ui:windows
$env:MUXDOCK_TEST_EDITOR = 'cursor'
npm run test:ui:windows
```

- Portable unit suite: **65 passed, 4 platform skips, 0 failed**. TypeScript
  checks pass. The skips cover POSIX-only execution on this Windows host.
- New production integration: **4 groups per backend**, covering the three
  shells and lifecycle/tab operations. Herdr was rerun after the daemon-start
  fix with a Unicode/special-character evidence directory.
- Existing psmux/Zellij production regression: **8 groups passed**. This caught
  and fixed a shared command-construction regression where the new tmux ASCII
  guard was accidentally evaluated for psmux CMD launch arguments.
- Packaged VSIX in isolated VS Code and Cursor profiles: **7 grouped checks
  per editor**, covering both new managers, Unicode input, simulated literal
  file drops, native details, capability menus, window/tab actions,
  close/reattach and reload. A development package is used; the published
  release artifact remains untouched. VS Code's installed updater lock was
  bypassed by testing the existing official portable build.
- Same-PID/in-memory reload assertions are included in the editor harness.
  Both editors passed these assertions for both backends. The final editor
  reports are `md_ui_vscode_1793356258582/result.json` and
  `md_ui_cursor_1793356341476/result.json` under `.test-results/`.
  Full machine restart, physical IME/drag gestures, Windows ARM64 and actual
  macOS/Linux Herdr execution remain outside this Windows run.

Generated transcripts, command JSON and editor screenshots are retained in
`.test-results/md_new_*` and `.test-results/md_ui_*` and are ignored by Git.
Each test uses its own sessions, tmux socket namespace and Herdr data/config
directories, then terminates only those resources.

Sources: [Herdr CLI reference](https://herdr.dev/tui/docs/cli-reference/),
[Herdr 0.9.5 release](https://github.com/herdrdev/herdr/releases/tag/v0.9.5),
[Herdr Windows daemon implementation](https://github.com/herdrdev/herdr/blob/v0.9.5/src/platform/windows.rs),
[tmux-windows README](https://github.com/arndawg/tmux-windows/blob/master/README_WIN32.MD),
[tmux-windows release](https://github.com/arndawg/tmux-windows/releases/tag/v3.6a-win32.7).
