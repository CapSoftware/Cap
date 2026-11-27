use std::cmp::{Ordering as CmpOrdering, Reverse};
use std::collections::{BTreeMap, BinaryHeap};
use std::fs::{self, File};
use std::io::{self, BufRead, BufReader, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard, PoisonError};

use chrono::{DateTime, FixedOffset, NaiveDate, NaiveDateTime, Offset, Utc};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::Value;

use crate::serde_util::{lenient, lenient_option};
use crate::session::StopReason;
use crate::text::{find_ci, fold_query, snippet};
use crate::transcript::Source;

#[cfg(test)]
mod tests;

pub const DOC_FILE: &str = "doc.json";
pub const NOTES_FILE: &str = "notes.json";
pub const ENHANCED_FILE: &str = "enhanced.json";
pub const TRANSCRIPT_FILE: &str = "transcript.jsonl";
pub const AUDIO_DIR: &str = "audio";
pub const ATTACHMENTS_DIR: &str = "attachments";
pub const FOLDERS_FILE: &str = "folders.json";
/// A doc.json that could not be read, kept when the doc is saved again.
pub const DAMAGED_DOC_FILE: &str = "doc.json.damaged";
/// Set (in [`DocMeta::extra`]) on a doc whose doc.json could not be read.
pub const DAMAGED_KEY: &str = "damaged";
pub const TRASH_RETENTION_DAYS: i64 = 30;

/// What a cleanup removed, and the documents it could not touch (a file in
/// use, a folder it may not write), which never stop the rest.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Cleaned {
    pub done: Vec<String>,
    pub failed: Vec<(String, String)>,
}
pub const MAX_ATTACHMENTS: usize = 50;
pub const MAX_ATTACHMENT_BYTES: usize = 25 * 1024 * 1024;
pub const IMAGE_EXTENSIONS: &[&str] =
    &["png", "jpg", "jpeg", "gif", "webp", "heic", "heif", "avif"];

#[derive(Debug, thiserror::Error)]
pub enum LibraryError {
    #[error("io error: {0}")]
    Io(#[from] io::Error),
    #[error("invalid json: {0}")]
    Json(#[from] serde_json::Error),
    #[error("invalid id: {0}")]
    InvalidId(String),
    #[error("not found: {0}")]
    NotFound(String),
    #[error("not allowed: {0}")]
    NotAllowed(String),
    #[error("limit reached: {0}")]
    Limit(String),
}

pub type Result<T> = std::result::Result<T, LibraryError>;

#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum DocKind {
    Meeting,
    Note,
    Plan,
    Script,
    Other(String),
}

impl DocKind {
    pub fn as_str(&self) -> &str {
        match self {
            DocKind::Meeting => "meeting",
            DocKind::Note => "note",
            DocKind::Plan => "plan",
            DocKind::Script => "script",
            DocKind::Other(other) => other,
        }
    }

