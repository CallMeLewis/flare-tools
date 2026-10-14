use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

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
}

impl Store {
    pub fn load(path: PathBuf) -> Self {
        let data = fs::read_to_string(&path)
            .ok()
            .and_then(|text| serde_json::from_str::<AppData>(&text).ok())
            .unwrap_or_else(|| AppData { settings: detect::detect_settings(), ..Default::default() });
        Self { path, data: Mutex::new(data) }
    }

    pub fn save(&self, data: &AppData) -> Result<(), String> {
        if let Some(dir) = self.path.parent() {
            fs::create_dir_all(dir).map_err(|e| format!("Couldn't create {}: {e}", dir.display()))?;
        }
        let text = serde_json::to_string_pretty(data).map_err(|e| e.to_string())?;
        let tmp = self.path.with_extension("json.tmp");
        fs::write(&tmp, text).map_err(|e| format!("Couldn't save settings: {e}"))?;
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
