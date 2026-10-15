use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::os::windows::io::AsRawHandle;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::OnceLock;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::detect;
use crate::history::Capture;
use crate::inspect::{self, Inspection, LinkStatus};
use crate::store::{ModConfig, Settings};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const POLL_INTERVAL: Duration = Duration::from_millis(250);
/// How long closing the app waits for a cancelled build to clean up.
const STOP_TIMEOUT: Duration = Duration::from_secs(10);
pub const EVENT: &str = "build-event";

#[derive(Default)]
pub struct BuildControl {
    pub running: AtomicBool,
    pub cancel: AtomicBool,
    /// Where each build's link on P: is recorded while it exists, to remove after a crash.
    pub links: PathBuf,
}

/// Cancels a running build and waits for it to finish cleaning up, so closing the app doesn't
/// leave the build's link on P: behind.
pub fn stop(app: &AppHandle) {
    let Some(control) = app.try_state::<BuildControl>() else { return };
    if !control.running.load(Ordering::SeqCst) {
        return;
    }
    control.cancel.store(true, Ordering::SeqCst);
    let deadline = Instant::now() + STOP_TIMEOUT;
    while control.running.load(Ordering::SeqCst) && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(50));
    }
}

/// Puts a tool the build started into a job that Windows ends when Flare Tools exits, however it
/// exits, so pboProject can't carry on writing PBOs in the background after a crash.
fn end_with_app(child: &Child) {
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation, SetInformationJobObject,
    };

    // The handle is never closed: Windows closes it as the process ends, which ends the job.
    static JOB: OnceLock<Option<usize>> = OnceLock::new();
    let job = JOB.get_or_init(|| {
        // SAFETY: the job handle is checked before use, and the limits struct outlives the call.
        unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                return None;
            }
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let set = SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                (&raw const limits).cast(),
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            if set == 0 {
                CloseHandle(job);
                return None;
            }
            Some(job as usize)
        }
    });
    if let Some(job) = *job {
        // SAFETY: both handles are open: the job's for the life of the app, the child's while it's borrowed.
        unsafe { AssignProcessToJobObject(job as HANDLE, child.as_raw_handle() as HANDLE) };
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Step {
    Prepare,
    Pack,
    Sign,
    Finish,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StepStatus {
    Running,
    Done,
    Failed,
    Skipped,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Level {
    Info,
    Command,
    Output,
    Warning,
    Error,
    Success,
}

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum BuildEvent {
    #[serde(rename_all = "camelCase")]
    Step { mod_id: String, step: Step, status: StepStatus },
    #[serde(rename_all = "camelCase")]
    Log { mod_id: String, level: Level, text: String },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuiltPbo {
    pub name: String,
    pub prefix: Option<String>,
    pub path: String,
    pub size: u64,
    pub signed: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildOutcome {
    pub ok: bool,
    pub cancelled: bool,
    pub duration_ms: u64,
    pub finished_at: u64,
    pub pbos: Vec<BuiltPbo>,
    pub signed: bool,
    pub warnings: Vec<String>,
    pub error: Option<String>,
}

struct Reporter<'a> {
    app: &'a AppHandle,
    mod_id: String,
    warnings: Vec<String>,
    /// A copy of everything emitted, saved with the build afterwards.
    capture: RefCell<Capture>,
}

impl Reporter<'_> {
    fn step(&self, step: Step, status: StepStatus) {
        self.capture.borrow_mut().step(step, status);
        let _ = self.app.emit(EVENT, BuildEvent::Step { mod_id: self.mod_id.clone(), step, status });
    }

    fn log(&self, level: Level, text: impl Into<String>) {
        let text = text.into();
        self.capture.borrow_mut().log(level, &text);
        let _ = self.app.emit(EVENT, BuildEvent::Log { mod_id: self.mod_id.clone(), level, text });
    }

    fn warn(&mut self, text: impl Into<String>) {
        let text = text.into();
        self.log(Level::Warning, text.clone());
        self.warnings.push(text);
    }
}

/// Failure inside a step: which step failed and why.
struct Failure {
    step: Step,
    message: String,
    cancelled: bool,
}

impl Failure {
    fn new(step: Step, message: impl Into<String>) -> Self {
        Self { step, message: message.into(), cancelled: false }
    }
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

type Snapshot = HashMap<PathBuf, (u64, SystemTime)>;

/// Size and modified time of each file with the given extension, to spot what a build rewrites.
fn snapshot(dir: &Path, extension: &str) -> Snapshot {
    fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|ext| ext.eq_ignore_ascii_case(extension)))
        .filter_map(|p| {
            let meta = fs::metadata(&p).ok()?;
            Some((p, (meta.len(), meta.modified().ok()?)))
        })
        .collect()
}

fn changed_since(path: &Path, before: &Snapshot) -> bool {
    let Ok(meta) = fs::metadata(path) else { return false };
    let now = (meta.len(), meta.modified().unwrap_or(UNIX_EPOCH));
    before.get(path) != Some(&now)
}

fn plural(count: usize, word: &str) -> String {
    if count == 1 { format!("1 {word}") } else { format!("{count} {word}s") }
}

/// Quotes a path for Mikero's command-line parser, which follows `-Option="value"`.
fn quoted(path: &Path) -> String {
    format!("\"{}\"", path.to_string_lossy().trim_end_matches('\\'))
}

/// A junction at `P:\<prefix>` that is removed again when dropped.
struct TempJunction {
    link: PathBuf,
    created_dirs: Vec<PathBuf>,
    /// The record of this link, kept until it's removed.
    record: Option<PathBuf>,
}

/// A build's link on P:, written down before it's made so that a crash can't leave it behind for
/// good: the next start removes it.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LinkRecord {
    /// The app that made it, which may still be building with it.
    pid: u32,
    link: PathBuf,
    target: PathBuf,
    created_dirs: Vec<PathBuf>,
}

impl TempJunction {
    fn create(link: &Path, target: &Path, records: &Path) -> Result<Self, String> {
        // Nested prefixes (a\b) need their parent folders on P: first.
        let mut missing = Vec::new();
        let mut parent = link.parent();
        while let Some(dir) = parent {
            if dir.exists() {
                break;
            }
            missing.push(dir.to_path_buf());
            parent = dir.parent();
        }
        missing.reverse();
        let target = std::path::absolute(target).map_err(|e| format!("Couldn't resolve {}: {e}", target.display()))?;

        let record = (!records.as_os_str().is_empty()).then(|| records.join(format!("{}.json", std::process::id())));
        if let Some(record) = &record {
            let entry = LinkRecord {
                pid: std::process::id(),
                link: link.to_path_buf(),
                target: target.clone(),
                created_dirs: missing.clone(),
            };
            fs::create_dir_all(records)
                .and_then(|()| fs::write(record, serde_json::to_vec(&entry).unwrap_or_default()))
                .map_err(|e| format!("Couldn't record the link at {}: {e}", link.display()))?;
        }
        // From here, dropping the junction cleans up whatever has been made so far.
        let mut junction = Self { link: PathBuf::new(), created_dirs: Vec::new(), record };
        for dir in missing {
            fs::create_dir(&dir).map_err(|e| format!("Couldn't create {}: {e}", dir.display()))?;
            junction.created_dirs.push(dir);
        }
        junction::create(&target, link)
            .map_err(|e| format!("Couldn't create a junction at {}: {e}", link.display()))?;
        junction.link = link.to_path_buf();
        Ok(junction)
    }
}

impl Drop for TempJunction {
    fn drop(&mut self) {
        // Only ever remove the link itself. remove_dir on a junction deletes the link,
        // never the folder it points to, and fails on a real non-empty folder.
        if !self.link.as_os_str().is_empty()
            && fs::symlink_metadata(&self.link).is_ok_and(|m| m.file_type().is_symlink())
        {
            let _ = fs::remove_dir(&self.link);
        }
        for dir in self.created_dirs.iter().rev() {
            let _ = fs::remove_dir(dir);
        }
        if let Some(record) = &self.record {
            let _ = fs::remove_file(record);
        }
    }
}

/// Whether `link` is still a junction to `target`, rather than something put in its place since.
fn links_to(link: &Path, target: &Path) -> bool {
    fn plain(path: &Path) -> String {
        let text = path.to_string_lossy();
        text.strip_prefix(r"\\?\").unwrap_or(&text).trim_end_matches('\\').to_lowercase()
    }
    fs::symlink_metadata(link).is_ok_and(|m| m.file_type().is_symlink())
        && fs::read_link(link).is_ok_and(|found| plain(&found) == plain(target))
}

/// Removes links on P: left by builds that never finished, because the app crashed or was ended.
pub fn remove_leftover_links(records: &Path) {
    let Ok(entries) = fs::read_dir(records) else { return };
    for path in entries.flatten().map(|e| e.path()) {
        let Some(record) = fs::read(&path).ok().and_then(|bytes| serde_json::from_slice::<LinkRecord>(&bytes).ok())
        else {
            let _ = fs::remove_file(&path);
            continue;
        };
        if record.pid != std::process::id() && crate::steam::process_running(record.pid) {
            continue;
        }
        if links_to(&record.link, &record.target) && fs::remove_dir(&record.link).is_err() {
            // Try again next time rather than forget it.
            continue;
        }
        for dir in record.created_dirs.iter().rev() {
            let _ = fs::remove_dir(dir);
        }
        let _ = fs::remove_file(&path);
    }
}

/// Follows pboProject's log files in its temp folder and reports new lines as they appear.
struct LogTail {
    dir: PathBuf,
    /// Logs as they were before the build, so older builds' logs aren't shown.
    before: Snapshot,
    offsets: HashMap<PathBuf, u64>,
    partial: HashMap<PathBuf, String>,
    /// The P: drive, which the paths in pboProject's log are relative to.
    p_drive: PathBuf,
    /// pboProject couldn't convert a PNG to PAA.
    png_failure: Option<PngFailure>,
}

/// A PNG that Pal2PacE couldn't convert, and its size if it could be read.
struct PngFailure {
    name: String,
    size: Option<(u32, u32)>,
}

impl PngFailure {
    /// Reads "Pal2Pace failed \Mod\a.png \Mod\a.paa", resolving the P:-relative path.
    fn parse(line: &str, p_drive: &Path) -> Option<Self> {
        let lower = line.to_ascii_lowercase();
        let start = lower.find("pal2pace failed")? + "pal2pace failed".len();
        let end = start + lower[start..].find(".png")? + ".png".len();
        let rel = line[start..end].trim();
        let name = rel.rsplit(['\\', '/']).next().unwrap_or(rel).to_string();
        let size = png_size(&p_drive.join(rel.trim_start_matches(['\\', '/'])));
        Some(Self { name, size })
    }

    fn message(&self) -> String {
        match self.size {
            Some((w, h)) if !w.is_power_of_two() || !h.is_power_of_two() => format!(
                "{} is {w}×{h}. PAA textures need power-of-two sides, such as 512, 1024 or 2048. Resize it, or move it out of the mod if nothing uses it.",
                self.name
            ),
            _ => format!(
                "pboProject couldn't convert {} to PAA. If the mod uses it as a PNG (common in GUIs), turn off Convert PNGs for this mod.",
                self.name
            ),
        }
    }
}

/// A PNG's width and height from its IHDR chunk.
fn png_size(path: &Path) -> Option<(u32, u32)> {
    let mut header = [0u8; 24];
    File::open(path).ok()?.read_exact(&mut header).ok()?;
    if &header[..8] != b"\x89PNG\r\n\x1a\n" || &header[12..16] != b"IHDR" {
        return None;
    }
    let width = u32::from_be_bytes(header[16..20].try_into().ok()?);
    let height = u32::from_be_bytes(header[20..24].try_into().ok()?);
    Some((width, height))
}

impl LogTail {
    fn new(dir: PathBuf, p_drive: PathBuf) -> Self {
        let before = snapshot(&dir, "log");
        Self { dir, before, offsets: HashMap::new(), partial: HashMap::new(), p_drive, png_failure: None }
    }

    fn emit(&mut self, reporter: &Reporter, line: &str) {
        if self.png_failure.is_none() && line.to_ascii_lowercase().contains("pal2pace failed") {
            // Read the size now: the build link the path goes through is removed after packing.
            self.png_failure =
                Some(PngFailure::parse(line, &self.p_drive).unwrap_or(PngFailure { name: "a PNG".into(), size: None }));
        }
        emit_log_line(reporter, line);
    }

    fn poll(&mut self, reporter: &Reporter, flush: bool) {
        let Ok(entries) = fs::read_dir(&self.dir) else { return };
        let mut logs: Vec<PathBuf> = entries
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("log")))
            .filter(|p| self.offsets.contains_key(p) || changed_since(p, &self.before))
            .collect();
        logs.sort();
        for path in logs {
            let Ok(mut file) = File::open(&path) else { continue };
            let len = file.metadata().map(|m| m.len()).unwrap_or(0);
            let is_new = !self.offsets.contains_key(&path);
            let offset = self.offsets.entry(path.clone()).or_insert(0);
            if len < *offset {
                *offset = 0;
            }
            if is_new {
                let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                reporter.log(Level::Info, format!("── {name}"));
            }
            if len == *offset {
                continue;
            }
            let mut bytes = Vec::new();
            if file.seek(SeekFrom::Start(*offset)).is_err() || file.read_to_end(&mut bytes).is_err() {
                continue;
            }
            *offset += bytes.len() as u64;
            let buffer = self.partial.entry(path.clone()).or_default();
            buffer.push_str(&String::from_utf8_lossy(&bytes));
            let mut lines = Vec::new();
            while let Some(end) = buffer.find('\n') {
                lines.push(buffer.drain(..=end).collect::<String>());
            }
            for line in lines {
                self.emit(reporter, line.trim_end());
            }
        }
        if flush {
            let rests: Vec<String> = self.partial.drain().map(|(_, rest)| rest).collect();
            for rest in rests {
                if !rest.trim().is_empty() {
                    self.emit(reporter, rest.trim_end());
                }
            }
        }
    }
}

