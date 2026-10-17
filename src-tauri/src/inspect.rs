use std::fs;
use std::path::{Component, Path, PathBuf};

use serde::Serialize;

/// How deep to look for `config.cpp` files below a mod's folder.
const MAX_DEPTH: usize = 8;
/// How many `config.cpp` files to read when looking for prefix evidence.
const MAX_CONFIGS_SCANNED: usize = 64;
const PREFIX_FILES: [&str; 3] = ["$PBOPREFIX$", "$PBOPREFIX$.txt", "pboprefix.txt"];

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum PrefixSource {
    Override,
    PrefixFile,
    ConfigPaths,
    FolderName,
}

/// How pboProject will reach the source, given that it works the prefix out from the
/// folder's position on the P: drive.
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum LinkStatus {
    /// The source already sits at `P:\<prefix>`.
    Direct,
    /// A temporary junction at `P:\<prefix>` will point to the source during the build.
    Junction,
    /// `P:\<prefix>` exists and is a different folder.
    Conflict,
    /// The P: drive isn't set or doesn't exist.
    NoPDrive,
    /// The prefix isn't a folder path that could sit on the P: drive.
    BadPrefix,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PboPlan {
    /// The PBO's final name, after any rename.
    pub name: String,
    /// The name pboProject gives it, after the folder it packs.
    pub packed_name: String,
    /// Folder holding the PBO's `config.cpp`, relative to the mod folder.
    pub rel_dir: String,
    pub prefix: String,
}

/// What a mod says about itself, in `mod.cpp` or its `CfgMods` class.
#[derive(Clone, Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ModMeta {
    pub name: Option<String>,
    pub author: Option<String>,
    pub version: Option<String>,
}

