use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::media;
use super::paths::{Bundle, REPAIR_DIR, RelPath, display_bytes};
use super::protocol::{JsonOp, JsonOpKind, ReadEncoding};
use super::redact::{self, Redactor};

pub const MAX_ATTEMPTS: u32 = 6;
const MAX_TEXT_READ: u64 = 262_144;
const MAX_HEX_READ: u64 = 65_536;
const MAX_JSON_BYTES: u64 = 8 * 1024 * 1024;
const MAX_TEXT_FILE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_JSON_OPS: usize = 200;
const MAX_READ_FILES_RESPONSE: usize = 4 * 1024 * 1024;
pub const MAX_OPS_FILE: u64 = 8 * 1024 * 1024;
const MAX_CHANGES: usize = 500;
const MAX_LIST: u32 = 2000;
const MIN_LOSS_ALLOWANCE: u64 = 16 * 1024 * 1024;
const PRUNE_AFTER: std::time::Duration = std::time::Duration::from_secs(30 * 24 * 60 * 60);
const JOURNAL: &str = "journal.json";

pub type Verifier = Arc<dyn Fn(&Path) -> Result<PathBuf, String> + Send + Sync>;

static ACTIVE: Mutex<Option<HashSet<PathBuf>>> = Mutex::new(None);

fn mark_active(dir: &Path, active: bool) {
    let mut guard = ACTIVE.lock().unwrap_or_else(|poison| poison.into_inner());
    let set = guard.get_or_insert_with(HashSet::new);
    if active {
        set.insert(dir.to_path_buf());
    } else {
        set.remove(dir);
    }
}

fn is_active(dir: &Path) -> bool {
    ACTIVE
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
        .as_ref()
        .is_some_and(|set| set.contains(dir))
}

/// Whether a repair still holds this bundle, even after its window closed:
/// a cancelled session finishes its current tool (possibly mid-apply) before
/// it lets go.
pub fn bundle_busy(bundle_root: &Path) -> bool {
    let root = dunce::canonicalize(bundle_root)
        .unwrap_or_else(|_| bundle_root.to_path_buf())
        .join(REPAIR_DIR);
    ACTIVE
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
        .as_ref()
        .is_some_and(|set| set.iter().any(|dir| dir.starts_with(&root)))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum JournalState {
    Staging,
    Committing,
    Verifying,
    Committed,
    RolledBack,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChangeKind {
    Edit,
    Truncate,
    Remove,
    Replace,
    Create,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalEntry {
    pub path: String,
    pub change: ChangeKind,
    pub had_original: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backup: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub staged: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Journal {
    pub version: u32,
    pub state: JournalState,
    pub operation: String,
    pub created_unix: u64,
    pub entries: Vec<JournalEntry>,
}

#[derive(Debug, Clone)]
enum Change {
    Edit { staged: PathBuf },
    Truncate { length: u64 },
    Remove,
    Replace { staged: PathBuf },
}

#[derive(Debug, Clone)]
struct Staged {
    change: Change,
    had_original: bool,
    loss: u64,
}

pub struct VerifyOutcome {
    pub fixed: bool,
    pub error: Option<String>,
    pub attempts_left: u32,
    pub project_path: Option<PathBuf>,
}

pub struct Workspace {
    bundle: Bundle,
    operation: String,
    dir: PathBuf,
    changes: BTreeMap<RelPath, Staged>,
    allowance: u64,
    media_bytes: u64,
    file_count: u64,
    total_bytes: u64,
    redactor: Redactor,
    counter: u64,
    attempts: u32,
    fixed: bool,
    initialized: bool,
    /// Journal entries of an apply that has not been committed or rolled
    /// back yet. While set, the on-disk journal is what restores the
    /// originals, so nothing may overwrite it.
    unsettled: Option<Vec<JournalEntry>>,
}

fn now_unix() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_secs())
}

fn sync_dir(path: &Path) {
    #[cfg(unix)]
    if let Ok(dir) = std::fs::File::open(path) {
        dir.sync_all().ok();
    }
    #[cfg(not(unix))]
    let _ = path;
}

fn write_durable(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let tmp = path.with_extension("tmp");
    {
        let mut file = std::fs::File::create(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
    }
    std::fs::rename(&tmp, path)?;
    if let Some(parent) = path.parent() {
        sync_dir(parent);
    }
    Ok(())
}

fn walk_files(
    root: &Path,
    dir: &Path,
    out: &mut Vec<(PathBuf, std::fs::Metadata)>,
    include_dirs: bool,
) -> std::io::Result<()> {
    let mut entries: Vec<_> = std::fs::read_dir(dir)?.filter_map(Result::ok).collect();
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let path = entry.path();
        let Ok(metadata) = path.symlink_metadata() else {
            continue;
        };
        if metadata.file_type().is_symlink() {
            continue;
        }
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if dir == root && name.eq_ignore_ascii_case(REPAIR_DIR) {
            continue;
        }
        if name.to_ascii_lowercase().starts_with(".recovery-") {
            continue;
        }
        if metadata.is_dir() {
            if include_dirs {
                out.push((path.clone(), metadata));
            }
            walk_files(root, &path, out, include_dirs)?;
        } else if metadata.is_file() {
            out.push((path, metadata));
        }
    }
    Ok(())
}

fn parse_pointer(pointer: &str) -> Result<Vec<String>, String> {
    if pointer.is_empty() {
        return Ok(Vec::new());
    }
    let Some(rest) = pointer.strip_prefix('/') else {
        return Err("JSON pointer must be empty or start with /".into());
    };
    Ok(rest
        .split('/')
        .map(|token| token.replace("~1", "/").replace("~0", "~"))
        .collect())
}

fn apply_json_op(root: &mut Value, op: &JsonOp) -> Result<(), String> {
    let tokens = parse_pointer(&op.pointer)?;
    match op.op {
        JsonOpKind::Set => {
            let value = op
                .value
                .clone()
                .ok_or_else(|| "set needs a value".to_string())?;
            let Some((last, parents)) = tokens.split_last() else {
                *root = value;
                return Ok(());
            };
            let parent = navigate(root, parents)?;
            match parent {
                Value::Object(map) => {
                    map.insert(last.clone(), value);
                }
                Value::Array(items) => {
                    if last == "-" {
                        items.push(value);
                    } else {
                        let index: usize = last
                            .parse()
                            .map_err(|_| format!("invalid array index {last}"))?;
                        if index < items.len() {
                            items[index] = value;
                        } else if index == items.len() {
                            items.push(value);
                        } else {
                            return Err(format!("array index {index} out of range"));
                        }
                    }
                }
                _ => return Err("pointer parent is not an object or array".into()),
            }
        }
        JsonOpKind::Remove => {
            let Some((last, parents)) = tokens.split_last() else {
                return Err("cannot remove the document root".into());
            };
            let parent = navigate(root, parents)?;
            match parent {
                Value::Object(map) => {
                    map.remove(last)
                        .ok_or_else(|| format!("key {last} does not exist"))?;
                }
                Value::Array(items) => {
                    let index: usize = last
                        .parse()
                        .map_err(|_| format!("invalid array index {last}"))?;
                    if index >= items.len() {
                        return Err(format!("array index {index} out of range"));
                    }
                    items.remove(index);
                }
                _ => return Err("pointer parent is not an object or array".into()),
            }
        }
    }
    Ok(())
}

fn navigate<'a>(root: &'a mut Value, tokens: &[String]) -> Result<&'a mut Value, String> {
    let mut current = root;
    for token in tokens {
        current = match current {
            Value::Object(map) => map
                .get_mut(token)
                .ok_or_else(|| format!("key {token} does not exist"))?,
            Value::Array(items) => {
                let index: usize = token
                    .parse()
                    .map_err(|_| format!("invalid array index {token}"))?;
                items
                    .get_mut(index)
                    .ok_or_else(|| format!("array index {index} out of range"))?
            }
            _ => return Err(format!("cannot descend into {token}")),
        };
    }
    Ok(current)
}

fn copy_prefix(source: &Path, dest: &Path, length: u64) -> std::io::Result<()> {
    let mut input = std::fs::File::open(source)?.take(length);
    let mut output = std::fs::File::create(dest)?;
    std::io::copy(&mut input, &mut output)?;
    output.sync_all()
}

fn copy_durable(source: &Path, dest: &Path) -> std::io::Result<()> {
    std::fs::copy(source, dest)?;
    std::fs::OpenOptions::new()
        .write(true)
        .open(dest)?
        .sync_all()
}

