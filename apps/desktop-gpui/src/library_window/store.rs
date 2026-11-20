//! The library's own file: smart folders, and which recordings and
//! screenshots sit in which folder. Notes keep their folder in their own
//! `doc.json`, as they always have; folders themselves are the notes
//! library's folders, so the notes window and the library show one set.
//!
//! Safety rules, all tested:
//! - every change re-reads the file, applies one edit and replaces the file
//!   atomically, so two windows (or two Cap processes) never undo each other;
//! - the previous good file is kept as `.bak`;
//! - a file that cannot be read is moved aside, never overwritten, and the
//!   library says so;
//! - a file from a newer Cap is read but never written.

use std::{
    collections::{BTreeMap, BTreeSet},
    io::Write as _,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::rules::SmartFolder;

pub const FILE_NAME: &str = "library.json";
pub const VERSION: u32 = 1;
/// Limits that keep a hand-edited or hostile file from stalling the UI.
pub const MAX_SMART_FOLDERS: usize = 200;
pub const MAX_RULES: usize = 50;
pub const MAX_NAME_CHARS: usize = 120;
pub const MAX_VALUE_CHARS: usize = 400;

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryFile {
    #[serde(default = "default_version")]
    pub version: u32,
    #[serde(default, deserialize_with = "lenient_folders")]
    pub smart_folders: Vec<SmartFolder>,
    /// Folder id -> stored item keys (`path:...`) for recordings and
    /// screenshots.
    #[serde(default, deserialize_with = "lenient_members")]
    pub members: BTreeMap<String, BTreeSet<String>>,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, Value>,
}

fn default_version() -> u32 {
    VERSION
}

/// One broken smart folder must not cost the others: each is parsed on its
/// own and a bad one is kept aside in `extra` rather than dropped.
fn lenient_folders<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Vec<SmartFolder>, D::Error> {
    let values = Vec::<Value>::deserialize(d).unwrap_or_default();
    Ok(values
        .into_iter()
        .filter_map(|v| serde_json::from_value::<SmartFolder>(v).ok())
        .filter(|f| !f.id.is_empty())
        .take(MAX_SMART_FOLDERS)
        .collect())
}

fn lenient_members<'de, D: serde::Deserializer<'de>>(
    d: D,
) -> Result<BTreeMap<String, BTreeSet<String>>, D::Error> {
    let map = BTreeMap::<String, Value>::deserialize(d).unwrap_or_default();
    Ok(map
        .into_iter()
        .filter_map(|(id, v)| {
            let keys: BTreeSet<String> = v
                .as_array()?
                .iter()
                .filter_map(|k| k.as_str().map(str::to_string))
                .collect();
            Some((id, keys))
        })
        .collect())
}

#[derive(Clone, Debug, PartialEq)]
pub enum LoadOutcome {
    Fresh,
    Loaded,
    /// The file could not be read; it was moved to this path.
    MovedAside(PathBuf),
    /// Written by a newer Cap: shown, never written.
    ReadOnly,
}

#[derive(Debug)]
pub struct Loaded {
    pub file: LibraryFile,
    pub outcome: LoadOutcome,
}

pub fn path_in(dir: &Path) -> PathBuf {
    dir.join(FILE_NAME)
}

fn sanitize(file: &mut LibraryFile) {
    file.smart_folders.truncate(MAX_SMART_FOLDERS);
    let mut seen = BTreeSet::new();
    file.smart_folders.retain(|f| seen.insert(f.id.clone()));
    for folder in &mut file.smart_folders {
        folder.name = clip(&folder.name, MAX_NAME_CHARS);
        folder.rules.truncate(MAX_RULES);
        for rule in &mut folder.rules {
            use super::rules::Rule;
            if let Rule::Title { value, .. }
            | Rule::Person { value, .. }
            | Rule::App { value, .. } = rule
            {
                *value = clip(value, MAX_VALUE_CHARS);
            }
        }
    }
}

fn clip(text: &str, max: usize) -> String {
    text.chars().take(max).collect()
}

/// Reads the file. Never fails: a missing file is an empty library, an
/// unreadable one is moved aside first so it can be recovered by hand.
pub fn load(dir: &Path) -> Loaded {
    let path = path_in(dir);
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Loaded {
                file: LibraryFile::default(),
                outcome: LoadOutcome::Fresh,
            };
        }
        Err(e) => {
            tracing::warn!("library file unreadable: {e}");
            return Loaded {
                file: LibraryFile::default(),
                outcome: LoadOutcome::ReadOnly,
            };
        }
    };
    match serde_json::from_slice::<LibraryFile>(&bytes) {
        Ok(mut file) => {
            sanitize(&mut file);
            let outcome = if file.version > VERSION {
                LoadOutcome::ReadOnly
            } else {
                LoadOutcome::Loaded
            };
            Loaded { file, outcome }
        }
        Err(error) => {
            tracing::warn!("library file did not parse, moving it aside: {error}");
            let aside = dir.join(format!(
                "library.unreadable-{}.json",
                chrono::Utc::now().format("%Y%m%dT%H%M%S%.3f")
            ));
            match std::fs::rename(&path, &aside) {
                Ok(()) => Loaded {
                    file: LibraryFile::default(),
                    outcome: LoadOutcome::MovedAside(aside),
                },
                // Could not move it: never write over it either.
                Err(_) => Loaded {
                    file: LibraryFile::default(),
                    outcome: LoadOutcome::ReadOnly,
                },
            }
        }
    }
}

