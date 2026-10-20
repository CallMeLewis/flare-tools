//! The folders a build or a Workshop upload is using. Neither may start on a folder the other is using: Steam would
//! upload PBOs that pboProject is still writing, or a build would change files that Steam is reading.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, PoisonError};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Use {
    Build,
    Upload,
}

#[derive(Default)]
pub struct InUse(Mutex<Vec<(PathBuf, Use)>>);

/// A folder in use until this is dropped.
pub struct Claim<'a> {
    owner: &'a InUse,
    folder: PathBuf,
}

impl InUse {
    /// Marks `folder` as in use, unless it, a folder inside it or one around it is in use already.
    pub fn claim(&self, folder: &Path, by: Use) -> Result<Claim<'_>, String> {
        let folder = key(folder);
        let mut claims = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        let taken = claims.iter().find(|(claimed, _)| claimed.starts_with(&folder) || folder.starts_with(claimed));
        if let Some((_, other)) = taken {
            return Err(match (other, by) {
                (Use::Build, Use::Upload) => "That folder is being built. Upload it once the build finishes.",
                (Use::Upload, Use::Build) => {
                    "The output folder is being uploaded to the Workshop. Build once the upload finishes."
                }
                (Use::Upload, Use::Upload) => "That folder is already being uploaded.",
                (Use::Build, Use::Build) => "The output folder is already being built.",
            }
            .into());
        }
        claims.push((folder.clone(), by));
        Ok(Claim { owner: self, folder })
    }
}

impl Drop for Claim<'_> {
    fn drop(&mut self) {
        let mut claims = self.owner.0.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(at) = claims.iter().position(|(claimed, _)| *claimed == self.folder) {
            claims.remove(at);
        }
    }
}

/// A folder's path as claims compare it: resolved as far as it exists, in lower case as Windows matches names, and
/// without the `\\?\` that resolving adds, so a folder that doesn't exist yet compares the same as it will once it does.
fn key(folder: &Path) -> PathBuf {
    let full = std::path::absolute(folder).unwrap_or_else(|_| folder.to_path_buf());
    let resolved = full
        .ancestors()
        .find_map(|existing| Some(fs::canonicalize(existing).ok()?.join(full.strip_prefix(existing).ok()?)))
        .unwrap_or_else(|| full.clone());
    let full = resolved.to_string_lossy().to_lowercase();
    let plain = match full.strip_prefix(r"\\?\unc\") {
        Some(share) => format!(r"\\{share}"),
        None => full.strip_prefix(r"\\?\").unwrap_or(&full).to_string(),
    };
    PathBuf::from(plain)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_builds_and_uploads_apart() {
        let root = std::env::temp_dir().join(format!("flare-tools-in-use-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let output = root.join("@MyMod");
        let in_use = InUse::default();

        // The build claims its output before creating it; the upload names the folder once it exists.
        let build = in_use.claim(&output, Use::Build).unwrap();
        fs::create_dir_all(&output).unwrap();
        let upper = PathBuf::from(output.to_string_lossy().to_uppercase());
        assert!(in_use.claim(&upper, Use::Upload).err().unwrap().contains("being built"));
        assert!(in_use.claim(&output.join("addons"), Use::Upload).is_err(), "nor a folder inside it");
        assert!(in_use.claim(&root.join("@Other"), Use::Upload).is_ok(), "other folders are free");

        drop(build);
        let upload = in_use.claim(&output, Use::Upload).unwrap();
        assert!(in_use.claim(&output, Use::Build).err().unwrap().contains("being uploaded"));
        drop(upload);
        assert!(in_use.claim(&output, Use::Build).is_ok());
        fs::remove_dir_all(root).unwrap();
    }
}