impl Workspace {
    pub fn open(
        bundle: Bundle,
        id: &str,
        operation: &str,
        redactor: Redactor,
    ) -> Result<Self, String> {
        let mut files = Vec::new();
        walk_files(bundle.root(), bundle.root(), &mut files, false)
            .map_err(|error| format!("cannot list the recording: {error}"))?;
        let mut media_bytes = 0u64;
        let mut total_bytes = 0u64;
        for (path, metadata) in &files {
            total_bytes = total_bytes.saturating_add(metadata.len());
            if bundle.relative(path).is_some_and(|rel| rel.is_media()) {
                media_bytes = media_bytes.saturating_add(metadata.len());
            }
        }
        let dir = bundle.repair_root().join(id);
        Ok(Self {
            allowance: (media_bytes / 50).max(MIN_LOSS_ALLOWANCE),
            media_bytes,
            file_count: files.len() as u64,
            total_bytes,
            bundle,
            operation: operation.to_string(),
            dir,
            changes: BTreeMap::new(),
            redactor,
            counter: 0,
            attempts: 0,
            fixed: false,
            initialized: false,
            unsettled: None,
        })
    }

    pub fn bundle(&self) -> &Bundle {
        &self.bundle
    }

    pub fn redactor(&self) -> &Redactor {
        &self.redactor
    }

    pub fn stats(&self) -> (u64, u64, u64) {
        (self.file_count, self.total_bytes, self.media_bytes)
    }

    pub fn is_fixed(&self) -> bool {
        self.fixed
    }

    pub fn loss_used(&self) -> u64 {
        self.changes.values().map(|staged| staged.loss).sum()
    }

    #[cfg(test)]
    pub fn allowance(&self) -> u64 {
        self.allowance
    }

    fn ensure_dir(&mut self) -> Result<(), String> {
        if self.initialized {
            return Ok(());
        }
        std::fs::create_dir_all(self.dir.join("staged"))
            .and_then(|()| std::fs::create_dir_all(self.dir.join("backup")))
            .and_then(|()| std::fs::create_dir_all(self.dir.join("tmp")))
            .map_err(|error| format!("cannot create the repair workspace: {error}"))?;
        mark_active(&self.dir, true);
        self.initialized = true;
        self.write_journal(JournalState::Staging, Vec::new())
    }

    fn write_journal(&self, state: JournalState, entries: Vec<JournalEntry>) -> Result<(), String> {
        let journal = Journal {
            version: 1,
            state,
            operation: self.operation.clone(),
            created_unix: now_unix(),
            entries,
        };
        let bytes = serde_json::to_vec_pretty(&journal).map_err(|error| error.to_string())?;
        write_durable(&self.dir.join(JOURNAL), &bytes)
            .map_err(|error| format!("cannot write the repair journal: {error}"))
    }

    fn next_staged_path(&mut self, rel: &RelPath) -> PathBuf {
        self.counter += 1;
        let name = rel.as_str().replace('/', "__");
        self.dir
            .join("staged")
            .join(format!("{}-{name}", self.counter))
    }

    pub fn incoming_path(&mut self) -> Result<PathBuf, String> {
        self.ensure_dir()?;
        self.counter += 1;
        Ok(self
            .dir
            .join("tmp")
            .join(format!("incoming-{}", self.counter)))
    }

