use std::cell::RefCell;
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::os::windows::io::AsRawHandle;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::OnceLock;
use std::sync::atomic::{AtomicU8, Ordering};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::detect;
use crate::history::Capture;
use crate::inspect::{self, Inspection, LinkStatus, PboPlan};
use crate::mod_cpp;
use crate::store::{ModConfig, Settings};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const POLL_INTERVAL: Duration = Duration::from_millis(250);
/// How long closing the app waits for a cancelled build to clean up.
const STOP_TIMEOUT: Duration = Duration::from_secs(10);
pub const EVENT: &str = "build-event";

const IDLE: u8 = 0;
const RUNNING: u8 = 1;
const CANCELLING: u8 = 2;

#[derive(Default)]
pub struct BuildControl {
    /// Idle, running or cancelling, kept in one value so that a cancel can't land between a build
    /// starting and it being marked as running, and be lost.
    state: AtomicU8,
    /// Where each build's link on P: is recorded while it exists, to remove after a crash.
    pub links: PathBuf,
}

impl BuildControl {
    pub fn new(links: PathBuf) -> Self {
        Self { links, ..Default::default() }
    }

    /// Marks a build as started, unless one is running already.
    pub fn start(&self) -> bool {
        self.state.compare_exchange(IDLE, RUNNING, Ordering::SeqCst, Ordering::SeqCst).is_ok()
    }

    /// Asks the running build to stop. Does nothing when there isn't one.
    pub fn cancel(&self) {
        let _ = self.state.compare_exchange(RUNNING, CANCELLING, Ordering::SeqCst, Ordering::SeqCst);
    }

    pub fn cancelled(&self) -> bool {
        self.state.load(Ordering::SeqCst) == CANCELLING
    }

    pub fn running(&self) -> bool {
        self.state.load(Ordering::SeqCst) != IDLE
    }

    pub fn finish(&self) {
        self.state.store(IDLE, Ordering::SeqCst);
    }
}