fn emit_log_line(reporter: &Reporter, line: &str) {
    let line = line.trim_start_matches('\u{feff}');
    if line.trim().is_empty() {
        return;
    }
    let lower = line.to_ascii_lowercase();
    let level = if lower.contains("error") || lower.contains("failed") {
        Level::Error
    } else if lower.contains("warning") {
        Level::Warning
    } else if lower.trim() == "success" {
        Level::Success
    } else {
        Level::Output
    };
    reporter.log(level, line);
}

fn kill_tree(pid: u32) {
    let _ = Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .creation_flags(CREATE_NO_WINDOW)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

fn require_file(path: &str, what: &str, step: Step) -> Result<PathBuf, Failure> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err(Failure::new(step, format!("{what} isn't set. Add it in Settings.")));
    }
    let p = PathBuf::from(trimmed);
    if !p.is_file() {
        return Err(Failure::new(step, format!("{what} wasn't found at {}.", p.display())));
    }
    Ok(p)
}

/// pboProject's arguments, already quoted the way its parser expects.
fn pbo_project_args(m: &ModConfig, plan: &Inspection, output: &Path) -> Vec<String> {
    // +Label is ignored when the PBO is in a subfolder, so renames happen after packing.
    // Every pboProject option persists into its GUI settings unless +Restore is passed.
    // -Key stops pboProject signing with its own key; this app signs afterwards.
    // +Stop is documented but makes pboProject 4.31 exit with an error before packing, so
    // a faulty PBO is caught afterwards by checking every expected PBO was written.
    let mut args = vec![
        "-P".to_string(),
        "+Restore".into(),
        "-Key".into(),
        "+Engine=dayz".into(),
        if m.binarise { "+Binarise" } else { "-Binarise" }.into(),
        // +H turns PNG to PAA conversion off, -H turns it on.
        if m.convert_png { "-H" } else { "+H" }.into(),
        format!("+Mod={}", quoted(output)),
    ];
    args.push(quoted(Path::new(&plan.build_path)));
    args
}

