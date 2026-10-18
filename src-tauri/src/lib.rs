mod build;
mod content;
mod detect;
mod history;
mod inspect;
mod meta_cpp;
mod mod_cpp;
mod steam;
mod store;

use std::fs;
use std::path::Path;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use build::{BuildControl, BuildOutcome};
use history::{BuildRecord, LogLine};
use inspect::Inspection;
use steam::{PublishError, PublishOutcome, PublishRequest, STEAM, SteamPresence, SteamStatus, WorkshopItem};
use store::{AppData, LastBuild, ModConfig, Settings, Store, WorkshopLink};

/// Stops walking a mod's files after this many when checking for changes.
const MAX_FILES_CHECKED: usize = 50_000;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ModStatus {
    id: String,
    source_exists: bool,
    /// Milliseconds since the Unix epoch of the newest file in the mod's folder.
    last_modified: Option<u64>,
    /// Why the mod can't be built right now, if it can't.
    problem: Option<String>,
    /// The version the mod declares, from its CfgMods class or failing that mod.cpp.
    version: Option<String>,
}

#[tauri::command]
fn get_data(store: State<Store>) -> AppData {
    store.snapshot()
}

#[tauri::command]
fn take_data_notice(store: State<Store>) -> Option<String> {
    store.take_notice()
}

/// Tells the smoke test the window has drawn its interface, by writing to the file it names in
/// FLARE_TOOLS_SMOKE_TEST. Without that variable, which only the smoke test sets, it does nothing.
#[tauri::command]
fn interface_ready() {
    if let Some(path) = std::env::var_os("FLARE_TOOLS_SMOKE_TEST") {
        let _ = fs::write(path, "ready");
    }
}

#[tauri::command]
fn detect_tools() -> Settings {
    detect::detect_settings()
}

#[tauri::command]
fn save_settings(store: State<Store>, settings: Settings) -> Result<Settings, String> {
    store.update(|data| {
        data.settings = settings;
        Ok(data.settings.clone())
    })
}

/// Runs work that reads the disk away from the main thread, where a slow or sleeping drive would
/// freeze the window. Commands that aren't async run on the main thread.
async fn off_main<T: Send + 'static>(work: impl FnOnce() -> T + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn inspect_mod(
    store: State<'_, Store>,
    source_path: String,
    prefix: Option<String>,
    pbo_name: Option<String>,
) -> Result<Inspection, String> {
    // Only the P: drive is needed, so the rest of the data isn't copied.
    let p_drive = store.data.lock().map(|data| data.settings.p_drive.clone()).unwrap_or_default();
    off_main(move || inspect::inspect(&p_drive, &source_path, prefix.as_deref(), pbo_name.as_deref())).await
}

fn new_id() -> String {
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    format!("mod-{nanos:x}")
}

#[tauri::command]
fn save_mod(store: State<Store>, config: ModConfig) -> Result<ModConfig, String> {
    let mut config = config.normalised();
    if config.source_path.is_empty() {
        return Err("Choose the mod's source folder.".into());
    }
    if config.output_path.is_empty() {
        return Err("Choose an output folder.".into());
    }
    if let Some(problem) = config.pbo_name.as_deref().and_then(inspect::pbo_name_problem) {
        return Err(problem);
    }
    if config.name.is_empty() {
        config.name = Path::new(&config.source_path)
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "Mod".into());
    }
    store.update(|data| {
        match data.mods.iter_mut().find(|m| !config.id.is_empty() && m.id == config.id) {
            Some(existing) => {
                // Build history is owned by the backend.
                config.last_build = existing.last_build.clone();
                *existing = config.clone();
            }
            None => {
                config.id = new_id();
                config.last_build = None;
                data.mods.push(config.clone());
            }
        }
        Ok(config)
    })
}

#[tauri::command]
async fn remove_mod(store: State<'_, Store>, builds: State<'_, history::Dir>, id: String) -> Result<(), String> {
    store.update(|data| {
        data.mods.retain(|m| m.id != id);
        Ok(())
    })?;
    let builds = history::Dir(builds.0.clone());
    off_main(move || history::remove(&builds, &id)).await
}

#[tauri::command]
fn build_history(builds: State<history::Dir>, mod_id: String) -> Vec<BuildRecord> {
    history::list(&builds, &mod_id)
}

#[tauri::command]
fn build_log(builds: State<history::Dir>, mod_id: String, build_id: String) -> Result<Vec<LogLine>, String> {
    history::log(&builds, &mod_id, &build_id)
}