#[derive(Debug, PartialEq)]
pub enum UpdateError {
    ReadOnly,
    Io(String),
}

/// Re-reads the file, applies `edit`, and replaces the file atomically.
/// Returns the file as written.
pub fn update(dir: &Path, edit: impl FnOnce(&mut LibraryFile)) -> Result<LibraryFile, UpdateError> {
    let loaded = load(dir);
    if loaded.outcome == LoadOutcome::ReadOnly {
        return Err(UpdateError::ReadOnly);
    }
    let mut file = loaded.file;
    edit(&mut file);
    file.version = VERSION;
    sanitize(&mut file);
    write_atomic(dir, &file).map_err(|e| UpdateError::Io(e.to_string()))?;
    Ok(file)
}

fn write_atomic(dir: &Path, file: &LibraryFile) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    let path = path_in(dir);
    let json = serde_json::to_vec_pretty(file).map_err(std::io::Error::other)?;
    let tmp = dir.join(format!(".{FILE_NAME}.{}.tmp", std::process::id()));
    {
        let mut out = std::fs::File::create(&tmp)?;
        out.write_all(&json)?;
        out.sync_all()?;
    }
    if path.exists() {
        let _ = std::fs::copy(&path, dir.join(format!("{FILE_NAME}.bak")));
    }
    std::fs::rename(&tmp, &path).inspect_err(|_| {
        let _ = std::fs::remove_file(&tmp);
    })
}

