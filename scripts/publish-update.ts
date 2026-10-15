// Publishes releases to GitHub. The build is made and published by the Release workflow
// (.github/workflows/release.yml), which runs when a v<version> tag is pushed.
//
//   node scripts/publish-update.ts release           (pnpm release) check the version is ready and CI passed on the
//                                                    commit (waiting for it if it's still running), tag the commit
//                                                    v<version> and push the tag, which starts the workflow
//   node scripts/publish-update.ts publish           (the workflow) sign the build, publish it as the GitHub release
//                                                    v<version>, then update the channel file on the update feed (needs
//                                                    `pnpm exec wrangler login`, or a Cloudflare API token in CI)
//   node scripts/publish-update.ts feed <dir> [url]  sign a local build and write a feed to <dir> instead of
//                                                    publishing, for testing; [url] is where <dir> will be served
//   node scripts/publish-update.ts check             (CI) go through publishing as far as it can without the signing
//                                                    key or uploading: find the build, read the notes, sign with a
//                                                    throwaway key and write the feed and the GitHub release notes
//   node scripts/publish-update.ts keygen            create the signing key (once) and print its public key
//
// The update feed is on Cloudflare R2, at https://updates.darkzone.dev/flare-tools/: the app's stable channel reads
// latest.json and its beta channel beta.json. A stable release is also published as beta.json when it is newer than
// the latest beta. Each channel file points at the installer attached to that version's GitHub release.
//
// The installer is signed with the private key (a repository secret in CI), and the signature is bound to the version.
// The app refuses an update whose signature does not match the public key in src-tauri/tauri.conf.json or whose
// signed version differs from the one the feed announces, so a tampered feed cannot push another installer.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { compareVersions, notesFor, versionProblem } from "./changelog.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// In CI the key comes from the TAURI_SIGNING_PRIVATE_KEY secret, which the Tauri CLI reads itself.
const keyFromEnv = Boolean(process.env.TAURI_SIGNING_PRIVATE_KEY);
const keyPath = process.env.FLARE_TOOLS_UPDATE_SIGNING_KEY ?? join(homedir(), ".flare-tools", "update-signing-key");
const repo = process.env.GITHUB_REPOSITORY ?? "CallMeLewis/flare-tools";
// The R2 bucket behind https://updates.darkzone.dev, shared with the other Darkzone apps, each under its own prefix.
// Must match FEED_URL in src-tauri/src/updater.rs.
const r2Bucket = process.env.FLARE_TOOLS_R2_BUCKET ?? "darkzone-updates";
const r2Prefix = "flare-tools";
const feedUrl = `https://updates.darkzone.dev/${r2Prefix}/`;
// Run through Node rather than the .bin shim, which on Windows is a .cmd that needs a shell, and a shell drops empty
// arguments and splits ones with spaces.
const tauri = join(root, "node_modules", "@tauri-apps", "cli", "tauri.js");
const wrangler = join(root, "node_modules", "wrangler", "bin", "wrangler.js");
const target = join(root, "src-tauri", "target");

/** The secrets the Release workflow gives this script, by the tool that needs each. */
const SECRETS = {
  signer: ["TAURI_SIGNING_PRIVATE_KEY", "TAURI_SIGNING_PRIVATE_KEY_PASSWORD"],
  github: ["GH_TOKEN", "GITHUB_TOKEN"],
  cloudflare: ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"],
};

/** The environment with only the given secrets, so no tool, or anything it runs, can read another's. */
function envFor(...keep: (keyof typeof SECRETS)[]): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const [tool, names] of Object.entries(SECRETS)) {
    if (!keep.includes(tool as keyof typeof SECRETS)) for (const name of names) delete env[name];
  }
  return env;
}

/** What each release ships. `platform` is the updater's key for it; `paths` are where Tauri may have built it. */
interface Build {
  platform: string;
  paths: (product: string, version: string) => string[];
  uploadName: (version: string) => string;
  buildWith: string;
}

/** A version ready to publish: its notes as "- " lines, and every build signed. */
interface Release {
  version: string;
  notes: string;
  builds: { platform: string; file: string; uploadName: string; signature: string }[];
  prerelease: boolean;
}

/** The parts of src-tauri/tauri.conf.json used here. */
interface TauriConfig {
  productName: string;
  plugins?: { updater?: { pubkey?: string } };
}

