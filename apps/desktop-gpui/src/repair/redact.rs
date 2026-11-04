use std::collections::HashMap;

use serde_json::Value;

pub const PLACEHOLDER_PREFIX: &str = "<redacted:";
pub const RECORDING_MARKER: &str = "<recording>";

const FREE_TEXT_KEYS: [&str; 14] = [
    "pretty_name",
    "prettyName",
    "title",
    "name",
    "label",
    "window_title",
    "windowTitle",
    "device_name",
    "deviceName",
    "display_name",
    "displayName",
    "owner_name",
    "ownerName",
    "windowName",
];

fn placeholder(text: &str) -> String {
    format!("{PLACEHOLDER_PREFIX}{}>", text.chars().count())
}

pub struct Redactor {
    home: Option<String>,
    extra: Vec<String>,
}

impl Redactor {
    pub fn new(home: Option<String>, extra: Vec<String>) -> Self {
        Self {
            home: home.filter(|home| home.len() > 1),
            extra: extra.into_iter().filter(|value| value.len() >= 3).collect(),
        }
    }

    pub fn for_bundle(bundle_root: &std::path::Path) -> Self {
        let home = dirs::home_dir().map(|home| home.to_string_lossy().into_owned());
        let mut extra = vec![bundle_root.to_string_lossy().into_owned()];
        if let Some(name) = bundle_root.file_name() {
            extra.push(name.to_string_lossy().into_owned());
        }
        if let Some(stem) = bundle_root.file_stem() {
            extra.push(stem.to_string_lossy().into_owned());
        }
        extra.sort_by_key(|value| std::cmp::Reverse(value.len()));
        Self::new(home, extra)
    }

    pub fn with_extra(mut self, value: &str) -> Self {
        let value = value.trim();
        if value.chars().count() >= 3 && !self.extra.iter().any(|existing| existing == value) {
            self.extra.push(value.to_string());
            self.extra
                .sort_by_key(|value| std::cmp::Reverse(value.len()));
        }
        self
    }

    pub fn text(&self, text: &str) -> String {
        let mut out = text.to_string();
        for value in &self.extra {
            if out.contains(value.as_str()) {
                out = out.replace(value.as_str(), RECORDING_MARKER);
            }
        }
        if let Some(home) = &self.home {
            out = replace_case_aware(&out, home, "~");
            let escaped = home.replace('\\', "\\\\");
            if escaped != *home {
                out = replace_case_aware(&out, &escaped, "~");
            }
        }
        out
    }

    fn is_marker_text(&self, text: &str) -> bool {
        text.contains(PLACEHOLDER_PREFIX)
            || text.contains(RECORDING_MARKER)
            || (self.home.is_some()
                && (text == "~" || text.starts_with("~/") || text.starts_with("~\\")))
    }

    pub fn contains_marker(&self, value: &Value) -> bool {
        match value {
            Value::String(text) => self.is_marker_text(text),
            Value::Array(items) => items.iter().any(|item| self.contains_marker(item)),
            Value::Object(map) => map
                .iter()
                .any(|(key, value)| self.is_marker_text(key) || self.contains_marker(value)),
            _ => false,
        }
    }

    pub fn json(&self, value: &mut Value) -> bool {
        let mut changed = false;
        self.visit(value, None, &mut changed);
        changed
    }

    fn visit(&self, value: &mut Value, key: Option<&str>, changed: &mut bool) {
        match value {
            Value::String(text) => {
                if key.is_some_and(|key| FREE_TEXT_KEYS.contains(&key)) && !text.is_empty() {
                    *text = placeholder(text);
                    *changed = true;
                } else {
                    let next = self.text(text);
                    if next != *text {
                        *text = next;
                        *changed = true;
                    }
                }
            }
            Value::Array(items) => {
                for item in items {
                    self.visit(item, key, changed);
                }
            }
            Value::Object(map) => {
                for (child_key, child) in map.iter_mut() {
                    self.visit(child, Some(child_key.as_str()), changed);
                }
            }
            _ => {}
        }
    }

    pub fn raw_json_text(&self, text: &str) -> (String, bool) {
        let mut out = String::with_capacity(text.len());
        let mut changed = false;
        let mut rest = text;
        'scan: while let Some(start) = rest.find('"') {
            out.push_str(&rest[..start]);
            let after = &rest[start + 1..];
            let Some(end) = find_string_end(after) else {
                out.push_str(&rest[start..]);
                rest = "";
                break;
            };
            let key = &after[..end];
            let tail = &after[end + 1..];
            out.push('"');
            out.push_str(key);
            out.push('"');
            rest = tail;
            if FREE_TEXT_KEYS.contains(&key) {
                let trimmed = rest.trim_start();
                if let Some(colon_rest) = trimmed.strip_prefix(':') {
                    let value_rest = colon_rest.trim_start();
                    if let Some(value_body) = value_rest.strip_prefix('"') {
                        out.push_str(": \"");
                        changed = true;
                        let Some(value_end) = find_string_end(value_body) else {
                            out.push_str(&placeholder(value_body));
                            rest = "";
                            break;
                        };
                        out.push_str(&placeholder(&value_body[..value_end]));
                        out.push('"');
                        rest = &value_body[value_end + 1..];
                        continue 'scan;
                    }
                }
            }
        }
        out.push_str(rest);
        let replaced = self.text(&out);
        if replaced != out {
            changed = true;
        }
        (replaced, changed)
    }
}

