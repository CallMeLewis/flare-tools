# Development

Flare Tools is built with Tauri 2 (Rust), React, TypeScript, Tailwind CSS and shadcn/ui (Base UI). It only runs on
Windows, like the tools it drives.

## Running it

You need Node 24 with pnpm, and Rust (the version in `rust-toolchain.toml`, which rustup installs for you).

```sh
pnpm install
pnpm tauri dev      # run the app
pnpm dist           # build the installer
```

Settings and mods are stored in `%APPDATA%\com.darkzone.flaretools\data.json`, build history in the `builds` folder
next to it.

## Checks

CI (`.github/workflows/ci.yml`) checks and builds every push to main and every pull request: the release notes, the
frontend type check and build, `cargo fmt`, `cargo clippy` and `cargo test`. It then builds the installer, installs it
and checks the app stays open (`scripts/smoke-test.ts`), and runs `node scripts/publish-update.ts check` against it,
so a release script that no longer fits the build fails on an ordinary push rather than on release day.

## Updates

Installed copies update themselves from a feed on Cloudflare R2, at `https://updates.darkzone.dev/flare-tools/`:
`latest.json` for the stable channel and `beta.json` for beta, each pointing at the installer on its version's GitHub
release. A stable release also updates `beta.json` when it's newer than the latest beta. The app checks at start and
every six hours (unless turned off in Settings > About), and nothing downloads or installs until the user chooses to.

Development builds don't update themselves. To try the update flow, make a local feed with `pnpm release:feed <dir>`,
serve that folder over HTTP and start a debug build with `FLARE_TOOLS_UPDATE_TEST_URL` set to its address.

## Releasing

The version number tells users how much has changed. Updates only ever offer a higher version, so a number can't be
taken back once it's released. A beta takes the number of the release it leads to (`1.3.0-beta.1` before `1.3.0`).

1. `pnpm bump <version>` sets the version in `package.json` (which `tauri.conf.json` reads), `Cargo.toml` and
   `Cargo.lock`, and adds a dated section for it at the top of `CHANGELOG.md`. `1.2.0` is stable, `1.2.0-beta.1` is
   beta.
2. Write the release notes in that section, following [release-notes.md](release-notes.md).
3. Commit and push, then `pnpm release`. It waits for CI to pass on the commit, tags it `v<version>` and pushes the
   tag, which starts the Release workflow (`.github/workflows/release.yml`). That builds and signs the installer,
   publishes the GitHub release, then updates the feed.

To build a tag again, run the Release workflow from the Actions tab on main and enter the tag. It uses the release
script from main, so a fix to it is picked up. Once the update feed offers the version, running it again only finishes
the feed, such as a stable release's `beta.json` after writing it failed: replacing the installer would break updates.
To change what's shipped, release a new version.

The workflow needs these secrets, kept in the repository's `release` environment rather than as repository secrets.
The environment only lets main and `v*` tags use them, so a workflow on any other branch can't read them.

- `TAURI_SIGNING_PRIVATE_KEY`: the update signing key, kept at `~/.flare-tools/update-signing-key` (back it up:
  without it no further updates can be shipped). The app refuses an update whose signature or signed version doesn't
  match the public key in `src-tauri/tauri.conf.json`.
- `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`, for writing the feed to R2. The firewall on
  `updates.darkzone.dev` only lets through the paths each app uses, so `/flare-tools/*.json` has to stay allowed in it.
- `CERTUM_USERNAME` and `CERTUM_TOTP_SECRET`, for signing the installer with the code signing certificate, so Windows
  names the publisher instead of warning about an unknown one. `CERTUM_TOTP_SECRET` is only the `secret=` value of the
  `otpauth://` link SimplySign gave, not the whole link. The certificate expires on 2027-10-14; renewing it changes its
  thumbprint, which is in `build.yml`. To check signing without releasing, run the CI workflow from the Actions tab
  with "Sign the Windows build".
