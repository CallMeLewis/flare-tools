// Publishes Flare Tools' releases to GitHub and its update feed, with the release script every Flare app shares
// (@flare/release, in the flare-common repo beside this one). The build is made and published by the Release workflow
// (.github/workflows/release.yml), which runs when a v<version> tag is pushed.
//
//   node scripts/publish-update.ts release           (pnpm release) tag the commit and push the tag, once CI passed on
//                                                    it, which starts the Release workflow
//   node scripts/publish-update.ts publish           (the workflow) sign the installer, publish the GitHub release,
//                                                    then the update feed's channel files
//   node scripts/publish-update.ts feed <dir> [url]  sign a local build and write a feed to <dir>, for testing
//   node scripts/publish-update.ts check             (CI) go through publishing as far as it can without the signing key
//   node scripts/publish-update.ts keygen            create the signing key (once) and print its public key
//
// The feed is https://updates.darkzone.dev/flare-tools/, which must match the feed given to the updater plugin in
// src-tauri/src/lib.rs: latest.json for the stable channel and beta.json for the beta channel.
import { release } from "@flare/release";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const target = join(root, "src-tauri", "target");

await release({
  name: "Flare Tools",
  app: root,
  root,
  repo: "CallMeLewis/flare-tools",
  feed: "flare-tools",
  keyPath: process.env.FLARE_TOOLS_UPDATE_SIGNING_KEY ?? join(homedir(), ".flare-tools", "update-signing-key"),
  script: "node scripts/publish-update.ts",
  secretEnvironment: "release",
  // Beside this repo, as the app links to it, and on the tag in .flare-common-version.
  common: { dir: resolve(root, "..", "flare-common"), versionFile: join(root, ".flare-common-version") },
  // DSSignFile and pboProject only run on Windows, so the app only ships for Windows.
  builds: [
    {
      platform: "windows-x86_64",
      paths: (product, version) => [join(target, "release", "bundle", "nsis", `${product}_${version}_x64-setup.exe`)],
      uploadName: (version) => `Flare-Tools-Setup-${version}.exe`,
      buildWith: "pnpm dist",
    },
  ],
});