fn run_pbo_project(
    reporter: &mut Reporter,
    control: &BuildControl,
    exe: &Path,
    args: &[String],
    mut tail: LogTail,
) -> Result<(), Failure> {
    let mut cmd = Command::new(exe);
    for arg in args {
        cmd.raw_arg(arg);
    }
    cmd.creation_flags(CREATE_NO_WINDOW).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    // The Workshop tool makes this process DayZ in Steam's eyes; Binarize would inherit that.
    cmd.env_remove("SteamAppId").env_remove("SteamGameId");
    reporter.log(Level::Command, format!("pboProject {}", args.join(" ")));

    let mut child = cmd.spawn().map_err(|e| Failure::new(Step::Pack, format!("Couldn't start pboProject: {e}")))?;
    end_with_app(&child);
    let status = loop {
        // Check for exit first: once pboProject has finished, a late cancel would only
        // throw away a good build and leave its PBOs unsigned.
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if control.cancel.load(Ordering::SeqCst) => {
                kill_tree(child.id());
                let _ = child.wait();
                tail.poll(reporter, true);
                return Err(Failure { step: Step::Pack, message: "Build cancelled.".into(), cancelled: true });
            }
            Ok(None) => {
                tail.poll(reporter, false);
                thread::sleep(POLL_INTERVAL);
            }
            Err(e) => return Err(Failure::new(Step::Pack, format!("Lost track of pboProject: {e}"))),
        }
    };
    // pboProject can finish writing a log just after it exits.
    thread::sleep(POLL_INTERVAL);
    tail.poll(reporter, true);

    if let Some(failure) = &tail.png_failure {
        return Err(Failure::new(Step::Pack, failure.message()));
    }
    if !status.success() {
        let code = status.code().map(|c| c.to_string()).unwrap_or_else(|| "unknown".into());
        return Err(Failure::new(
            Step::Pack,
            format!("pboProject failed (exit code {code}). Check its log above for the cause."),
        ));
    }
    Ok(())
}