fn newest_file(dir: &Path, newest: &mut Option<SystemTime>, seen: &mut usize) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        if *seen >= MAX_FILES_CHECKED {
            return;
        }
        let path = entry.path();
        let Ok(kind) = entry.file_type() else { continue };
        if kind.is_dir() {
            if !entry.file_name().to_string_lossy().starts_with('.') {
                newest_file(&path, newest, seen);
            }
            continue;
        }
        *seen += 1;
        if let Ok(modified) = entry.metadata().and_then(|m| m.modified())
            && newest.is_none_or(|n| modified > n)
        {
            *newest = Some(modified);
        }
    }
}

#[tauri::command]
async fn mod_statuses(store: State<'_, Store>) -> Result<Vec<ModStatus>, String> {
    let AppData { settings, mods, .. } = store.snapshot();
    tauri::async_runtime::spawn_blocking(move || {
        mods.iter()
            .map(|m| {
                let dir = Path::new(&m.source_path);
                let mut newest = None;
                let mut seen = 0;
                newest_file(dir, &mut newest, &mut seen);
                let plan =
                    inspect::inspect(&settings.p_drive, &m.source_path, m.prefix.as_deref(), m.pbo_name.as_deref());
                ModStatus {
                    problem: plan.problem.clone(),
                    version: plan
                        .cfg_mods
                        .as_ref()
                        .and_then(|meta| meta.version.clone())
                        .or_else(|| plan.mod_cpp.as_ref().and_then(|meta| meta.version.clone())),
                    id: m.id.clone(),
                    source_exists: dir.is_dir(),
                    last_modified: newest.and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64),
                }
            })
            .collect()
    })
    .await
    .map_err(|e| e.to_string())
}

/// Marks the build as finished even if it panics.
struct RunningGuard<'a>(&'a BuildControl);

impl Drop for RunningGuard<'_> {
    fn drop(&mut self) {
        self.0.finish();
    }
}

#[tauri::command]
async fn build_mod(app: AppHandle, id: String) -> Result<BuildOutcome, String> {
    let control = app.state::<BuildControl>();
    if !control.start() {
        return Err("Another build is already running.".into());
    }

    let handle = app.clone();
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        let control = handle.state::<BuildControl>();
        let _guard = RunningGuard(&control);
        let store = handle.state::<Store>();
        let data = store.snapshot();
        let config = data.mods.iter().find(|m| m.id == id).cloned().ok_or("That mod no longer exists.")?;
        let started_at = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
        let (outcome, capture) = build::build(&handle, &control, &data.settings, &config, &data.mods);
        // A mod removed while it built has had its history deleted, which saving now would bring back.
        let listed = store.data.lock().map(|data| data.mods.iter().any(|m| m.id == id)).unwrap_or(true);
        if listed && let Err(error) = history::save(&handle.state::<history::Dir>(), &id, started_at, &outcome, capture)
        {
            eprintln!("Couldn't save the build record: {error}");
        }
        // The PBOs are built and the history saved either way, so a failed save doesn't fail the build.
        if !outcome.cancelled
            && let Err(error) = store.update(|data| {
                if let Some(m) = data.mods.iter_mut().find(|m| m.id == id) {
                    m.last_build = Some(LastBuild {
                        finished_at: outcome.finished_at,
                        ok: outcome.ok,
                        duration_ms: outcome.duration_ms,
                        pbos: outcome.pbos.iter().map(|p| p.name.clone()).collect(),
                        signed: outcome.signed,
                    });
                }
                Ok(())
            })
        {
            eprintln!("Couldn't save the mod's last build: {error}");
        }
        Ok::<_, String>(outcome)
    })
    .await
    .map_err(|e| e.to_string());

    // The guard only exists once the blocking task starts, so make sure the build is marked finished.
    if outcome.is_err() {
        control.finish();
    }
    outcome?
}

#[tauri::command]
fn cancel_build(control: State<BuildControl>) {
    control.cancel();
}

#[tauri::command]
async fn path_exists(path: String) -> bool {
    off_main(move || !path.trim().is_empty() && Path::new(path.trim()).exists()).await.unwrap_or(false)
}

#[tauri::command]
async fn open_folder(path: String) -> Result<(), String> {
    off_main(move || {
        let path = Path::new(path.trim());
        let target = if path.is_dir() {
            path.to_path_buf()
        } else {
            path.parent()
                .filter(|p| p.is_dir())
                .map(Path::to_path_buf)
                .ok_or_else(|| format!("{} doesn't exist yet.", path.display()))?
        };
        without_steam_ids(Command::new("explorer").arg(target)).spawn().map(|_| ()).map_err(|e| e.to_string())
    })
    .await?
}

