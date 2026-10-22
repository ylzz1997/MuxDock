# MuxDock

**Persistent terminal sessions. One dock.**

MuxDock brings **tmux, zmx, screen, Zellij, shpool, abduco and a4** into a dedicated terminal panel in VS Code and Cursor. Work in the terminal on the left and browse managers, named sessions and tmux windows on the right.

Your sessions belong to the underlying manager. Close a tab, detach or reload the editor, then reconnect to continue working.

## Features

- **Seven managers in one place.** Discover installed tools and browse their existing sessions without replacing their configuration.
- **A real interactive terminal.** Keep native keyboard shortcuts, pane layouts, status bars, shell prompts, ANSI colors and truecolor output.
- **Drag files into the terminal.** Hold **Shift** while dragging files or folders from the editor Explorer into MuxDock (VS Code/Cursor require Shift to forward drops to extension webviews). Multiple selections are separated by spaces, special characters are shell-quoted, and paths are inserted without pressing Enter.
- **Session tabs.** Switch between open terminals, close individual tabs, hide the tab bar or set a maximum tab count.
- **Session details.** Inspect the working directory, process IDs, creation time, current command and attachment information from each session's menu. tmux windows also have their own details view, with information for each pane. Refresh or copy the details without attaching to the session.
- **Disconnect all clients.** Release every connection to a selected session, including external terminals, while preserving its background programs. Closed tabs keep their output and display a muted red underline and status circle.
- **Batch session actions.** Choose **批量操作** from the session panel's **…** menu, select sessions across managers, then disconnect their clients or end the sessions with one confirmation. Use the filter and select-all checkbox to narrow the selection; ending sessions requires manager support.
- **Default shell or command.** Choose the shell used for new sessions, or save a startup command such as `codex` in the terminal toolbar.
- **tmux window navigation.** Expand a session to select, create, rename or close its windows. Native shortcuts such as `Ctrl+B` keep working.
- **A compact session tree.** Open the filter with the magnifying glass, then collapse it when you are done. Choose which managers appear and in what order.
- **More room for the terminal.** Collapse the session panel with the button at the far right of the terminal toolbar. Expand it from the same button; its width and visibility are remembered.
- **Local and remote hosts.** Run the extension where your workspace lives, including Remote SSH, WSL and Dev Containers.

## Requirements

- VS Code **1.95 or later**, or a compatible Cursor version.
- A **macOS or Linux** extension host. On Windows, open a WSL or Linux Remote SSH workspace.
- At least one supported manager installed on that host. MuxDock discovers installed tools; it does not install them.
- **Python 3** on Linux hosts and on any host where the native PTY cannot be loaded. The extension includes native macOS PTY binaries for Apple Silicon and Intel.

Zellij, abduco and a4 also use Python 3 for session process inspection and disconnecting external clients on macOS and Linux. Details depend on the installed manager and host permissions; unavailable fields display **未提供**. Screen reports an attachment state because its session listing does not expose an exact client count.

The managers must be installed on the **workspace host**: locally for a local workspace, on the SSH host for Remote SSH, inside WSL for a WSL workspace, or inside the container for Dev Containers.

## Getting started

1. Install **MuxDock** from your editor's Extensions view, or run **Extensions: Install from VSIX...** and select `muxdock-0.0.11.vsix`.
2. Open the Command Palette, search for **MuxDock**, and open the dock (`muxdock.open`). You can also select the **MuxDock** panel tab.
3. Click a session in the right-hand tree to attach, or use the `+` beside a manager to create a named session.
4. Use the terminal icon and shell name in the toolbar to select the default shell for new sessions. It starts with the workspace host's system default shell. Choose **添加命令…** to save and select a command such as `codex`; it runs after shell initialization, and exiting the command returns to the shell. The selection and saved commands are remembered on that host. Use the × beside a saved command to remove it.
5. Expand a tmux session to browse its windows. Click a window to select it, or use its context menu for window actions.
6. Use the tabs above the terminal to switch between open sessions. Each tab shows its session name and manager.

Only installed managers are shown by default. After installing a tool, refresh the tree. If a binary is not on the extension host's search path, set its absolute path with `muxdock.executables`.

For example, a session tree can look like this:

```text
tmux
  backend
    0: api
    1: logs
zmx
  worker
screen
  training
```

## Session lifecycle

| Action | What happens |
| --- | --- |
| Switch tabs | Reuses an existing connection. |
| Close a tab | Removes that tab and detaches its client. The background session keeps running. |
| Detach from the session context menu | Disconnects the client and keeps its final output in a closed tab. |
| Disconnect all from the session context menu | Detaches all clients of that session, including external terminals, while preserving background work and other sessions. MuxDock keeps its final output in a closed tab. |
| Exceed the tab limit | Removes the earliest-opened tab and detaches its client. The background session keeps running. |
| End a session from the tree | After confirmation, ends the backend session and removes its terminal tabs. |
| A client exits on its own | Keeps its final output in a closed tab until you close or replace it. |
| Reload or close the editor | Releases MuxDock's clients. Reopen the dock and attach to available backend sessions. |

The default limit is **8 tabs**, including closed tabs. Selecting an existing tab does not change its position in the eviction order. The limit also applies when the tab bar is hidden.

Screen restoration and scrollback after reconnecting depend on the manager. In particular, abduco does not provide full screen restoration.

## Supported operations

| Manager | Create / attach / detach | End session | Rename session | Child navigation |
| --- | --- | --- | --- | --- |
| tmux | Yes | Yes | Yes | Windows |
| zmx | Yes | Yes | No | Sessions |
| screen | Yes | Yes | No | Sessions |
| Zellij | Yes | Yes | No | Sessions |
| shpool | Yes | Yes | No | Sessions |
| abduco | Yes | Use `exit` inside the session | No | Sessions |
| a4 | Yes | Use `exit` inside the session | No | Sessions |