    fn original(&self, rel: &RelPath) -> Result<Option<(PathBuf, u64)>, String> {
        let path = self.bundle.resolve(rel)?;
        match path.symlink_metadata() {
            Ok(metadata) if metadata.is_file() => Ok(Some((path, metadata.len()))),
            Ok(_) => Err("path is not a file".into()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(format!("cannot read path: {error}")),
        }
    }

    pub fn effective(&self, rel: &RelPath) -> Result<Option<(PathBuf, u64)>, String> {
        match self.changes.get(rel).map(|staged| &staged.change) {
            Some(Change::Edit { staged }) | Some(Change::Replace { staged }) => {
                let len = staged.metadata().map_err(|error| error.to_string())?.len();
                Ok(Some((staged.clone(), len)))
            }
            Some(Change::Truncate { length }) => {
                Ok(self.original(rel)?.map(|(path, _)| (path, *length)))
            }
            Some(Change::Remove) => Ok(None),
            None => self.original(rel),
        }
    }

    pub fn list(&self, dir: Option<&str>, limit: Option<u32>) -> Result<Value, String> {
        let limit = limit.unwrap_or(MAX_LIST).clamp(1, MAX_LIST) as usize;
        let base = match dir.filter(|dir| !dir.is_empty() && *dir != ".") {
            Some(dir) => {
                let rel = RelPath::parse(dir.trim_end_matches('/'))?;
                let path = self.bundle.resolve(&rel)?;
                if !path.is_dir() {
                    return Err("not a folder".into());
                }
                Some((rel, path))
            }
            None => None,
        };
        let start = base.as_ref().map_or_else(
            || self.bundle.root().to_path_buf(),
            |(_, path)| path.clone(),
        );
        let mut entries = Vec::new();
        walk_files(self.bundle.root(), &start, &mut entries, true)
            .map_err(|error| format!("cannot list: {error}"))?;
        let mut rows = BTreeMap::new();
        for (path, metadata) in entries {
            let Some(rel) = self.bundle.relative(&path) else {
                continue;
            };
            let modified = metadata
                .modified()
                .ok()
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .map_or(0, |elapsed| elapsed.as_secs());
            if metadata.is_dir() {
                rows.insert(rel.as_str().to_string(), ("dir", 0u64, modified));
            } else {
                match self.effective(&rel)? {
                    Some((_, len)) => {
                        rows.insert(rel.as_str().to_string(), ("file", len, modified));
                    }
                    None => continue,
                }
            }
        }
        for (rel, staged) in &self.changes {
            if staged.had_original {
                continue;
            }
            let inside = base
                .as_ref()
                .is_none_or(|(dir, _)| rel.as_str().starts_with(&format!("{}/", dir.as_str())));
            if inside && let Some((_, len)) = self.effective(rel)? {
                rows.insert(rel.as_str().to_string(), ("file", len, now_unix()));
            }
        }
        let truncated = rows.len() > limit;
        let entries: Vec<Value> = rows
            .into_iter()
            .take(limit)
            .map(|(path, (kind, size, modified))| {
                json!({ "path": path, "kind": kind, "size": size, "modifiedUnix": modified })
            })
            .collect();
        Ok(json!({ "entries": entries, "truncated": truncated }))
    }

    fn load_json_redacted(&self, source: &Path, len: u64) -> Result<(Vec<u8>, bool), String> {
        if len > MAX_JSON_BYTES {
            return Err("JSON file is too large to read whole".into());
        }
        let mut raw = Vec::new();
        std::fs::File::open(source)
            .and_then(|file| file.take(len).read_to_end(&mut raw))
            .map_err(|error| format!("cannot read file: {error}"))?;
        match serde_json::from_slice::<Value>(&raw) {
            Ok(mut value) => {
                let changed = self.redactor.json(&mut value);
                let text = serde_json::to_vec_pretty(&value).map_err(|error| error.to_string())?;
                Ok((text, changed))
            }
            Err(_) => {
                let text = String::from_utf8_lossy(&raw);
                let (out, changed) = self.redactor.raw_json_text(&text);
                Ok((out.into_bytes(), changed))
            }
        }
    }

    fn load_text_redacted(
        &self,
        rel: &RelPath,
        source: &Path,
        len: u64,
    ) -> Result<(Vec<u8>, bool), String> {
        if rel.is_json() && len <= MAX_JSON_BYTES {
            return self.load_json_redacted(source, len);
        }
        if len > MAX_TEXT_FILE_BYTES {
            return Err("file is too large to read with private text hidden".into());
        }
        let mut raw = Vec::new();
        std::fs::File::open(source)
            .and_then(|file| file.take(len).read_to_end(&mut raw))
            .map_err(|error| format!("cannot read file: {error}"))?;
        let text = String::from_utf8_lossy(&raw);
        let (out, changed) = if rel.is_json() {
            self.redactor.raw_json_text(&text)
        } else {
            let out = self.redactor.text(&text);
            let changed = out != text;
            (out, changed)
        };
        Ok((out.into_bytes(), changed))
    }

    pub fn redacted_json(&self, rel: &RelPath) -> Result<Vec<u8>, String> {
        let (source, len) = self
            .effective(rel)?
            .ok_or_else(|| "file does not exist".to_string())?;
        self.load_json_redacted(&source, len)
            .map(|(bytes, _)| bytes)
    }

    pub fn read_many(&self, paths: &[String], max_each: u64) -> Value {
        let mut files = Vec::with_capacity(paths.len());
        let mut total = 0usize;
        let mut full = false;
        for raw in paths {
            let shown = super::sanitize::truncate(raw, super::sanitize::TARGET_LIMIT);
            if full {
                files.push(json!({ "path": shown, "error": "response limit reached" }));
                continue;
            }
            let entry = match RelPath::parse(raw)
                .and_then(|rel| self.read(&rel, None, Some(max_each), ReadEncoding::Auto))
            {
                Ok(read) => {
                    let size = read["size"].as_u64().unwrap_or(0);
                    let length = read["length"].as_u64().unwrap_or(0);
                    json!({
                        "path": read["path"],
                        "size": size,
                        "encoding": read["encoding"],
                        "data": read["data"],
                        "redacted": read["redacted"],
                        "truncated": length < size,
                    })
                }
                Err(error) => json!({ "path": shown, "error": self.redactor.text(&error) }),
            };
            let entry_len = serde_json::to_vec(&entry).map_or(0, |bytes| bytes.len());
            if total + entry_len > MAX_READ_FILES_RESPONSE {
                full = true;
                files.push(json!({ "path": shown, "error": "response limit reached" }));
                continue;
            }
            total += entry_len;
            files.push(entry);
        }
        json!({ "files": files })
    }

    pub fn read(
        &self,
        rel: &RelPath,
        offset: Option<u64>,
        length: Option<u64>,
        encoding: ReadEncoding,
    ) -> Result<Value, String> {
        let (source, len) = self
            .effective(rel)?
            .ok_or_else(|| "file does not exist".to_string())?;
        let offset = offset.unwrap_or(0);
        let cap = if encoding == ReadEncoding::Hex {
            MAX_HEX_READ
        } else {
            MAX_TEXT_READ
        };
        let binary = rel.is_media() || rel.extension().as_deref() == Some("png");
        let (bytes, size, redacted) = if binary {
            let want = length
                .unwrap_or(cap)
                .min(cap)
                .min(len.saturating_sub(offset));
            let mut file = std::fs::File::open(&source).map_err(|error| error.to_string())?;
            file.seek(SeekFrom::Start(offset.min(len)))
                .map_err(|error| error.to_string())?;
            let mut buffer = Vec::with_capacity(want as usize);
            file.take(want)
                .read_to_end(&mut buffer)
                .map_err(|error| error.to_string())?;
            (buffer, len, false)
        } else {
            let (text, redacted) = self.load_text_redacted(rel, &source, len)?;
            let size = text.len() as u64;
            let start = offset.min(size) as usize;
            let want = length.unwrap_or(cap).min(cap) as usize;
            let end = (start + want).min(text.len());
            (text[start..end].to_vec(), size, redacted)
        };
        let (encoding_name, data) = match encoding {
            ReadEncoding::Hex => ("hex", hex_encode(&bytes)),
            ReadEncoding::Base64 => (
                "base64",
                base64::engine::general_purpose::STANDARD.encode(&bytes),
            ),
            ReadEncoding::Auto => match std::str::from_utf8(&bytes) {
                Ok(text) => {
                    let replaced = self.redactor.text(text);
                    let redacted_now = replaced != text;
                    return Ok(json!({
                        "path": rel.as_str(),
                        "size": size,
                        "offset": offset,
                        "length": bytes.len(),
                        "encoding": "utf8",
                        "data": replaced,
                        "redacted": redacted || redacted_now,
                    }));
                }
                Err(_) => (
                    "base64",
                    base64::engine::general_purpose::STANDARD.encode(&bytes),
                ),
            },
        };
        Ok(json!({
            "path": rel.as_str(),
            "size": size,
            "offset": offset,
            "length": bytes.len(),
            "encoding": encoding_name,
            "data": data,
            "redacted": redacted,
        }))
    }

    pub fn inspect(&self, rel: &RelPath) -> Result<Value, String> {
        let (source, _) = self
            .effective(rel)?
            .ok_or_else(|| "file does not exist".to_string())?;
        let is_fragment = rel.extension().as_deref() == Some("m4s");
        let mut inspection = media::inspect(&source, rel.as_str(), is_fragment)?;
        if let Some(Change::Truncate { length }) =
            self.changes.get(rel).map(|staged| &staged.change)
            && *length < inspection.size
        {
            let tmp = std::env::temp_dir().join(format!(
                "cap-repair-inspect-{}-{}",
                std::process::id(),
                now_unix()
            ));
            copy_prefix(&source, &tmp, *length).map_err(|error| error.to_string())?;
            let truncated = media::inspect(&tmp, rel.as_str(), is_fragment);
            std::fs::remove_file(&tmp).ok();
            inspection = truncated?;
        }
        serde_json::to_value(inspection).map_err(|error| error.to_string())
    }

    fn check_writable(&self, rel: &RelPath) -> Result<(), String> {
        if self.fixed {
            return Err("already repaired".into());
        }
        if !rel.is_writable_kind() {
            return Err("this kind of file cannot be changed".into());
        }
        if !self.changes.contains_key(rel) && self.changes.len() >= MAX_CHANGES {
            return Err("too many staged changes".into());
        }
        Ok(())
    }

    fn non_zero_loss(
        &self,
        rel: &RelPath,
        path: &Path,
        start: u64,
        end: u64,
        previous: u64,
    ) -> Result<u64, String> {
        if !rel.is_media() || end <= start {
            return Ok(0);
        }
        let budget = self
            .allowance
            .saturating_sub(self.loss_used().saturating_sub(previous));
        let (zero, exceeded) = media::zero_bytes_in_range_until(path, start, end, budget)
            .map_err(|error| format!("cannot scan file: {error}"))?;
        if exceeded {
            return Err(self.loss_refusal());
        }
        Ok((end - start).saturating_sub(zero))
    }

    /// Media files a JSON document names, relative to the bundle or to the
    /// document's own folder (fragment manifests use bare file names).
    fn media_references(&self, rel: &RelPath, text: &str) -> BTreeSet<RelPath> {
        let dir = rel.as_str().rsplit_once('/').map(|(dir, _)| dir);
        redact::string_literals(text)
            .into_iter()
            .flat_map(|value| {
                let nested = dir.map(|dir| format!("{dir}/{value}"));
                [Some(value), nested]
            })
            .flatten()
            .filter_map(|candidate| RelPath::parse(&candidate).ok())
            .filter(|candidate| {
                candidate.is_media() && matches!(self.original(candidate), Ok(Some(_)))
            })
            .collect()
    }

    /// Real (non-zero) bytes of media the edit stops naming. Unlinking a file
    /// from the metadata hides it from Cap as surely as deleting it, so it is
    /// charged against the same allowance; files that are gone cost nothing.
    fn dereferenced_loss(&self, rel: &RelPath, before: &str, after: &str) -> Result<u64, String> {
        let kept = self.media_references(rel, after);
        let mut loss = 0u64;
        for dropped in self.media_references(rel, before).difference(&kept) {
            let Some((path, len)) = self.original(dropped)? else {
                continue;
            };
            let (zero, _) = media::zero_bytes_in_range_until(&path, 0, len, u64::MAX)
                .map_err(|error| format!("cannot scan file: {error}"))?;
            loss = loss.saturating_add(len.saturating_sub(zero));
            if loss > self.allowance {
                return Err(self.loss_refusal());
            }
        }
        Ok(loss)
    }

    fn loss_refusal(&self) -> String {
        format!(
            "refused: this would discard more than {} of real recording data (only zero-filled data can be dropped freely)",
            display_bytes(self.allowance)
        )
    }

    fn admit(&mut self, rel: RelPath, staged: Staged) -> Result<(), String> {
        let previous = self.changes.get(&rel).map_or(0, |current| current.loss);
        let used = self.loss_used().saturating_sub(previous);
        if used.saturating_add(staged.loss) > self.allowance {
            if let Change::Edit { staged: path } | Change::Replace { staged: path } = &staged.change
            {
                std::fs::remove_file(path).ok();
            }
            return Err(self.loss_refusal());
        }
        if let Some(old) = self.changes.insert(rel, staged)
            && let Change::Edit { staged: path } | Change::Replace { staged: path } = old.change
        {
            std::fs::remove_file(path).ok();
        }
        Ok(())
    }

    pub fn stage_json_edit(&mut self, rel: &RelPath, ops: &[JsonOp]) -> Result<Value, String> {
        self.check_writable(rel)?;
        if !rel.is_json() {
            return Err("only .json files can be edited".into());
        }
        if ops.is_empty() || ops.len() > MAX_JSON_OPS {
            return Err(format!("between 1 and {MAX_JSON_OPS} ops are required"));
        }
        let original_text = match self.original(rel)? {
            Some((path, len)) if len <= MAX_JSON_BYTES => {
                String::from_utf8_lossy(&std::fs::read(&path).map_err(|error| error.to_string())?)
                    .into_owned()
            }
            _ => String::new(),
        };
        let hidden = redact::hidden_values(&original_text);
        let ops = ops
            .iter()
            .cloned()
            .map(|mut op| {
                if let Some(value) = op.value.as_mut() {
                    let key = parse_pointer(&op.pointer)?.pop();
                    redact::restore_hidden(value, key.as_deref(), &hidden)?;
                }
                Ok(op)
            })
            .collect::<Result<Vec<_>, String>>()?;
        let ops = ops.as_slice();
        if ops.iter().any(|op| {
            op.value
                .as_ref()
                .is_some_and(|value| self.redactor.contains_marker(value))
        }) {
            return Err(
                "values must not contain redacted placeholders, <recording> or ~ home paths; set only values you know"
                    .into(),
            );
        }
        let is_root_set = |op: &JsonOp| op.op == JsonOpKind::Set && op.pointer.is_empty();
        let original = self.original(rel)?;
        let mut document = match self.effective(rel)? {
            Some((source, len)) => {
                if len > MAX_JSON_BYTES {
                    return Err("JSON file is too large to edit".into());
                }
                let raw = std::fs::read(&source).map_err(|error| error.to_string())?;
                match serde_json::from_slice::<Value>(&raw[..(len as usize).min(raw.len())]) {
                    Ok(_) if ops.iter().any(is_root_set) => {
                        return Err(
                            "this file is valid JSON; a root set would drop fields you cannot see, so use per-key pointer ops"
                                .into(),
                        );
                    }
                    Ok(value) => value,
                    Err(_) if ops[0].op == JsonOpKind::Set && ops[0].pointer.is_empty() => {
                        Value::Null
                    }
                    Err(error) => {
                        return Err(format!(
                            "file is not valid JSON ({error}); start with a root set to rewrite it"
                        ));
                    }
                }
            }
            None => {
                if ops[0].op != JsonOpKind::Set || !ops[0].pointer.is_empty() {
                    return Err("creating a file requires a root set as the first op".into());
                }
                Value::Null
            }
        };
        for op in ops {
            apply_json_op(&mut document, op)?;
        }
        let bytes = serde_json::to_vec_pretty(&document).map_err(|error| error.to_string())?;
        if bytes.len() as u64 > MAX_JSON_BYTES {
            return Err("edited JSON is too large".into());
        }
        let loss = self.dereferenced_loss(rel, &original_text, &String::from_utf8_lossy(&bytes))?;
        self.ensure_dir()?;
        let staged_path = self.next_staged_path(rel);
        std::fs::write(&staged_path, &bytes).map_err(|error| error.to_string())?;
        self.admit(
            rel.clone(),
            Staged {
                change: Change::Edit {
                    staged: staged_path,
                },
                had_original: original.is_some(),
                loss,
            },
        )?;
        Ok(json!({ "staged": true }))
    }

    pub fn stage_truncate(&mut self, rel: &RelPath, length: u64) -> Result<Value, String> {
        self.check_writable(rel)?;
        if !rel.is_media() {
            return Err("only media files can be truncated; edit JSON with stage_json_edit".into());
        }
        match self.changes.get(rel).map(|staged| &staged.change) {
            Some(Change::Edit { .. }) | Some(Change::Replace { .. }) => {
                return Err("this file has a staged rewrite; discard_staged first".into());
            }
            Some(Change::Remove) => return Err("this file is staged for removal".into()),
            _ => {}
        }
        let (path, original_len) = self
            .original(rel)?
            .ok_or_else(|| "file does not exist".to_string())?;
        if length >= original_len {
            return Err("truncate can only shorten a file".into());
        }
        let previous = self.changes.get(rel).map_or(0, |staged| staged.loss);
        let loss = self.non_zero_loss(rel, &path, length, original_len, previous)?;
        let removed = original_len - length;
        self.ensure_dir()?;
        self.admit(
            rel.clone(),
            Staged {
                change: Change::Truncate { length },
                had_original: true,
                loss,
            },
        )?;
        Ok(
            json!({ "staged": true, "removedBytes": removed, "removedZeroBytes": removed - loss.min(removed) }),
        )
    }

    pub fn stage_remove(&mut self, rel: &RelPath) -> Result<Value, String> {
        self.check_writable(rel)?;
        if !rel.is_media() {
            return Err("only media files can be removed; edit JSON with stage_json_edit".into());
        }
        let Some((path, original_len)) = self.original(rel)? else {
            if self.changes.remove(rel).is_some() {
                return Ok(json!({ "staged": true, "removedBytes": 0, "removedZeroBytes": 0 }));
            }
            return Err("file does not exist".into());
        };
        let previous = self.changes.get(rel).map_or(0, |staged| staged.loss);
        let loss = self.non_zero_loss(rel, &path, 0, original_len, previous)?;
        self.ensure_dir()?;
        self.admit(
            rel.clone(),
            Staged {
                change: Change::Remove,
                had_original: true,
                loss,
            },
        )?;
        Ok(json!({
            "staged": true,
            "removedBytes": original_len,
            "removedZeroBytes": original_len - loss.min(original_len),
        }))
    }

    pub fn stage_replace(&mut self, rel: &RelPath, incoming: &Path) -> Result<Value, String> {
        let result = self.stage_replace_inner(rel, incoming);
        if result.is_err() {
            std::fs::remove_file(incoming).ok();
        }
        result
    }

    fn stage_replace_inner(&mut self, rel: &RelPath, incoming: &Path) -> Result<Value, String> {
        self.check_writable(rel)?;
        if !rel.is_media() {
            return Err("only media files can be replaced; edit JSON with stage_json_edit".into());
        }
        let new_size = incoming
            .metadata()
            .map_err(|error| error.to_string())?
            .len();
        let original = self.original(rel)?;
        let previous = self.changes.get(rel).map_or(0, |staged| staged.loss);
        let loss = match &original {
            Some((path, len)) if rel.is_media() => {
                let (zero, _) = media::zero_bytes_in_range_until(path, 0, *len, u64::MAX)
                    .map_err(|error| error.to_string())?;
                let loss = len.saturating_sub(zero);
                let used = self.loss_used().saturating_sub(previous);
                if used.saturating_add(loss) > self.allowance {
                    return Err(self.loss_refusal());
                }
                loss
            }
            _ => 0,
        };
        self.ensure_dir()?;
        let staged_path = self.next_staged_path(rel);
        std::fs::rename(incoming, &staged_path).map_err(|error| error.to_string())?;
        self.admit(
            rel.clone(),
            Staged {
                change: Change::Replace {
                    staged: staged_path,
                },
                had_original: original.is_some(),
                loss,
            },
        )?;
        Ok(json!({ "staged": true, "size": new_size }))
    }

    pub fn list_staged(&self) -> Value {
        let changes: Vec<Value> = self
            .changes
            .iter()
            .map(|(rel, staged)| {
                let (change, detail) = match &staged.change {
                    Change::Edit { staged: path } => (
                        if staged.had_original {
                            "edit"
                        } else {
                            "create"
                        },
                        format!(
                            "{} JSON",
                            display_bytes(path.metadata().map_or(0, |meta| meta.len()))
                        ),
                    ),
                    Change::Truncate { length } => ("truncate", format!("to {length} bytes")),
                    Change::Remove => ("remove", "moved to backup on apply".to_string()),
                    Change::Replace { staged: path } => (
                        if staged.had_original {
                            "replace"
                        } else {
                            "create"
                        },
                        display_bytes(path.metadata().map_or(0, |meta| meta.len())),
                    ),
                };
                json!({ "path": rel.as_str(), "change": change, "detail": detail })
            })
            .collect();
        json!({ "changes": changes })
    }

    pub fn discard(&mut self) -> Result<Value, String> {
        let count = self.changes.len() as u32;
        for staged in std::mem::take(&mut self.changes).into_values() {
            if let Change::Edit { staged: path } | Change::Replace { staged: path } = staged.change
            {
                std::fs::remove_file(path).ok();
            }
        }
        Ok(json!({ "discarded": count }))
    }

    #[cfg(test)]
    pub fn change_count(&self) -> usize {
        self.changes.len()
    }

    fn journal_entries(&self) -> Vec<JournalEntry> {
        self.changes
            .iter()
            .map(|(rel, staged)| {
                let (change, staged_path) = match &staged.change {
                    Change::Edit { staged: path } => (
                        if staged.had_original {
                            ChangeKind::Edit
                        } else {
                            ChangeKind::Create
                        },
                        Some(path),
                    ),
                    Change::Truncate { .. } => (ChangeKind::Truncate, None),
                    Change::Remove => (ChangeKind::Remove, None),
                    Change::Replace { staged: path } => (
                        if staged.had_original {
                            ChangeKind::Replace
                        } else {
                            ChangeKind::Create
                        },
                        Some(path),
                    ),
                };
                JournalEntry {
                    path: rel.as_str().to_string(),
                    change,
                    had_original: staged.had_original,
                    backup: staged
                        .had_original
                        .then(|| format!("backup/{}", rel.as_str())),
                    staged: staged_path.and_then(|path| {
                        path.strip_prefix(&self.dir)
                            .ok()
                            .map(|rel| rel.to_string_lossy().replace('\\', "/"))
                    }),
                }
            })
            .collect()
    }

    fn install(&mut self, rel: &RelPath, staged: &Staged) -> Result<(), String> {
        let target = self.bundle.resolve(rel)?;
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let backup = rel.join_to(&self.dir.join("backup"));
        if staged.had_original {
            if let Some(parent) = backup.parent() {
                std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
            }
            std::fs::rename(&target, &backup)
                .map_err(|error| format!("cannot move {} aside: {error}", rel.as_str()))?;
        }
        self.counter += 1;
        let tmp = self
            .dir
            .join("tmp")
            .join(format!("install-{}", self.counter));
        match &staged.change {
            Change::Edit { staged: path } | Change::Replace { staged: path } => {
                copy_durable(path, &tmp).map_err(|error| error.to_string())?;
            }
            Change::Truncate { length } => {
                copy_prefix(&backup, &tmp, *length).map_err(|error| error.to_string())?;
            }
            Change::Remove => return Ok(()),
        }
        std::fs::rename(&tmp, &target)
            .map_err(|error| format!("cannot install {}: {error}", rel.as_str()))?;
        if let Some(parent) = target.parent() {
            sync_dir(parent);
        }
        Ok(())
    }

    pub fn apply_and_verify(&mut self, verifier: &Verifier) -> Result<VerifyOutcome, String> {
        if self.fixed {
            return Err("already repaired".into());
        }
        if self.attempts >= MAX_ATTEMPTS {
            return Err("no attempts left".into());
        }
        self.attempts += 1;
        let attempts_left = MAX_ATTEMPTS - self.attempts;
        if self.changes.is_empty() {
            return Ok(match verifier(self.bundle.root()) {
                Ok(path) => {
                    self.fixed = true;
                    VerifyOutcome {
                        fixed: true,
                        error: None,
                        attempts_left,
                        project_path: Some(path),
                    }
                }
                Err(error) => VerifyOutcome {
                    fixed: false,
                    error: Some(self.redactor.text(&error)),
                    attempts_left,
                    project_path: None,
                },
            });
        }
        self.ensure_dir()?;
        let entries = self.journal_entries();
        self.write_journal(JournalState::Committing, entries.clone())?;
        self.unsettled = Some(entries.clone());
        let changes: Vec<(RelPath, Staged)> = self
            .changes
            .iter()
            .map(|(rel, staged)| (rel.clone(), staged.clone()))
            .collect();
        let mut install_error = None;
        for (rel, staged) in &changes {
            if let Err(error) = self.install(rel, staged) {
                install_error = Some(error);
                break;
            }
        }
        let verify_error = match install_error {
            Some(error) => Some(error),
            None => {
                self.write_journal(JournalState::Verifying, entries.clone())?;
                match verifier(self.bundle.root()) {
                    Ok(path) => {
                        self.write_journal(JournalState::Committed, entries)?;
                        self.unsettled = None;
                        self.fixed = true;
                        self.cleanup_staged();
                        return Ok(VerifyOutcome {
                            fixed: true,
                            error: None,
                            attempts_left,
                            project_path: Some(path),
                        });
                    }
                    Err(error) => Some(error),
                }
            }
        };
        rollback_entries(&self.bundle, &self.dir, &entries)?;
        self.write_journal(JournalState::RolledBack, entries)?;
        self.unsettled = None;
        Ok(VerifyOutcome {
            fixed: false,
            error: verify_error.map(|error| self.redactor.text(&error)),
            attempts_left,
            project_path: None,
        })
    }

    fn cleanup_staged(&mut self) {
        std::fs::remove_dir_all(self.dir.join("staged")).ok();
        std::fs::remove_dir_all(self.dir.join("tmp")).ok();
        self.changes.clear();
    }

    pub fn close(&mut self) {
        if !self.initialized {
            return;
        }
        if let Some(entries) = self.unsettled.take() {
            let settled = rollback_entries(&self.bundle, &self.dir, &entries)
                .and_then(|()| self.write_journal(JournalState::RolledBack, entries));
            if let Err(error) = settled {
                tracing::warn!(%error, "repair rollback on close failed; left for startup recovery");
                mark_active(&self.dir, false);
                self.initialized = false;
                return;
            }
        }
        if !self.fixed {
            self.discard().ok();
            self.cleanup_staged();
            if !dir_has_files(&self.dir.join("backup")) {
                std::fs::remove_dir_all(&self.dir).ok();
                let root = self.bundle.repair_root();
                if std::fs::read_dir(&root).is_ok_and(|mut dir| dir.next().is_none()) {
                    std::fs::remove_dir(&root).ok();
                }
            } else {
                self.write_journal(JournalState::RolledBack, Vec::new())
                    .ok();
            }
        }
        mark_active(&self.dir, false);
        self.initialized = false;
    }
}

impl Drop for Workspace {
    fn drop(&mut self) {
        if self.initialized {
            mark_active(&self.dir, false);
        }
    }
}

fn dir_has_files(dir: &Path) -> bool {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return false;
    };
    entries.flatten().any(|entry| {
        let path = entry.path();
        match path.symlink_metadata() {
            Ok(metadata) if metadata.is_dir() => dir_has_files(&path),
            Ok(_) => true,
            Err(_) => false,
        }
    })
}

