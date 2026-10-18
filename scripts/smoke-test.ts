// Starts a built app and fails if it closes within its first seconds or never draws its interface, so a build that
// compiles but crashes or comes up blank on start never reaches users through an update. CI runs it on every build,
// after making the build. The app reports its interface has drawn by writing to the file named in
// FLARE_TOOLS_SMOKE_TEST, which nothing but this test sets.
//
//   node scripts/smoke-test.ts <installer or program>
//
// An installer (*-setup.exe) is installed silently into a scratch folder first, which also runs the installer's hooks,
// and the app it installed is started. Anything else is started as it is. It proves the app starts and draws its
// interface, not that every screen works.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

/** How long the app has to stay open. Long enough to load the interface and read its data. */
const SECONDS = 20;

const [file] = process.argv.slice(2);
if (!file) {
  console.error("Usage: node scripts/smoke-test.ts <installer or program>");
  process.exit(1);
}

try {
  const program = basename(file).endsWith("-setup.exe") ? install(resolve(file)) : resolve(file);
  await staysOpen(program);
} catch (error) {
  console.error(`\n${error instanceof Error ? error.message : error}`);
  process.exit(1);
}

/** Installs silently into a scratch folder and returns the app it installed. */
function install(installer: string): string {
  const dir = mkdtempSync(join(tmpdir(), "flare-tools-smoke-"));
  // NSIS takes the folder as the last argument, unquoted, even with spaces in it.
  const result = spawnSync(installer, ["/S", `/D=${dir}`], { stdio: "inherit" });
  if (result.error) throw new Error(`The installer couldn't be started: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`The installer failed with exit code ${result.status}.`);
  const programs = readdirSync(dir).filter((name) => name.endsWith(".exe") && name !== "uninstall.exe");
  if (programs.length !== 1) throw new Error(`Expected one program in ${dir}, found: ${programs.join(", ") || "none"}`);
  console.log(`Installed ${programs[0]} into ${dir}`);
  return join(dir, programs[0]);
}

/** Starts the app, fails if it exits within SECONDS or hasn't drawn its interface, then closes it and all it started. */
async function staysOpen(program: string): Promise<void> {
  const ready = join(mkdtempSync(join(tmpdir(), "flare-tools-ready-")), "ready");
  const child = spawn(program, [], { stdio: "inherit", env: { ...process.env, FLARE_TOOLS_SMOKE_TEST: ready, FLARE_NO_AUTO_UPDATE_CHECK: "1" } });
  const exited = new Promise<string>((done) => {
    child.on("error", (error) => done(`couldn't be started: ${error.message}`));
    child.on("exit", (code, signal) => done(`closed after starting (${signal ?? `exit code ${code}`})`));
  });
  const timer = new Promise<null>((done) => setTimeout(() => done(null), SECONDS * 1000));
  const failure = await Promise.race([exited, timer]);
  if (failure) throw new Error(`The app ${failure}.`);

  console.log(`The app stayed open for ${SECONDS} seconds.`);
  spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  await exited;
  if (!existsSync(ready)) throw new Error("The app's window never drew its interface.");
  console.log("The app drew its interface.");
}
