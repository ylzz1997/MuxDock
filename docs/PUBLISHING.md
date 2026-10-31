# Publishing MuxDock

The current release is **0.0.16**, with extension ID **muxdock.muxdock**. The same VSIX can be submitted to Visual Studio Marketplace and Open VSX.

## GitHub Release automation

The [Release packages workflow](../.github/workflows/release.yml) builds both distributions on macOS with Node.js 22. It runs the type check and unit tests, verifies the packaged manifests, native binaries and executable permissions, then creates SHA-256 checksums.

1. Commit the intended release sources, including this workflow, and synchronize the version in `package.json` and `package-lock.json`.
2. Create a tag matching that version (`v0.0.16` or `0.0.16`, for example) on the release commit.
3. Publish a GitHub Release for that tag. Both normal releases and pre-releases trigger the workflow; saving a draft or pushing a tag alone does not.
4. When **Release packages** finishes, the release has three attachments: `muxdock-<version>.vsix`, `muxdock-iterm2-<version>.tgz`, and `SHA256SUMS.txt`.

The workflow builds the tagged commit and fails if the release tag or lockfile version disagrees with `package.json`. The iTerm2 archive includes Apple Silicon and Intel bindings and requires no Python interpreter. Install it as described in the [iTerm2 guide](ITERM2.md).

For a build preview, use **Actions → Release packages → Run workflow** and select a branch or tag. Download the `muxdock-<version>` artifact from that run; it is retained for 14 days. Manual runs only build and save artifacts. To retry an automatic release upload, use **Re-run failed jobs** on its release-triggered run; rerunning all jobs rebuilds the packages and replaces attachments of the same name.

Release uploads use GitHub's automatic `GITHUB_TOKEN` with `contents: write` only in the upload job. No custom secret is needed. Marketplace and Open VSX publication remain the separate steps below. The trigger follows GitHub's [`release: published` event](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#release).

## Prepare the package

Use Node.js 22 or later:

```sh
npm ci
npm run check
npm test
npm run package
```

The output is `artifacts/muxdock-0.0.16.vsix`. Packaging also runs the type check and build. The checked-in PNG icon is included automatically; rebuilding the icon is optional.

To reproduce the two-package release locally, also run `npm run package:iterm2`, then `node scripts/verify-release.mjs`. The latter validates both archives and writes `artifacts/SHA256SUMS.txt`.

The README, changelog and Marketplace listing are in English. The extension's existing UI labels are unchanged. `package.json` contains the listing description, icon, banner and `muxdock` publisher ID.

## First npm publication of the iTerm2 package

The iTerm2 distribution uses the unscoped public name `muxdock-iterm2`. It is built separately from the VS Code extension at the repository root. Verify your npm account's email and enable two-factor authentication before an interactive publication; see [npm's publishing requirements](https://docs.npmjs.com/creating-and-publishing-unscoped-public-packages/).

From the repository, prepare and inspect the exact archive, then log in and publish it:

```sh
npm run package:iterm2
npm publish ./artifacts/muxdock-iterm2-0.0.16.tgz --dry-run --access public --registry=https://registry.npmjs.org
npm login --registry=https://registry.npmjs.org
npm whoami --registry=https://registry.npmjs.org
npm publish ./artifacts/muxdock-iterm2-0.0.16.tgz --access public --registry=https://registry.npmjs.org
npm view muxdock-iterm2@0.0.16 version --registry=https://registry.npmjs.org
```

Complete login and any publishing verification in your own browser or terminal. The archive argument is intentional: a bare `npm publish` at the repository root targets the VS Code extension's `muxdock` package. Build this archive from the current sources; the earlier GitHub `v0.0.16` archive used the scoped name `@muxdock/iterm2` internally.

After a successful publication, users can run `npm install -g muxdock-iterm2` and `muxdock-iterm2 start`. The current GitHub Release workflow uploads GitHub assets; npm Trusted Publishing can be configured separately after the initial publication.

## Visual Studio Marketplace

1. Sign in with your Microsoft account at the [publisher management portal](https://marketplace.visualstudio.com/manage).
2. Create a publisher with ID **muxdock** and display name **MuxDock**, or select it if you already have publishing rights. The ID must match `package.json`.
3. Choose **New extension → Visual Studio Code** and upload `artifacts/muxdock-0.0.16.vsix`. For an existing listing, use its update action instead of creating another extension.
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
   npm exec --yes --package=node@22 --package=ovsx@1.3.0 -- ovsx publish artifacts/muxdock-0.0.16.vsix -p "$OVSX_PAT"
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
