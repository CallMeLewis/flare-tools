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

/// The names of the `.bikey` files in `keys`, as servers match them to signatures: the name written at the start of
/// each key, which DSSignFile names signatures after and needn't match its file's. A key that can't be read counts by
/// its file's name.
fn key_names(keys: &Path) -> Vec<String> {
    stems(keys, "bikey")
        .into_iter()
        .map(|stem| {
            fs::read(keys.join(format!("{stem}.bikey")))
                .ok()
                .and_then(|bytes| {
                    Some(String::from_utf8_lossy(&bytes[..bytes.iter().position(|&b| b == 0)?]).into_owned())
                })
                .filter(|name| !name.is_empty())
                .unwrap_or(stem)
        })
        .collect()
}

/// The keys a PBO is signed with, from the names of its signatures: `<pbo>.pbo.<key>.bisign`.
fn signing_keys(pbo: &str, signatures: &[String]) -> Vec<String> {
    let prefix = format!("{pbo}.pbo.");
    signatures
        .iter()
        .filter(|name| name.get(..prefix.len()).is_some_and(|head| head.eq_ignore_ascii_case(&prefix)))
        .filter_map(|name| name.get(prefix.len()..name.len() - ".bisign".len()))
        .filter(|key| !key.is_empty())
        .map(str::to_string)
        .collect()
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
    let keys = child_dir(root, "keys");
    summary.keys = keys.as_deref().map(|d| stems(d, "bikey")).unwrap_or_default();
    let key_names = keys.as_deref().map(key_names).unwrap_or_default();
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
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .filter(|n| n.to_ascii_lowercase().ends_with(".bisign"))
                .collect();
            let signed_with: Vec<Vec<String>> = summary.pbos.iter().map(|pbo| signing_keys(pbo, &signatures)).collect();
            let unsigned = signed_with.iter().filter(|keys| keys.is_empty()).count();
            let has_key = |key: &String| key_names.iter().any(|k| k.eq_ignore_ascii_case(key));
            // A server only accepts a signature whose key it has, from a .bikey of the same name.
            let unmatched: Vec<&Vec<String>> =
                signed_with.iter().filter(|keys| !keys.is_empty() && !keys.iter().any(has_key)).collect();
            if unsigned > 0 {
                summary.warnings.push(if unsigned == summary.pbos.len() {
                    "The PBOs aren't signed, so servers that check signatures will kick players.".into()
                } else {
                    format!("{unsigned} of the PBOs {} signed.", if unsigned == 1 { "isn't" } else { "aren't" })
                });
            } else if summary.keys.is_empty() {
                summary
                    .warnings
                    .push("The PBOs are signed but there's no .bikey in a keys folder for servers to use.".into());
            } else if !unmatched.is_empty() {
                let mut missing: Vec<&String> = unmatched.iter().flat_map(|keys| keys.iter()).collect();
                missing.sort_by_key(|key| key.to_lowercase());
                missing.dedup_by_key(|key| key.to_lowercase());
                let missing = missing.iter().map(|key| key.as_str()).collect::<Vec<_>>().join(", ");
                summary.warnings.push(if unmatched.len() == summary.pbos.len() {
                    format!(
                        "The PBOs are signed with {missing}, but the keys folder has no .bikey of that name, so servers that check signatures will kick players."
                    )
                } else {
                    format!(
                        "{} of the PBOs {} signed with {missing}, but the keys folder has no .bikey of that name.",
                        unmatched.len(),
                        if unmatched.len() == 1 { "is" } else { "are" }
                    )
                });
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

    #[test]
    fn warns_when_the_keys_dont_match_the_signatures() {
        let root = std::env::temp_dir().join(format!("flare-tools-content-keys-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let addons = root.join("addons");
        let keys = root.join("keys");
        fs::create_dir_all(&addons).unwrap();
        fs::create_dir_all(&keys).unwrap();
        let warnings = |files: &[&str], key_files: &[&str]| {
            for dir in [&addons, &keys] {
                for entry in fs::read_dir(dir).unwrap() {
                    fs::remove_file(entry.unwrap().path()).unwrap();
                }
            }
            for file in files {
                fs::write(addons.join(file), "").unwrap();
            }
            for file in key_files {
                fs::write(keys.join(file), "").unwrap();
            }
            inspect(&root.to_string_lossy()).warnings
        };

        assert!(warnings(&["A.pbo", "A.pbo.My.Key.bisign"], &["my.key.bikey"]).is_empty());
        // Servers go by the name written in the key, which a renamed file keeps.
        warnings(&["A.pbo", "A.pbo.Old.bisign"], &[]);
        fs::write(keys.join("Renamed.bikey"), b"Old\0\x94\0\0\0").unwrap();
        assert!(inspect(&root.to_string_lossy()).warnings.is_empty());
        assert_eq!(
            warnings(&["A.pbo", "A.pbo.Old.bisign", "B.pbo", "B.pbo.Old.bisign"], &["New.bikey"]),
            [
                "The PBOs are signed with Old, but the keys folder has no .bikey of that name, so servers that check signatures will kick players."
            ]
        );
        assert_eq!(
            warnings(&["A.pbo", "A.pbo.New.bisign", "B.pbo", "B.pbo.Old.bisign"], &["New.bikey"]),
            ["1 of the PBOs is signed with Old, but the keys folder has no .bikey of that name."]
        );
        fs::remove_dir_all(root).unwrap();
    }
}