/// Free-text values of a file the agent only ever saw as placeholders, keyed
/// by key and placeholder. `None` marks a placeholder two different values
/// share, which cannot be put back unambiguously.
pub type HiddenValues = HashMap<(String, String), Option<String>>;

/// Collects the free-text values of `text`, valid or cut-off JSON, under the
/// placeholders `Redactor::json` and `Redactor::raw_json_text` show for them.
pub fn hidden_values(text: &str) -> HiddenValues {
    let mut hidden = HiddenValues::new();
    let mut rest = text;
    while let Some(start) = rest.find('"') {
        let after = &rest[start + 1..];
        let Some(end) = find_string_end(after) else {
            break;
        };
        let key = &after[..end];
        rest = &after[end + 1..];
        if !FREE_TEXT_KEYS.contains(&key) {
            continue;
        }
        let Some(body) = rest
            .trim_start()
            .strip_prefix(':')
            .and_then(|value| value.trim_start().strip_prefix('"'))
        else {
            continue;
        };
        let Some(value_end) = find_string_end(body) else {
            break;
        };
        let raw = &body[..value_end];
        rest = &body[value_end + 1..];
        let Ok(value) = serde_json::from_str::<String>(&format!("\"{raw}\"")) else {
            continue;
        };
        if value.is_empty() {
            continue;
        }
        let mut shown = vec![placeholder(raw)];
        if placeholder(&value) != shown[0] {
            shown.push(placeholder(&value));
        }
        for token in shown {
            hidden
                .entry((key.to_string(), token))
                .and_modify(|existing| {
                    if existing.as_deref() != Some(value.as_str()) {
                        *existing = None;
                    }
                })
                .or_insert_with(|| Some(value.clone()));
        }
    }
    hidden
}

/// Puts hidden values back where the agent wrote a placeholder at the same
/// free-text key it was read from. Placeholders anywhere else are left for
/// `contains_marker` to refuse.
pub fn restore_hidden(
    value: &mut Value,
    key: Option<&str>,
    hidden: &HiddenValues,
) -> Result<(), String> {
    match value {
        Value::String(text) if text.starts_with(PLACEHOLDER_PREFIX) => {
            let Some(key) = key.filter(|key| FREE_TEXT_KEYS.contains(key)) else {
                return Ok(());
            };
            match hidden.get(&(key.to_string(), text.clone())) {
                Some(Some(original)) => {
                    *text = original.clone();
                    Ok(())
                }
                _ => Err(format!(
                    "{text} at \"{key}\" does not match a hidden value in this file; write a placeholder only at the key and file it was read from"
                )),
            }
        }
        Value::Array(items) => items
            .iter_mut()
            .try_for_each(|item| restore_hidden(item, key, hidden)),
        Value::Object(map) => map
            .iter_mut()
            .try_for_each(|(child_key, child)| restore_hidden(child, Some(child_key), hidden)),
        _ => Ok(()),
    }
}

/// Every complete string literal in `text`, valid or cut-off JSON.
pub fn string_literals(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = text;
    while let Some(start) = rest.find('"') {
        let after = &rest[start + 1..];
        let Some(end) = find_string_end(after) else {
            break;
        };
        if let Ok(value) = serde_json::from_str::<String>(&format!("\"{}\"", &after[..end])) {
            out.push(value);
        }
        rest = &after[end + 1..];
    }
    out
}

fn find_string_end(text: &str) -> Option<usize> {
    let bytes = text.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'\\' => index += 2,
            b'"' => return Some(index),
            _ => index += 1,
        }
    }
    None
}

