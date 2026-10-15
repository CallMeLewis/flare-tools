//! The mod.cpp that goes into the `@mod` folder: the mod's own with the version from its `CfgMods` class, or one
//! written from that class when the mod hasn't got one. The mod's source folder is never changed.

use std::ops::Range;

/// What a mod.cpp can say that a `CfgMods` class can say too, in the order mod.cpp files usually list them.
const FIELDS: [&str; 11] = [
    "name",
    "picture",
    "logo",
    "logoSmall",
    "logoOver",
    "tooltip",
    "overview",
    "action",
    "author",
    "authorID",
    "version",
];

fn quoted(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

/// A mod.cpp for a mod that hasn't got one, from its `CfgMods` fields (keys lower-cased), named after the mod when
/// the class doesn't give a name.
pub fn create(cfg_mods: &[(String, String)], mod_name: &str) -> String {
    let value = |field: &str| {
        let key = field.to_ascii_lowercase();
        cfg_mods.iter().find(|(k, v)| *k == key && !v.is_empty()).map(|(_, v)| v.as_str())
    };
    let mut text = String::new();
    for field in FIELDS {
        let value = match (field, value(field)) {
            (_, Some(value)) => value,
            ("name", None) => mod_name,
            _ => continue,
        };
        text.push_str(&format!("{field} = {};\r\n", quoted(value)));
    }
    text
}

/// The mod's mod.cpp with `version` set to `version`, kept otherwise as written, or None if it already says that.
pub fn with_version(text: &str, version: &str) -> Option<String> {
    match version_value(text) {
        Some(range) => {
            let current = text[range.clone()].trim_matches('"');
            (current != version).then(|| format!("{}{}{}", &text[..range.start], quoted(version), &text[range.end..]))
        }
        None => {
            let newline = if text.contains("\r\n") { "\r\n" } else { "\n" };
            let mut out = text.to_string();
            if !out.is_empty() && !out.ends_with('\n') {
                out.push_str(newline);
            }
            out.push_str(&format!("version = {};{newline}", quoted(version)));
            Some(out)
        }
    }
}

/// Where the value of the top-level `version = ...;` sits, skipping comments, strings and classes.
fn version_value(text: &str) -> Option<Range<usize>> {
    let bytes = text.as_bytes();
    let mut i = if text.starts_with('\u{feff}') { 3 } else { 0 };
    let mut depth = 0usize;
    let mut statement_start = true;
    while i < bytes.len() {
        match bytes[i] {
            b'"' => {
                i = string_end(bytes, i);
                statement_start = false;
                continue;
            }
            b'/' if bytes.get(i + 1) == Some(&b'/') => {
                while i < bytes.len() && bytes[i] != b'\n' {
                    i += 1;
                }
                continue;
            }
            b'/' if bytes.get(i + 1) == Some(&b'*') => {
                i += 2;
                while i < bytes.len() && !(bytes[i] == b'*' && bytes.get(i + 1) == Some(&b'/')) {
                    i += 1;
                }
                i += 2;
                continue;
            }
            b'{' | b'}' | b';' => {
                match bytes[i] {
                    b'{' => depth += 1,
                    b'}' => depth = depth.saturating_sub(1),
                    _ => {}
                }
                statement_start = true;
            }
            c if c.is_ascii_whitespace() => {}
            _ => {
                if statement_start
                    && depth == 0
                    && bytes.len() >= i + 7
                    && bytes[i..i + 7].eq_ignore_ascii_case(b"version")
                {
                    let mut j = i + 7;
                    while j < bytes.len() && bytes[j].is_ascii_whitespace() {
                        j += 1;
                    }
                    if bytes.get(j) == Some(&b'=') {
                        let mut start = j + 1;
                        while start < bytes.len() && bytes[start].is_ascii_whitespace() {
                            start += 1;
                        }
                        let mut end = start;
                        while end < bytes.len() && bytes[end] != b';' {
                            end = if bytes[end] == b'"' { string_end(bytes, end) } else { end + 1 };
                        }
                        let end = end.min(bytes.len());
                        let end = start + text[start..end].trim_end().len();
                        return Some(start..end);
                    }
                }
                statement_start = false;
            }
        }
        i += 1;
    }
    None
}

/// The index just past the string starting at `start`, where `""` inside it is an escaped quote.
fn string_end(bytes: &[u8], start: usize) -> usize {
    let mut i = start + 1;
    while i < bytes.len() {
        if bytes[i] == b'"' {
            if bytes.get(i + 1) == Some(&b'"') {
                i += 2;
                continue;
            }
            return i + 1;
        }
        i += 1;
    }
    bytes.len()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sets_the_version_and_keeps_the_rest() {
        let text = "name = \"One Life\"; // shown in the launcher\r\nversion = \"1.1.3\";\t// the version\r\n";
        assert_eq!(
            with_version(text, "1.1.4").unwrap(),
            "name = \"One Life\"; // shown in the launcher\r\nversion = \"1.1.4\";\t// the version\r\n"
        );
        assert_eq!(with_version(text, "1.1.3"), None);
        assert_eq!(with_version("Version=2;", "3").unwrap(), "Version=\"3\";");
    }

    #[test]
    fn ignores_versions_in_comments_strings_and_classes() {
        let text = "// version = \"0\";\n/* version = \"0\"; */\noverview = \"version = 0;\";\nclass X { version = \"0\"; };\n";
        assert_eq!(with_version(text, "1.0").unwrap(), format!("{text}version = \"1.0\";\n"));
        assert_eq!(with_version("name = \"A\";", "1.0").unwrap(), "name = \"A\";\nversion = \"1.0\";\n");
        assert_eq!(with_version("versionNote = \"x\";", "1.0").unwrap(), "versionNote = \"x\";\nversion = \"1.0\";\n");
    }

    #[test]
    fn writes_one_from_cfg_mods() {
        let fields = [
            ("dir".to_string(), "OneLife".to_string()),
            ("version".to_string(), "1.1.4".to_string()),
            ("picture".to_string(), "OneLife/data/logo.edds".to_string()),
            ("author".to_string(), "Starburzts".to_string()),
        ];
        assert_eq!(
            create(&fields, "One Life"),
            "name = \"One Life\";\r\npicture = \"OneLife/data/logo.edds\";\r\nauthor = \"Starburzts\";\r\nversion = \"1.1.4\";\r\n"
        );
        assert_eq!(create(&[], "Say \"hi\""), "name = \"Say \"\"hi\"\"\";\r\n");
    }
}
