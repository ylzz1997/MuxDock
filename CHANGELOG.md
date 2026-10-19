# Changelog

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
