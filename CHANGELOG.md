# Changelog

## 0.0.14

- Add native Windows support for psmux and Zellij, including bundled ConPTY binaries, executable discovery and PowerShell/CMD startup commands.
- Add psmux as a separate manager with session rename, window navigation, details and targeted disconnect-all.
- Add Zellij 0.45.1+ tab navigation and native Windows details. Use paired named pipes for disconnect-all on verified Windows 0.45.1; keep session rename disabled.
- Support Windows file links and shell-specific file-drop quoting. Explain the backend's stale working-directory limitation in session details.

## 0.0.13

- Keep terminal content stable when resizing the dock or session sidebar, including applications such as Codex.
- Fill unused space at the bottom and right edges with the terminal theme background to avoid dark gaps.

## 0.0.12

- Add ten interface languages with editor-language detection, English fallback and an immediate language switch that preserves open terminals and UI state. Localize commands, settings, dialogs, search, session details and accessibility labels.

- Accept file drops across the whole active terminal area, including its header, footer and padding; highlight the drop area and clarify when to press Shift.

## 0.0.11

- Align Powerline separator arrows with the full terminal cell height, including after font changes, selection and redraws.
- Fix consecutive file drops by preserving the webview drag/drop lifecycle and deferring terminal focus until after each drop.
- Keep wrapped web URLs and file paths complete when opening them from any continuation row, including multiplexer redraws that lose soft-wrap markers.

## 0.0.10

- Preserve drag/drop event propagation to the webview shell and defer terminal focus until after the drop, so consecutive file drops keep working.
- Insert shell-quoted file and folder paths when Shift-dragging from the editor Explorer into an active terminal, including multiple selections and remote workspace resources. Shift is required by the editor to forward drops into webviews.
- Add batch selection from the session panel's More actions menu, with select-all, disconnect-all clients and a single confirmation for ending selected sessions. Preserve selections across refreshes and report partial failures.
- Bundle a Powerline symbol fallback font so shell prompt arrows and branch symbols render correctly with ordinary terminal fonts in VS Code and Cursor.

## 0.0.9

- Add session details for all seven managers, including working paths, process IDs, creation times, current commands and connection information where available; add per-window/pane details for tmux, refresh and copy actions.
- Add per-session **Disconnect all connections** for all seven managers, releasing external clients while preserving background programs and unrelated sessions.
- Mark disconnected terminals with a muted red status circle and underline on active and inactive tabs; clear both when reconnecting.
- Match the editor terminal's minimum contrast setting so text remains readable on application backgrounds and light themes; apply setting changes to open terminals immediately.
- Open terminal folder links as projects in a new VS Code or Cursor window with Cmd-click on macOS or Ctrl-click on Windows/Linux.

## 0.0.8

- Reduce the default terminal font size to 12px and add direct font-setting entries in the terminal context menu and session panel's More actions menu. Preserve custom font settings and apply changes immediately.

## 0.0.7

- Refresh attachment status after clients actually exit, including closed and retained tabs, and repeat in-flight refreshes when connection state changes so stale hollow indicators clear.
- Keep the tmux current-window green marker anchored to its own icon and clipped with its row while scrolling the session tree.
- Keep search navigation and close controls visible when the terminal panel is both narrow and short.

## 0.0.6

- Prevent handled paste shortcuts from also reaching the editor, fixing duplicate pastes while preserving repeated intentional pastes and native/context-menu paste.
- Replace the terminal search strip with a compact floating find widget, including case/whole-word/regex options, match counts and highlights, previous/next navigation, validation and keyboard shortcuts.

## 0.0.5

- Support Cmd/Ctrl-click and destination previews for plain URLs, OSC 8 hyperlinks and existing file paths with line/column navigation. Add link copying actions and preserve terminal text selection and application mouse handling.
- Advertise tmux client hyperlink/truecolor capabilities and preserve macOS Ctrl+F for terminal applications.

## 0.0.4

- Replace the toolbar disconnect button with a default shell/startup command picker. Discover installed shells, start with the system default, and remember custom commands for new sessions across all seven managers.
- Handle OSC 52 clipboard writes from terminal applications so application-managed copy shortcuts work in VS Code and Cursor.
- Ignore clipboard requests from background or closed terminals and history replay, and reject clipboard reads and malformed payloads.

## 0.0.3

- Preserve the session tree's scroll position when selecting sessions, switching tabs and refreshing.
- Allow Option-drag text selection on macOS when a terminal application captures the mouse, and preserve the clipboard when copying without a selection.
- Use Unicode 11 character widths so emoji render and copy without extra padding spaces.

## 0.0.2

- Fix zmx session discovery when list output indents each row, so every session appears in the tree.

## 0.0.1 — Initial release

- Add a dedicated dock with an interactive terminal on the left and a manager/session tree on the right.
- Support tmux, zmx, screen, Zellij, shpool, abduco and a4.
- Create, attach to and detach from named sessions; offer session termination and renaming where supported by the backend.
- Browse, select, create, rename and close tmux windows while preserving native shortcuts and pane layouts.
- Add terminal tabs with switching, closing, keyboard navigation, an optional tab bar and a configurable FIFO limit.
- Retain background sessions when closing or evicting tabs. Keep final output from naturally exited or detached clients.
- Remove matching terminal tabs after successfully ending a session from the tree.
- Add a collapsible session filter and configurable manager visibility/order, with immediate settings updates.
- Add a session-panel toggle beside the terminal toolbar actions, remembering panel visibility and width while keeping connections active.
- Support theme colors, ANSI palettes, truecolor, clipboard actions, terminal search and links.
- Fit the terminal to its actual available area so prompts, cursors and status bars remain visible at different panel heights and font sizes.
- Run on the workspace host, with bundled macOS PTY binaries and a Python PTY fallback for Linux hosts.
- Include a Marketplace icon and English documentation.