fn replace_case_aware(text: &str, needle: &str, replacement: &str) -> String {
    if cfg!(windows) {
        let lower_text = text.to_lowercase();
        let lower_needle = needle.to_lowercase();
        if lower_text.len() != text.len() || lower_needle.len() != needle.len() {
            return text.replace(needle, replacement);
        }
        let mut out = String::with_capacity(text.len());
        let mut last = 0;
        for (index, _) in lower_text.match_indices(&lower_needle) {
            out.push_str(&text[last..index]);
            out.push_str(replacement);
            last = index + needle.len();
        }
        out.push_str(&text[last..]);
        out
    } else {
        text.replace(needle, replacement)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn redactor() -> Redactor {
        Redactor::new(
            Some("/Users/bob".into()),
            vec![
                "/Users/bob/Movies/Q3 Plan - Docs.cap".into(),
                "Q3 Plan - Docs.cap".into(),
                "Q3 Plan - Docs".into(),
            ],
        )
    }

    #[test]
    fn redacts_free_text_keys_nested() {
        let mut value = json!({
            "pretty_name": "Q3 Restructure Plan - Google Docs",
            "segments": [{ "display": { "path": "content/display.mp4", "device_name": "Bob's iPhone" } }],
            "mic": { "label": "AirPods" },
            "fps": 30,
            "title": ""
        });
        assert!(redactor().json(&mut value));
        assert_eq!(value["pretty_name"], json!("<redacted:33>"));
        assert_eq!(
            value["segments"][0]["display"]["device_name"],
            json!("<redacted:12>")
        );
        assert_eq!(
            value["segments"][0]["display"]["path"],
            json!("content/display.mp4")
        );
        assert_eq!(value["mic"]["label"], json!("<redacted:7>"));
        assert_eq!(value["fps"], json!(30));
        assert!(redactor().contains_marker(&value));
    }

    #[test]
    fn redacts_home_and_bundle_paths() {
        let mut value = json!({
            "error": "failed at /Users/bob/Movies/Q3 Plan - Docs.cap/content/x.m4s",
            "other": "/Users/bob/Library/x"
        });
        assert!(redactor().json(&mut value));
        assert_eq!(value["error"], json!("failed at <recording>/content/x.m4s"));
        assert_eq!(value["other"], json!("~/Library/x"));
    }

    #[test]
    fn redacts_raw_text_of_corrupt_json() {
        let raw =
            r#"{"pretty_name" : "Secret \"Plan\"", "path": "/Users/bob/a", "name":"x", broken"#;
        let (out, changed) = redactor().raw_json_text(raw);
        assert!(changed);
        assert!(!out.contains("Secret"), "{out}");
        assert!(out.contains("<redacted:"), "{out}");
        assert!(out.contains("~/a"), "{out}");
        assert!(!out.contains("\"x\""), "{out}");

        let (cut, changed) = redactor().raw_json_text(r#"{"fps":30,"device_name": "Bob's iPh"#);
        assert!(changed);
        assert!(!cut.contains("Bob"), "{cut}");
        assert!(cut.ends_with("\"<redacted:9>"), "{cut}");
    }

    #[test]
    fn placeholders_restore_hidden_values_from_cut_off_json() {
        let raw = r#"{"pretty_name": "Q3 \"Plan\"", "segments": [{"name": "Desk"}, {"name": "Mic"}], "cursors": {"#;
        let (shown, _) = redactor().raw_json_text(raw);
        let token = shown
            .split('"')
            .find(|part| part.starts_with(PLACEHOLDER_PREFIX))
            .unwrap()
            .to_string();
        let hidden = hidden_values(raw);
        let mut value = json!({ "pretty_name": token, "status": { "status": "Complete" } });
        restore_hidden(&mut value, None, &hidden).unwrap();
        assert_eq!(value["pretty_name"], json!("Q3 \"Plan\""));
        assert!(!redactor().contains_marker(&value));

        let mut unescaped = json!(placeholder("Q3 \"Plan\""));
        restore_hidden(&mut unescaped, Some("pretty_name"), &hidden).unwrap();
        assert_eq!(unescaped, json!("Q3 \"Plan\""));

        let mut wrong_key = json!({ "title": token });
        assert!(restore_hidden(&mut wrong_key, None, &hidden).is_err());
        let mut invented = json!({ "pretty_name": "<redacted:99>" });
        assert!(restore_hidden(&mut invented, None, &hidden).is_err());
        let mut ambiguous_free = json!({ "name": "<redacted:4>" });
        restore_hidden(&mut ambiguous_free, None, &hidden).unwrap();
        assert_eq!(ambiguous_free["name"], json!("Desk"));
        let mut elsewhere = json!({ "path": token });
        restore_hidden(&mut elsewhere, None, &hidden).unwrap();
        assert!(redactor().contains_marker(&elsewhere));
    }

    #[test]
    fn placeholders_shared_by_different_values_are_refused() {
        let hidden = hidden_values(r#"{"a": {"name": "Desk"}, "b": {"name": "Lamp"}}"#);
        let mut value = json!({ "name": "<redacted:4>" });
        assert!(restore_hidden(&mut value, None, &hidden).is_err());
    }

    #[test]
    fn marker_detection_covers_keys_arrays_and_redacted_paths() {
        let redactor = redactor();
        assert!(redactor.contains_marker(&json!(["a", "<redacted:4>"])));
        assert!(redactor.contains_marker(&json!({"<redacted:2>": 1})));
        assert!(redactor.contains_marker(&json!({"path": "<recording>/content/display.mp4"})));
        assert!(redactor.contains_marker(&json!({"dir": "~/Movies/x.cap"})));
        assert!(redactor.contains_marker(&json!({"dir": "~\\Movies"})));
        assert!(redactor.contains_marker(&json!("~")));
        assert!(!redactor.contains_marker(&json!({"is_complete": false, "note": "~approx"})));
        assert!(!redactor.contains_marker(&json!({"path": "content/display.mp4"})));
        let homeless = Redactor::new(None, Vec::new());
        assert!(!homeless.contains_marker(&json!("~/Movies")));
        assert!(homeless.contains_marker(&json!("<recording>")));
    }
}
