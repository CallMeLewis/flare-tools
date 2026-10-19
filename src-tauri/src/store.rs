use std::collections::BTreeMap;
use std::fs::{self, File};
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::detect;
use crate::steam::ItemStats;

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub p_drive: String,
    pub pbo_project_path: String,
    pub ds_sign_file_path: String,
    pub default_private_key_path: String,
    pub default_output_root: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LastBuild {
    /// Milliseconds since the Unix epoch.
    pub finished_at: u64,
    pub ok: bool,
    pub duration_ms: u64,
    pub pbos: Vec<String>,
    pub signed: bool,
}

fn yes() -> bool {
    true
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModConfig {
    pub id: String,
    pub name: String,
    pub source_path: String,
    /// Overrides the detected prefix when set.
    #[serde(default)]
    pub prefix: Option<String>,
    /// The `@Mod` folder; PBOs go into its `addons` folder.
    pub output_path: String,
    /// Overrides the PBO name for single-PBO mods.
    #[serde(default)]
    pub pbo_name: Option<String>,
    #[serde(default = "yes")]
    pub binarise: bool,
    #[serde(default = "yes")]
    pub sign: bool,
    /// Overrides the default private key when set.
    #[serde(default)]
    pub private_key_path: Option<String>,
    #[serde(default = "yes")]
    pub copy_mod_cpp: bool,
    /// Lets pboProject convert PNGs to PAA. DayZ GUIs often use PNGs as they are.
    #[serde(default = "yes")]
    pub convert_png: bool,
    /// The folders of the PBOs left out of builds, relative to the mod folder. A list of what's left out rather than
    /// what's in, so a PBO added to the mod later is built without being ticked.
    #[serde(default)]
    pub skipped_pbos: Vec<String>,
    #[serde(default)]
    pub last_build: Option<LastBuild>,
}

impl ModConfig {
    /// Treats blank optional fields as unset so the frontend can send empty strings.
    pub fn normalised(mut self) -> Self {
        fn clean(value: Option<String>) -> Option<String> {
            value.map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
        }
        self.name = self.name.trim().to_string();
        self.source_path = self.source_path.trim().to_string();
        self.output_path = self.output_path.trim().to_string();
        self.prefix = clean(self.prefix);
        self.pbo_name = clean(self.pbo_name);
        self.private_key_path = clean(self.private_key_path);
        self
    }
}

/// What the app remembers about a Workshop item that Steam doesn't store.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct WorkshopLink {
    /// The folder last uploaded as the item's files.
    pub content_path: String,
}

/// An item's totals as they were on one day. Steam only gives the current figures, so trends
/// come from the app recording them whenever the Workshop list is refreshed.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatSnapshot {
    /// Milliseconds since the Unix epoch.
    pub at: u64,
    pub stats: ItemStats,
}

const DAY_MS: u64 = 86_400_000;
/// About a year of daily snapshots per item.
const MAX_SNAPSHOTS: usize = 400;

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AppData {
    pub settings: Settings,
    pub mods: Vec<ModConfig>,
    /// Keyed by Workshop item id.
    pub workshop: BTreeMap<String, WorkshopLink>,
    /// Daily stat snapshots, keyed by Workshop item id, oldest first.
    pub history: BTreeMap<String, Vec<StatSnapshot>>,
}

impl AppData {
    /// Records today's totals for an item, replacing an earlier snapshot from the same day.
    pub fn record_stats(&mut self, item_id: &str, at: u64, stats: &ItemStats) -> &[StatSnapshot] {
        let history = self.history.entry(item_id.to_string()).or_default();
        let snapshot = StatSnapshot { at, stats: stats.clone() };
        match history.last_mut() {
            Some(last) if last.at / DAY_MS == at / DAY_MS => *last = snapshot,
            _ => history.push(snapshot),
        }
        if history.len() > MAX_SNAPSHOTS {
            history.drain(..history.len() - MAX_SNAPSHOTS);
        }
        history
    }
}

pub struct Store {
    path: PathBuf,
    pub data: Mutex<AppData>,
    /// What went wrong reading the saved data at startup, until the user has been told.
    notice: Mutex<Option<String>>,
    /// The unreadable file couldn't be moved out of the way, so saving would overwrite it.
    read_only: bool,
}

/// Reads saved data, or `None` when there isn't any yet.
fn read(path: &Path) -> Result<Option<AppData>, String> {
    let text = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.to_string()),
    };
    serde_json::from_str(&text).map(Some).map_err(|e| e.to_string())
}