/// Cancels a running build and waits for it to finish cleaning up, so closing the app doesn't
/// leave the build's link on P: behind.
pub fn stop(app: &AppHandle) {
    let Some(control) = app.try_state::<BuildControl>() else { return };
    if !control.running() {
        return;
    }
    control.cancel();
    let deadline = Instant::now() + STOP_TIMEOUT;
    while control.running() && Instant::now() < deadline {
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
        if is_network_path(&target) {
            return Err(format!(
                "{} is on a network share, and the link on P: can only point to a folder on this computer. Move the mod to a local drive.",
                target.display()
            ));
        }
        if fs::symlink_metadata(link).is_ok() {
            return Err(format!("{} already exists.", link.display()));
        }

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
        if let Err(e) = junction::create(&target, link) {
            // It makes a folder before turning it into a link, and leaves the folder behind when that fails,
            // which would then stand in the way of every build. Nothing was there before, as checked above.
            let _ = fs::remove_dir(link);
            return Err(format!("Couldn't create a junction at {}: {e}", link.display()));
        }
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

/// A path on a network share, which a junction can't point to.
fn is_network_path(path: &Path) -> bool {
    let text = path.to_string_lossy();
    text.starts_with(r"\\?\UNC\") || (text.starts_with(r"\\") && !text.starts_with(r"\\?\"))
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
    /// The end of each log after its last line break, kept as bytes until the line is whole.
    partial: HashMap<PathBuf, Vec<u8>>,
    /// The P: drive, which the paths in pboProject's log are relative to.
    p_drive: PathBuf,
    /// pboProject couldn't convert a PNG to PAA.
    png_failure: Option<PngFailure>,
    /// Files the mod refers to that pboProject couldn't find, from the summary it writes before giving up.
    missing_files: Vec<String>,
}

/// The file in a line of pboProject's missing file summary, "missing in config.cpp : \Other\a.p3d".
fn missing_file(line: &str) -> Option<&str> {
    let line = line.trim();
    if !line.get(..11)?.eq_ignore_ascii_case("missing in ") {
        return None;
    }
    let (_, file) = line.split_once(" : ")?;
    Some(file.trim()).filter(|f| !f.is_empty())
}

/// Why the build failed when pboProject couldn't find files the mod refers to. Most often they're in another
/// mod, such as a map the mod builds on, which pboProject needs on the P: drive even though it doesn't pack it.
fn missing_files_message(files: &[String], p_drive: &Path) -> String {
    let mut folders: Vec<&str> = Vec::new();
    for file in files {
        let top = file.trim_start_matches(['\\', '/']).split(['\\', '/']).next().unwrap_or_default();
        if !top.is_empty() && !folders.iter().any(|f| f.eq_ignore_ascii_case(top)) {
            folders.push(top);
        }
    }
    let folders: Vec<String> = folders.iter().map(|f| p_drive.join(f).to_string_lossy().into_owned()).collect();
    let folders = match folders.as_slice() {
        [] => String::new(),
        [one] => one.clone(),
        [rest @ .., last] => format!("{} and {last}", rest.join(", ")),
    };
    match files {
        [file] => format!(
            "pboProject can't find {file}, which the mod refers to. If it's part of another mod, unpack that mod into {folders} so pboProject can check it; otherwise fix the path."
        ),
        _ => format!(
            "pboProject can't find {} files the mod refers to, in {folders}. If they're part of other mods, unpack those into the same folders so pboProject can check them; otherwise fix the paths. They're listed at the end of the log above.",
            files.len()
        ),
    }
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
        Self {
            dir,
            before,
            offsets: HashMap::new(),
            partial: HashMap::new(),
            p_drive,
            png_failure: None,
            missing_files: Vec::new(),
        }
    }

    fn emit(&mut self, reporter: &Reporter, line: &str) {
        if let Some(file) = missing_file(line)
            && !self.missing_files.iter().any(|f| f.eq_ignore_ascii_case(file))
        {
            self.missing_files.push(file.to_string());
        }
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
            buffer.extend_from_slice(&bytes);
            for line in take_lines(buffer) {
                self.emit(reporter, line.trim_end());
            }
        }
        if flush {
            let rests: Vec<String> =
                self.partial.drain().map(|(_, rest)| String::from_utf8_lossy(&rest).into_owned()).collect();
            for rest in rests {
                if !rest.trim().is_empty() {
                    self.emit(reporter, rest.trim_end());
                }
            }
        }
    }
}

/// Takes the complete lines from the start of a log's unread bytes. Lines are decoded whole (pboProject
/// writes UTF-8), so a character split between two reads of the log comes out intact.
fn take_lines(buffer: &mut Vec<u8>) -> Vec<String> {
    let mut lines = Vec::new();
    while let Some(end) = buffer.iter().position(|&b| b == b'\n') {
        let line: Vec<u8> = buffer.drain(..=end).collect();
        lines.push(String::from_utf8_lossy(&line).into_owned());
    }
    lines
}

fn emit_log_line(reporter: &Reporter, line: &str) {
    let line = line.trim_start_matches('\u{feff}');
    if line.trim().is_empty() {
        return;
    }
    reporter.log(line_level(line), line);
}

/// How a line of pboProject's or DSSignFile's output is shown. Only whole words count, so a script
/// such as ErrorHandler.c isn't shown as an error, and nor is any line pboProject prints while it
/// loads a script, whatever the script is called.
fn line_level(line: &str) -> Level {
    let lower = line.trim().to_ascii_lowercase();
    if lower.ends_with(":loading...") {
        Level::Output
    } else if has_word(&lower, "error") || has_word(&lower, "failed") {
        Level::Error
    } else if has_word(&lower, "warning") {
        Level::Warning
    } else if lower == "success" {
        Level::Success
    } else {
        Level::Output
    }
}

/// Whether `word` appears in `text` on its own rather than as part of a longer name.
fn has_word(text: &str, word: &str) -> bool {
    let part_of_word = |c: char| c.is_alphanumeric() || c == '_';
    text.match_indices(word).any(|(at, _)| {
        !text[..at].chars().next_back().is_some_and(part_of_word)
            && !text[at + word.len()..].chars().next().is_some_and(part_of_word)
    })
}

/// Moves a file to the Recycle Bin, so one a build shouldn't have removed can be put back. On a drive without a
/// Recycle Bin, such as a network share, Windows deletes it instead.
fn recycle(path: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::UI::Shell::{
        FO_DELETE, FOF_ALLOWUNDO, FOF_NOCONFIRMATION, FOF_NOERRORUI, FOF_SILENT, SHFILEOPSTRUCTW, SHFileOperationW,
    };

    // Undo needs a full path. The list of paths ends with an empty one, hence the two nulls.
    let path = std::path::absolute(path).map_err(|e| e.to_string())?;
    let from: Vec<u16> = path.as_os_str().encode_wide().chain([0, 0]).collect();
    let mut operation = SHFILEOPSTRUCTW {
        wFunc: FO_DELETE,
        pFrom: from.as_ptr(),
        fFlags: (FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_NOERRORUI | FOF_SILENT) as u16,
        ..Default::default()
    };
    // SAFETY: `from` is a double-null-terminated list that outlives the call, and no window is passed.
    let result = unsafe { SHFileOperationW(&mut operation) };
    if result != 0 || operation.fAnyOperationsAborted != 0 {
        return Err(format!("Windows couldn't move it to the Recycle Bin (error {result:#x})."));
    }
    Ok(())
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

/// pboProject's arguments for packing `source`, the mod or one of its PBO folders on P:, already quoted the way its
/// parser expects.
fn pbo_project_args(m: &ModConfig, source: &Path, output: &Path) -> Vec<String> {
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
    args.push(quoted(source));
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
            Ok(None) if control.cancelled() => {
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
    if !status.success() && !tail.missing_files.is_empty() {
        return Err(Failure::new(Step::Pack, missing_files_message(&tail.missing_files, &tail.p_drive)));
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

/// A PBO's signatures, whatever key made them: `<pbo>.<key>.bisign` next to it.
fn signatures(addons: &Path, pbo_file: &str) -> Vec<PathBuf> {
    let prefix = format!("{}.", pbo_file.to_ascii_lowercase());
    fs::read_dir(addons)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|entry| {
            let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
            name.starts_with(&prefix) && name.ends_with(".bisign")
        })
        .map(|entry| entry.path())
        .collect()
}

/// Whether a PBO is unticked, leaving it out of the mod's builds. A mod of one PBO always builds it.
fn skipped(m: &ModConfig, plan: &Inspection, pbo: &PboPlan) -> bool {
    plan.pbos.len() > 1 && m.skipped_pbos.iter().any(|dir| dir.eq_ignore_ascii_case(&pbo.rel_dir))
}

/// Why the mod's ticked PBOs can't be built: because there aren't any.
pub fn ticked_problem(m: &ModConfig, plan: &Inspection) -> Option<String> {
    (!plan.pbos.is_empty() && plan.pbos.iter().all(|pbo| skipped(m, plan, pbo)))
        .then(|| "Every PBO is unticked under Packing, so there's nothing to build.".into())
}

/// The other mods that build into the same `@mod` folder, such as a mod's client and server halves.
fn sharing<'a>(m: &ModConfig, mods: &'a [ModConfig], output: &Path) -> impl Iterator<Item = &'a ModConfig> {
    let (id, output) = (m.id.clone(), output.to_path_buf());
    mods.iter()
        .filter(move |other| other.id != id && !other.output_path.trim().is_empty())
        .filter(move |other| inspect::same_folder(Path::new(other.output_path.trim()), &output))
}

fn plan_of(settings: &Settings, m: &ModConfig) -> Inspection {
    inspect::inspect(&settings.p_drive, &m.source_path, m.prefix.as_deref(), m.pbo_name.as_deref())
}

/// The PBOs that the other mods built into the same `@mod` folder produce, so building one doesn't remove the
/// other's. Counts what each would pack now and what it last built.
fn shared_pbos(settings: &Settings, m: &ModConfig, mods: &[ModConfig], output: &Path) -> Vec<String> {
    sharing(m, mods, output)
        .flat_map(|other| {
            let last_built = other.last_build.iter().flat_map(|build| build.pbos.clone());
            plan_of(settings, other).pbos.into_iter().map(|pbo| pbo.name).chain(last_built)
        })
        .map(|name| format!("{name}.pbo"))
        .collect()
}

/// Why packing would overwrite a PBO another mod builds into the same `@mod` folder: one of the same name, or of the
/// name pboProject writes before the app renames it.
fn overwrite_problem(
    settings: &Settings,
    m: &ModConfig,
    mods: &[ModConfig],
    chosen: &[&PboPlan],
    output: &Path,
) -> Option<String> {
    sharing(m, mods, output).find_map(|other| {
        let theirs = plan_of(settings, other).pbos;
        chosen.iter().flat_map(|pbo| [&pbo.packed_name, &pbo.name]).find_map(|name| {
            theirs.iter().any(|pbo| pbo.name.eq_ignore_ascii_case(name)).then(|| {
                format!(
                    "pboProject would write {name}.pbo over the one {} builds into the same output folder. Rename one of the two PBOs.",
                    other.name
                )
            })
        })
    })
}

/// The files in `addons` other than the PBOs a build just packed, and the PBOs and signatures of other mods built
/// into the same folder. Folders are left to the upload's checks.
fn stale_files(addons: &Path, built: &[String], shared: &[String]) -> Vec<PathBuf> {
    let is_built = |name: &str| built.iter().any(|pbo| pbo.eq_ignore_ascii_case(name));
    let mut stale: Vec<PathBuf> = fs::read_dir(addons)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_file()))
        .filter(|entry| {
            let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
            // A PBO this build packed is new, so a signature only survives for another mod's PBO.
            let shared = shared.iter().filter(|pbo| !is_built(pbo)).any(|pbo| {
                let pbo = pbo.to_ascii_lowercase();
                name == pbo || (name.starts_with(&format!("{pbo}.")) && name.ends_with(".bisign"))
            });
            !is_built(&name) && !shared
        })
        .map(|entry| entry.path())
        .collect();
    stale.sort();
    stale
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
        // DSSignFile names the signature after the key's own name, which needn't match its file's,
        // so look for whichever it wrote. The PBO's old signatures were removed after packing.
        let signed =
            pbo_path.parent().is_some_and(|addons| !signatures(addons, &format!("{}.pbo", pbo.name)).is_empty());
        if !result.status.success() || !signed {
            return Err(Failure::new(Step::Sign, format!("DSSignFile couldn't sign {}.pbo.", pbo.name)));
        }
        pbo.signed = true;
    }

    let keys_dir = output.join("keys");
    fs::create_dir_all(&keys_dir)
        .map_err(|e| Failure::new(Step::Sign, format!("Couldn't create {}: {e}", keys_dir.display())))?;
    let key_target = keys_dir.join(format!("{key_name}.bikey"));
    fs::read(&public_key)
        .and_then(|key| write_output(&key_target, key))
        .map_err(|e| Failure::new(Step::Sign, format!("Couldn't copy the public key: {e}")))?;
    reporter.log(Level::Info, format!("Copied {key_name}.bikey to {}", keys_dir.display()));
    Ok(())
}