fn remove_signatures(addons: &Path, pbo_file: &str) -> Vec<PathBuf> {
    let prefix = format!("{}.", pbo_file.to_ascii_lowercase());
    let mut removed = Vec::new();
    if let Ok(entries) = fs::read_dir(addons) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
            if name.starts_with(&prefix) && name.ends_with(".bisign") && fs::remove_file(entry.path()).is_ok() {
                removed.push(entry.path());
            }
        }
    }
    removed
}

fn sign_pbos(
    reporter: &mut Reporter,
    settings: &Settings,
    m: &ModConfig,
    output: &Path,
    pbos: &mut [BuiltPbo],
) -> Result<(), Failure> {
    let ds_sign = require_file(&settings.ds_sign_file_path, "DSSignFile.exe", Step::Sign)?;
    let key_path = m.private_key_path.clone().unwrap_or_else(|| settings.default_private_key_path.clone());
    let key = require_file(&key_path, "The private key", Step::Sign)?;
    let key_name = key.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let public_key = key.with_extension("bikey");
    if !public_key.is_file() {
        return Err(Failure::new(
            Step::Sign,
            format!(
                "{} wasn't found next to the private key, so players couldn't verify the signature.",
                public_key.display()
            ),
        ));
    }

    for pbo in pbos.iter_mut() {
        let pbo_path = PathBuf::from(&pbo.path);
        reporter.log(Level::Command, format!("DSSignFile {} {}", quoted(&key), quoted(&pbo_path)));
        let child = Command::new(&ds_sign)
            .arg(&key)
            .arg(&pbo_path)
            .creation_flags(CREATE_NO_WINDOW)
            .env_remove("SteamAppId")
            .env_remove("SteamGameId")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| Failure::new(Step::Sign, format!("Couldn't start DSSignFile: {e}")))?;
        end_with_app(&child);
        let result =
            child.wait_with_output().map_err(|e| Failure::new(Step::Sign, format!("Lost track of DSSignFile: {e}")))?;
        for line in
            String::from_utf8_lossy(&result.stdout).lines().chain(String::from_utf8_lossy(&result.stderr).lines())
        {
            emit_log_line(reporter, line);
        }
        let signature = pbo_path.with_file_name(format!("{}.pbo.{key_name}.bisign", pbo.name));
        if !result.status.success() || !signature.is_file() {
            return Err(Failure::new(Step::Sign, format!("DSSignFile couldn't sign {}.pbo.", pbo.name)));
        }
        pbo.signed = true;
    }

    let keys_dir = output.join("keys");
    fs::create_dir_all(&keys_dir)
        .map_err(|e| Failure::new(Step::Sign, format!("Couldn't create {}: {e}", keys_dir.display())))?;
    let key_target = keys_dir.join(format!("{key_name}.bikey"));
    fs::copy(&public_key, &key_target)
        .map_err(|e| Failure::new(Step::Sign, format!("Couldn't copy the public key: {e}")))?;
    reporter.log(Level::Info, format!("Copied {key_name}.bikey to {}", keys_dir.display()));
    Ok(())
}