pub fn hex_encode(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(DIGITS[(byte >> 4) as usize] as char);
        out.push(DIGITS[(byte & 0xf) as usize] as char);
    }
    out
}

fn rollback_entries(bundle: &Bundle, dir: &Path, entries: &[JournalEntry]) -> Result<(), String> {
    for entry in entries.iter().rev() {
        let Ok(rel) = RelPath::parse(&entry.path) else {
            continue;
        };
        let target = rel.join_to(bundle.root());
        let backup = rel.join_to(&dir.join("backup"));
        let backup_exists = backup.symlink_metadata().is_ok();
        if entry.had_original {
            if backup_exists {
                if target.symlink_metadata().is_ok() {
                    std::fs::remove_file(&target)
                        .map_err(|error| format!("cannot roll back {}: {error}", entry.path))?;
                }
                std::fs::rename(&backup, &target)
                    .map_err(|error| format!("cannot restore {}: {error}", entry.path))?;
            }
        } else if target.symlink_metadata().is_ok() {
            std::fs::remove_file(&target)
                .map_err(|error| format!("cannot roll back {}: {error}", entry.path))?;
        }
        if let Some(parent) = target.parent() {
            sync_dir(parent);
        }
    }
    Ok(())
}

fn read_journal(dir: &Path) -> Option<Journal> {
    serde_json::from_slice(&std::fs::read(dir.join(JOURNAL)).ok()?).ok()
}

