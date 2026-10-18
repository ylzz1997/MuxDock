# Publishing MuxDock

The first release is **0.0.1**, with extension ID **muxdock.muxdock**. The same VSIX can be submitted to Visual Studio Marketplace and Open VSX.

## Prepare the package

Use Node.js 22 or later:

```sh
npm ci
npm run check
npm test
npm run package
```

The output is `artifacts/muxdock-0.0.1.vsix`. Packaging also runs the type check and build. The checked-in PNG icon is included automatically; rebuilding the icon is optional.

The README, changelog and Marketplace listing are in English. The extension's existing UI labels are unchanged. `package.json` contains the listing description, icon, banner and `muxdock` publisher ID.

## Visual Studio Marketplace

1. Register or sign in to the **muxdock** publisher in the [publisher management portal](https://marketplace.visualstudio.com/manage).
2. Upload `artifacts/muxdock-0.0.1.vsix` as a new Visual Studio Code extension.
3. Review the icon, description, README and license before publishing.

For authentication or automated publishing, follow the [official VS Code publishing guide](https://code.visualstudio.com/api/working-with-extensions/publishing-extension).

## Open VSX and Cursor

Cursor's extension library uses Open VSX. A Visual Studio Marketplace upload is a separate submission; follow the [Cursor team's extension-library announcement](https://forum.cursor.com/t/extension-marketplace-changes-transition-to-openvsx/109138) and the [Open VSX publishing guide](https://github.com/eclipse-openvsx/openvsx/wiki/Publishing-Extensions).

1. Sign in to Open VSX, connect the required Eclipse account and accept its Publisher Agreement.
2. Create an access token in your Open VSX account settings.
3. Create or obtain publishing rights for the **muxdock** namespace.
4. Upload the packaged VSIX using the `ovsx` CLI. The official guide documents namespace creation and publishing an existing package.
5. Verify the resulting listing and its availability in Cursor.

Keep credentials in your account or publishing environment. This repository does not require tokens to build or package the extension.

## Add the public repository later

Once the public repository exists, add its real `repository`, `homepage` and `bugs` URLs to `package.json`. Those fields are currently omitted intentionally.

If screenshots are added to the README, use publicly accessible HTTPS image URLs or let `vsce` resolve relative image paths against a real public repository. See the [Marketplace presentation guidance](https://code.visualstudio.com/api/references/extension-manifest#marketplace-presentation-tips).

## Local installation before release

In VS Code or Cursor, run **Extensions: Install from VSIX...** and select the package. Reload the editor and open MuxDock from the Command Palette. Install the extension on the workspace host when using Remote SSH, WSL or a container.