fn build_steps(
    reporter: &mut Reporter,
    control: &BuildControl,
    settings: &Settings,
    m: &ModConfig,
    pbos: &mut Vec<BuiltPbo>,
) -> Result<(), Failure> {
    // Prepare
    reporter.step(Step::Prepare, StepStatus::Running);
    let pbo_project = require_file(&settings.pbo_project_path, "pboProject.exe", Step::Prepare)?;
    let plan = inspect::inspect(&settings.p_drive, &m.source_path, m.prefix.as_deref(), m.pbo_name.as_deref());
    if let Some(problem) = &plan.problem {
        return Err(Failure::new(Step::Prepare, problem.clone()));
    }
    if m.output_path.trim().is_empty() {
        return Err(Failure::new(Step::Prepare, "The output folder isn't set."));
    }
    let output = PathBuf::from(m.output_path.trim());
    reporter.log(Level::Info, format!("Prefix: {}", plan.prefix));
    for pbo in &plan.pbos {
        reporter.log(Level::Info, format!("Will pack {}.pbo ({})", pbo.name, pbo.prefix));
    }
    let _junction = match plan.link {
        LinkStatus::Direct => None,
        LinkStatus::Junction => {
            let link = PathBuf::from(&plan.build_path);
            let junction = TempJunction::create(&link, Path::new(&m.source_path), &control.links)
                .map_err(|e| Failure::new(Step::Prepare, e))?;
            reporter.log(Level::Info, format!("Linked {} → {} for this build", link.display(), m.source_path));
            Some(junction)
        }
        // Each of these is a problem, which stopped the build above.
        LinkStatus::Conflict | LinkStatus::NoPDrive | LinkStatus::BadPrefix => {
            return Err(Failure::new(Step::Prepare, "This mod can't be built from where it is."));
        }
    };
    let addons = output.join("addons");
    fs::create_dir_all(&addons)
        .map_err(|e| Failure::new(Step::Prepare, format!("Couldn't create {}: {e}", addons.display())))?;
    reporter.step(Step::Prepare, StepStatus::Done);

    // Pack
    reporter.step(Step::Pack, StepStatus::Running);
    let pbos_before = snapshot(&addons, "pbo");
    let tail = LogTail::new(detect::pbo_project_temp_dir(&settings.p_drive), PathBuf::from(&settings.p_drive));
    let packed = run_pbo_project(reporter, control, &pbo_project, &pbo_project_args(m, &plan, &output), tail);
    let written: Vec<PathBuf> =
        snapshot(&addons, "pbo").into_keys().filter(|p| changed_since(p, &pbos_before)).collect();
    if let Err(mut failure) = packed {
        // pboProject drops a PBO's old signatures when it rewrites it, so say which PBOs
        // were left unsigned.
        if !written.is_empty() {
            let names: Vec<String> =
                written.iter().filter_map(|p| p.file_name().map(|n| n.to_string_lossy().into_owned())).collect();
            failure.message.push_str(&format!(
                " {} {} already rewritten and {} unsigned until the next build.",
                names.join(", "),
                if names.len() == 1 { "was" } else { "were" },
                if names.len() == 1 { "is" } else { "are" },
            ));
        }
        return Err(failure);
    }

    let stem = |p: &Path| p.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let mut missing = Vec::new();
    for planned in &plan.pbos {
        let Some(packed) = written.iter().find(|p| stem(p).eq_ignore_ascii_case(&planned.packed_name)) else {
            missing.push(format!("{}.pbo", planned.packed_name));
            continue;
        };
        let mut path = packed.clone();
        if !planned.packed_name.eq_ignore_ascii_case(&planned.name) {
            let target = addons.join(format!("{}.pbo", planned.name));
            fs::rename(packed, &target).map_err(|e| {
                Failure::new(
                    Step::Pack,
                    format!("Couldn't rename {}.pbo to {}.pbo: {e}", planned.packed_name, planned.name),
                )
            })?;
            reporter.log(Level::Info, format!("Renamed {}.pbo to {}.pbo", planned.packed_name, planned.name));
            path = target;
        }
        pbos.push(BuiltPbo {
            size: fs::metadata(&path).map(|m| m.len()).unwrap_or(0),
            path: path.to_string_lossy().into_owned(),
            name: planned.name.clone(),
            prefix: Some(planned.prefix.clone()),
            signed: false,
        });
    }
    if !missing.is_empty() {
        return Err(Failure::new(
            Step::Pack,
            format!("pboProject didn't write {}. Check its log above.", missing.join(", ")),
        ));
    }
    pbos.sort_by(|a, b| a.name.cmp(&b.name));

    let expected: HashSet<String> = plan.pbos.iter().map(|p| p.name.to_ascii_lowercase()).collect();
    for path in snapshot(&addons, "pbo").into_keys() {
        let name = stem(&path);
        if !expected.contains(&name.to_ascii_lowercase()) {
            reporter.warn(format!("addons\\{name}.pbo wasn't produced by this build. It has been left in place."));
        }
    }

    // A rebuilt PBO invalidates every signature made for the old one.
    for pbo in pbos.iter() {
        for removed in remove_signatures(&addons, &format!("{}.pbo", pbo.name)) {
            reporter.log(
                Level::Info,
                format!("Removed old signature {}", removed.file_name().unwrap_or_default().to_string_lossy()),
            );
        }
    }
    reporter.step(Step::Pack, StepStatus::Done);

    // Sign
    if m.sign {
        reporter.step(Step::Sign, StepStatus::Running);
        sign_pbos(reporter, settings, m, &output, pbos)?;
        reporter.step(Step::Sign, StepStatus::Done);
    } else {
        reporter.step(Step::Sign, StepStatus::Skipped);
    }

    // Finish
    reporter.step(Step::Finish, StepStatus::Running);
    let mod_cpp = Path::new(&m.source_path).join("mod.cpp");
    if m.copy_mod_cpp && mod_cpp.is_file() {
        fs::copy(&mod_cpp, output.join("mod.cpp"))
            .map_err(|e| Failure::new(Step::Finish, format!("Couldn't copy mod.cpp: {e}")))?;
        reporter.log(Level::Info, "Copied mod.cpp");
    }
    reporter.step(Step::Finish, StepStatus::Done);
    Ok(())
}