// DSSignFile and pboProject only run on Windows, so the app only ships for Windows.
const BUILDS: Build[] = [
  {
    platform: "windows-x86_64",
    paths: (product, version) => [join(target, "release", "bundle", "nsis", `${product}_${version}_x64-setup.exe`)],
    uploadName: (version) => `Flare-Tools-Setup-${version}.exe`,
    buildWith: "pnpm dist",
  },
];

const [command = "release", ...args] = process.argv.slice(2);

try {
  if (command === "keygen") keygen();
  else if (command === "feed") {
    const [dir, url = "http://127.0.0.1:8765/"] = args;
    if (!dir) throw new Error("Usage: node scripts/publish-update.ts feed <dir> [url]");
    const release = prepare();
    const out = resolve(dir);
    mkdirSync(out, { recursive: true });
    for (const build of release.builds) copyFileSync(build.file, join(out, build.uploadName));
    writeFileSync(join(out, channelFile(release)), JSON.stringify(manifest(release, url), null, 2) + "\n");
    console.log(`Wrote ${channelFile(release)} and ${release.builds.map((b) => b.uploadName).join(", ")} to ${out}`);
  } else if (command === "check") {
    check();
  } else if (command === "release") {
    const version = checkReady();
    await waitForCi();
    if (tagRelease(version)) {
      console.log(`\nThe Release workflow is now building ${version}. Follow it with: gh run watch`);
    } else {
      console.log(
        `\nv${version} was already on GitHub, so pushing it started nothing. To build it again, run the Release ` +
          "workflow from the Actions tab on main and enter the tag.",
      );
    }
  } else if (command === "publish") {
    const version = packageVersion();
    const live = await liveManifest(version);
    if (live) await finishFeed(version, live);
    else {
      const release = prepare();
      await publishRelease(release);
      await publishFeed(release);
    }
  } else throw new Error(`Unknown command "${command}". Use release, publish, feed, check or keygen.`);
} catch (error) {
  console.error(`\n${error instanceof Error ? error.message : error}`);
  process.exit(1);
}

function keygen(): void {
  if (existsSync(keyPath)) throw new Error(`A signing key already exists at ${keyPath}. Refusing to replace it.`);
  mkdirSync(dirname(keyPath), { recursive: true });
  run(process.execPath, [tauri, "signer", "generate", "--ci", "--password", "", "--write-keys", keyPath], envFor());
  console.log(`\nSigning key written to ${keyPath}. Back it up: without it no further updates can be shipped.`);
  console.log(
    `Public key for plugins.updater.pubkey in src-tauri/tauri.conf.json:\n${readFileSync(`${keyPath}.pub`, "utf8").trim()}`,
  );
  console.log(`\nFor the Release workflow: gh secret set TAURI_SIGNING_PRIVATE_KEY < ${keyPath}`);
}

function packageVersion(): string {
  return JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
}

/** The version's release notes as "- " lines, after checking the version is one the channels can carry. */
function releaseNotes(version: string): string {
  const problem = versionProblem(version);
  if (problem) throw new Error(problem);
  const items = notesFor(readFileSync(join(root, "CHANGELOG.md"), "utf8"), version);
  if (!items) throw new Error(`CHANGELOG.md has no "## ${version}" section.`);
  if (items.length === 0) throw new Error(`The "## ${version}" section of CHANGELOG.md has no "- " bullet points.`);
  return items.map((item) => `- ${item}`).join("\n");
}

/**
 * Publishing up to the upload, so a release script that no longer fits the build or the changelog fails on an ordinary
 * push rather than on release day. Signs with a throwaway key, since the real one is only given to the Release
 * workflow, and removes the signatures again.
 */