fn build_steps(
    reporter: &mut Reporter,
    control: &BuildControl,
    settings: &Settings,
    m: &ModConfig,
    mods: &[ModConfig],
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
    if let Some(problem) = inspect::output_problem(Path::new(&m.source_path), &output) {
        return Err(Failure::new(Step::Prepare, problem));
    }
    if let Some(problem) = ticked_problem(m, &plan) {
        return Err(Failure::new(Step::Prepare, problem));
    }
    let (chosen, left_out): (Vec<&PboPlan>, Vec<&PboPlan>) = plan.pbos.iter().partition(|pbo| !skipped(m, &plan, pbo));
    reporter.log(Level::Info, format!("Prefix: {}", plan.prefix));
    for pbo in &chosen {
        reporter.log(Level::Info, format!("Will pack {}.pbo ({})", pbo.name, pbo.prefix));
    }
    for pbo in &left_out {
        reporter
            .log(Level::Info, format!("Leaving out {}.pbo, which is unticked, and keeping its last build", pbo.name));
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
    if let Some(problem) = overwrite_problem(settings, m, mods, &chosen, &output) {
        return Err(Failure::new(Step::Prepare, problem));
    }
    reporter.step(Step::Prepare, StepStatus::Done);

    // Pack
    reporter.step(Step::Pack, StepStatus::Running);
    let pbos_before = snapshot(&addons, "pbo");
    // pboProject packs the whole mod in one go when every PBO is ticked, and each ticked PBO's folder on its own
    // otherwise. Its prefix comes out the same, since pboProject reads it from the folder's place on P:.
    let build_path = Path::new(&plan.build_path);
    let sources: Vec<PathBuf> = if left_out.is_empty() {
        vec![build_path.to_path_buf()]
    } else {
        chosen.iter().map(|pbo| build_path.join(&pbo.rel_dir)).collect()
    };
    let mut packed = Ok(());
    for source in &sources {
        let tail = LogTail::new(detect::pbo_project_temp_dir(&settings.p_drive), PathBuf::from(&settings.p_drive));
        packed = run_pbo_project(reporter, control, &pbo_project, &pbo_project_args(m, source, &output), tail);
        if packed.is_err() {
            break;
        }
    }
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
    let mut unplanned = written.clone();
    for planned in &chosen {
        let Some(packed) = written.iter().find(|p| stem(p).eq_ignore_ascii_case(&planned.packed_name)) else {
            missing.push(format!("{}.pbo", planned.packed_name));
            continue;
        };
        unplanned.retain(|p| p != packed);
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
    // pboProject can find a PBO folder that the app's search doesn't, such as one nested very deep. It's as much a
    // part of the build as the rest, so it's signed with them rather than cleared out as stale.
    for path in unplanned {
        let name = stem(&path);
        reporter.log(
            Level::Warning,
            format!("Keeping {name}.pbo, which pboProject also packed, from a folder Flare Tools didn't look in"),
        );
        pbos.push(BuiltPbo {
            size: fs::metadata(&path).map(|m| m.len()).unwrap_or(0),
            path: path.to_string_lossy().into_owned(),
            name,
            prefix: None,
            signed: false,
        });
    }
    pbos.sort_by(|a, b| a.name.cmp(&b.name));

    // Everything else in addons goes, so nothing stale is uploaded with the mod: DayZ loads only PBOs and their
    // signatures from it, and a rebuilt PBO invalidates every signature made for the old one. Other mods built into
    // the same folder keep theirs. Files go to the Recycle Bin, in case one was something the modder wanted.
    let built: Vec<String> = pbos.iter().map(|p| format!("{}.pbo", p.name)).collect();
    let mut shared = shared_pbos(settings, m, mods, &output);
    // An unticked PBO keeps its last build and that build's signatures.
    shared.extend(left_out.iter().map(|pbo| format!("{}.pbo", pbo.name)));
    for path in stale_files(&addons, &built, &shared) {
        let name = path.file_name().unwrap_or_default().to_string_lossy().into_owned();
        let signature = name.to_ascii_lowercase().ends_with(".bisign")
            && built.iter().any(|pbo| name.to_ascii_lowercase().starts_with(&format!("{}.", pbo.to_ascii_lowercase())));
        match recycle(&path) {
            Ok(()) if signature => reporter.log(Level::Info, format!("Moved old signature {name} to the Recycle Bin")),
            Ok(()) => reporter
                .log(Level::Info, format!("Moved addons\\{name}, which this build didn't produce, to the Recycle Bin")),
            Err(e) => reporter.warn(format!("Couldn't remove addons\\{name}: {e}")),
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
    if m.copy_mod_cpp {
        add_mod_cpp(reporter, m, mods, &output)?;
    }
    reporter.step(Step::Finish, StepStatus::Done);
    Ok(())
}

/// Writes a file the app puts in an `@mod` folder. Copying would carry a source file's read-only attribute with it,
/// and then nothing could replace the copy later, so the bytes are written instead, over any copy that is read-only
/// already.
pub fn write_output(path: &Path, contents: impl AsRef<[u8]>) -> std::io::Result<()> {
    if let Ok(metadata) = fs::metadata(path)
        && metadata.permissions().readonly()
    {
        let mut permissions = metadata.permissions();
        #[allow(
            clippy::permissions_set_readonly_false,
            reason = "on Windows this only clears the read-only attribute"
        )]
        permissions.set_readonly(false);
        fs::set_permissions(path, permissions)?;
    }
    fs::write(path, contents)
}

/// Another mod built into the same `@mod` folder that brings a mod.cpp of its own, which a mod without one leaves in
/// place, so building a mod's server half doesn't replace the mod.cpp of its client half.
fn mod_cpp_owner<'a>(m: &ModConfig, mods: &'a [ModConfig], output: &Path) -> Option<&'a ModConfig> {
    sharing(m, mods, output).find(|other| other.copy_mod_cpp && Path::new(&other.source_path).join("mod.cpp").is_file())
}

