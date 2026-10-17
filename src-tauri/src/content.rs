use std::fs;
use std::path::Path;

use serde::Serialize;

/// Stops counting a folder's files after this many.
const MAX_FILES: usize = 50_000;

/// What's in a folder that's about to be uploaded to the Workshop.
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentSummary {
    pub exists: bool,
    /// PBO names in `addons`, without the extension.
    pub pbos: Vec<String>,
    /// `.bikey` names in `keys`, without the extension.
    pub keys: Vec<String>,
    pub has_mod_cpp: bool,
    pub file_count: usize,
    pub total_size: u64,
    pub warnings: Vec<String>,
}

fn has_extension(path: &Path, ext: &str) -> bool {
    path.extension().is_some_and(|e| e.eq_ignore_ascii_case(ext))
}

fn stems(dir: &Path, ext: &str) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_file() && has_extension(p, ext))
        .filter_map(|p| p.file_stem().map(|s| s.to_string_lossy().into_owned()))
        .collect();
    names.sort_by_key(|n| n.to_lowercase());
    names
}

/// Finds a child folder by name, ignoring case, as DayZ does.
fn child_dir(dir: &Path, name: &str) -> Option<std::path::PathBuf> {
    fs::read_dir(dir)
        .ok()?
        .flatten()
        .find(|e| e.file_name().to_string_lossy().eq_ignore_ascii_case(name) && e.path().is_dir())
        .map(|e| e.path())
}

/// Names what's in `addons` besides PBOs and their signatures, which is all DayZ loads from it.
fn unloaded(addons: &Path) -> Option<String> {
    let mut names: Vec<String> = fs::read_dir(addons)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| !p.is_file() || !(has_extension(p, "pbo") || has_extension(p, "bisign")))
        .filter_map(|p| p.file_name().map(|s| s.to_string_lossy().into_owned()))
        .collect();
    names.sort_by_key(|n| n.to_lowercase());
    (!names.is_empty()).then(|| format!("DayZ won't load {} from the addons folder.", names.join(", ")))
}

fn count(dir: &Path, summary: &mut ContentSummary) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        if summary.file_count >= MAX_FILES {
            return;
        }
        let Ok(kind) = entry.file_type() else { continue };
        if kind.is_dir() {
            count(&entry.path(), summary);
        } else {
            summary.file_count += 1;
            summary.total_size += entry.metadata().map(|m| m.len()).unwrap_or(0);
        }
    }
}

pub fn inspect(path: &str) -> ContentSummary {
    let root = Path::new(path);
    if !root.is_dir() {
        return ContentSummary::default();
    }
    let mut summary = ContentSummary { exists: true, ..Default::default() };
    count(root, &mut summary);
    if summary.file_count >= MAX_FILES {
        summary.warnings.push(format!("Stopped counting at {MAX_FILES} files. Is this the right folder?"));
    }

    let addons = child_dir(root, "addons");
    summary.pbos = addons.as_deref().map(|d| stems(d, "pbo")).unwrap_or_default();
    summary.keys = child_dir(root, "keys").map(|d| stems(&d, "bikey")).unwrap_or_default();
    summary.has_mod_cpp = root.join("mod.cpp").is_file();

    match &addons {
        None if !stems(root, "pbo").is_empty() => {
            summary.warnings.push("The PBOs aren't in an addons folder, so DayZ won't load them.".into())
        }
        None => summary.warnings.push("There's no addons folder.".into()),
        Some(_) if summary.pbos.is_empty() => summary.warnings.push("The addons folder has no PBOs.".into()),
        Some(dir) => {
            if let Some(warning) = unloaded(dir) {
                summary.warnings.push(warning);
            }
            let signatures: Vec<String> = fs::read_dir(dir)
                .into_iter()
                .flatten()
                .flatten()
                .map(|e| e.file_name().to_string_lossy().to_lowercase())
                .filter(|n| n.ends_with(".bisign"))
                .collect();
            let unsigned = summary
                .pbos
                .iter()
                .filter(|pbo| !signatures.iter().any(|s| s.starts_with(&format!("{}.pbo.", pbo.to_lowercase()))))
                .count();
            if unsigned > 0 {
                summary.warnings.push(if unsigned == summary.pbos.len() {
                    "The PBOs aren't signed, so servers that check signatures will kick players.".into()
                } else {
                    format!("{unsigned} of the PBOs aren't signed.")
                });
            } else if summary.keys.is_empty() {
                summary
                    .warnings
                    .push("The PBOs are signed but there's no .bikey in a keys folder for servers to use.".into());
            }
        }
    }
    summary
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_what_dayz_will_not_load_from_addons() {
        let root = std::env::temp_dir().join(format!("flare-tools-content-{}", std::process::id()));
        let addons = root.join("addons");
        fs::create_dir_all(addons.join("old")).unwrap();
        for file in ["Mod.pbo", "Mod.pbo.key.bisign", "mod.cpp"] {
            fs::write(addons.join(file), "").unwrap();
        }

        let summary = inspect(&root.to_string_lossy());
        assert!(summary.warnings.contains(&"DayZ won't load mod.cpp, old from the addons folder.".to_string()));

        fs::remove_dir_all(root).unwrap();
    }
}
