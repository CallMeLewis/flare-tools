use std::path::{Path, PathBuf};

use winreg::RegKey;
use winreg::enums::HKEY_CURRENT_USER;

use crate::store::Settings;

const PBO_PROJECT_KEY: &str = r"Software\Mikero\pboProject";
const PBO_PROJECT_SETTINGS_KEY: &str = r"Software\Mikero\pboProject\Settings";
const DAYZ_TOOLS_KEY: &str = r"Software\Bohemia Interactive\Dayz Tools";
const PBO_PROJECT_FALLBACK: &str = r"C:\Program Files (x86)\Mikero\DePboTools\bin\pboProject.exe";

fn reg_string(key: &str, name: &str) -> Option<String> {
    RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey(key)
        .ok()?
        .get_value::<String, _>(name)
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

fn existing(path: PathBuf) -> Option<String> {
    path.exists().then(|| path.to_string_lossy().into_owned())
}

/// Finds the tools and P: drive from what pboProject and DayZ Tools store in the registry.
pub fn detect_settings() -> Settings {
    let pbo_project_path = reg_string(PBO_PROJECT_KEY, "exe")
        .and_then(|p| existing(PathBuf::from(p)))
        .or_else(|| existing(PathBuf::from(PBO_PROJECT_FALLBACK)))
        .unwrap_or_default();

    let p_drive = reg_string(PBO_PROJECT_SETTINGS_KEY, "prj_Pdrive")
        .and_then(|p| existing(PathBuf::from(p)))
        .or_else(|| existing(PathBuf::from(r"P:\")))
        .unwrap_or_default();

    let default_private_key_path = reg_string(PBO_PROJECT_SETTINGS_KEY, "fs_privatekey")
        .and_then(|p| existing(PathBuf::from(p)))
        .unwrap_or_default();

    let ds_sign_file_path = reg_string(DAYZ_TOOLS_KEY, "path")
        .and_then(|p| existing(Path::new(&p).join(r"Bin\DsUtils\DSSignFile.exe")))
        .or_else(|| {
            // Keys are usually created in DsUtils, next to DSSignFile.exe.
            let key_dir = Path::new(&default_private_key_path).parent()?;
            existing(key_dir.join("DSSignFile.exe"))
        })
        .unwrap_or_default();

    Settings {
        p_drive,
        pbo_project_path,
        ds_sign_file_path,
        default_private_key_path,
        default_output_root: String::new(),
    }
}

/// pboProject's temp folder, where it writes its packing logs.
pub fn pbo_project_temp_dir(p_drive: &str) -> PathBuf {
    let folder = reg_string(PBO_PROJECT_SETTINGS_KEY, "drive_temp_folder").unwrap_or_else(|| "temp".into());
    Path::new(p_drive).join(folder)
}