fn sweep_repair_dir(bundle_root: &Path, dir: &Path) {
    let Ok(dir) = dunce::canonicalize(dir) else {
        return;
    };
    let dir = dir.as_path();
    if is_active(dir) {
        return;
    }
    let Ok(bundle) = Bundle::open(bundle_root) else {
        return;
    };
    let journal = read_journal(dir);
    let finished_state = match &journal {
        Some(journal) => match journal.state {
            JournalState::Staging => Some(JournalState::RolledBack),
            JournalState::Committing => rollback_entries(&bundle, dir, &journal.entries)
                .inspect_err(|error| tracing::warn!(%error, "repair rollback at startup failed"))
                .ok()
                .map(|()| JournalState::RolledBack),
            JournalState::Verifying => {
                let recovered = journal.operation == "recover"
                    && cap_recording::recovery::RecoveryManager::inspect_recording(bundle_root)
                        .is_none();
                if recovered {
                    Some(JournalState::Committed)
                } else {
                    rollback_entries(&bundle, dir, &journal.entries)
                        .inspect_err(
                            |error| tracing::warn!(%error, "repair rollback at startup failed"),
                        )
                        .ok()
                        .map(|()| JournalState::RolledBack)
                }
            }
            JournalState::Committed | JournalState::RolledBack => None,
        },
        None => None,
    };
    if let (Some(state), Some(journal)) = (finished_state, &journal) {
        let updated = Journal {
            state,
            ..journal.clone()
        };
        if let Ok(bytes) = serde_json::to_vec_pretty(&updated) {
            write_durable(&dir.join(JOURNAL), &bytes).ok();
        }
        std::fs::remove_dir_all(dir.join("staged")).ok();
        std::fs::remove_dir_all(dir.join("tmp")).ok();
        tracing::info!(state = ?state, "finished an interrupted recording repair");
    }
    let age = std::fs::metadata(dir.join(JOURNAL))
        .or_else(|_| std::fs::metadata(dir))
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|modified| modified.elapsed().ok());
    let settled = read_journal(dir).is_none_or(|journal| {
        matches!(
            journal.state,
            JournalState::Committed | JournalState::RolledBack
        )
    });
    if settled && age.is_some_and(|age| age > PRUNE_AFTER) {
        std::fs::remove_dir_all(dir).ok();
    }
}