function check(): void {
  const scratch = mkdtempSync(join(tmpdir(), "flare-tools-release-check-"));
  try {
    const key = join(scratch, "key");
    run(process.execPath, [tauri, "signer", "generate", "--ci", "--password", "", "--write-keys", key], envFor());
    const release = prepare({ path: key, pubkey: readFileSync(`${key}.pub`, "utf8").trim() });
    for (const build of release.builds) rmSync(`${build.file}.sig`);
    const feed = JSON.stringify(manifest(release, `https://github.com/${repo}/releases/download/v${release.version}/`));
    console.log(`\n${channelFile(release)}:\n${feed}\n\nGitHub release notes:\n${githubNotes(release)}`);
    console.log(`\nReady to publish ${release.version}.`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * Checks the builds and their notes, then signs each build for this version: with the update signing key, or with
 * `testKey` and its public key when checking.
 */
function prepare(testKey?: { path: string; pubkey: string }): Release {
  const version = packageVersion();
  const notes = releaseNotes(version);
  const config: TauriConfig = JSON.parse(readFileSync(join(root, "src-tauri", "tauri.conf.json"), "utf8"));
  if (!testKey && !keyFromEnv && !existsSync(keyPath)) {
    throw new Error(`No signing key at ${keyPath}. Run: node scripts/publish-update.ts keygen`);
  }

  const found = BUILDS.map((build) => ({ ...build, file: build.paths(config.productName, version).find(existsSync) }));
  const missing = found.filter((build) => !build.file);
  if (missing.length > 0) {
    const steps = missing.map((build) => `  ${build.platform}: ${build.buildWith}`).join("\n");
    throw new Error(`Not built for ${version} yet. Build first:\n${steps}`);
  }

  const key = testKey ? ["--private-key-path", testKey.path] : keyFromEnv ? [] : ["--private-key-path", keyPath];
  const pubkey = testKey?.pubkey ?? config.plugins?.updater?.pubkey ?? "";
  const builds = found.map(({ platform, file: built, uploadName }) => {
    const file = built!; // Every build was found, or the check above stopped.
    const args = [tauri, "signer", "sign", ...key, "--password", "", "--app-version", version, file];
    run(process.execPath, args, envFor("signer"));
    const signature = readFileSync(`${file}.sig`, "utf8").trim();
    if (keyId(signature) !== keyId(pubkey)) {
      throw new Error("The signing key does not match plugins.updater.pubkey in src-tauri/tauri.conf.json.");
    }
    console.log(`Signed ${platform} build for ${version}`);
    return { platform, file, uploadName: uploadName(version), signature };
  });

  return { version, notes, builds, prerelease: version.includes("-") };
}

/**
 * The id of the key behind a Tauri public key or signature: both are base64 of a minisign file whose second line is
 * base64 of a two-byte algorithm, then the eight-byte key id.
 */
function keyId(base64: string): string {
  const line = Buffer.from(base64, "base64").toString("utf8").split("\n")[1] ?? "";
  return Buffer.from(line, "base64").subarray(2, 10).toString("hex");
}

function channelFile(release: Release): string {
  return release.prerelease ? "beta.json" : "latest.json";
}

function manifest(release: Release, baseUrl: string) {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return {
    version: release.version,
    notes: release.notes,
    pub_date: new Date().toISOString(),
    platforms: Object.fromEntries(
      release.builds.map((build) => [
        build.platform,
        { signature: build.signature, url: `${base}${build.uploadName}` },
      ]),
    ),
  };
}

/** A channel file on the live feed that already offers `version`, as published. */
async function liveManifest(version: string): Promise<{ name: string; text: string } | null> {
  for (const name of ["latest.json", "beta.json"]) {
    const text = await publishedText(name);
    if (text && JSON.parse(text).version === version) return { name, text };
  }
  return null;
}

/**
 * Publishing a version the feed already offers only finishes the feed, as when writing a stable release's beta.json
 * failed after its latest.json. A rebuilt installer has a new signature, so replacing the one on GitHub would break
 * updates for everyone the feed sends to it. Instead the channels still to update get the channel file that's live,
 * which points at the installer that's there.
 */
async function finishFeed(version: string, live: { name: string; text: string }): Promise<void> {
  console.log(`${version} is already on the update feed (${feedUrl}${live.name}), so its installer is left as it is.`);
  const file = join(target, "github-release", live.name);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, live.text);
  await writeChannels(version, file);
}

/**
 * The GitHub release v<version> with every build, made as a draft and only published once all of them are attached.
 * Running it again for the same version, before the feed offers it, replaces the builds.
 */
async function publishRelease(release: Release): Promise<void> {
  const tag = `v${release.version}`;
  const staging = join(target, "github-release");
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  const files = release.builds.map((build) => {
    const file = join(staging, build.uploadName);
    copyFileSync(build.file, file);
    return file;
  });
  const notesFile = join(staging, "notes.md");
  writeFileSync(notesFile, `${githubNotes(release)}\n`);

  if (gh(["release", "view", tag, "--json", "tagName"], true)) {
    gh(["release", "upload", tag, ...files, "--clobber"]);
    gh(["release", "edit", tag, "--notes-file", notesFile]);
  } else {
    const title = `Flare Tools ${release.version}`;
    gh(["release", "create", tag, ...files, "--draft", "--verify-tag", "--title", title, "--notes-file", notesFile]);
  }
  // Building an older tag again leaves the newest stable release as GitHub's latest.
  const latest = !release.prerelease && !(await newerPublished("latest.json", release.version));
  const channel = [release.prerelease ? "--prerelease" : "--prerelease=false", latest ? "--latest" : "--latest=false"];
  gh(["release", "edit", tag, "--draft=false", ...channel]);
  console.log(`Published the release ${tag}`);
}

/**
 * The GitHub release's notes: the users' notes, then a link to every commit since the previous release, for
 * developers. The app shows only the users' notes. A stable release links from the last stable one, so the link spans
 * the betas between them.
 */
function githubNotes(release: Release): string {
  const tagged = git(["ls-remote", "--tags", "--refs", "origin", "refs/tags/v*"], true)
    .split("\n")
    .map((line) => line.match(/refs\/tags\/v(.+)$/)?.[1])
    .filter((version) => version !== undefined);
  const previous = tagged
    .filter(
      (version) => compareVersions(version, release.version) < 0 && (release.prerelease || !version.includes("-")),
    )
    .sort((a, b) => compareVersions(b, a))[0];
  if (!previous) return release.notes;
  const compare = `https://github.com/${repo}/compare/v${previous}...v${release.version}`;
  return `${release.notes}\n\nEvery change since ${previous}: ${compare}`;
}

/** The channel file last, so the app never sees a version whose builds are not there yet. */
async function publishFeed(release: Release): Promise<void> {
  const builds = `https://github.com/${repo}/releases/download/v${release.version}/`;
  const file = join(target, "github-release", channelFile(release));
  writeFileSync(file, JSON.stringify(manifest(release, builds), null, 2) + "\n");
  await writeChannels(release.version, file);
}

/**
 * Writes a version's channel file to the channels it goes to. Beta users get a stable release too, unless a newer beta
 * is already out. A channel file already on this version or a newer one is left alone, so building an older tag again
 * doesn't take users back to it.
 */
async function writeChannels(version: string, file: string): Promise<void> {
  const names: string[] = [];
  for (const name of version.includes("-") ? ["beta.json"] : ["latest.json", "beta.json"]) {
    const published = await publishedVersion(name);
    if (published && compareVersions(published, version) > 0) {
      console.log(`Left ${name} on ${published}, which is newer than ${version}.`);
    } else if (published !== version) names.push(name);
  }
  if (names.length === 0) {
    console.log(`Every channel ${version} goes to already has it or something newer.`);
    return;
  }
  for (const name of names) {
    const object = `${r2Bucket}/${r2Prefix}/${name}`;
    const flags = ["--file", file, "--remote", "--content-type", "application/json", "--cache-control", "no-cache"];
    run(process.execPath, [wrangler, "r2", "object", "put", object, ...flags], envFor("cloudflare"));
  }
  console.log(`Published ${version} to ${names.map((name) => `${feedUrl}${name}`).join(" and ")}`);
}

/** The version in a channel file on the live feed, if it is newer than `version`. */
async function newerPublished(name: string, version: string): Promise<string | null> {
  const published = await publishedVersion(name);
  return published && compareVersions(published, version) > 0 ? published : null;
}

/** Version in a channel file on the live feed, or null if it has not been published. */
async function publishedVersion(name: string): Promise<string | null> {
  const text = await publishedText(name);
  if (!text) return null;
  const { version } = JSON.parse(text) as { version?: string };
  if (!version) throw new Error(`${feedUrl}${name} has no version.`);
  return version;
}

/** A channel file on the live feed as it's published, or null if it hasn't been. */
async function publishedText(name: string): Promise<string | null> {
  const response = await fetch(`${feedUrl}${name}?t=${Date.now()}`, { cache: "no-store" });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Could not read ${feedUrl}${name} (HTTP ${response.status}).`);
  return response.text();
}

/**
 * Every release is tagged and built from its tag, so the tag has to name what is meant to ship: refuse uncommitted or
 * unpushed work, missing notes, and a version whose tag already points at another commit.
 */
function checkReady(): string {
  const version = packageVersion();
  releaseNotes(version);
  if (git(["status", "--porcelain"])) throw new Error("Commit your changes before releasing: every release is tagged.");
  git(["fetch", "--quiet", "origin"]);
  // Release refuses a tag that isn't on main, but only once the tag is pushed and its version used up.
  const ancestor = ["merge-base", "--is-ancestor", "HEAD", "origin/main"];
  const onMain = spawnSync("git", ancestor, { cwd: root, env: envFor("github") }).status === 0;
  if (!onMain) throw new Error("Push this commit to main before releasing: releases are only made from main.");
  const tagged = git(["rev-parse", "--quiet", "--verify", `v${version}^{commit}`], true);
  if (tagged && tagged !== git(["rev-parse", "HEAD"])) {
    throw new Error(`Tag v${version} already points at another commit. Bump the version before releasing.`);
  }
  return version;
}

/**
 * Waits for CI on this commit, and refuses to tag it if CI failed. Release checks everything again itself, but by then
 * the tag is pushed, and a tag on a broken commit uses up its version: the fix is a new commit, which needs a new one.
 */
async function waitForCi(): Promise<void> {
  const commit = git(["rev-parse", "HEAD"]);
  // A run can take a few seconds to appear after a push.
  let found = ciRun(commit);
  for (let tries = 0; !found && tries < 12; tries++) {
    await sleep(5000);
    found = ciRun(commit);
  }
  if (!found) {
    throw new Error(
      `CI hasn't run on ${commit.slice(0, 7)}. It checks the newest commit of each push, unless only docs changed. ` +
        "Release from a commit CI has checked.",
    );
  }
  if (found.status !== "completed") {
    console.log(`Waiting for CI to finish on ${commit.slice(0, 7)}: ${found.url}`);
    spawnSync("gh", ["run", "watch", String(found.databaseId), "--interval", "10", "--repo", repo], {
      stdio: "inherit",
      env: envFor("github"),
    });
    found = ciRun(commit)!;
  }
  if (found.conclusion !== "success") {
    throw new Error(
      `CI didn't pass on this commit (${found.conclusion}), so it wasn't tagged: ${found.url}\n` +
        "Fix it in a new commit, push it, then run pnpm release again.",
    );
  }
  console.log(`CI passed on ${commit.slice(0, 7)}.`);
}