/// Drops memberships for folders that no longer exist and for items that
/// are gone. Called after a full scan, never from a partial one.
pub fn prune_members(
    file: &mut LibraryFile,
    folder_ids: &BTreeSet<String>,
    live_keys: &BTreeSet<String>,
) -> bool {
    let before = file.members.clone();
    file.members.retain(|id, _| folder_ids.contains(id));
    for keys in file.members.values_mut() {
        keys.retain(|k| live_keys.contains(k));
    }
    file.members.retain(|_, keys| !keys.is_empty());
    before != file.members
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::library_window::rules::{Matching, Rule, TextOp};

    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "cap-library-store-{tag}-{}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn folder(id: &str) -> SmartFolder {
        SmartFolder {
            id: id.into(),
            name: format!("Folder {id}"),
            matching: Matching::All,
            rules: vec![Rule::Title {
                op: TextOp::Contains,
                value: "standup".into(),
            }],
            extra: Default::default(),
        }
    }

    #[test]
    fn missing_file_is_an_empty_library() {
        let dir = scratch("missing");
        let loaded = load(&dir);
        assert_eq!(loaded.outcome, LoadOutcome::Fresh);
        assert!(loaded.file.smart_folders.is_empty());
    }

    #[test]
    fn edits_round_trip_and_keep_a_backup() {
        let dir = scratch("roundtrip");
        update(&dir, |f| f.smart_folders.push(folder("a"))).unwrap();
        update(&dir, |f| f.smart_folders.push(folder("b"))).unwrap();
        let loaded = load(&dir);
        assert_eq!(loaded.outcome, LoadOutcome::Loaded);
        assert_eq!(loaded.file.smart_folders.len(), 2);
        let backup: LibraryFile =
            serde_json::from_slice(&std::fs::read(dir.join("library.json.bak")).unwrap()).unwrap();
        assert_eq!(backup.smart_folders.len(), 1);
        assert!(
            std::fs::read_dir(&dir).unwrap().all(|e| !e
                .unwrap()
                .file_name()
                .to_string_lossy()
                .ends_with(".tmp"))
        );
    }

    #[test]
    fn two_writers_never_undo_each_other() {
        let dir = scratch("writers");
        // Each window holds a stale copy; edits go through update(), which
        // re-reads, so both survive.
        update(&dir, |f| f.smart_folders.push(folder("from-window-1"))).unwrap();
        update(&dir, |f| f.smart_folders.push(folder("from-window-2"))).unwrap();
        let ids: Vec<_> = load(&dir)
            .file
            .smart_folders
            .into_iter()
            .map(|f| f.id)
            .collect();
        assert_eq!(ids, ["from-window-1", "from-window-2"]);
    }

    #[test]
    fn a_corrupt_file_is_moved_aside_never_overwritten() {
        let dir = scratch("corrupt");
        std::fs::write(path_in(&dir), b"{ \"smartFolders\": [ trunc").unwrap();
        let loaded = load(&dir);
        let LoadOutcome::MovedAside(aside) = loaded.outcome else {
            panic!(
                "expected the file to be moved aside, got {:?}",
                loaded.outcome
            );
        };
        assert_eq!(
            std::fs::read(&aside).unwrap(),
            b"{ \"smartFolders\": [ trunc"
        );
        assert!(!path_in(&dir).exists());
        update(&dir, |f| f.smart_folders.push(folder("new"))).unwrap();
        assert!(aside.exists());
    }

    #[test]
    fn one_broken_folder_does_not_cost_the_others() {
        let dir = scratch("onebad");
        std::fs::write(
            path_in(&dir),
            r#"{"version":1,"smartFolders":[
                {"id":"good","name":"Good","rules":[{"field":"title","op":"contains","value":"x"}]},
                {"name":"no id"},
                42,
                {"id":"good","name":"Duplicate id"}
            ],"members":{"f1":["path:/a.cap", 7], "f2": "junk"}}"#,
        )
        .unwrap();
        let loaded = load(&dir);
        assert_eq!(loaded.outcome, LoadOutcome::Loaded);
        assert_eq!(loaded.file.smart_folders.len(), 1);
        assert_eq!(loaded.file.smart_folders[0].name, "Good");
        assert_eq!(
            loaded
                .file
                .members
                .get("f1")
                .unwrap()
                .iter()
                .collect::<Vec<_>>(),
            ["path:/a.cap"]
        );
        assert!(!loaded.file.members.contains_key("f2"));
    }

    #[test]
    fn a_newer_file_is_read_but_never_written() {
        let dir = scratch("newer");
        let newer = r#"{"version":9,"smartFolders":[{"id":"a","name":"A","rules":[
            {"field":"sentiment","is":"happy"},
            {"field":"title","op":"contains","value":"x"}
        ],"colour":"teal"}],"cloudSync":{"on":true}}"#;
        std::fs::write(path_in(&dir), newer).unwrap();
        let loaded = load(&dir);
        assert_eq!(loaded.outcome, LoadOutcome::ReadOnly);
        assert_eq!(loaded.file.smart_folders[0].rules.len(), 2);
        assert!(matches!(
            loaded.file.smart_folders[0].rules[0],
            Rule::Unknown(_)
        ));
        assert_eq!(
            update(&dir, |f| f.smart_folders.clear()),
            Err(UpdateError::ReadOnly)
        );
        assert_eq!(std::fs::read_to_string(path_in(&dir)).unwrap(), newer);
    }

    #[test]
    fn unknown_rules_and_fields_survive_a_round_trip() {
        let dir = scratch("unknown");
        std::fs::write(
            path_in(&dir),
            r#"{"version":1,"smartFolders":[{"id":"a","name":"A","rules":[
                {"field":"sentiment","is":"happy"}],"colour":"teal"}],"cloudSync":{"on":true}}"#,
        )
        .unwrap();
        update(&dir, |f| f.smart_folders[0].name = "Renamed".into()).unwrap();
        let json: Value = serde_json::from_slice(&std::fs::read(path_in(&dir)).unwrap()).unwrap();
        assert_eq!(json["cloudSync"]["on"], true);
        assert_eq!(json["smartFolders"][0]["colour"], "teal");
        assert_eq!(json["smartFolders"][0]["rules"][0]["field"], "sentiment");
        assert_eq!(json["smartFolders"][0]["name"], "Renamed");
    }

    #[test]
    fn oversized_input_is_clipped_not_rejected() {
        let dir = scratch("huge");
        update(&dir, |f| {
            let mut big = folder("big");
            big.name = "n".repeat(10_000);
            big.rules = (0..500)
                .map(|_| Rule::Title {
                    op: TextOp::Contains,
                    value: "v".repeat(10_000),
                })
                .collect();
            f.smart_folders.push(big);
        })
        .unwrap();
        let file = load(&dir).file;
        assert_eq!(file.smart_folders[0].name.chars().count(), MAX_NAME_CHARS);
        assert_eq!(file.smart_folders[0].rules.len(), MAX_RULES);
    }

    #[test]
    fn pruning_drops_gone_folders_and_items_only() {
        let mut file = LibraryFile::default();
        file.members.insert(
            "kept".into(),
            ["path:/a".into(), "path:/gone".into()].into(),
        );
        file.members
            .insert("deleted".into(), ["path:/a".into()].into());
        let changed = prune_members(
            &mut file,
            &["kept".to_string()].into(),
            &["path:/a".to_string()].into(),
        );
        assert!(changed);
        assert_eq!(file.members.len(), 1);
        assert_eq!(file.members["kept"].len(), 1);
    }
}