#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    // Only web and Steam links: another kind, such as file: or a program's own, could run something.
    // steam:// links open inside the Steam client, which is signed in already.
    if !["https://", "http://", "steam://"].iter().any(|scheme| url.starts_with(scheme)) {
        return Err("Only web and Steam links can be opened.".into());
    }
    // Explorer can't take a URL with a query string (it opens Documents instead), so hand it to
    // Windows' URL handler, which opens the default browser like a clicked link.
    without_steam_ids(Command::new("rundll32").args(["url.dll,FileProtocolHandler", &url]))
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// Connecting to Steam sets SteamAppId and SteamGameId to DayZ's for this process, and anything it
/// starts would inherit them, including Steam itself when a steam:// link opens it.
fn without_steam_ids(command: &mut Command) -> &mut Command {
    command.env_remove("SteamAppId").env_remove("SteamGameId")
}

/// Images the window may read, which are those it offers as a Workshop preview.
const READABLE_IMAGES: &[&str] = &["png", "jpg", "jpeg", "gif"];

/// Reads an image for the webview, which can't load local paths itself. Used for preview images, and
/// limited to them so the window can't be used to read anything else on the computer.
#[tauri::command]
async fn read_file(path: String) -> Result<tauri::ipc::Response, String> {
    off_main(move || {
        let path = Path::new(path.trim());
        let image = path.extension().is_some_and(|ext| READABLE_IMAGES.iter().any(|e| ext.eq_ignore_ascii_case(e)));
        if !image {
            return Err("Only PNG, JPEG and GIF images can be shown.".into());
        }
        let size = fs::metadata(path).map_err(|e| e.to_string())?.len();
        // Previews are limited to 1 MB; anything far bigger isn't worth loading.
        if size > 32 * 1024 * 1024 {
            return Err("That file is too big to show.".into());
        }
        fs::read(path).map(tauri::ipc::Response::new).map_err(|e| e.to_string())
    })
    .await?
}

#[tauri::command]
async fn steam_status() -> Result<SteamStatus, String> {
    tauri::async_runtime::spawn_blocking(|| STEAM.status()).await.map_err(|e| e.to_string())
}

/// Cheap enough to poll: it reads the registry rather than connecting to Steam.
#[tauri::command]
async fn steam_presence() -> Result<SteamPresence, String> {
    tauri::async_runtime::spawn_blocking(|| STEAM.presence()).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn workshop_items(store: State<'_, Store>) -> Result<Vec<WorkshopItem>, String> {
    let mut items = tauri::async_runtime::spawn_blocking(|| STEAM.items()).await.map_err(|e| e.to_string())??;
    let now =
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
    store.update(|data| {
        for item in &mut items {
            item.content_path = data.workshop.get(&item.id).map(|l| l.content_path.clone()).filter(|p| !p.is_empty());
            item.history = data.record_stats(&item.id, now, &item.stats).to_vec();
        }
        Ok(())
    })?;
    Ok(items)
}

#[tauri::command]
async fn inspect_content(path: String) -> Result<content::ContentSummary, String> {
    tauri::async_runtime::spawn_blocking(move || content::inspect(path.trim())).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn publish_item(app: AppHandle, request: PublishRequest) -> Result<PublishOutcome, PublishError> {
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let outcome = STEAM.publish(&request, |progress| {
            let _ = handle.emit("publish-progress", progress);
        })?;
        if let Some(path) = request.content_path.as_deref().map(str::trim) {
            handle.state::<Store>().update(|data| {
                data.workshop.insert(outcome.item_id.clone(), WorkshopLink { content_path: path.to_string() });
                Ok(())
            })?;
        }
        Ok(outcome)
    })
    .await
    .map_err(|e| PublishError::from(e.to_string()))?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    // A second copy would share data.json and the links on P:, so starting the app again brings the
    // open window forward instead. Development builds skip this, to run beside an installed copy.
    #[cfg(not(debug_assertions))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
        }
    }));
    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_flare_updater::updater())
        .plugin(
            // Must match the feed in scripts/publish-update.ts.
            tauri_plugin_flare_updater::Builder::new("Flare-Tools", "https://updates.darkzone.dev/flare-tools/")
                // The installer closes the app straight away, so let a build clean up first.
                .on_before_exit(build::stop)
                .build(),
        )
        .setup(|app| {
            let path = app.path().app_config_dir()?.join("data.json");
            app.manage(Store::load(path));
            app.manage(history::Dir(app.path().app_config_dir()?.join("builds")));
            let links = app.path().app_config_dir()?.join("build-links");
            build::remove_leftover_links(&links);
            app.manage(BuildControl::new(links));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_data,
            take_data_notice,
            interface_ready,
            detect_tools,
            save_settings,
            inspect_mod,
            save_mod,
            remove_mod,
            mod_statuses,
            build_mod,
            build_history,
            build_log,
            cancel_build,
            path_exists,
            open_folder,
            open_url,
            read_file,
            steam_status,
            steam_presence,
            workshop_items,
            inspect_content,
            publish_item,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                build::stop(app);
            }
        });
}