    pub fn parse(s: &str) -> Self {
        match s {
            "meeting" => DocKind::Meeting,
            "note" | "" => DocKind::Note,
            "plan" => DocKind::Plan,
            "script" => DocKind::Script,
            other => DocKind::Other(other.to_string()),
        }
    }
}

impl Serialize for DocKind {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for DocKind {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> std::result::Result<Self, D::Error> {
        String::deserialize(deserializer).map(|s| DocKind::parse(&s))
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Attendee {
    pub name: Option<String>,
    pub email: Option<String>,
    pub is_self: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct EventSnapshot {
    pub id: String,
    pub title: String,
    pub start: Option<DateTime<Utc>>,
    pub end: Option<DateTime<Utc>>,
    pub link: Option<String>,
    pub attendees: Vec<Attendee>,
    pub calendar_name: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct AudioTrack {
    #[serde(deserialize_with = "lenient")]
    pub source: Source,
    pub file: String,
    pub codec: String,
    pub duration_ms: u64,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct MeetingDetails {
    pub started_at: Option<DateTime<Utc>>,
    pub ended_at: Option<DateTime<Utc>>,
    pub duration_ms: u64,
    pub app_id: Option<String>,
    pub app_name: Option<String>,
    pub event: Option<EventSnapshot>,
    pub participants: Vec<String>,
    pub engine: Option<String>,
    pub language: Option<String>,
    #[serde(deserialize_with = "lenient_option")]
    pub stop_reason: Option<StopReason>,
    pub transcript_chars: u64,
    pub audio: Vec<AudioTrack>,
    pub has_enhanced: bool,
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

/// How many people a meeting's transcript heard, kept in
/// [`MeetingDetails::extra`] so the notes list can say so without reading it.
pub const SPEAKER_COUNT_KEY: &str = "speakerCount";

impl MeetingDetails {
    pub fn speaker_count(&self) -> Option<u64> {
        self.extra.get(SPEAKER_COUNT_KEY).and_then(Value::as_u64)
    }

    pub fn set_speaker_count(&mut self, count: usize) {
        self.extra
            .insert(SPEAKER_COUNT_KEY.to_string(), Value::from(count as u64));
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", from = "DocMetaRaw")]
pub struct DocMeta {
    pub id: String,
    pub kind: DocKind,
    pub title: String,
    pub title_is_auto: bool,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub folder_id: Option<String>,
    pub tags: Vec<String>,
    pub template_id: Option<String>,
    pub pinned: bool,
    pub trashed_at: Option<DateTime<Utc>>,
    pub meeting: Option<MeetingDetails>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DocMetaRaw {
    #[serde(default)]
    id: String,
    #[serde(default, deserialize_with = "lenient_option")]
    kind: Option<DocKind>,
    #[serde(default)]
    title: String,
    #[serde(default)]
    title_is_auto: bool,
    #[serde(default)]
    created_at: DateTime<Utc>,
    #[serde(default)]
    updated_at: Option<DateTime<Utc>>,
    #[serde(default)]
    folder_id: Option<String>,
    #[serde(default)]
    tags: Vec<String>,
    #[serde(default)]
    template_id: Option<String>,
    #[serde(default)]
    pinned: bool,
    #[serde(default)]
    trashed_at: Option<DateTime<Utc>>,
    #[serde(default)]
    meeting: Option<MeetingDetails>,
    #[serde(flatten)]
    extra: BTreeMap<String, Value>,
}

impl From<DocMetaRaw> for DocMeta {
    fn from(raw: DocMetaRaw) -> Self {
        let kind = raw.kind.unwrap_or(if raw.meeting.is_some() {
            DocKind::Meeting
        } else {
            DocKind::Note
        });
        DocMeta {
            id: raw.id,
            kind,
            title: raw.title,
            title_is_auto: raw.title_is_auto,
            created_at: raw.created_at,
            updated_at: raw.updated_at.unwrap_or(raw.created_at),
            folder_id: raw.folder_id,
            tags: raw.tags,
            template_id: raw.template_id,
            pinned: raw.pinned,
            trashed_at: raw.trashed_at,
            meeting: raw.meeting,
            extra: raw.extra,
        }
    }
}

impl DocMeta {
    pub fn new(id: String, kind: DocKind, now: DateTime<Utc>) -> Self {
        let meeting = (kind == DocKind::Meeting).then(MeetingDetails::default);
        Self {
            id,
            kind,
            title: String::new(),
            title_is_auto: true,
            created_at: now,
            updated_at: now,
            folder_id: None,
            tags: Vec::new(),
            template_id: None,
            pinned: false,
            trashed_at: None,
            meeting,
            extra: BTreeMap::new(),
        }
    }

    pub fn sort_time(&self) -> DateTime<Utc> {
        self.meeting
            .as_ref()
            .and_then(|m| m.started_at)
            .unwrap_or(self.created_at)
    }

    pub fn is_trashed(&self) -> bool {
        self.trashed_at.is_some()
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Folder {
    pub id: String,
    pub name: String,
    pub parent_id: Option<String>,
    pub pinned: bool,
    pub created_at: DateTime<Utc>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct FoldersFile {
    folders: Vec<Folder>,
    #[serde(flatten)]
    extra: BTreeMap<String, Value>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum TrashFilter {
    #[default]
    Exclude,
    Only,
    Include,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ListFilter {
    pub kind: Option<DocKind>,
    pub trash: TrashFilter,
    pub folder_id: Option<String>,
}

impl ListFilter {
    fn matches(&self, meta: &DocMeta) -> bool {
        let kind = self.kind.as_ref().is_none_or(|k| *k == meta.kind);
        let trash = match self.trash {
            TrashFilter::Exclude => !meta.is_trashed(),
            TrashFilter::Only => meta.is_trashed(),
            TrashFilter::Include => true,
        };
        let folder = self
            .folder_id
            .as_ref()
            .is_none_or(|f| meta.folder_id.as_ref() == Some(f));
        kind && trash && folder
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BrokenEntry {
    pub name: String,
    pub error: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Listing {
    pub docs: Vec<DocMeta>,
    pub broken: Vec<BrokenEntry>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DayGroup {
    pub date: NaiveDate,
    pub ids: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SearchOptions {
    pub kind: Option<DocKind>,
    pub include_trashed: bool,
    pub limit: usize,
}

impl Default for SearchOptions {
    fn default() -> Self {
        Self {
            kind: None,
            include_trashed: false,
            limit: 50,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SearchField {
    Title,
    Notes,
    Transcript,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SearchHit {
    pub id: String,
    pub kind: DocKind,
    pub title: String,
    pub field: SearchField,
    pub snippet: String,
    pub score: u32,
    pub sort_time: DateTime<Utc>,
}

#[derive(Clone, Debug, Default)]
pub struct TitleHint<'a> {
    pub event_title: Option<&'a str>,
    pub notes_markdown: Option<&'a str>,
    pub app_name: Option<&'a str>,
    pub local_start: Option<NaiveDateTime>,
}

#[derive(Debug, Clone)]
pub struct Library {
    root: PathBuf,
}

static META_LOCK: Mutex<()> = Mutex::new(());

/// Held from loading a note's meta.json to saving it again, by every
/// read-modify-write in the app (the documents writer, the meetings engine,
/// this file), so one writer never undoes another's change. Not reentrant:
/// never call a [`Library`] method that saves while holding it.
pub fn lock_meta() -> MutexGuard<'static, ()> {
    META_LOCK.lock().unwrap_or_else(PoisonError::into_inner)
}

impl Library {
    pub fn open(root: impl Into<PathBuf>) -> Result<Self> {
        let root = root.into();
        fs::create_dir_all(&root)?;
        // Transcripts, titles and attendees live below: owner-only, like the
        // audio, wherever the home folder's own mode would let others read.
        // Best effort, since some file systems keep no modes.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&root, fs::Permissions::from_mode(0o700));
        }
        Ok(Self { root })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn doc_dir(&self, id: &str) -> Result<PathBuf> {
        if !is_valid_id(id) {
            return Err(LibraryError::InvalidId(id.to_string()));
        }
        join_name(&self.root, id)
    }

    pub fn transcript_path(&self, id: &str) -> Result<PathBuf> {
        Ok(self.doc_dir(id)?.join(TRANSCRIPT_FILE))
    }

    pub fn audio_dir(&self, id: &str) -> Result<PathBuf> {
        Ok(self.doc_dir(id)?.join(AUDIO_DIR))
    }

    pub fn attachments_dir(&self, id: &str) -> Result<PathBuf> {
        Ok(self.doc_dir(id)?.join(ATTACHMENTS_DIR))
    }

    pub fn audio_file_path(&self, id: &str, file: &str) -> Result<PathBuf> {
        let name = file
            .strip_prefix(AUDIO_DIR)
            .and_then(|rest| rest.strip_prefix(['/', '\\']))
            .unwrap_or(file);
        join_name(&self.audio_dir(id)?, name)
    }

    pub fn create(&self, kind: DocKind, now: DateTime<Utc>, entropy: u64) -> Result<DocMeta> {
        for attempt in 0..32u64 {
            let id = new_id(now, entropy.wrapping_add(attempt.wrapping_mul(0x9e37_79b9)));
            let dir = self.doc_dir(&id)?;
            match fs::create_dir(&dir) {
                Ok(()) => {
                    let meta = DocMeta::new(id, kind, now);
                    self.save(&meta)?;
                    return Ok(meta);
                }
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(e) => return Err(e.into()),
            }
        }
        Err(LibraryError::Limit("could not allocate a unique id".into()))
    }

    pub fn load(&self, id: &str) -> Result<DocMeta> {
        let path = self.doc_dir(id)?.join(DOC_FILE);
        let bytes = match fs::read(&path) {
            Ok(bytes) => bytes,
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                return Err(LibraryError::NotFound(id.to_string()));
            }
            Err(e) => return Err(e.into()),
        };
        let mut meta: DocMeta = serde_json::from_slice(&bytes)?;
        meta.id = id.to_string();
        Ok(meta)
    }

    pub fn save(&self, meta: &DocMeta) -> Result<()> {
        let dir = self.doc_dir(&meta.id)?;
        fs::create_dir_all(&dir)?;
        let path = dir.join(DOC_FILE);
        let bytes = if meta.extra.contains_key(DAMAGED_KEY) {
            // The first save of a recovered doc keeps the unreadable details
            // next to it, once, so nothing that was on disk is lost.
            let kept = dir.join(DAMAGED_DOC_FILE);
            if path.exists() && !kept.exists() {
                fs::copy(&path, &kept)?;
            }
            let mut clean = meta.clone();
            clean.extra.remove(DAMAGED_KEY);
            serde_json::to_vec_pretty(&clean)?
        } else {
            serde_json::to_vec_pretty(meta)?
        };
        atomic_write(&path, &bytes)?;
        Ok(())
    }

    /// The doc's saved details or, when its doc.json can't be read as one (cut
    /// short, empty, overwritten), the details its folder still shows: when it
    /// was made, its audio and whether it has a transcript. Such a doc carries
    /// [`DAMAGED_KEY`] so it can be shown and opened instead of vanishing.
    pub fn load_or_recover(&self, id: &str) -> Result<DocMeta> {
        match self.load(id) {
            Err(LibraryError::Json(_)) => self.recover(id),
            other => other,
        }
    }

    fn recover(&self, id: &str) -> Result<DocMeta> {
        let dir = self.doc_dir(id)?;
        let created_at = created_at_from_id(id)
            .or_else(|| {
                fs::metadata(dir.join(DOC_FILE))
                    .and_then(|m| m.modified())
                    .ok()
                    .map(DateTime::<Utc>::from)
            })
            .unwrap_or_default();
        let audio = recovered_audio(&dir.join(AUDIO_DIR));
        let transcript_chars = fs::metadata(dir.join(TRANSCRIPT_FILE)).map_or(0, |m| m.len());
        let kind = if transcript_chars > 0 || !audio.is_empty() {
            DocKind::Meeting
        } else {
            DocKind::Note
        };
        let mut meta = DocMeta::new(id.to_string(), kind, created_at);
        if let Some(meeting) = meta.meeting.as_mut() {
            meeting.started_at = Some(created_at);
            meeting.transcript_chars = transcript_chars;
            meeting.audio = audio;
        }
        meta.extra.insert(DAMAGED_KEY.into(), Value::Bool(true));
        Ok(meta)
    }

    pub fn list(&self, filter: &ListFilter) -> Result<Listing> {
        let mut listing = Listing::default();
        for name in self.doc_names()? {
            match self.load(&name) {
                Ok(meta) => {
                    if filter.matches(&meta) {
                        listing.docs.push(meta);
                    }
                }
                Err(e) => listing.broken.push(BrokenEntry {
                    name,
                    error: e.to_string(),
                }),
            }
        }
        listing
            .docs
            .sort_by(|a, b| b.sort_time().cmp(&a.sort_time()).then(b.id.cmp(&a.id)));
        Ok(listing)
    }

    pub fn trash(&self, id: &str, now: DateTime<Utc>) -> Result<DocMeta> {
        let _lock = lock_meta();
        let mut meta = self.load(id)?;
        if meta.trashed_at.is_none() {
            meta.trashed_at = Some(now);
            self.save(&meta)?;
        }
        Ok(meta)
    }

    pub fn restore(&self, id: &str) -> Result<DocMeta> {
        let _lock = lock_meta();
        let mut meta = self.load(id)?;
        if meta.trashed_at.take().is_some() {
            self.save(&meta)?;
        }
        Ok(meta)
    }

    pub fn delete_permanently(&self, id: &str) -> Result<()> {
        let dir = self.doc_dir(id)?;
        match fs::remove_dir_all(&dir) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.into()),
        }
    }

    /// Deletes items trashed at least [`TRASH_RETENTION_DAYS`] ago, except
    /// any `keep` names.
    pub fn purge_trash(
        &self,
        now: DateTime<Utc>,
        keep: impl Fn(&DocMeta) -> bool,
    ) -> Result<Cleaned> {
        self.purge_trash_claimed(now, |meta| (!keep(meta)).then_some(()))
    }

    /// [`Library::purge_trash`], where `claim` returns None to keep an item,
    /// or a value held until that item is gone.
    pub fn purge_trash_claimed<G>(
        &self,
        now: DateTime<Utc>,
        claim: impl Fn(&DocMeta) -> Option<G>,
    ) -> Result<Cleaned> {
        let listing = self.list(&ListFilter {
            trash: TrashFilter::Only,
            ..ListFilter::default()
        })?;
        let mut purged = Cleaned::default();
        for meta in listing.docs {
            let Some(_claim) = claim(&meta) else {
                continue;
            };
            let expired = meta
                .trashed_at
                .is_some_and(|t| (now - t).num_days() >= TRASH_RETENTION_DAYS);
            if expired {
                match self.delete_permanently(&meta.id) {
                    Ok(()) => purged.done.push(meta.id),
                    Err(error) => purged.failed.push((meta.id, error.to_string())),
                }
            }
        }
        Ok(purged)
    }

    pub fn read_notes(&self, id: &str) -> Result<Option<String>> {
        self.read_payload(id, NOTES_FILE)
    }

    pub fn write_notes(&self, id: &str, json: &str) -> Result<()> {
        self.write_payload(id, NOTES_FILE, json)
    }

    pub fn read_enhanced(&self, id: &str) -> Result<Option<String>> {
        self.read_payload(id, ENHANCED_FILE)
    }

    pub fn write_enhanced(&self, id: &str, json: &str) -> Result<()> {
        let meta = self.load(id)?;
        if meta.kind != DocKind::Meeting {
            return Err(LibraryError::NotAllowed(
                "enhanced notes only exist for meetings".into(),
            ));
        }
        self.write_payload(id, ENHANCED_FILE, json)
    }

    pub fn add_attachment(&self, id: &str, file_name: &str, bytes: &[u8]) -> Result<String> {
        let dir = self.doc_dir(id)?;
        if !dir.join(DOC_FILE).exists() {
            return Err(LibraryError::NotFound(id.to_string()));
        }
        let (stem, ext) = sanitise_file_name(file_name)
            .ok_or_else(|| LibraryError::NotAllowed(format!("unsupported file: {file_name}")))?;
        if bytes.len() > MAX_ATTACHMENT_BYTES {
            return Err(LibraryError::Limit("attachment too large".into()));
        }
        if self.list_attachments(id)?.len() >= MAX_ATTACHMENTS {
            return Err(LibraryError::Limit("too many attachments".into()));
        }
        let attachments = dir.join(ATTACHMENTS_DIR);
        fs::create_dir_all(&attachments)?;
        let mut name = format!("{stem}.{ext}");
        let mut n = 1u32;
        while join_name(&attachments, &name)?.exists() {
            name = format!("{stem}-{n}.{ext}");
            n = n.saturating_add(1);
        }
        atomic_write(&join_name(&attachments, &name)?, bytes)?;
        Ok(name)
    }

    pub fn list_attachments(&self, id: &str) -> Result<Vec<String>> {
        let dir = self.attachments_dir(id)?;
        let entries = match fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(e.into()),
        };
        let mut names: Vec<String> = entries
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().is_ok_and(|t| t.is_file()))
            .filter_map(|e| e.file_name().into_string().ok())
            .filter(|n| !n.starts_with('.'))
            .collect();
        names.sort();
        Ok(names)
    }

    pub fn attachment_path(&self, id: &str, name: &str) -> Result<PathBuf> {
        join_name(&self.attachments_dir(id)?, name)
    }

    pub fn remove_attachment(&self, id: &str, name: &str) -> Result<bool> {
        match fs::remove_file(self.attachment_path(id, name)?) {
            Ok(()) => Ok(true),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(false),
            Err(e) => Err(e.into()),
        }
    }

    /// Deletes the audio of meetings that ended at least `retention_days`
    /// ago. A meeting that never ended may still be recording or waiting to
    /// be recovered, so its audio is kept, as is any meeting `keep` names.
    pub fn sweep_audio(
        &self,
        now: DateTime<Utc>,
        retention_days: u32,
        keep: impl Fn(&DocMeta) -> bool,
    ) -> Result<Cleaned> {
        self.sweep_audio_claimed(now, retention_days, |meta| (!keep(meta)).then_some(()))
    }

    /// [`Library::sweep_audio`], where `claim` returns None to keep a
    /// meeting's audio, or a value held until its audio is gone and saved.
    pub fn sweep_audio_claimed<G>(
        &self,
        now: DateTime<Utc>,
        retention_days: u32,
        claim: impl Fn(&DocMeta) -> Option<G>,
    ) -> Result<Cleaned> {
        let listing = self.list(&ListFilter {
            kind: Some(DocKind::Meeting),
            trash: TrashFilter::Include,
            folder_id: None,
        })?;
        let mut swept = Cleaned::default();
        for meta in listing.docs {
            let Some(_claim) = claim(&meta) else {
                continue;
            };
            let Some(meeting) = meta.meeting.as_ref() else {
                continue;
            };
            let Some(ended_at) = meeting.ended_at else {
                continue;
            };
            if (now - ended_at).num_days() < i64::from(retention_days) {
                continue;
            }
            let audio_dir = match self.audio_dir(&meta.id) {
                Ok(dir) => dir,
                Err(error) => {
                    swept.failed.push((meta.id, error.to_string()));
                    continue;
                }
            };
            let had_dir = audio_dir.exists();
            if !had_dir && meeting.audio.is_empty() {
                continue;
            }
            if had_dir && let Err(error) = fs::remove_dir_all(&audio_dir) {
                swept.failed.push((meta.id, error.to_string()));
                continue;
            }
            let _lock = lock_meta();
            let saved = self.load(&meta.id).and_then(|mut meta| {
                if let Some(meeting) = meta.meeting.as_mut() {
                    meeting.audio.clear();
                }
                self.save(&meta)
            });
            match saved {
                Ok(()) => swept.done.push(meta.id),
                Err(error) => swept.failed.push((meta.id, error.to_string())),
            }
        }
        Ok(swept)
    }

    pub fn folders(&self) -> Result<Vec<Folder>> {
        Ok(self.read_folders()?.folders)
    }

    pub fn create_folder(
        &self,
        name: &str,
        parent_id: Option<&str>,
        now: DateTime<Utc>,
        entropy: u64,
    ) -> Result<Folder> {
        let mut file = self.read_folders()?;
        if let Some(parent) = parent_id
            && !file.folders.iter().any(|f| f.id == parent)
        {
            return Err(LibraryError::NotFound(parent.to_string()));
        }
        let mut id = format!("f-{}", new_id(now, entropy));
        let mut bump = 1u64;
        while file.folders.iter().any(|f| f.id == id) {
            id = format!("f-{}", new_id(now, entropy.wrapping_add(bump)));
            bump += 1;
        }
        let folder = Folder {
            id,
            name: clean_name(name),
            parent_id: parent_id.map(str::to_string),
            pinned: false,
            created_at: now,
            extra: BTreeMap::new(),
        };
        file.folders.push(folder.clone());
        self.write_folders(&file)?;
        Ok(folder)
    }

    pub fn rename_folder(&self, id: &str, name: &str) -> Result<Folder> {
        self.update_folder(id, |f| f.name = clean_name(name))
    }

    pub fn set_folder_pinned(&self, id: &str, pinned: bool) -> Result<Folder> {
        self.update_folder(id, |f| f.pinned = pinned)
    }

    pub fn move_folder(&self, id: &str, parent_id: Option<&str>) -> Result<Folder> {
        let file = self.read_folders()?;
        if let Some(parent) = parent_id {
            let mut cursor = Some(parent.to_string());
            let mut steps = 0;
            while let Some(current) = cursor {
                if current == id {
                    return Err(LibraryError::NotAllowed("folder cycle".into()));
                }
                let folder = file
                    .folders
                    .iter()
                    .find(|f| f.id == current)
                    .ok_or_else(|| LibraryError::NotFound(current.clone()))?;
                cursor = folder.parent_id.clone();
                steps += 1;
                if steps > file.folders.len() {
                    return Err(LibraryError::NotAllowed("folder cycle".into()));
                }
            }
        }
        self.update_folder(id, |f| f.parent_id = parent_id.map(str::to_string))
    }

    pub fn delete_folder(&self, id: &str) -> Result<Vec<String>> {
        let mut file = self.read_folders()?;
        let index = file
            .folders
            .iter()
            .position(|f| f.id == id)
            .ok_or_else(|| LibraryError::NotFound(id.to_string()))?;
        let removed = file.folders.remove(index);
        for folder in &mut file.folders {
            if folder.parent_id.as_deref() == Some(id) {
                folder.parent_id.clone_from(&removed.parent_id);
            }
        }
        let mut moved = Vec::new();
        let listing = self.list(&ListFilter {
            trash: TrashFilter::Include,
            folder_id: Some(id.to_string()),
            ..ListFilter::default()
        })?;
        for listed in listing.docs {
            let _lock = lock_meta();
            let mut meta = match self.load(&listed.id) {
                Ok(meta) if meta.folder_id.as_deref() == Some(id) => meta,
                Ok(_) | Err(LibraryError::NotFound(_)) => continue,
                Err(error) => return Err(error),
            };
            meta.folder_id.clone_from(&removed.parent_id);
            self.save(&meta)?;
            moved.push(meta.id);
        }
        self.write_folders(&file)?;
        Ok(moved)
    }

    pub fn move_doc(&self, id: &str, folder_id: Option<&str>) -> Result<DocMeta> {
        if let Some(folder) = folder_id
            && !self.folders()?.iter().any(|f| f.id == folder)
        {
            return Err(LibraryError::NotFound(folder.to_string()));
        }
        let _lock = lock_meta();
        let mut meta = self.load(id)?;
        meta.folder_id = folder_id.map(str::to_string);
        self.save(&meta)?;
        Ok(meta)
    }

    pub fn search(&self, query: &str, options: &SearchOptions) -> Result<Vec<SearchHit>> {
        let needle = fold_query(query);
        if needle.is_empty() || options.limit == 0 {
            return Ok(Vec::new());
        }
        let listing = self.list(&ListFilter {
            kind: options.kind.clone(),
            trash: if options.include_trashed {
                TrashFilter::Include
            } else {
                TrashFilter::Exclude
            },
            folder_id: None,
        })?;
        let mut kept: BinaryHeap<Reverse<Ranked>> = BinaryHeap::new();
        for meta in listing.docs {
            let floor = (kept.len() >= options.limit)
                .then(|| kept.peek().map(|worst| worst.0.0.score))
                .flatten();
            if floor.is_some_and(|floor| floor >= BEST_SCORE) {
                break;
            }
            if let Some(hit) = self.search_doc(&meta, &needle, floor) {
                kept.push(Reverse(Ranked(hit)));
                if kept.len() > options.limit {
                    kept.pop();
                }
            }
        }
        let mut hits: Vec<SearchHit> = kept.into_iter().map(|r| r.0.0).collect();
        hits.sort_by(|a, b| rank(b, a));
        Ok(hits)
    }

    fn search_doc(&self, meta: &DocMeta, needle: &[char], floor: Option<u32>) -> Option<SearchHit> {
        // Documents arrive newest first, so a hit that only ties the worst kept score loses on
        // recency and fields that cannot beat the floor are never read.
        let wanted = |score: u32| floor.is_none_or(|floor| score > floor);
        let hit = |field, score, text: &str, (start, end): (usize, usize)| SearchHit {
            id: meta.id.clone(),
            kind: meta.kind.clone(),
            title: meta.title.clone(),
            field,
            snippet: snippet(text, start, end, 40),
            score,
            sort_time: meta.sort_time(),
        };
        if wanted(TITLE_SCORE)
            && let Some(range) = find_ci(&meta.title, needle)
        {
            let score = if range.0 == 0 {
                BEST_SCORE
            } else {
                TITLE_SCORE
            };
            if wanted(score) {
                return Some(hit(SearchField::Title, score, &meta.title, range));
            }
        }
        if wanted(TAG_SCORE) {
            for tag in &meta.tags {
                if let Some(range) = find_ci(tag, needle) {
                    return Some(hit(SearchField::Title, TAG_SCORE, tag, range));
                }
            }
        }
        if wanted(NOTES_SCORE)
            && let Ok(Some(notes)) = self.read_notes(&meta.id)
        {
            let text = notes_text(&notes);
            if let Some(range) = find_ci(&text, needle) {
                return Some(hit(SearchField::Notes, NOTES_SCORE, &text, range));
            }
        }
        if wanted(TRANSCRIPT_SCORE) && meta.kind == DocKind::Meeting {
            let path = self.transcript_path(&meta.id).ok()?;
            let file = File::open(path).ok()?;
            for chunk in BufReader::new(file).split(b'\n') {
                let Ok(chunk) = chunk else {
                    break;
                };
                let Ok(value) = serde_json::from_slice::<Value>(&chunk) else {
                    continue;
                };
                let text = value
                    .pointer("/utterance/text")
                    .or_else(|| value.get("text"))
                    .and_then(Value::as_str)
                    .unwrap_or("");
                if let Some(range) = find_ci(text, needle) {
                    return Some(hit(SearchField::Transcript, TRANSCRIPT_SCORE, text, range));
                }
            }
        }
        None
    }

    fn doc_names(&self) -> Result<Vec<String>> {
        let mut names: Vec<String> = fs::read_dir(&self.root)?
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
            .filter_map(|e| e.file_name().into_string().ok())
            .filter(|n| is_valid_id(n))
            .collect();
        names.sort();
        Ok(names)
    }

    fn read_payload(&self, id: &str, file: &str) -> Result<Option<String>> {
        match fs::read_to_string(self.doc_dir(id)?.join(file)) {
            Ok(text) => Ok(Some(text)),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    fn write_payload(&self, id: &str, file: &str, json: &str) -> Result<()> {
        serde_json::from_str::<serde::de::IgnoredAny>(json)?;
        let dir = self.doc_dir(id)?;
        if !dir.join(DOC_FILE).exists() {
            return Err(LibraryError::NotFound(id.to_string()));
        }
        atomic_write(&dir.join(file), json.as_bytes())?;
        Ok(())
    }

    fn read_folders(&self) -> Result<FoldersFile> {
        match fs::read(self.root.join(FOLDERS_FILE)) {
            Ok(bytes) => Ok(serde_json::from_slice(&bytes)?),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(FoldersFile::default()),
            Err(e) => Err(e.into()),
        }
    }

    fn write_folders(&self, file: &FoldersFile) -> Result<()> {
        let bytes = serde_json::to_vec_pretty(file)?;
        atomic_write(&self.root.join(FOLDERS_FILE), &bytes)?;
        Ok(())
    }

    fn update_folder(&self, id: &str, change: impl FnOnce(&mut Folder)) -> Result<Folder> {
        let mut file = self.read_folders()?;
        let folder = file
            .folders
            .iter_mut()
            .find(|f| f.id == id)
            .ok_or_else(|| LibraryError::NotFound(id.to_string()))?;
        change(folder);
        let folder = folder.clone();
        self.write_folders(&file)?;
        Ok(folder)
    }
}

const BEST_SCORE: u32 = 400;
const TITLE_SCORE: u32 = 300;
const TAG_SCORE: u32 = 250;
const NOTES_SCORE: u32 = 200;
const TRANSCRIPT_SCORE: u32 = 100;

fn rank(a: &SearchHit, b: &SearchHit) -> CmpOrdering {
    a.score
        .cmp(&b.score)
        .then(a.sort_time.cmp(&b.sort_time))
        .then(a.id.cmp(&b.id))
}

struct Ranked(SearchHit);

impl PartialEq for Ranked {
    fn eq(&self, other: &Self) -> bool {
        rank(&self.0, &other.0) == CmpOrdering::Equal
    }
}

impl Eq for Ranked {}

impl PartialOrd for Ranked {
    fn partial_cmp(&self, other: &Self) -> Option<CmpOrdering> {
        Some(self.cmp(other))
    }
}

impl Ord for Ranked {
    fn cmp(&self, other: &Self) -> CmpOrdering {
        rank(&self.0, &other.0)
    }
}

const ID_ALPHABET: &[u8; 32] = b"0123456789abcdefghjkmnpqrstvwxyz";

pub fn new_id(now: DateTime<Utc>, entropy: u64) -> String {
    let suffix: String = (0..6)
        .map(|i| ID_ALPHABET[((entropy >> (i * 5)) & 31) as usize] as char)
        .collect();
    format!("{}-{suffix}", now.format("%Y%m%dT%H%M%S%3fZ"))
}

/// When a doc was made, from its id ("20261118T215402519Z-0y136b").
fn created_at_from_id(id: &str) -> Option<DateTime<Utc>> {
    let stamp = id.get(..18)?;
    let at = NaiveDateTime::parse_from_str(stamp.get(..15)?, "%Y%m%dT%H%M%S").ok()?;
    let millis: i64 = stamp.get(15..18)?.parse().ok()?;
    (id.as_bytes().get(18) == Some(&b'Z'))
        .then(|| at.and_utc() + chrono::Duration::milliseconds(millis))
}

/// The meeting audio files in `dir`, as the app names them (system audio
/// files start with "others", the microphone's with "you").
fn recovered_audio(dir: &Path) -> Vec<AudioTrack> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut names: Vec<String> = entries
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_ok_and(|t| t.is_file()))
        .filter_map(|e| e.file_name().into_string().ok())
        .filter(|n| n.ends_with(".ogg") && !n.starts_with('.'))
        .collect();
    names.sort();
    names
        .into_iter()
        .map(|name| AudioTrack {
            source: if name.starts_with("others") {
                Source::System
            } else {
                Source::Mic
            },
            file: format!("{AUDIO_DIR}/{name}"),
            codec: "opus".into(),
            duration_ms: 0,
        })
        .collect()
}

pub fn is_valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 80
        && !id.starts_with('.')
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        && !is_reserved_device_name(id)
}

pub fn group_by_day(docs: &[DocMeta], tz_offset_minutes: i32) -> Vec<DayGroup> {
    let seconds = tz_offset_minutes.clamp(-14 * 60, 14 * 60) * 60;
    let offset = FixedOffset::east_opt(seconds).unwrap_or_else(|| Utc.fix());
    group_by_local_day(docs, |at| at.with_timezone(&offset).date_naive())
}

/// Docs newest first, grouped by the day `day_of` puts each one on. Each doc
/// gets its own day, so a zone's daylight saving rules apply to every date
/// (a July meeting just after midnight stays on its own day in November).
pub fn group_by_local_day(
    docs: &[DocMeta],
    day_of: impl Fn(DateTime<Utc>) -> NaiveDate,
) -> Vec<DayGroup> {
    let mut sorted: Vec<&DocMeta> = docs.iter().collect();
    sorted.sort_by(|a, b| b.sort_time().cmp(&a.sort_time()).then(b.id.cmp(&a.id)));
    let mut groups: Vec<DayGroup> = Vec::new();
    for doc in sorted {
        let date = day_of(doc.sort_time());
        match groups.last_mut() {
            Some(group) if group.date == date => group.ids.push(doc.id.clone()),
            _ => groups.push(DayGroup {
                date,
                ids: vec![doc.id.clone()],
            }),
        }
    }
    groups
}

pub fn first_markdown_heading(markdown: &str) -> Option<String> {
    markdown.lines().find_map(|line| {
        let line = line.trim();
        let hashes = line.bytes().take_while(|b| *b == b'#').count();
        if !(1..=6).contains(&hashes) {
            return None;
        }
        let rest = &line[hashes..];
        if !rest.starts_with(' ') {
            return None;
        }
        let text = rest.trim().trim_end_matches('#').trim();
        (!text.is_empty()).then(|| text.to_string())
    })
}

pub fn auto_title_from(hint: &TitleHint<'_>) -> String {
    let clean = |s: Option<&str>| {
        s.map(|s| s.split_whitespace().collect::<Vec<_>>().join(" "))
            .filter(|s| !s.is_empty())
            .map(|s| s.chars().take(120).collect::<String>())
    };
    if let Some(title) = clean(hint.event_title) {
        return title;
    }
    if let Some(title) = clean(
        hint.notes_markdown
            .and_then(first_markdown_heading)
            .as_deref(),
    ) {
        return title;
    }
    let time = hint.local_start.map(|t| t.format("%H:%M").to_string());
    match (clean(hint.app_name), time) {
        (Some(app), Some(time)) => format!("{app} at {time}"),
        (Some(app), None) => app,
        (None, Some(time)) => format!("Meeting at {time}"),
        (None, None) => "Untitled".to_string(),
    }
}

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

pub(crate) fn atomic_write(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let dir = path
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "path has no parent"))?;
    let name = path
        .file_name()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "path has no file name"))?
        .to_string_lossy()
        .into_owned();
    let tmp = dir.join(format!(
        ".{name}.{}.{}.tmp",
        std::process::id(),
        TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    let written = (|| {
        let mut file = File::create(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        fs::rename(&tmp, path)
    })();
    if let Err(e) = written {
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }
    sync_dir(dir);
    Ok(())
}

#[cfg(unix)]
fn sync_dir(dir: &Path) {
    if let Ok(handle) = File::open(dir) {
        let _ = handle.sync_all();
    }
}

#[cfg(not(unix))]
fn sync_dir(_dir: &Path) {}

fn clean_name(name: &str) -> String {
    let name: String = name
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(200)
        .collect();
    if name.is_empty() {
        "Untitled".to_string()
    } else {
        name
    }
}

fn join_name(base: &Path, name: &str) -> Result<PathBuf> {
    if !is_plain_file_name(name) {
        return Err(LibraryError::InvalidId(name.to_string()));
    }
    Ok(base.join(name))
}

const WINDOWS_INVALID: [char; 9] = ['<', '>', ':', '"', '/', '\\', '|', '?', '*'];

fn is_plain_file_name(name: &str) -> bool {
    let mut components = Path::new(name).components();
    let single = matches!(
        (components.next(), components.next()),
        (Some(Component::Normal(part)), None) if part == name
    );
    single
        && name.len() <= 255
        && !name.starts_with('.')
        && !name.ends_with(['.', ' '])
        && !name
            .chars()
            .any(|c| c.is_control() || WINDOWS_INVALID.contains(&c))
        && !is_reserved_device_name(name)
}

fn is_reserved_device_name(name: &str) -> bool {
    let stem = name
        .split('.')
        .next()
        .unwrap_or(name)
        .trim_end_matches(' ')
        .to_ascii_uppercase();
    match stem.as_str() {
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$" => true,
        _ => {
            let mut chars = stem.chars();
            let prefix: String = chars.by_ref().take(3).collect();
            let rest: Vec<char> = chars.collect();
            (prefix == "COM" || prefix == "LPT")
                && rest.len() == 1
                && (rest[0].is_ascii_digit() || matches!(rest[0], '\u{b9}' | '\u{b2}' | '\u{b3}'))
        }
    }
}

fn sanitise_file_name(file_name: &str) -> Option<(String, String)> {
    let base = file_name
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(file_name)
        .trim();
    let (stem, ext) = base.rsplit_once('.')?;
    let ext = ext.to_ascii_lowercase();
    if !IMAGE_EXTENSIONS.contains(&ext.as_str()) {
        return None;
    }
    let stem: String = stem
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' || c == ' ' {
                c
            } else {
                '_'
            }
        })
        .take(100)
        .collect();
    let stem = stem.trim().trim_start_matches('_');
    let stem = if stem.is_empty() { "image" } else { stem };
    if is_reserved_device_name(stem) {
        return Some((format!("{stem}_"), ext));
    }
    Some((stem.to_string(), ext))
}

fn notes_text(json: &str) -> String {
    let Ok(value) = serde_json::from_str::<Value>(json) else {
        return String::new();
    };
    let mut parts = Vec::new();
    collect_text(&value, &mut parts, 0);
    parts.join(" ")
}

fn collect_text<'a>(value: &'a Value, out: &mut Vec<&'a str>, depth: usize) {
    if depth > 64 {
        return;
    }
    match value {
        Value::String(s) if depth == 0 => out.push(s),
        Value::Array(items) => items.iter().for_each(|v| collect_text(v, out, depth + 1)),
        Value::Object(map) => {
            for (key, v) in map {
                match v {
                    Value::String(s)
                        if ["text", "markdown", "md", "content", "title", "plain"]
                            .contains(&key.as_str()) =>
                    {
                        out.push(s)
                    }
                    _ => collect_text(v, out, depth + 1),
                }
            }
        }
        _ => {}
    }
}