/// Runs a build, returning its outcome and everything it showed along the way.
pub fn build(app: &AppHandle, control: &BuildControl, settings: &Settings, m: &ModConfig) -> (BuildOutcome, Capture) {
    let timer = Instant::now();
    let mut reporter = Reporter { app, mod_id: m.id.clone(), warnings: Vec::new(), capture: RefCell::default() };
    let mut pbos = Vec::new();
    let result = build_steps(&mut reporter, control, settings, m, &mut pbos);
    let duration_ms = timer.elapsed().as_millis() as u64;

    let (ok, cancelled, error) = match result {
        Ok(()) => {
            reporter.log(
                Level::Success,
                format!("Built {} in {:.1}s", plural(pbos.len(), "PBO"), duration_ms as f64 / 1000.0),
            );
            (true, false, None)
        }
        Err(failure) => {
            reporter.step(failure.step, StepStatus::Failed);
            reporter.log(Level::Error, failure.message.clone());
            (false, failure.cancelled, Some(failure.message))
        }
    };

    let outcome = BuildOutcome {
        ok,
        cancelled,
        duration_ms,
        finished_at: now_ms(),
        signed: ok && m.sign,
        pbos,
        warnings: reporter.warnings,
        error,
    };
    (outcome, reporter.capture.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png_header(width: u32, height: u32) -> Vec<u8> {
        let mut bytes = b"\x89PNG\r\n\x1a\n\0\0\0\x0dIHDR".to_vec();
        bytes.extend_from_slice(&width.to_be_bytes());
        bytes.extend_from_slice(&height.to_be_bytes());
        bytes
    }

    #[test]
    fn removes_a_link_left_by_a_build_that_never_finished() {
        let root = std::env::temp_dir().join(format!("flare-tools-link-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let source = root.join("source");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("config.cpp"), "").unwrap();
        let records = root.join("links");
        let link = root.join(r"P\Nested\MyMod");

        // A crash skips the junction's cleanup, which forgetting it stands in for here.
        std::mem::forget(TempJunction::create(&link, &source, &records).unwrap());
        assert!(link.join("config.cpp").is_file());
        // The record names this process, which counts as not building any more.
        remove_leftover_links(&records);

        assert!(!link.exists() && !root.join(r"P\Nested").exists());
        assert!(source.join("config.cpp").is_file());
        assert_eq!(fs::read_dir(&records).unwrap().count(), 0);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn leaves_a_folder_that_replaced_the_link() {
        let root = std::env::temp_dir().join(format!("flare-tools-replaced-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let source = root.join("source");
        fs::create_dir_all(&source).unwrap();
        let records = root.join("links");
        let link = root.join("MyMod");

        std::mem::forget(TempJunction::create(&link, &source, &records).unwrap());
        fs::remove_dir(&link).unwrap();
        fs::create_dir(&link).unwrap();
        remove_leftover_links(&records);

        assert!(link.is_dir());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn names_a_png_that_is_not_a_power_of_two() {
        let root = std::env::temp_dir().join(format!("flare-tools-png-{}", std::process::id()));
        fs::create_dir_all(root.join(r"Mod\GUI")).unwrap();
        fs::write(root.join(r"Mod\GUI\shield.png"), png_header(1254, 1254)).unwrap();
        fs::write(root.join(r"Mod\GUI\icon.png"), png_header(128, 128)).unwrap();

        let odd = PngFailure::parse(r"Pal2Pace failed \Mod\GUI\shield.png \Mod\GUI\shield.paa", &root).unwrap();
        assert_eq!(odd.size, Some((1254, 1254)));
        assert!(odd.message().starts_with("shield.png is 1254×1254."));

        let square = PngFailure::parse(r"Pal2Pace failed \Mod\GUI\icon.png \Mod\GUI\icon.paa", &root).unwrap();
        assert!(square.message().contains("turn off Convert PNGs"));

        let missing = PngFailure::parse(r"Pal2Pace failed \Mod\gone.png \Mod\gone.paa", &root).unwrap();
        assert_eq!(missing.size, None);
        assert!(missing.message().contains("convert gone.png"));

        fs::remove_dir_all(root).unwrap();
    }
}