pub fn recover_interrupted_repairs(recordings_dirs: &[PathBuf]) {
    for recordings in recordings_dirs {
        let Ok(entries) = std::fs::read_dir(recordings) else {
            continue;
        };
        for entry in entries.flatten() {
            let bundle_root = entry.path();
            let repair_root = bundle_root.join(REPAIR_DIR);
            let Ok(metadata) = repair_root.symlink_metadata() else {
                continue;
            };
            if !metadata.is_dir() {
                continue;
            }
            let Ok(repairs) = std::fs::read_dir(&repair_root) else {
                continue;
            };
            for repair in repairs.flatten() {
                let path = repair.path();
                if path.symlink_metadata().is_ok_and(|meta| meta.is_dir()) {
                    sweep_repair_dir(&bundle_root, &path);
                }
            }
            if std::fs::read_dir(&repair_root).is_ok_and(|mut dir| dir.next().is_none()) {
                std::fs::remove_dir(&repair_root).ok();
            }
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::repair::protocol::JsonOp;

    pub fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "cap-repair-ws-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    pub fn fixture(tag: &str) -> PathBuf {
        let recordings = temp_dir(tag);
        let bundle = recordings.join("My Window.cap");
        let display = bundle.join("content/segments/segment-0/display");
        std::fs::create_dir_all(&display).unwrap();
        std::fs::write(
            bundle.join("recording-meta.json"),
            br#"{"pretty_name":"My Window","segments":[{"fps":30}]}"#,
        )
        .unwrap();
        std::fs::write(
            display.join("manifest.json"),
            br#"{"segments":[{"path":"fragment_001.m4s","is_complete":true},{"path":"fragment_002.m4s","is_complete":true}]}"#,
        )
        .unwrap();
        std::fs::write(
            display.join("fragment_001.m4s"),
            vec![5u8; 40 * 1024 * 1024],
        )
        .unwrap();
        std::fs::write(display.join("fragment_002.m4s"), vec![0u8; 3 * 1024 * 1024]).unwrap();
        bundle
    }

    fn workspace(bundle: &Path) -> Workspace {
        Workspace::open(
            Bundle::open(bundle).unwrap(),
            "rpr_test",
            "recover",
            Redactor::for_bundle(bundle),
        )
        .unwrap()
    }

    fn op(kind: JsonOpKind, pointer: &str, value: Option<Value>) -> JsonOp {
        JsonOp {
            op: kind,
            pointer: pointer.into(),
            value,
        }
    }

    fn manifest() -> RelPath {
        RelPath::parse("content/segments/segment-0/display/manifest.json").unwrap()
    }

    fn torn() -> RelPath {
        RelPath::parse("content/segments/segment-0/display/fragment_002.m4s").unwrap()
    }

    fn real() -> RelPath {
        RelPath::parse("content/segments/segment-0/display/fragment_001.m4s").unwrap()
    }

    #[test]
    fn json_edits_apply_pointer_ops_and_refuse_placeholders() {
        let bundle = fixture("json");
        let mut ws = workspace(&bundle);
        ws.stage_json_edit(
            &manifest(),
            &[op(
                JsonOpKind::Set,
                "/segments/1/is_complete",
                Some(json!(false)),
            )],
        )
        .unwrap();
        let read = ws
            .read(&manifest(), None, None, ReadEncoding::Auto)
            .unwrap();
        let value: Value = serde_json::from_str(read["data"].as_str().unwrap()).unwrap();
        assert_eq!(value["segments"][1]["is_complete"], json!(false));
        assert_eq!(value["segments"][0]["is_complete"], json!(true));

        let meta = RelPath::parse("recording-meta.json").unwrap();
        for (pointer, token) in [
            ("/pretty_name", "<redacted:8>"),
            ("/title", "<redacted:9>"),
            ("/segments/0/path", "<redacted:9>"),
        ] {
            assert!(
                ws.stage_json_edit(&meta, &[op(JsonOpKind::Set, pointer, Some(json!(token)))])
                    .is_err(),
                "{pointer} {token}"
            );
        }
        ws.stage_json_edit(
            &meta,
            &[op(
                JsonOpKind::Set,
                "/pretty_name",
                Some(json!("<redacted:9>")),
            )],
        )
        .unwrap();
        let staged = ws.effective(&meta).unwrap().unwrap().0;
        let value: Value = serde_json::from_slice(&std::fs::read(staged).unwrap()).unwrap();
        assert_eq!(value["pretty_name"], json!("My Window"));
        assert!(
            ws.stage_json_edit(&meta, &[op(JsonOpKind::Remove, "", None)])
                .is_err()
        );
        assert!(
            ws.stage_json_edit(&meta, &[op(JsonOpKind::Set, "/segments/5", Some(json!(1)))])
                .is_err()
        );
        ws.stage_json_edit(&meta, &[op(JsonOpKind::Set, "/a~1b", Some(json!(1)))])
            .unwrap();
        let read = ws.read(&meta, None, None, ReadEncoding::Auto).unwrap();
        let value: Value = serde_json::from_str(read["data"].as_str().unwrap()).unwrap();
        assert_eq!(value["a/b"], json!(1));
        assert_eq!(value["pretty_name"], json!("<redacted:9>"));
        assert_eq!(read["redacted"], json!(true));

        let created = RelPath::parse("content/new.json").unwrap();
        assert!(
            ws.stage_json_edit(&created, &[op(JsonOpKind::Set, "/x", Some(json!(1)))])
                .is_err()
        );
        ws.stage_json_edit(&created, &[op(JsonOpKind::Set, "", Some(json!({"x": 1})))])
            .unwrap();
        assert!(
            ws.stage_json_edit(&RelPath::parse("notes.txt").unwrap(), &[])
                .is_err()
        );
        std::fs::remove_dir_all(bundle.parent().unwrap()).ok();
    }

    #[test]
    fn unlinking_real_media_from_json_counts_as_loss() {
        let bundle = fixture("unlink");
        let mut ws = workspace(&bundle);
        let error = ws
            .stage_json_edit(&manifest(), &[op(JsonOpKind::Remove, "/segments/0", None)])
            .unwrap_err();
        assert!(error.contains("refused"), "{error}");
        ws.stage_json_edit(&manifest(), &[op(JsonOpKind::Remove, "/segments/1", None)])
            .unwrap();
        ws.stage_json_edit(
            &manifest(),
            &[op(
                JsonOpKind::Set,
                "/segments/0/is_complete",
                Some(json!(false)),
            )],
        )
        .unwrap();
        assert!(
            ws.stage_truncate(&RelPath::parse("recording-meta.json").unwrap(), 0)
                .is_err()
        );
        std::fs::remove_dir_all(bundle.parent().unwrap()).ok();
    }

    #[test]
    fn rebuilding_a_cut_off_meta_keeps_its_hidden_title() {
        let bundle = fixture("cutmeta");
        let meta = RelPath::parse("recording-meta.json").unwrap();
        std::fs::write(
            meta.join_to(&bundle),
            br#"{"pretty_name":"Board Review","segments":[{"display":{"path":"content/a.mp4","fps"#,
        )
        .unwrap();
        let mut ws = workspace(&bundle);
        let read = ws.read(&meta, None, None, ReadEncoding::Auto).unwrap();
        let shown = read["data"].as_str().unwrap();
        assert!(!shown.contains("Board Review"), "{shown}");
        assert!(shown.contains("<redacted:12>"), "{shown}");
        ws.stage_json_edit(
            &meta,
            &[op(
                JsonOpKind::Set,
                "",
                Some(json!({ "pretty_name": "<redacted:12>", "segments": [], "status": { "status": "Complete" } })),
            )],
        )
        .unwrap();
        let staged = ws.effective(&meta).unwrap().unwrap().0;
        let value: Value = serde_json::from_slice(&std::fs::read(staged).unwrap()).unwrap();
        assert_eq!(value["pretty_name"], json!("Board Review"));
        std::fs::remove_dir_all(bundle.parent().unwrap()).ok();
    }

    #[test]
    fn json_cannot_be_replaced_removed_or_wholesale_overwritten() {
        let bundle = fixture("jsonsafety");
        let config = RelPath::parse("project-config.json").unwrap();
        std::fs::write(
            config.join_to(&bundle),
            br#"{"timeline":{"segments":[{"start":0,"end":12.5}]},"captions":{"enabled":true}}"#,
        )
        .unwrap();
        let mut ws = workspace(&bundle);

        let incoming = ws.incoming_path().unwrap();
        std::fs::write(&incoming, br#"{"timeline":null}"#).unwrap();
        let error = ws.stage_replace(&config, &incoming).unwrap_err();
        assert!(error.contains("stage_json_edit"), "{error}");
        assert!(!incoming.exists());
        let incoming = ws.incoming_path().unwrap();
        std::fs::write(&incoming, b"{}").unwrap();
        assert!(ws.stage_replace(&manifest(), &incoming).is_err());

        for path in [&config, &manifest()] {
            let error = ws.stage_remove(path).unwrap_err();
            assert!(error.contains("only media"), "{error}");
        }
        assert!(
            ws.stage_remove(&RelPath::parse("recording-meta.json").unwrap())
                .is_err()
        );

        let error = ws
            .stage_json_edit(&config, &[op(JsonOpKind::Set, "", Some(json!({})))])
            .unwrap_err();
        assert!(error.contains("per-key pointer ops"), "{error}");
        assert!(
            ws.stage_json_edit(
                &config,
                &[
                    op(JsonOpKind::Set, "/captions/enabled", Some(json!(false))),
                    op(JsonOpKind::Set, "", Some(json!({}))),
                ],
            )
            .is_err()
        );
        assert_eq!(ws.change_count(), 0);

        let corrupt = RelPath::parse("content/segments/segment-0/display/broken.json").unwrap();
        std::fs::write(corrupt.join_to(&bundle), b"{\"segments\": [").unwrap();
        ws.stage_json_edit(
            &corrupt,
            &[op(JsonOpKind::Set, "", Some(json!({"segments": []})))],
        )
        .unwrap();
        ws.stage_json_edit(
            &config,
            &[op(JsonOpKind::Set, "/captions/enabled", Some(json!(false)))],
        )
        .unwrap();
        let read = ws.read(&config, None, None, ReadEncoding::Auto).unwrap();
        let value: Value = serde_json::from_str(read["data"].as_str().unwrap()).unwrap();
        assert_eq!(value["timeline"]["segments"][0]["end"], json!(12.5));
        assert_eq!(value["captions"]["enabled"], json!(false));
        std::fs::remove_dir_all(bundle.parent().unwrap()).ok();
    }

    #[test]
    fn json_edits_refuse_redaction_markers() {
        let bundle = fixture("markers");
        let mut ws = workspace(&bundle);
        let meta = RelPath::parse("recording-meta.json").unwrap();
        let home = dirs::home_dir().is_some();
        let mut values = vec![
            json!("<recording>/content/display.mp4"),
            json!({"path": "<redacted:12>"}),
            json!(["ok", "<recording>"]),
        ];
        if home {
            values.extend([
                json!("~/Movies/x.cap"),
                json!("~"),
                json!({"dir": "~\\Movies"}),
            ]);
        }
        for value in values {
            let error = ws
                .stage_json_edit(
                    &meta,
                    &[op(JsonOpKind::Set, "/segments/0/path", Some(value.clone()))],
                )
                .unwrap_err();
            assert!(error.contains("placeholders"), "{value}: {error}");
        }
        ws.stage_json_edit(
            &meta,
            &[op(
                JsonOpKind::Set,
                "/segments/0/note",
                Some(json!("~approx")),
            )],
        )
        .unwrap();
        std::fs::remove_dir_all(bundle.parent().unwrap()).ok();
    }

    #[test]
    fn read_many_returns_per_file_results_and_caps_the_response() {
        let bundle = fixture("readmany");
        let display = bundle.join("content/segments/segment-0/display");
        for index in 0..3 {
            std::fs::write(
                bundle.join(format!("content/segments/segment-{index}-start-times.json")),
                format!(r#"{{"display":{index}.5,"title":"Secret {index}"}}"#),
            )
            .ok();
        }
        std::fs::create_dir_all(bundle.join(".cap-repair")).unwrap();
        let ws = workspace(&bundle);
        let paths: Vec<String> = [
            "recording-meta.json",
            "content/segments/segment-0/display/manifest.json",
            "../outside.json",
            ".cap-repair/journal.json",
            "content/missing.json",
            "content/segments/segment-0-start-times.json",
        ]
        .iter()
        .map(|path| path.to_string())
        .collect();
        let result = ws.read_many(&paths, 65_536);
        let files = result["files"].as_array().unwrap();
        assert_eq!(files.len(), paths.len());
        assert!(!files[0]["data"].as_str().unwrap().contains("My Window"));
        assert_eq!(files[0]["redacted"], json!(true));
        assert_eq!(files[0]["truncated"], json!(false));
        assert_eq!(files[1]["encoding"], json!("utf8"));
        for file in &files[2..5] {
            assert!(file["error"].is_string(), "{file}");
            assert!(file.get("data").is_none());
        }
        assert!(!files[5]["data"].as_str().unwrap().contains("Secret"));

        let small = ws.read_many(&paths[1..2], 10);
        assert_eq!(small["files"][0]["truncated"], json!(true));
        assert_eq!(small["files"][0]["data"].as_str().unwrap().len(), 10);

        let mut big = Vec::new();
        for index in 0..80 {
            let name = format!("chunk_{index:03}.m4s");
            std::fs::write(display.join(&name), vec![(index % 250) as u8 + 1; 65_536]).unwrap();
            big.push(format!("content/segments/segment-0/display/{name}"));
        }
        let capped = ws.read_many(&big, 65_536);
        let entries = capped["files"].as_array().unwrap();
        assert_eq!(entries.len(), 80);
        let read = entries
            .iter()
            .filter(|entry| entry.get("data").is_some())
            .count();
        assert!(read > 10 && read < 80, "{read}");
        assert!(
            entries[read..]
                .iter()
                .all(|entry| entry["error"] == json!("response limit reached"))
        );
        assert!(serde_json::to_vec(&capped).unwrap().len() <= MAX_READ_FILES_RESPONSE + 64 * 1024);
        std::fs::remove_dir_all(bundle.parent().unwrap()).ok();
    }

    #[test]
    fn loss_guard_counts_only_non_zero_media_bytes() {
        let bundle = fixture("guard");
        let mut ws = workspace(&bundle);
        assert_eq!(ws.allowance(), MIN_LOSS_ALLOWANCE);
        let removed = ws.stage_remove(&torn()).unwrap();
        assert_eq!(removed["removedZeroBytes"], json!(3 * 1024 * 1024));
        assert_eq!(ws.loss_used(), 0);
        let error = ws.stage_remove(&real()).unwrap_err();
        assert!(error.starts_with("refused"), "{error}");
        let truncated = ws.stage_truncate(&real(), 30 * 1024 * 1024).unwrap();
        assert_eq!(truncated["removedZeroBytes"], json!(0));
        assert_eq!(ws.loss_used(), 10 * 1024 * 1024);
        assert!(ws.stage_truncate(&real(), 20 * 1024 * 1024).is_err());
        ws.stage_truncate(&real(), 25 * 1024 * 1024).unwrap();
        assert_eq!(ws.loss_used(), 15 * 1024 * 1024);
        assert!(ws.stage_truncate(&real(), 50 * 1024 * 1024).is_err());
        let meta = RelPath::parse("recording-meta.json").unwrap();
        assert!(ws.stage_remove(&meta).is_err());
        std::fs::remove_dir_all(bundle.parent().unwrap()).ok();
    }

    #[test]
    fn replace_charges_the_originals_real_bytes() {
        let bundle = fixture("replace");
        let mut ws = workspace(&bundle);
        for size in [1024, 40 * 1024 * 1024] {
            let incoming = ws.incoming_path().unwrap();
            std::fs::write(&incoming, vec![1u8; size]).unwrap();
            assert!(
                ws.stage_replace(&real(), &incoming)
                    .unwrap_err()
                    .starts_with("refused")
            );
            assert!(!incoming.exists());
        }
        let incoming = ws.incoming_path().unwrap();
        std::fs::write(&incoming, vec![1u8; 1024]).unwrap();
        ws.stage_replace(&torn(), &incoming).unwrap();
        assert_eq!(ws.loss_used(), 0);
        assert_eq!(ws.list_staged()["changes"][0]["change"], json!("replace"));
        std::fs::remove_dir_all(bundle.parent().unwrap()).ok();
    }

    #[test]
    fn apply_rolls_back_on_failed_verification_and_keeps_staging() {
        let bundle = fixture("rollback");
        let original_manifest = std::fs::read(manifest().join_to(&bundle)).unwrap();
        let mut ws = workspace(&bundle);
        ws.stage_json_edit(
            &manifest(),
            &[op(
                JsonOpKind::Set,
                "/segments/1/is_complete",
                Some(json!(false)),
            )],
        )
        .unwrap();
        ws.stage_remove(&torn()).unwrap();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let seen_in = seen.clone();
        let failing: Verifier = Arc::new(move |root: &Path| {
            seen_in.lock().unwrap().push((
                root.join("content/segments/segment-0/display/fragment_002.m4s")
                    .exists(),
                std::fs::read_to_string(
                    root.join("content/segments/segment-0/display/manifest.json"),
                )
                .unwrap(),
            ));
            Err(format!("validation failed in {}", root.display()))
        });
        let outcome = ws.apply_and_verify(&failing).unwrap();
        assert!(!outcome.fixed);
        assert_eq!(outcome.attempts_left, MAX_ATTEMPTS - 1);
        let error = outcome.error.unwrap();
        assert!(!error.contains("My Window"), "{error}");
        let (torn_present, manifest_text) = seen.lock().unwrap()[0].clone();
        assert!(!torn_present);
        assert!(manifest_text.contains("false"));
        assert_eq!(
            std::fs::read(manifest().join_to(&bundle)).unwrap(),
            original_manifest
        );
        assert!(torn().join_to(&bundle).exists());
        assert_eq!(ws.change_count(), 2);
        let journal = read_journal(&bundle.join(".cap-repair/rpr_test")).unwrap();
        assert_eq!(journal.state, JournalState::RolledBack);

        let passing: Verifier = Arc::new(|root: &Path| Ok(root.to_path_buf()));
        let outcome = ws.apply_and_verify(&passing).unwrap();
        assert!(outcome.fixed);
        assert!(!torn().join_to(&bundle).exists());
        assert!(
            bundle
                .join(".cap-repair/rpr_test/backup")
                .join(torn().as_str())
                .exists()
        );
        assert!(
            ws.stage_remove(&real())
                .unwrap_err()
                .contains("already repaired")
        );
        assert!(ws.apply_and_verify(&passing).is_err());
        ws.close();
        assert!(bundle.join(".cap-repair/rpr_test/journal.json").exists());
        std::fs::remove_dir_all(bundle.parent().unwrap()).ok();
    }

    #[test]
    fn attempts_are_capped() {
        let bundle = fixture("attempts");
        let mut ws = workspace(&bundle);
        let failing: Verifier = Arc::new(|_: &Path| Err("no".into()));
        for _ in 0..MAX_ATTEMPTS {
            assert!(!ws.apply_and_verify(&failing).unwrap().fixed);
        }
        assert!(ws.apply_and_verify(&failing).is_err());
        std::fs::remove_dir_all(bundle.parent().unwrap()).ok();
    }

    #[test]
    fn encoded_and_split_reads_of_text_files_stay_redacted() {
        let bundle = fixture("encoded");
        let home = "/Users/private-person";
        std::fs::write(
            bundle.join("recording-logs.log"),
            format!("started {home}/Movies/clip.cap\nflushed\n"),
        )
        .unwrap();
        let ws = Workspace::open(
            Bundle::open(&bundle).unwrap(),
            "rpr_test",
            "open",
            Redactor::new(Some(home.to_string()), Vec::new()),
        )
        .unwrap();
        let log = RelPath::parse("recording-logs.log").unwrap();
        let decode = |read: Value| -> String {
            let data = read["data"].as_str().unwrap().to_string();
            let bytes = match read["encoding"].as_str().unwrap() {
                "hex" => (0..data.len())
                    .step_by(2)
                    .map(|i| u8::from_str_radix(&data[i..i + 2], 16).unwrap())
                    .collect(),
                "base64" => base64::engine::general_purpose::STANDARD
                    .decode(data)
                    .unwrap(),
                _ => data.into_bytes(),
            };
            String::from_utf8_lossy(&bytes).into_owned()
        };
        for encoding in [ReadEncoding::Hex, ReadEncoding::Base64, ReadEncoding::Auto] {
            let text = decode(ws.read(&log, None, None, encoding).unwrap());
            assert!(!text.contains("private-person"), "{text}");
            assert!(text.contains("~/Movies/clip.cap"), "{text}");
        }
        let mut joined = String::new();
        for offset in (0..64).step_by(5) {
            joined.push_str(&decode(
                ws.read(&log, Some(offset), Some(5), ReadEncoding::Auto)
                    .unwrap(),
            ));
        }
        assert!(!joined.contains("private-person"), "{joined}");
        std::fs::remove_dir_all(bundle.parent().unwrap()).ok();
    }

    #[test]
    fn startup_sweep_rolls_back_a_crash_mid_commit() {
        let bundle = fixture("crash");
        let recordings = bundle.parent().unwrap().to_path_buf();
        let original_manifest = std::fs::read(manifest().join_to(&bundle)).unwrap();
        {
            let mut ws = workspace(&bundle);
            ws.stage_json_edit(
                &manifest(),
                &[op(
                    JsonOpKind::Set,
                    "/segments/1/is_complete",
                    Some(json!(false)),
                )],
            )
            .unwrap();
            ws.stage_remove(&torn()).unwrap();
            let entries = ws.journal_entries();
            ws.write_journal(JournalState::Committing, entries).unwrap();
            let changes: Vec<_> = ws
                .changes
                .iter()
                .map(|(r, s)| (r.clone(), s.clone()))
                .collect();
            for (rel, staged) in &changes {
                ws.install(rel, staged).unwrap();
            }
            mark_active(&ws.dir, false);
            ws.initialized = false;
        }
        assert_ne!(
            std::fs::read(manifest().join_to(&bundle)).unwrap(),
            original_manifest
        );
        recover_interrupted_repairs(std::slice::from_ref(&recordings));
        assert_eq!(
            std::fs::read(manifest().join_to(&bundle)).unwrap(),
            original_manifest
        );
        assert!(torn().join_to(&bundle).exists());
        let journal = read_journal(&bundle.join(".cap-repair/rpr_test")).unwrap();
        assert_eq!(journal.state, JournalState::RolledBack);
        assert!(!bundle.join(".cap-repair/rpr_test/staged").exists());
        std::fs::remove_dir_all(recordings).ok();
    }

    #[test]
    fn startup_sweep_skips_live_sessions_and_is_a_no_op_without_repairs() {
        let bundle = fixture("live");
        let recordings = bundle.parent().unwrap().to_path_buf();
        recover_interrupted_repairs(std::slice::from_ref(&recordings));
        assert!(!bundle.join(".cap-repair").exists());
        let mut ws = workspace(&bundle);
        ws.stage_remove(&torn()).unwrap();
        recover_interrupted_repairs(std::slice::from_ref(&recordings));
        assert!(bundle.join(".cap-repair/rpr_test/staged").exists());
        ws.close();
        assert!(!bundle.join(".cap-repair").exists());
        std::fs::remove_dir_all(recordings).ok();
    }

    #[test]
    fn listing_and_reads_reflect_staging_and_hide_workspaces() {
        let bundle = fixture("list");
        std::fs::create_dir_all(bundle.join(".recovery-123/staged")).unwrap();
        std::fs::write(bundle.join(".recovery-123/staged/x.json"), b"{}").unwrap();
        let small = RelPath::parse("content/segments/segment-0/display/small.m4s").unwrap();
        std::fs::write(small.join_to(&bundle), vec![5u8; 300]).unwrap();
        let mut ws = workspace(&bundle);
        ws.stage_remove(&torn()).unwrap();
        ws.stage_truncate(&small, 100).unwrap();
        let listing = ws.list(None, None).unwrap();
        let paths: Vec<String> = listing["entries"]
            .as_array()
            .unwrap()
            .iter()
            .map(|entry| entry["path"].as_str().unwrap().to_string())
            .collect();
        assert!(
            !paths
                .iter()
                .any(|path| path.contains("recovery-") || path.contains("cap-repair"))
        );
        assert!(!paths.contains(&torn().as_str().to_string()));
        let size = listing["entries"]
            .as_array()
            .unwrap()
            .iter()
            .find(|entry| entry["path"] == json!(small.as_str()))
            .unwrap()["size"]
            .clone();
        assert_eq!(size, json!(100));
        let read = ws
            .read(&small, Some(90), Some(1000), ReadEncoding::Hex)
            .unwrap();
        assert_eq!(read["length"], json!(10));
        assert_eq!(read["data"], json!("05".repeat(10)));
        let meta = ws
            .read(
                &RelPath::parse("recording-meta.json").unwrap(),
                None,
                None,
                ReadEncoding::Auto,
            )
            .unwrap();
        assert!(!meta["data"].as_str().unwrap().contains("My Window"));
        std::fs::remove_dir_all(bundle.parent().unwrap()).ok();
    }
}