/// Puts a mod.cpp in the `@mod` folder: the mod's own with the version from its `CfgMods` class, so the two always
/// agree, or one written from that class if the mod hasn't got one.
fn add_mod_cpp(reporter: &mut Reporter, m: &ModConfig, mods: &[ModConfig], output: &Path) -> Result<(), Failure> {
    let source = Path::new(&m.source_path).join("mod.cpp");
    let target = output.join("mod.cpp");
    if !source.is_file()
        && target.is_file()
        && let Some(owner) = mod_cpp_owner(m, mods, output)
    {
        reporter.log(
            Level::Info,
            format!("Left mod.cpp as it is, since {} builds into the same folder and has its own", owner.name),
        );
        return Ok(());
    }
    let fail = |e: std::io::Error| Failure::new(Step::Finish, format!("Couldn't write mod.cpp: {e}"));
    let cfg_mods = inspect::cfg_mods_fields(Path::new(&m.source_path));
    let version = cfg_mods.iter().find(|(key, value)| key == "version" && !value.is_empty()).map(|(_, v)| v.as_str());

    if !source.is_file() {
        write_output(&target, mod_cpp::create(&cfg_mods, &m.name)).map_err(fail)?;
        reporter.log(
            Level::Info,
            if cfg_mods.is_empty() { "Wrote mod.cpp with the mod's name" } else { "Wrote mod.cpp from config.cpp" },
        );
        return Ok(());
    }
    let bytes = fs::read(&source).map_err(fail)?;
    let updated = match (version, std::str::from_utf8(&bytes)) {
        (Some(version), Ok(text)) => mod_cpp::with_version(text, version).map(|text| (version, text)),
        (Some(_), Err(_)) => {
            reporter.warn("mod.cpp isn't saved as UTF-8, so its version was left as it is.");
            None
        }
        (None, _) => None,
    };
    match updated {
        Some((version, text)) => {
            write_output(&target, text).map_err(fail)?;
            reporter.log(Level::Info, format!("Copied mod.cpp, with version {version} from config.cpp"));
        }
        None => {
            write_output(&target, bytes).map_err(fail)?;
            reporter.log(Level::Info, "Copied mod.cpp");
        }
    }
    Ok(())
}

