//! Who spoke in each meeting, for "Speaker or attendee" rules and search.
//!
//! Speaker names live only in a meeting's `transcript.jsonl` (renames and
//! merges are appended there, never written to `doc.json`). Reading every
//! transcript on every open would be slow, so names are cached per meeting
//! with the transcript's length and modified time: a rename appends a line,
//! which changes both, and the next scan reads that one transcript again.

use std::{
    collections::{BTreeMap, HashMap, HashSet},
    io::Write as _,
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};

use serde::{Deserialize, Serialize};

pub const CACHE_FILE: &str = "library-people.json";
const CACHE_VERSION: u32 = 1;

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
struct Entry {
    len: u64,
    mtime_ms: u128,
    names: Vec<String>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct Cache {
    version: u32,
    #[serde(default)]
    docs: BTreeMap<String, Entry>,
}

fn stamp(path: &Path) -> Option<(u64, u128)> {
    let meta = std::fs::metadata(path).ok()?;
    let mtime = meta
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()?
        .as_millis();
    Some((meta.len(), mtime))
}

/// Named speakers of one transcript, the user left out (they are in every
/// meeting, so a rule about them says nothing).
pub fn read_names(transcript: &Path) -> Vec<String> {
    match cap_meetings::transcript::Transcript::load_jsonl(transcript) {
        Ok((transcript, _)) => transcript
            .named_speakers(None)
            .into_iter()
            .filter(|(_, user)| !user)
            .map(|(name, _)| name)
            .collect(),
        Err(_) => Vec::new(),
    }
}

fn load_cache(path: &Path) -> Cache {
    std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Cache>(&bytes).ok())
        .filter(|c| c.version == CACHE_VERSION)
        .unwrap_or_default()
}

fn save_cache(path: &Path, cache: &Cache) {
    let Some(dir) = path.parent() else {
        return;
    };
    let tmp = dir.join(format!(".{CACHE_FILE}.{}.tmp", std::process::id()));
    let written = serde_json::to_vec(cache)
        .ok()
        .and_then(|json| {
            let mut file = std::fs::File::create(&tmp).ok()?;
            file.write_all(&json).ok()?;
            file.sync_all().ok()
        })
        .is_some();
    if !written || std::fs::rename(&tmp, path).is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
}

/// Speaker names for every meeting in `docs` (id, transcript path), reading
/// only transcripts that changed since the cache was written. The cache is a
/// convenience: a missing, corrupt or old one costs a slower first scan and
/// nothing else.
pub fn index(docs: &[(String, PathBuf)], cache_path: &Path) -> HashMap<String, Vec<String>> {
    let mut cache = load_cache(cache_path);
    let mut stale: Vec<(String, PathBuf, (u64, u128))> = Vec::new();
    let mut out = HashMap::with_capacity(docs.len());
    for (id, path) in docs {
        let Some(stamp) = stamp(path) else {
            continue;
        };
        match cache.docs.get(id) {
            Some(entry) if (entry.len, entry.mtime_ms) == stamp => {
                out.insert(id.clone(), entry.names.clone());
            }
            _ => stale.push((id.clone(), path.clone(), stamp)),
        }
    }
    let ids: HashSet<&str> = docs.iter().map(|(id, _)| id.as_str()).collect();
    let changed = !stale.is_empty() || cache.docs.keys().any(|id| !ids.contains(id.as_str()));
    if !stale.is_empty() {
        let threads = std::thread::available_parallelism()
            .map_or(4, usize::from)
            .clamp(1, 6);
        let chunk = stale.len().div_ceil(threads).max(8);
        let read: Vec<(String, (u64, u128), Vec<String>)> = std::thread::scope(|scope| {
            let handles: Vec<_> = stale
                .chunks(chunk)
                .map(|part| {
                    scope.spawn(move || {
                        part.iter()
                            .map(|(id, path, stamp)| (id.clone(), *stamp, read_names(path)))
                            .collect::<Vec<_>>()
                    })
                })
                .collect();
            handles
                .into_iter()
                .flat_map(|h| h.join().unwrap_or_default())
                .collect()
        });
        for (id, (len, mtime_ms), names) in read {
            out.insert(id.clone(), names.clone());
            cache.docs.insert(
                id,
                Entry {
                    len,
                    mtime_ms,
                    names,
                },
            );
        }
    }
    if changed {
        cache.version = CACHE_VERSION;
        cache.docs.retain(|id, _| ids.contains(id.as_str()));
        save_cache(cache_path, &cache);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "cap-library-people-{tag}-{}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_missing_transcript_gives_no_names_and_no_error() {
        let dir = scratch("missing");
        let docs = vec![("a".to_string(), dir.join("nope.jsonl"))];
        assert!(index(&docs, &dir.join(CACHE_FILE)).is_empty());
    }

    #[test]
    fn a_corrupt_cache_is_ignored_and_replaced() {
        let dir = scratch("corrupt");
        let transcript = dir.join("t.jsonl");
        std::fs::write(&transcript, b"not json\n").unwrap();
        std::fs::write(dir.join(CACHE_FILE), b"{{{{").unwrap();
        let docs = vec![("a".to_string(), transcript)];
        let names = index(&docs, &dir.join(CACHE_FILE));
        assert_eq!(names.get("a"), Some(&Vec::new()));
        let cache = load_cache(&dir.join(CACHE_FILE));
        assert!(cache.docs.contains_key("a"));
    }

    #[test]
    fn an_unchanged_transcript_is_served_from_the_cache_and_a_changed_one_is_reread() {
        let dir = scratch("stale");
        let transcript = dir.join("t.jsonl");
        std::fs::write(&transcript, b"\n").unwrap();
        let cache_path = dir.join(CACHE_FILE);
        let docs = vec![("a".to_string(), transcript.clone())];
        index(&docs, &cache_path);
        // Plant a name in the cache: an unchanged transcript must return it
        // without reading the file.
        let mut cache = load_cache(&cache_path);
        cache.docs.get_mut("a").unwrap().names = vec!["Cached Ana".into()];
        save_cache(&cache_path, &cache);
        assert_eq!(index(&docs, &cache_path)["a"], vec!["Cached Ana".to_string()]);
        // Appending (what a rename does) changes the length: read again.
        std::fs::write(&transcript, b"\n\n").unwrap();
        assert_eq!(index(&docs, &cache_path)["a"], Vec::<String>::new());
    }

    #[test]
    fn deleted_meetings_leave_the_cache() {
        let dir = scratch("gone");
        let transcript = dir.join("t.jsonl");
        std::fs::write(&transcript, b"\n").unwrap();
        let cache_path = dir.join(CACHE_FILE);
        index(&[("a".to_string(), transcript.clone())], &cache_path);
        index(&[("b".to_string(), transcript)], &cache_path);
        let cache = load_cache(&cache_path);
        assert!(!cache.docs.contains_key("a"));
        assert!(cache.docs.contains_key("b"));
    }
}