impl ModMeta {
    fn is_empty(&self) -> bool {
        self.name.is_none() && self.author.is_none() && self.version.is_none()
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Inspection {
    pub source_exists: bool,
    /// From `mod.cpp` in the mod folder, when there is one.
    pub mod_cpp: Option<ModMeta>,
    /// From the mod's class under `CfgMods`, in whichever `config.cpp` declares it.
    pub cfg_mods: Option<ModMeta>,
    pub folder_name: String,
    pub detected_prefix: String,
    pub detected_from: PrefixSource,
    /// What the detection was based on, e.g. a path quoted in a `config.cpp`.
    pub evidence: Option<String>,
    pub prefix: String,
    pub prefix_source: PrefixSource,
    pub pbos: Vec<PboPlan>,
    pub has_mod_cpp: bool,
    pub build_path: String,
    pub link: LinkStatus,
    pub warnings: Vec<String>,
    /// Why the mod can't be built, if it can't. It's one of the warnings too.
    pub problem: Option<String>,
}

/// Normalises a prefix to `a\b\c`: backslashes, no leading or trailing separators.
pub fn normalise_prefix(value: &str) -> String {
    value.split(['\\', '/']).map(str::trim).filter(|part| !part.is_empty()).collect::<Vec<_>>().join("\\")
}

/// Characters Windows doesn't allow in a file or folder name.
const NOT_IN_NAMES: &[char] = &['\\', '/', ':', '*', '?', '"', '<', '>', '|'];

/// Why a name can't be a file or folder name, if it can't.
fn name_problem(name: &str) -> Option<&'static str> {
    if name == "." || name == ".." {
        Some("can't be . or ..")
    } else if name.chars().any(|c| NOT_IN_NAMES.contains(&c) || c.is_control()) {
        Some(r#"can't contain : * ? " < > |"#)
    } else if name.ends_with('.') {
        Some("can't end with a full stop")
    } else {
        None
    }
}

/// Why a normalised prefix can't be used as a folder path on P:, if it can't. Without this, a
/// prefix such as `D:\Mods\MyMod` or `..\Other` would point the build somewhere off the P: drive.
pub fn prefix_problem(prefix: &str) -> Option<String> {
    prefix.split('\\').find_map(name_problem).map(|problem| format!("The prefix {prefix} {problem}."))
}

/// Why a PBO name can't be used, if it can't.
pub fn pbo_name_problem(name: &str) -> Option<String> {
    let name = name.trim();
    if name.contains(['\\', '/']) {
        return Some("The PBO name can't contain \\ or /.".into());
    }
    name_problem(name).map(|problem| format!("The PBO name {problem}."))
}

/// A PBO name without its `.pbo` extension, in any case.
fn pbo_stem(name: &str) -> &str {
    let name = name.trim();
    match name.len().checked_sub(4) {
        Some(at) if name.is_char_boundary(at) && name[at..].eq_ignore_ascii_case(".pbo") => &name[..at],
        _ => name,
    }
}

/// Two PBOs that would be written to the same file, since Windows ignores case in file names.
fn same_name(pbos: &[PboPlan]) -> Option<(&PboPlan, &PboPlan)> {
    pbos.iter()
        .enumerate()
        .find_map(|(i, a)| pbos[i + 1..].iter().find(|b| b.name.eq_ignore_ascii_case(&a.name)).map(|b| (a, b)))
}

fn is_hidden(path: &Path) -> bool {
    path.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with('.'))
}

fn has_config(dir: &Path) -> bool {
    dir.join("config.cpp").is_file()
}

/// Folders that become PBOs: those with a `config.cpp` and no `config.cpp` above them,
/// which is how pboProject splits a mod into PBOs.
fn find_pbo_roots(dir: &Path, depth: usize, roots: &mut Vec<PathBuf>) {
    if has_config(dir) {
        roots.push(dir.to_path_buf());
        return;
    }
    if depth >= MAX_DEPTH {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else { return };
    let mut children: Vec<PathBuf> = entries
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .map(|e| e.path())
        .filter(|p| !is_hidden(p))
        .collect();
    children.sort();
    for child in children {
        find_pbo_roots(&child, depth + 1, roots);
    }
}

fn find_configs(dir: &Path, depth: usize, configs: &mut Vec<PathBuf>) {
    if configs.len() >= MAX_CONFIGS_SCANNED {
        return;
    }
    if has_config(dir) {
        configs.push(dir.join("config.cpp"));
    }
    if depth >= MAX_DEPTH {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if entry.file_type().is_ok_and(|t| t.is_dir()) && !is_hidden(&path) {
            find_configs(&path, depth + 1, configs);
        }
    }
}

/// Drops `//` and `/* */` comments, keeping quoted text intact.
fn strip_comments(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    let mut in_string = false;
    while let Some(c) = chars.next() {
        if in_string {
            out.push(c);
            if c == '"' {
                in_string = false;
            }
        } else if c == '"' {
            in_string = true;
            out.push(c);
        } else if c == '/' && chars.peek() == Some(&'/') {
            for c in chars.by_ref() {
                if c == '\n' {
                    out.push('\n');
                    break;
                }
            }
        } else if c == '/' && chars.peek() == Some(&'*') {
            chars.next();
            let mut last = ' ';
            for c in chars.by_ref() {
                if last == '*' && c == '/' {
                    break;
                }
                last = c;
            }
        } else {
            out.push(c);
        }
    }
    out
}

/// The text between the first `{` at or after `from` and its matching `}`.
fn block_after(text: &str, from: usize) -> Option<&str> {
    let open = from + text[from..].find('{')?;
    let mut depth = 0usize;
    let mut in_string = false;
    for (i, c) in text[open..].char_indices() {
        match c {
            '"' => in_string = !in_string,
            '{' if !in_string => depth += 1,
            '}' if !in_string => {
                depth -= 1;
                if depth == 0 {
                    return Some(&text[open + 1..open + i]);
                }
            }
            _ => {}
        }
    }
    None
}

/// `key = value;` statements at the top level of a class body, with keys lower-cased and
/// string values unquoted. Nested classes are skipped.
fn assignments(body: &str) -> Vec<(String, String)> {
    let mut found = Vec::new();
    let mut depth = 0usize;
    let mut in_string = false;
    let mut statement = String::new();
    for c in body.chars() {
        match c {
            '"' => {
                in_string = !in_string;
                statement.push(c);
            }
            '{' if !in_string => depth += 1,
            '}' if !in_string => {
                depth = depth.saturating_sub(1);
                statement.clear();
            }
            ';' if !in_string && depth == 0 => {
                if let Some((key, value)) = statement.split_once('=') {
                    let value = value.trim().trim_matches('"').trim();
                    found.push((key.trim().to_ascii_lowercase(), value.to_string()));
                }
                statement.clear();
            }
            _ if depth == 0 => statement.push(c),
            _ => {}
        }
    }
    found
}

fn meta_from(fields: &[(String, String)]) -> Option<ModMeta> {
    let mut meta = ModMeta::default();
    for (key, value) in fields {
        let value = Some(value.clone()).filter(|v| !v.is_empty());
        match key.as_str() {
            "name" => meta.name = value,
            "author" => meta.author = value,
            "version" => meta.version = value,
            _ => {}
        }
    }
    (!meta.is_empty()).then_some(meta)
}

fn read_mod_cpp(source: &Path) -> Option<ModMeta> {
    let text = fs::read_to_string(source.join("mod.cpp")).ok()?;
    meta_from(&assignments(&strip_comments(&text)))
}

/// The `key = value` statements in the mod's own class under `CfgMods`: the first one declared there.
fn cfg_mods_class(text: &str) -> Option<Vec<(String, String)>> {
    let lower = text.to_ascii_lowercase();
    let at = lower.find("class cfgmods")?;
    let cfg_body = block_after(text, at)?;
    let cfg_lower = cfg_body.to_ascii_lowercase();
    let class_at = cfg_lower.find("class ")?;
    Some(assignments(block_after(cfg_body, class_at)?))
}

#[cfg(test)]
fn cfg_mods_meta(text: &str) -> Option<ModMeta> {
    meta_from(&cfg_mods_class(text)?)
}

/// Everything the mod's `CfgMods` class sets, with keys lower-cased, from whichever `config.cpp` declares it.
pub fn cfg_mods_fields(source: &Path) -> Vec<(String, String)> {
    let mut configs = Vec::new();
    find_configs(source, 0, &mut configs);
    configs
        .iter()
        .filter_map(|path| fs::read_to_string(path).ok())
        .filter_map(|text| cfg_mods_class(&strip_comments(&text)))
        .find(|fields| meta_from(fields).is_some())
        .unwrap_or_default()
}

fn read_cfg_mods(source: &Path) -> Option<ModMeta> {
    meta_from(&cfg_mods_fields(source))
}

fn read_prefix_file(dir: &Path) -> Option<(String, String)> {
    for name in PREFIX_FILES {
        let path = dir.join(name);
        let Ok(text) = fs::read_to_string(&path) else { continue };
        // Either a bare prefix or `prefix=...` among other `key=value` lines.
        let value = text
            .lines()
            .map(str::trim)
            .find_map(|line| {
                let lower = line.to_ascii_lowercase();
                if let Some(rest) = lower.strip_prefix("prefix") {
                    let rest = rest.trim_start();
                    if rest.starts_with('=') {
                        return Some(line[line.find('=')? + 1..].trim().trim_end_matches(';').to_string());
                    }
                }
                (!line.is_empty() && !line.contains('=')).then(|| line.to_string())
            })
            .map(|v| normalise_prefix(&v))
            .filter(|v| !v.is_empty());
        if let Some(value) = value {
            return Some((value, name.to_string()));
        }
    }
    None
}

/// Quoted strings in a config, normalised like prefixes and lower-cased for matching.
fn quoted_paths(text: &str) -> impl Iterator<Item = (String, String)> + '_ {
    text.split('"')
        .skip(1)
        .step_by(2)
        .filter(|s| s.contains('/') || s.contains('\\'))
        .map(|s| (normalise_prefix(s).to_ascii_lowercase(), s.to_string()))
}

/// Picks the trailing part of the source path that the mod's configs refer to,
/// e.g. `OneLife` for `P:\Mods\Unpacked\OneLife` when configs use `OneLife/Scripts/...`.
fn prefix_from_configs(source: &Path) -> Option<(String, String)> {
    let parts: Vec<String> = source
        .components()
        .filter_map(|c| match c {
            Component::Normal(part) => Some(part.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect();
    if parts.is_empty() {
        return None;
    }
    let candidates: Vec<String> = (0..parts.len()).rev().map(|start| parts[start..].join("\\")).collect();

    let mut configs = Vec::new();
    find_configs(source, 0, &mut configs);
    let texts: Vec<String> = configs.iter().filter_map(|p| fs::read_to_string(p).ok()).collect();

    let mut best: Option<(usize, String, String)> = None;
    for candidate in candidates {
        let lower = candidate.to_ascii_lowercase();
        let with_sep = format!("{lower}\\");
        let mut hits = 0;
        let mut example = None;
        for text in &texts {
            for (normalised, original) in quoted_paths(text) {
                if normalised == lower || normalised.starts_with(&with_sep) {
                    hits += 1;
                    example.get_or_insert(original);
                }
            }
        }
        if hits > 0 && best.as_ref().is_none_or(|(n, _, _)| hits > *n) {
            best = Some((hits, candidate, example.unwrap_or_default()));
        }
    }
    best.map(|(_, prefix, example)| (prefix, example))
}

pub fn same_folder(a: &Path, b: &Path) -> bool {
    match (fs::canonicalize(a), fs::canonicalize(b)) {
        (Ok(a), Ok(b)) => a.to_string_lossy().eq_ignore_ascii_case(&b.to_string_lossy()),
        _ => false,
    }
}

pub fn inspect(p_drive: &str, source_path: &str, prefix_override: Option<&str>, pbo_name: Option<&str>) -> Inspection {
    let source = Path::new(source_path.trim());
    let source_exists = source.is_dir();
    let folder_name = source.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let mut warnings = Vec::new();

    let (detected_prefix, detected_from, evidence) = if let Some((prefix, file)) = read_prefix_file(source) {
        (prefix, PrefixSource::PrefixFile, Some(file))
    } else if let Some((prefix, example)) = source_exists.then(|| prefix_from_configs(source)).flatten() {
        (prefix, PrefixSource::ConfigPaths, Some(example))
    } else {
        (folder_name.clone(), PrefixSource::FolderName, None)
    };

    let override_prefix = prefix_override.map(normalise_prefix).filter(|p| !p.is_empty());
    let (prefix, prefix_source) = match override_prefix {
        Some(p) => (p, PrefixSource::Override),
        None => (detected_prefix.clone(), detected_from),
    };

    let mut roots = Vec::new();
    if source_exists {
        find_pbo_roots(source, 0, &mut roots);
    }
    let prefix_leaf = prefix.rsplit('\\').next().unwrap_or(&prefix).to_string();
    let mut pbos: Vec<PboPlan> = roots
        .iter()
        .map(|root| {
            let rel_dir = root.strip_prefix(source).map(|r| r.to_string_lossy().replace('/', "\\")).unwrap_or_default();
            if rel_dir.is_empty() {
                // pboProject names the PBO after the folder it packs, which is the
                // `P:\<prefix>` folder rather than wherever the source really lives.
                PboPlan { name: prefix_leaf.clone(), packed_name: prefix_leaf.clone(), rel_dir, prefix: prefix.clone() }
            } else {
                let name = root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                PboPlan { packed_name: name.clone(), name, prefix: format!("{prefix}\\{rel_dir}"), rel_dir }
            }
        })
        .collect();

    if let Some(name) = pbo_name.map(pbo_stem).filter(|n| !n.is_empty()) {
        if let Some(problem) = pbo_name_problem(name) {
            warnings.push(problem);
        } else if pbos.len() == 1 {
            pbos[0].name = name.to_string();
        } else if pbos.len() > 1 {
            warnings.push("The PBO name is ignored because this mod has more than one PBO.".into());
        }
    }

    // What stops the mod being built, listed after the other warnings.
    let mut blockers = Vec::new();
    if !source_exists {
        blockers.push(format!("{} doesn't exist.", source.display()));
    } else if pbos.is_empty() {
        blockers.push("No config.cpp was found, so there's nothing for pboProject to pack.".into());
    } else if let Some((a, b)) = same_name(&pbos) {
        blockers.push(format!(
            "{} and {} would both be packed as {}.pbo, and one would overwrite the other. Rename one of the folders.",
            a.rel_dir, b.rel_dir, a.name
        ));
    }

    let p_root = Path::new(p_drive.trim());
    let bad_prefix = prefix_problem(&prefix);
    let build_path =
        if p_drive.trim().is_empty() || bad_prefix.is_some() { PathBuf::new() } else { p_root.join(&prefix) };
    let link = if p_drive.trim().is_empty() || !p_root.exists() {
        LinkStatus::NoPDrive
    } else if let Some(problem) = bad_prefix {
        blockers.push(problem);
        LinkStatus::BadPrefix
    } else if same_folder(source, &build_path) {
        LinkStatus::Direct
    } else if fs::symlink_metadata(&build_path).is_err() {
        LinkStatus::Junction
    } else {
        LinkStatus::Conflict
    };
    match link {
        LinkStatus::NoPDrive => blockers.push("The P: drive isn't set up or isn't mounted.".into()),
        LinkStatus::Conflict => blockers.push(format!(
            "{} already exists and isn't this mod's folder. pboProject packs from P:\\<prefix>, so build from that folder, move it, or change the prefix.",
            build_path.display()
        )),
        _ => {}
    }
    let problem = blockers.first().cloned();
    warnings.extend(blockers);

    Inspection {
        source_exists,
        mod_cpp: source_exists.then(|| read_mod_cpp(source)).flatten(),
        cfg_mods: source_exists.then(|| read_cfg_mods(source)).flatten(),
        has_mod_cpp: source.join("mod.cpp").is_file(),
        folder_name,
        detected_prefix,
        detected_from,
        evidence,
        prefix,
        prefix_source,
        pbos,
        build_path: build_path.to_string_lossy().into_owned(),
        link,
        warnings,
        problem,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalises_prefixes() {
        assert_eq!(normalise_prefix(r"\KK_Krasna/gear\medical\ "), r"KK_Krasna\gear\medical");
        assert_eq!(normalise_prefix(""), "");
    }

    #[test]
    fn rejects_prefixes_that_leave_the_p_drive() {
        assert_eq!(prefix_problem(r"KK_Krasna\gear"), None);
        assert!(prefix_problem(&normalise_prefix(r"D:\Mods\MyMod")).is_some());
        assert!(prefix_problem(&normalise_prefix(r"..\Other")).is_some());
        assert!(prefix_problem(r"MyMod\.").is_some());
        assert!(prefix_problem("My|Mod").is_some());

        let root = std::env::temp_dir().join(format!("flare-tools-prefix-{}", std::process::id()));
        fs::create_dir_all(root.join("MyMod")).unwrap();
        fs::write(root.join(r"MyMod\config.cpp"), "").unwrap();
        let source = root.join("MyMod").to_string_lossy().into_owned();
        let plan = inspect(&root.to_string_lossy(), &source, Some(r"C:\Windows"), None);
        assert_eq!(plan.link, LinkStatus::BadPrefix);
        assert!(plan.build_path.is_empty());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn blocks_two_addons_with_the_same_name() {
        let root = std::env::temp_dir().join(format!("flare-tools-same-name-{}", std::process::id()));
        for dir in [r"MyMod\gear\data", r"MyMod\weapons\Data"] {
            fs::create_dir_all(root.join(dir)).unwrap();
            fs::write(root.join(dir).join("config.cpp"), "").unwrap();
        }
        let source = root.join("MyMod").to_string_lossy().into_owned();
        let plan = inspect(&root.to_string_lossy(), &source, None, None);
        let problem = plan.problem.unwrap();
        assert!(problem.contains(r"gear\data and weapons\Data would both be packed as data.pbo"), "{problem}");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn checks_pbo_names() {
        assert_eq!(pbo_stem("MyMod.PBO"), "MyMod");
        assert_eq!(pbo_stem(" MyMod.pbo "), "MyMod");
        assert_eq!(pbo_stem("pbo"), "pbo");
        assert_eq!(pbo_name_problem("MyMod_Data"), None);
        assert!(pbo_name_problem(r"..\x").is_some());
        assert!(pbo_name_problem("a:b").is_some());
        assert!(pbo_name_problem("..").is_some());
    }

    #[test]
    fn reads_mod_cpp_fields() {
        let text = "name = \"One Life\"; // shown in the launcher\nauthor = \"Starburzts\";\nversion = \"1.1.4\";\n";
        let meta = meta_from(&assignments(&strip_comments(text))).unwrap();
        assert_eq!(meta.name.as_deref(), Some("One Life"));
        assert_eq!(meta.author.as_deref(), Some("Starburzts"));
        assert_eq!(meta.version.as_deref(), Some("1.1.4"));
    }

    #[test]
    fn reads_cfg_mods_class() {
        let text = r#"
class CfgPatches { class OneLife { requiredVersion = 0.1; }; };
class CfgMods
{
    class OneLife
    {
        dir = "OneLife";
        name = "One Life";
        author = "Starburzts";
        version = "1.1.4";
        class defs { class worldScriptModule { value = ""; files[] = {"OneLife/Scripts/4_World"}; }; };
    };
};
"#;
        let meta = cfg_mods_meta(&strip_comments(text)).unwrap();
        assert_eq!(meta.version.as_deref(), Some("1.1.4"));
        assert_eq!(meta.name.as_deref(), Some("One Life"));
        assert!(cfg_mods_meta("class CfgPatches {};").is_none());
    }

    #[test]
    fn finds_quoted_paths() {
        let text = r#"files[] = {"OneLife/Scripts/3_Game"}; name = "One Life";"#;
        let found: Vec<_> = quoted_paths(text).map(|(n, _)| n).collect();
        assert_eq!(found, vec![r"onelife\scripts\3_game".to_string()]);
    }
}
