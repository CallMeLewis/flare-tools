mod build;
mod content;
mod detect;
mod history;
mod inspect;
mod steam;
mod store;
mod updater;

use std::fs;
use std::path::Path;
use std::process::Command;
use std::sync::atomic::Ordering;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use build::{BuildControl, BuildOutcome};
use history::{BuildRecord, LogLine};
use inspect::Inspection;
use steam::{PublishOutcome, PublishRequest, STEAM, SteamPresence, SteamStatus, WorkshopItem};
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
    /// The version the mod declares, from mod.cpp or failing that its CfgMods class.
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

#[tauri::command]
fn inspect_mod(
    store: State<Store>,
    source_path: String,
    prefix: Option<String>,
    pbo_name: Option<String>,
) -> Inspection {
    let p_drive = store.snapshot().settings.p_drive;
    inspect::inspect(&p_drive, &source_path, prefix.as_deref(), pbo_name.as_deref())
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
fn remove_mod(store: State<Store>, builds: State<history::Dir>, id: String) -> Result<(), String> {
    store.update(|data| {
        data.mods.retain(|m| m.id != id);
        Ok(())
    })?;
    history::remove(&builds, &id);
    Ok(())
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
                let blocked = !plan.source_exists
                    || plan.pbos.is_empty()
                    || matches!(plan.link, inspect::LinkStatus::Conflict | inspect::LinkStatus::NoPDrive);
                ModStatus {
                    problem: blocked.then(|| plan.warnings.last().cloned().unwrap_or_default()),
                    version: plan
                        .mod_cpp
                        .as_ref()
                        .and_then(|meta| meta.version.clone())
                        .or_else(|| plan.cfg_mods.as_ref().and_then(|meta| meta.version.clone())),
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

/// Clears the running flag even if the build panics.
struct RunningGuard<'a>(&'a BuildControl);

impl Drop for RunningGuard<'_> {
    fn drop(&mut self) {
        self.0.running.store(false, Ordering::SeqCst);
    }
}

#[tauri::command]
async fn build_mod(app: AppHandle, id: String) -> Result<BuildOutcome, String> {
    let control = app.state::<BuildControl>();
    if control.running.swap(true, Ordering::SeqCst) {
        return Err("Another build is already running.".into());
    }
    control.cancel.store(false, Ordering::SeqCst);

    let handle = app.clone();
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        let control = handle.state::<BuildControl>();
        let _guard = RunningGuard(&control);
        let store = handle.state::<Store>();
        let data = store.snapshot();
        let config = data.mods.iter().find(|m| m.id == id).cloned().ok_or("That mod no longer exists.")?;
        let started_at = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
        let (outcome, capture) = build::build(&handle, &control, &data.settings, &config);
        if let Err(error) = history::save(&handle.state::<history::Dir>(), &id, started_at, &outcome, capture) {
            eprintln!("Couldn't save the build record: {error}");
        }
        if !outcome.cancelled {
            store.update(|data| {
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
            })?;
        }
        Ok::<_, String>(outcome)
    })
    .await
    .map_err(|e| e.to_string());

    // The guard only exists once the blocking task starts, so make sure the flag clears.
    if outcome.is_err() {
        control.running.store(false, Ordering::SeqCst);
    }
    outcome?
}

#[tauri::command]
fn cancel_build(control: State<BuildControl>) {
    if control.running.load(Ordering::SeqCst) {
        control.cancel.store(true, Ordering::SeqCst);
    }
}

#[tauri::command]
fn path_exists(path: String) -> bool {
    !path.trim().is_empty() && Path::new(path.trim()).exists()
}

#[tauri::command]
fn open_folder(path: String) -> Result<(), String> {
    let path = Path::new(path.trim());
    let target = if path.is_dir() {
        path.to_path_buf()
    } else {
        path.parent()
            .filter(|p| p.is_dir())
            .map(Path::to_path_buf)
            .ok_or_else(|| format!("{} doesn't exist yet.", path.display()))?
    };
    Command::new("explorer").arg(target).spawn().map(|_| ()).map_err(|e| e.to_string())
}

#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    // steam:// links open inside the Steam client, which is signed in already.
    if !(url.starts_with("https://") || url.starts_with("steam://")) {
        return Err("Only https and steam links can be opened.".into());
    }
    // Explorer can't take a URL with a query string (it opens Documents instead), so hand it to
    // Windows' URL handler, which opens the default browser like a clicked link.
    Command::new("rundll32").args(["url.dll,FileProtocolHandler", &url]).spawn().map(|_| ()).map_err(|e| e.to_string())
}

/// Reads a file for the webview, which can't load local paths itself. Used for preview images.
#[tauri::command]
fn read_file(path: String) -> Result<tauri::ipc::Response, String> {
    let path = Path::new(path.trim());
    let size = fs::metadata(path).map_err(|e| e.to_string())?.len();
    // Previews are limited to 1 MB; anything far bigger isn't worth loading.
    if size > 32 * 1024 * 1024 {
        return Err("That file is too big to show.".into());
    }
    fs::read(path).map(tauri::ipc::Response::new).map_err(|e| e.to_string())
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
async fn publish_item(app: AppHandle, request: PublishRequest) -> Result<PublishOutcome, String> {
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
    .map_err(|e| e.to_string())?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(updater::Updater::new())
        .setup(|app| {
            let path = app.path().app_config_dir()?.join("data.json");
            app.manage(Store::load(path));
            app.manage(history::Dir(app.path().app_config_dir()?.join("builds")));
            app.manage(BuildControl::default());
            updater::Updater::start(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_data,
            take_data_notice,
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
            updater::update_status,
            updater::check_for_updates,
            updater::download_update,
            updater::install_update,
            updater::update_settings,
            updater::set_auto_update_check,
            updater::set_update_channel,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