- **tmux:** multiple clients attached to the same session share its current window. Selecting a window in MuxDock can also change the window shown by other clients.
- **shpool:** a session accepts one attached client. MuxDock does not force another client's connection to detach.
- New session names must start with a Unicode letter, digit or underscore. The remaining characters may also include hyphens and dots. For new tmux session names, use underscores instead of dots.
- This is a dedicated terminal panel. Tasks, debugging sessions and other extensions' terminal commands continue to use the editor's built-in Terminal.

## Settings

Search for **MuxDock** in Settings, or use `@ext:muxdock.muxdock`.

To adjust terminal text, right-click inside a terminal or open the session panel's **More actions** menu and choose **终端字体设置…**. Font size and font family changes apply immediately to open terminals; custom values are preserved when the default changes.

| Setting | Default | Description |
| --- | --- | --- |
| `muxdock.showTabs` | `true` | Show the terminal tab bar. Use the tree to switch sessions when hidden. |
| `muxdock.maxTabs` | `8` | Keep 1–50 tabs. When full, remove the earliest-opened tab and retain its background session. |
| `muxdock.visibleManagers` | All seven | Managers displayed in the tree, in list order. An empty array hides all managers without closing existing tabs. |
| `muxdock.showUnavailable` | `false` | Also show selected managers that are not installed. |
| `muxdock.refreshInterval` | `3` | Refresh interval in seconds while the panel is visible. |
| `muxdock.fontSize` | `12` | Terminal font size in pixels (8–40); applies immediately. |
| `muxdock.fontFamily` | Empty | Use the editor's terminal font when empty. |
| `muxdock.scrollback` | `10000` | Scrollback lines retained for each terminal. |
| `muxdock.defaultDirectory` | Empty | Use the workspace folder, or the user's home directory when no workspace is open. |
| `muxdock.executables` | `{}` | Absolute executable paths, keyed by manager ID. |
| `muxdock.arguments` | `{}` | Additional global arguments for each manager, as arrays. |

Font, tab and manager-visibility settings apply immediately. Changing a manager's executable or global arguments affects future connections; detach existing clients before switching backend configuration.

For example, show three managers, keep six tabs and connect to a named tmux server:

```json
{
  "muxdock.visibleManagers": ["tmux", "zmx", "screen"],
  "muxdock.maxTabs": 6,
  "muxdock.arguments": {
    "tmux": ["-L", "work"]
  }
}
```

Manager IDs are `tmux`, `zmx`, `screen`, `zellij`, `shpool`, `abduco` and `a4`. Arguments are passed directly to the executable, without shell interpolation.

## Navigation and terminal tools

- Click the magnifying glass beside the session heading to expand the filter. Click it again or press `Esc` to clear and collapse the filter.
- Use arrow keys to navigate the tree, Left/Right to collapse or expand nodes, and Enter to attach.
- Use Left/Right or Home/End to navigate focused terminal tabs. Press Enter to focus the terminal, or Delete to close the focused tab.
- Drag the divider between the terminal and session tree to resize it. The focused divider also accepts Left/Right keys.
- Use the rightmost terminal-toolbar button to hide or show the entire session panel. Existing terminal connections keep running, and tabs remain available while the panel is hidden.
- Use `Cmd+C/V` on macOS or `Ctrl+Shift+C/V` on Linux to copy and paste. Terminal context menus also provide clipboard actions.
- If a terminal application or multiplexer captures the mouse, hold `Option` on macOS or `Shift` on Linux while dragging to select text, then copy normally.
- Application copy commands that emit OSC 52 can write to the local clipboard from the active terminal, including remote workspace sessions. For tmux, enable `set -g set-clipboard on` for direct clipboard writes, or `set -g allow-passthrough on` for tmux-wrapped clipboard sequences.
- Hover over a URL or an application-generated hyperlink (OSC 8) to preview its full destination. Use `Cmd+click` on macOS or `Ctrl+click` on Windows/Linux to open it, or use the hover/context-menu actions to open or copy its address. Ordinary clicks and dragging remain available for selecting terminal text.
- Existing file paths and `file://` links open in the editor, including `src/main.ts:12:3` and `file:///path/main.ts#L12C3`. Folder paths open as projects in a new window of the current editor (VS Code or Cursor). Relative paths use the current tmux pane directory, shell-reported working directory (OSC 7), or the connection/workspace directory. Quote printed paths that contain spaces. tmux 3.4+ clients advertise hyperlink support automatically.
- Use `Cmd+F` on macOS or `Ctrl+F` on Linux to open the floating terminal find widget. Toggle case sensitivity, whole-word matching or regular expressions, view match counts and highlights, and use Enter/Shift+Enter, F3/Shift+F3 or the arrow buttons to move between matches. Escape closes find and returns focus to the terminal. Search options are remembered. On macOS, `Ctrl+F` is passed to the terminal application.

## Troubleshooting

**A manager is missing from the tree**

Check `muxdock.visibleManagers`, confirm the tool is installed on the workspace host, then refresh. If necessary, add its absolute executable path to `muxdock.executables`.

**A Linux terminal cannot start**

Confirm that `python3` is available to the extension host. The fallback uses Python's standard library and does not require additional Python packages.

**A shpool session is already attached**

Detach it from its existing client before opening it in MuxDock.

**More diagnostics are needed**

Open the MuxDock output channel using `muxdock.logs`. Include the editor version, workspace host OS, manager version and relevant log output when [reporting an issue](https://github.com/ylzz1997/MuxDock/issues).

## Source

Source code and development documentation are available in the [MuxDock repository](https://github.com/ylzz1997/MuxDock).

## License

MIT.