/** The latest CI run on a commit, if there is one yet. */
function ciRun(commit: string): { databaseId: number; status: string; conclusion: string; url: string } | undefined {
  const fields = "databaseId,status,conclusion,url";
  const runs = gh(["run", "list", "--workflow", "ci.yml", "--commit", commit, "--limit", "1", "--json", fields]);
  return JSON.parse(runs)[0];
}

/**
 * Tags the commit v<version>, like "Release 1.0.0", and pushes the tag, which starts the Release workflow. Returns
 * false when GitHub already had the tag, so nothing started: run the workflow again from the Actions tab instead.
 */
function tagRelease(version: string): boolean {
  const tag = `v${version}`;
  if (!git(["rev-parse", "--quiet", "--verify", `${tag}^{commit}`], true)) {
    run("git", ["tag", "--annotate", tag, "--message", `Release ${version}`], envFor("github"));
  }
  // Pushing a tag GitHub already has does nothing, and starts no workflow.
  if (git(["ls-remote", "--tags", "origin", `refs/tags/${tag}`])) return false;
  run("git", ["push", "origin", tag], envFor("github"));
  console.log(`Tagged ${tag}`);
  return true;
}

/** A git command's output. `allowFailure` returns "" instead of throwing, for lookups that may find nothing. */
function git(args: string[], allowFailure = false): string {
  return capture("git", args, allowFailure, envFor("github"));
}

/** A GitHub CLI command's output, run against this repository. */
function gh(args: string[], allowFailure = false): string {
  return capture("gh", [...args, "--repo", repo], allowFailure, envFor("github"));
}

function capture(file: string, args: string[], allowFailure: boolean, env: NodeJS.ProcessEnv): string {
  const result = spawnSync(file, args, { cwd: root, encoding: "utf8", env });
  if (result.status !== 0) {
    if (allowFailure) return "";
    throw new Error(`${file} ${args.join(" ")} failed:\n${(result.stderr || result.error?.message || "").trim()}`);
  }
  return result.stdout.trim();
}

function run(file: string, args: string[], env: NodeJS.ProcessEnv): void {
  const result = spawnSync(file, args, { stdio: "inherit", env });
  if (result.status !== 0) throw new Error(`${[file, ...args].join(" ")} failed.`);
}