/// Runs a build, returning its outcome and everything it showed along the way. `mods` is every saved mod, so the
/// build can leave alone the PBOs of others that share its output folder.
pub fn build(
    app: &AppHandle,
    control: &BuildControl,
    settings: &Settings,
    m: &ModConfig,
    mods: &[ModConfig],
) -> (BuildOutcome, Capture) {
    let timer = Instant::now();
    let mut reporter = Reporter { app, mod_id: m.id.clone(), warnings: Vec::new(), capture: RefCell::default() };
    let mut pbos = Vec::new();
    let result = build_steps(&mut reporter, control, settings, m, mods, &mut pbos);
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
    fn colours_whole_words_only() {
        // From real pboProject logs.
        assert!(matches!(line_level(r"\KK_Map\customassets\Spool\spool.p3d DeP3d:Generic Error"), Level::Error));
        assert!(matches!(line_level("preprocessing files produced an error"), Level::Error));
        assert!(matches!(line_level(r"Pal2Pace failed \Mod\a.png \Mod\a.paa"), Level::Error));
        assert!(matches!(line_level("Warning: Terrain grid 12.5 will be too slow, should use 30.0"), Level::Warning));
        assert!(matches!(line_level("success"), Level::Success));
        assert!(matches!(line_level(r"Scripts\3_Game\Core\ErrorHandler.c:loading..."), Level::Output));
        assert!(matches!(line_level(r"Scripts\4_World\error.c:loading..."), Level::Output));
        assert!(matches!(line_level("0 errors, 0 warnings"), Level::Output));
        assert!(matches!(line_level("cfgPatches.Mod.ammo[]= has been altered"), Level::Output));
    }

    #[test]
    fn keeps_a_character_split_between_reads() {
        let text = "Processing \\Müller\r\nPrefix = Müller\r\n".as_bytes();
        let split = text.iter().position(|&b| b == 0xC3).unwrap() + 1;
        let mut buffer = text[..split].to_vec();
        assert!(take_lines(&mut buffer).is_empty());
        buffer.extend_from_slice(&text[split..]);
        assert_eq!(take_lines(&mut buffer), ["Processing \\Müller\r\n", "Prefix = Müller\r\n"]);
        assert!(buffer.is_empty());
    }

    #[test]
    fn leaves_a_shared_folders_mod_cpp_to_the_mod_that_has_one() {
        let root = std::env::temp_dir().join(format!("flare-tools-shared-mod-cpp-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let output = root.join("@MyMod");
        for dir in ["Client", "Server", "Other", "@Other"] {
            fs::create_dir_all(root.join(dir)).unwrap();
        }
        fs::create_dir_all(&output).unwrap();
        fs::write(root.join(r"Client\mod.cpp"), "name = \"My Mod\";").unwrap();
        let config = |id: &str, source: &str, output: &Path| -> ModConfig {
            serde_json::from_value(serde_json::json!({
                "id": id,
                "name": id,
                "sourcePath": root.join(source),
                "outputPath": output,
            }))
            .unwrap()
        };
        let client = config("client", "Client", &output);
        let server = config("server", "Server", &output);
        let other = config("other", "Other", &root.join("@Other"));
        let mods = [client.clone(), server.clone(), other.clone()];

        assert_eq!(mod_cpp_owner(&server, &mods, &output).map(|m| m.id.as_str()), Some("client"));
        assert!(mod_cpp_owner(&client, &mods, &output).is_none(), "a mod's own mod.cpp is never left behind");
        assert!(mod_cpp_owner(&other, &mods, &root.join("@Other")).is_none(), "only mods in the same folder count");
        let mut without = client.clone();
        without.copy_mod_cpp = false;
        assert!(mod_cpp_owner(&server, &[without, server.clone()], &output).is_none());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_mod_with_every_pbo_unticked_cant_build() {
        let source = std::env::temp_dir().join(format!("flare-tools-unticked-{}", std::process::id()));
        let _ = fs::remove_dir_all(&source);
        for dir in ["gear", "vehicles"] {
            fs::create_dir_all(source.join(dir)).unwrap();
            fs::write(source.join(dir).join("config.cpp"), "").unwrap();
        }
        let plan = inspect::inspect("", &source.to_string_lossy(), None, None);
        let unticking = |skipped: &[&str]| -> ModConfig {
            serde_json::from_value(serde_json::json!({
                "id": "mod",
                "name": "Mod",
                "sourcePath": source,
                "outputPath": "",
                "skippedPbos": skipped,
            }))
            .unwrap()
        };

        assert!(ticked_problem(&unticking(&[]), &plan).is_none());
        assert!(ticked_problem(&unticking(&["gear"]), &plan).is_none());
        assert!(ticked_problem(&unticking(&["GEAR", "vehicles"]), &plan).is_some());
        fs::remove_dir_all(source).unwrap();
    }

    #[test]
    fn wont_pack_over_a_pbo_another_mod_builds_into_the_same_folder() {
        let root = std::env::temp_dir().join(format!("flare-tools-overwrite-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let output = root.join("@Mod");
        fs::create_dir_all(&output).unwrap();
        for source in [r"a\Core", r"b\Core", r"c\Server"] {
            fs::create_dir_all(root.join(source)).unwrap();
            fs::write(root.join(source).join("config.cpp"), "").unwrap();
        }
        let config = |id: &str, source: &str, pbo_name: Option<&str>| -> ModConfig {
            serde_json::from_value(serde_json::json!({
                "id": id,
                "name": id,
                "sourcePath": root.join(source),
                "outputPath": output,
                "pboName": pbo_name,
            }))
            .unwrap()
        };
        let settings = Settings::default();
        let check = |m: &ModConfig, mods: &[ModConfig]| {
            let plan = plan_of(&settings, m);
            let chosen: Vec<&PboPlan> = plan.pbos.iter().collect();
            overwrite_problem(&settings, m, mods, &chosen, &output)
        };

        // pboProject writes Core.pbo before it's renamed to A_Core.pbo.
        let renamed = config("renamed", r"a\Core", Some("A_Core"));
        let core = config("core", r"b\Core", None);
        let server = config("server", r"c\Server", None);
        assert!(check(&renamed, &[renamed.clone(), core.clone()]).unwrap().contains("Core.pbo over the one core"));
        assert!(check(&core, &[core.clone(), renamed.clone()]).is_none(), "A_Core.pbo is no threat to Core.pbo");
        assert!(check(&server, &[server.clone(), core.clone(), renamed.clone()]).is_none());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn writes_over_a_read_only_copy() {
        let path = std::env::temp_dir().join(format!("flare-tools-read-only-{}.cpp", std::process::id()));
        fs::write(&path, "old").unwrap();
        let mut permissions = fs::metadata(&path).unwrap().permissions();
        permissions.set_readonly(true);
        fs::set_permissions(&path, permissions).unwrap();

        write_output(&path, "new").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "new");
        assert!(!fs::metadata(&path).unwrap().permissions().readonly());
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn a_cancel_only_reaches_a_running_build() {
        let control = BuildControl::default();
        control.cancel();
        assert!(control.start(), "a cancel with nothing running is ignored");
        assert!(!control.start(), "one build at a time");
        control.cancel();
        assert!(control.cancelled() && control.running());
        control.finish();
        assert!(!control.running() && !control.cancelled());
        assert!(control.start() && !control.cancelled(), "the next build starts afresh");
    }

    #[test]
    fn spots_network_paths() {
        assert!(is_network_path(Path::new(r"\\server\mods\MyMod")));
        assert!(is_network_path(Path::new(r"\\?\UNC\server\mods\MyMod")));
        assert!(!is_network_path(Path::new(r"D:\Mods\MyMod")));
        assert!(!is_network_path(Path::new(r"\\?\D:\Mods\MyMod")));
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
    fn finds_everything_in_addons_but_the_built_pbos() {
        let addons = std::env::temp_dir().join(format!("flare-tools-addons-{}", std::process::id()));
        fs::create_dir_all(addons.join("folder")).unwrap();
        for file in ["Mod.pbo", "Mod.pbo.key.bisign", "Old.pbo", "mod.cpp"] {
            fs::write(addons.join(file), "").unwrap();
        }

        let stale = stale_files(&addons, &["mod.pbo".into()], &[]);
        let names: Vec<_> = stale.iter().map(|p| p.file_name().unwrap().to_string_lossy()).collect();
        assert_eq!(names, ["Mod.pbo.key.bisign", "Old.pbo", "mod.cpp"]);

        fs::remove_dir_all(addons).unwrap();
    }

    #[test]
    fn keeps_the_pbos_of_other_mods_built_into_the_same_folder() {
        let addons = std::env::temp_dir().join(format!("flare-tools-shared-{}", std::process::id()));
        fs::create_dir_all(&addons).unwrap();
        for file in ["Client.pbo", "Client.pbo.key.bisign", "Server.pbo", "Server.pbo.key.bisign", "Old.pbo"] {
            fs::write(addons.join(file), "").unwrap();
        }

        let stale = stale_files(&addons, &["Server.pbo".into()], &["client.pbo".into(), "Server.pbo".into()]);
        let names: Vec<_> = stale.iter().map(|p| p.file_name().unwrap().to_string_lossy()).collect();
        assert_eq!(names, ["Old.pbo", "Server.pbo.key.bisign"]);

        fs::remove_dir_all(addons).unwrap();
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

    #[test]
    fn explains_files_pbo_project_cannot_find() {
        assert_eq!(missing_file(r"missing in config.cpp : \AM_Fog\sphere.p3d"), Some(r"\AM_Fog\sphere.p3d"));
        assert_eq!(missing_file(r"\Mod\config.cpp circa Line 337: \AM_Fog\sphere.p3d"), None);
        assert_eq!(missing_file("Missing File Summary"), None);

        let p = Path::new("P:\\");
        let one = missing_files_message(&[r"\AM_Fog\sphere.p3d".into()], p);
        assert!(one.starts_with(r"pboProject can't find \AM_Fog\sphere.p3d, which"));
        assert!(one.contains(r"unpack that mod into P:\AM_Fog so"));

        let files = [r"\AM_Fog\a.p3d", r"\am_fog\b.p3d", r"deerisle\objects\c.p3d", r"\Other\d.paa"].map(String::from);
        let many = missing_files_message(&files, p);
        assert!(
            many.starts_with(
                r"pboProject can't find 4 files the mod refers to, in P:\AM_Fog, P:\deerisle and P:\Other."
            )
        );
    }
}
