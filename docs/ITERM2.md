# MuxDock for iTerm2

Manage persistent terminal sessions from iTerm2's Toolbelt sidebar. Select a session to attach in an iTerm2 tab; selecting it again focuses the existing connection. Terminal rendering, selection, fonts and keyboard input belong to iTerm2.

## Requirements

- macOS with iTerm2 and Node.js 20 or later.
- Enable **iTerm2 Settings → General → Magic → Enable Python API**. This is the name of iTerm2's automation server; **MuxDock does not require Python**.
- Install whichever session managers you use: tmux, zmx, screen, Zellij, Herdr, shpool, abduco or a4.

The service uses TypeScript/Node.js and connects directly to iTerm2's local API. Its macOS process inspector ships precompiled Node bindings for Apple Silicon and Intel; no Python interpreter or compiler is required on the target machine.

## Install and run

From the MuxDock repository:

```sh
npm install
npm run package:iterm2
npm install -g ./artifacts/muxdock-iterm2-0.0.16.tgz
muxdock-iterm2 doctor
muxdock-iterm2 start
```

Alternatively, run the unpacked build with `node artifacts/iterm2/dist/cli.cjs start`. Keep the service running while using the sidebar. On first connection, allow macOS Automation access to iTerm2 if prompted.

In iTerm2, select **View → Toolbelt → Show Toolbelt**, then enable **View → Toolbelt → MuxDock**. In Simplified Chinese, these are **显示 → 工具箱 → 显示工具箱** and **显示 → 工具箱 → MuxDock**. If iTerm2 was already showing the sidebar, MuxDock appears there directly.

To start MuxDock automatically at login, run `muxdock-iterm2 install` after installing the package at a stable path. To remove that login service, run `muxdock-iterm2 uninstall`. Uninstalling the service preserves backend sessions and configuration. The login service retries when iTerm2 is not running; it does not launch iTerm2 automatically.

## Using the sidebar

- Use the host selector at the top to switch between **Local** and **SSH** hosts. MuxDock automatically lists concrete `Host` aliases from `~/.ssh/config`, `/etc/ssh/ssh_config` and their `Include` files, including Chinese aliases. **Add SSH host…** also accepts a host alias or `user@hostname`.
- Expand a manager to browse sessions and supported child windows/tabs.
- Use **+** to create a session. The launch selector at the bottom chooses a shell or a saved startup command.
- Click a session to open/focus its native iTerm2 tab. Session connections are tagged so the service can rediscover them after restarting.
- Use the session's **…** menu for details, disconnect, rename and end-session actions, according to the manager's capabilities.
- **Disconnect this client** closes MuxDock's iTerm2 connection while leaving its backend session running. **Disconnect all clients** also detaches other clients of that backend session.
- Ending a session or closing a backend window requires confirmation. Batch actions use the same confirmation and capability checks.
- Filter, keyboard tree navigation, details, batch selection and all ten MuxDock languages share the VS Code frontend.
- In **… → MuxDock settings**, choose a setting and select **Next** to edit it. **New session directory** sets the starting directory for new sessions (for example, `~/Projects`); existing sessions keep their own working directory. **Managers in sidebar** controls which managers appear in the session list. Change fonts in iTerm2's own profile settings.

SSH hosts currently support **tmux and zmx on Linux/macOS**. Queries run over SSH and session clients open in native iTerm2 tabs. The remote host needs its session manager and a POSIX shell, but no Node.js, Python or MuxDock agent. Each host has its own new-session directory and saved startup commands. Switching hosts keeps existing terminal tabs and backend sessions running, and identical session names on different hosts remain separate.

The host list refreshes when you open the menu and during normal sidebar polling. It merges duplicate aliases, skips wildcard/negated patterns such as `Host *` and `!excluded`, and shows a config entry's source file on hover. Config entries are read-only in MuxDock; edit the SSH config to add or remove them. Discovery only reads files: it does not connect to every host or run `Match exec`/`ProxyCommand`. It lists aliases without evaluating conditional `Host`/`Match` blocks; destination-dependent `Include` paths cannot be enumerated. Selecting a host uses OpenSSH's original config, including its port, identity and jump-host settings.

If SSH needs a password, key passphrase or host-key confirmation, select **Log in via SSH terminal** from the host menu or connection error. Complete authentication in that normal SSH terminal, then refresh the sidebar. Background queries never accept an unknown host key automatically and do not collect passwords. MuxDock reuses a private OpenSSH control socket for up to ten idle minutes; an authenticated connection may remain available during that time. **Remove SSH host** removes a manually added entry and its settings, leaving open tabs and backend sessions intact.

Host selection is shared by this service's sidebar windows and is restored on restart. MuxDock does not automatically follow arbitrary SSH tabs or inherit VS Code Remote SSH/WSL/container hosts.

## Configuration and troubleshooting

Configuration and launchers are stored in `~/Library/Application Support/MuxDock/iTerm2/`. The login service writes `service.log` there. Configuration includes `language`, `defaultDirectory`, `visibleManagers`, `showUnavailable`, manager `executables` and `arguments`, and saved `launch` profiles. Stop the service before editing the file manually. Its `token` is a private sidebar credential; do not share it.

`muxdock-iterm2 start --config-dir PATH --port NUMBER` supports an isolated configuration. The default port is 41739 and is bound only to `127.0.0.1`. Both the sidebar URL and WebSocket require a private token; WebSocket connections also verify the page's origin. A second service on the same port fails instead of taking over the first.

Use `muxdock-iterm2 doctor` to check Node, iTerm2 and its API socket. If the API is unavailable, open iTerm2 and enable its API setting. MuxDock requests fresh credentials through macOS's built-in `osascript`; it does not disable iTerm2's authentication.

The VS Code extension keeps its existing PTY fallbacks. The separate iTerm2 distribution includes no Python scripts and its process inspection path never launches Python.
