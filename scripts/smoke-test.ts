// Starts a built app and fails if it closes within its first seconds or its window doesn't show the app, so a build
// that compiles but crashes or comes up blank on start never reaches users through an update. CI runs it on every
// build, after making the build.
//
//   node scripts/smoke-test.ts <installer or program>
//
// An installer (*-setup.exe) is installed silently into a scratch folder first, which also runs the installer's hooks,
// and the app it installed is started. That only happens in CI, since installing writes to the registry and Start menu
// over any copy installed on the computer. Anything else is started as it is. It proves the app starts and shows its
// interface, not that every screen works.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

/** How long the app has to stay open. Long enough to load the interface and read its data. */
const SECONDS = 20;
/** WebView2 opens its DevTools port here, which is how the window is asked what it shows. */
const DEBUG_PORT = 9339;

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
  if (!process.env.CI) {
    throw new Error(
      "Installers are only tested in CI, since installing replaces this computer's copy of the app. " +
        "Give the built program instead, such as src-tauri/target/release/flare-tools.exe.",
    );
  }
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

/** Starts the app, fails if it exits within SECONDS or isn't showing the app, then closes it and all it started. */
async function staysOpen(program: string): Promise<void> {
  const env = { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${DEBUG_PORT}` };
  const child = spawn(program, [], { stdio: "inherit", env });
  const exited = new Promise<string>((done) => {
    child.on("error", (error) => done(`couldn't be started: ${error.message}`));
    child.on("exit", (code, signal) => done(`closed after starting (${signal ?? `exit code ${code}`})`));
  });
  const timer = new Promise<null>((done) => setTimeout(() => done(null), SECONDS * 1000));
  const failure = await Promise.race([exited, timer]);
  if (failure) throw new Error(`The app ${failure}.`);
  console.log(`The app stayed open for ${SECONDS} seconds.`);

  try {
    const text = await windowText();
    // The title bar's name shows whatever the app is waiting for, Steam included.
    if (!text.includes("Flare Tools")) throw new Error(`The window doesn't show the app. It shows: ${text.slice(0, 200)}`);
    console.log("The window shows the app.");
  } finally {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    await exited;
  }
}

/** The text in the app's window, read through WebView2's DevTools port. Fails if it's showing something else. */
async function windowText(): Promise<string> {
  const targets = (await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json`)).json()) as {
    type: string;
    url: string;
    webSocketDebuggerUrl: string;
  }[];
  const page = targets.find((target) => target.type === "page");
  if (!page) throw new Error("The app's window has no page in it.");
  if (!page.url.startsWith("http://tauri.localhost/")) throw new Error(`The window shows ${page.url} instead of the app.`);

  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((open, fail) => {
    socket.addEventListener("open", open, { once: true });
    socket.addEventListener("error", () => fail(new Error("Couldn't connect to the app's window.")), { once: true });
  });
  const reply = new Promise<string>((done) =>
    socket.addEventListener("message", (event) => done(String(event.data)), { once: true }),
  );
  const expression = "document.body.innerText";
  socket.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, returnByValue: true } }));
  const { result } = JSON.parse(await reply) as { result?: { result?: { value?: string } } };
  socket.close();
  return result?.result?.value ?? "";
}