/// Moves an unreadable file aside so the next save can't overwrite it, returning where it went.
fn set_aside(path: &Path) -> Option<PathBuf> {
    let at = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    let kept = path.with_file_name(format!("data-unreadable-{at}.json"));
    (fs::rename(path, &kept).is_ok() || fs::copy(path, &kept).is_ok()).then_some(kept)
}

impl Store {
    pub fn load(path: PathBuf) -> Self {
        let backup = path.with_extension("json.bak");
        let fresh = || AppData { settings: detect::detect_settings(), ..Default::default() };
        let (data, notice, read_only) = match read(&path) {
            Ok(Some(data)) => {
                // A copy of the last data that loaded, in case the next save is lost.
                let _ = fs::copy(&path, &backup);
                (data, None, false)
            }
            Ok(None) => (fresh(), None, false),
            Err(error) => {
                eprintln!("Couldn't read {}: {error}", path.display());
                let kept = set_aside(&path);
                let (data, restored) = match read(&backup) {
                    Ok(Some(data)) => (data, true),
                    _ => (fresh(), false),
                };
                let what = if restored {
                    "They were restored from the copy saved when Flare Tools last started, so changes made since then are lost."
                } else {
                    "There was no copy to restore them from, so Flare Tools started afresh."
                };
                let notice = match &kept {
                    Some(kept) => format!("{what} The unreadable file was kept as {}.", kept.display()),
                    None => format!(
                        "{what} {} couldn't be moved aside, so changes won't be saved until Flare Tools is restarted.",
                        path.display()
                    ),
                };
                (data, Some(notice), kept.is_none())
            }
        };
        Self { path, data: Mutex::new(data), notice: Mutex::new(notice), read_only }
    }

    /// What went wrong reading the saved data at startup, once.
    pub fn take_notice(&self) -> Option<String> {
        self.notice.lock().ok()?.take()
    }

    pub fn save(&self, data: &AppData) -> Result<(), String> {
        if self.read_only {
            return Err(format!(
                "Couldn't save settings: {} couldn't be read when Flare Tools started.",
                self.path.display()
            ));
        }
        if let Some(dir) = self.path.parent() {
            fs::create_dir_all(dir).map_err(|e| format!("Couldn't create {}: {e}", dir.display()))?;
        }
        let text = serde_json::to_string_pretty(data).map_err(|e| e.to_string())?;
        let tmp = self.path.with_extension("json.tmp");
        // Flushed before the rename, so losing power can't leave data.json empty.
        File::create(&tmp)
            .and_then(|mut file| {
                file.write_all(text.as_bytes())?;
                file.sync_all()
            })
            .map_err(|e| format!("Couldn't save settings: {e}"))?;
        fs::rename(&tmp, &self.path).map_err(|e| format!("Couldn't save settings: {e}"))
    }

    /// Applies a change to the stored data and saves it.
    pub fn update<T>(&self, change: impl FnOnce(&mut AppData) -> Result<T, String>) -> Result<T, String> {
        let mut data = self.data.lock().map_err(|_| "Settings are locked".to_string())?;
        let result = change(&mut data)?;
        self.save(&data)?;
        Ok(result)
    }

    pub fn snapshot(&self) -> AppData {
        self.data.lock().map(|d| d.clone()).unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("flare-tools-store-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn with_mod(name: &str) -> AppData {
        let config = serde_json::json!({ "id": "a", "name": name, "sourcePath": "", "outputPath": "" });
        AppData { mods: vec![serde_json::from_value(config).unwrap()], ..Default::default() }
    }

    #[test]
    fn restores_the_backup_and_keeps_an_unreadable_file() {
        let dir = temp_dir("restore");
        let path = dir.join("data.json");
        Store::load(path.clone()).save(&with_mod("Saved")).unwrap();
        // Loading a good file keeps a backup of it.
        assert_eq!(Store::load(path.clone()).snapshot().mods[0].name, "Saved");

        fs::write(&path, "{ not json").unwrap();
        let store = Store::load(path.clone());
        assert_eq!(store.snapshot().mods[0].name, "Saved");
        assert!(store.take_notice().unwrap().starts_with("They were restored"));
        assert!(store.take_notice().is_none());
        let kept: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().starts_with("data-unreadable-"))
            .collect();
        assert_eq!(fs::read_to_string(kept[0].path()).unwrap(), "{ not json");

        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_missing_file_starts_afresh_without_a_notice() {
        let dir = temp_dir("missing");
        let store = Store::load(dir.join("data.json"));
        assert!(store.snapshot().mods.is_empty());
        assert!(store.take_notice().is_none());
        fs::remove_dir_all(dir).unwrap();
    }
}
