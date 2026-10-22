# Publishing MuxDock

The current release is **0.0.9**, with extension ID **muxdock.muxdock**. The same VSIX can be submitted to Visual Studio Marketplace and Open VSX.

## Prepare the package

Use Node.js 22 or later:

```sh
npm ci
npm run check
npm test
npm run package
```

The output is `artifacts/muxdock-0.0.9.vsix`. Packaging also runs the type check and build. The checked-in PNG icon is included automatically; rebuilding the icon is optional.

The README, changelog and Marketplace listing are in English. The extension's existing UI labels are unchanged. `package.json` contains the listing description, icon, banner and `muxdock` publisher ID.

## Visual Studio Marketplace

1. Sign in with your Microsoft account at the [publisher management portal](https://marketplace.visualstudio.com/manage).
2. Create a publisher with ID **muxdock** and display name **MuxDock**, or select it if you already have publishing rights. The ID must match `package.json`.
3. Choose **New extension → Visual Studio Code** and upload `artifacts/muxdock-0.0.9.vsix`. For an existing listing, use its update action instead of creating another extension.
4. Review the imported icon, description, README and license, then submit the extension. Follow its validation status in the portal.

The browser upload route uses the prepared VSIX directly. After release, verify that `muxdock.muxdock` appears in VS Code's Extensions view.

For authentication or automated publishing, follow the [official VS Code publishing guide](https://code.visualstudio.com/api/working-with-extensions/publishing-extension).

## Open VSX and Cursor

Cursor uses Open VSX through its own marketplace proxy, so submit to Open VSX separately. See the [current Cursor extension documentation](https://cursor.com/help/customization/extensions) and the [Open VSX publishing guide](https://github.com/eclipse-openvsx/openvsx/wiki/Publishing-Extensions).

1. Sign in to [Open VSX](https://open-vsx.org/) with GitHub.
2. Create or link an [Eclipse account](https://accounts.eclipse.org/user/register), using the same GitHub username. In Open VSX **Settings**, sign in with Eclipse and accept the **Publisher Agreement** if you agree to its terms.
3. In **Settings → Access Tokens**, generate a publishing token.
4. In the local terminal, read the token into a variable without echoing it. Run this line, paste the token, then press Enter (macOS zsh):

   ```sh
   read -r -s OVSX_PAT
   ```

5. From the project directory, create the **muxdock** namespace and upload the prepared package. These commands explicitly run the CLI with a temporary Node.js 22 runtime, including when the system default is Node.js 20:

   ```sh
   npm exec --yes --package=node@22 --package=ovsx@1.3.0 -- ovsx create-namespace muxdock -p "$OVSX_PAT"
   npm exec --yes --package=node@22 --package=ovsx@1.3.0 -- ovsx publish artifacts/muxdock-0.0.9.vsix -p "$OVSX_PAT"
   unset OVSX_PAT
   ```

   Skip namespace creation if it already exists and you have publishing rights. If someone else owns it, resolve access or use an available publisher ID consistently in both registries and rebuild the VSIX.

   `ovsx` 1.3.0 and its `vsce` dependency require Node.js 22 or later. With an older system Node, npm may print engine warnings while downloading the temporary tools, but the commands above execute them under Node.js 22. Verify without publishing with `npm exec --yes --package=node@22 --package=ovsx@1.3.0 -- ovsx --version`. An `ERR_REQUIRE_ESM` under Node.js 20 indicates that the CLI was started with the wrong runtime.

6. Check the Open VSX listing, then search for **MuxDock** in Cursor. Cursor applies its own checks before offering extensions, so Open VSX publication alone does not confirm Cursor search availability. The CLI can also report registry validation failures; use its result before proceeding.

Keep credentials in your account or publishing environment. This repository does not require tokens to build or package the extension.

## Repository metadata

The manifest already contains the repository `https://github.com/ylzz1997/MuxDock.git`, its README homepage and its GitHub Issues URL. Push the release sources to that repository so the published package and public documentation match.

If screenshots are added to the README, use publicly accessible HTTPS image URLs or let `vsce` resolve relative image paths against a real public repository. See the [Marketplace presentation guidance](https://code.visualstudio.com/api/references/extension-manifest#marketplace-presentation-tips).

## Local installation before release

In VS Code or Cursor, run **Extensions: Install from VSIX...** and select the package. Reload the editor and open MuxDock from the Command Palette. Install the extension on the workspace host when using Remote SSH, WSL or a container.
