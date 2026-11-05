use serde_json::{Map, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum WalkStatus {
    Recording,
    Saved,
    Processing,
    Ready,
    Failed(String),
    OwnerUnknown(String),
    Interrupted,
}

impl WalkStatus {
    pub fn label(&self) -> &'static str {
        match self {
            Self::Recording => "Recording",
            Self::Saved => "Notes saved",
            Self::Processing => "Processing",
            Self::Ready => "Ready",
            Self::Failed(_) => "Processing needs attention",
            Self::OwnerUnknown(_) => "Processing status unknown",
            Self::Interrupted => "Interrupted · notes saved",
        }
    }

    pub fn notice(&self) -> String {
        match self {
            Self::Recording => "Recording and notes are being saved.".into(),
            Self::Saved => {
                "Recording and notes are saved. A processed report is not available yet.".into()
            }
            Self::Processing => {
                "Preparing chapters, screenshots and transcript… Your notes are available below."
                    .into()
            }
            Self::Ready => "Walk ready. Read the report or copy a prompt for your agent.".into(),
            Self::Failed(error) => {
                format!("Recording and notes are saved. Processing needs attention: {error}")
            }
            Self::OwnerUnknown(error) => format!("Recording and notes are saved. {error}"),
            Self::Interrupted => {
                "This walk was interrupted. Its saved notes remain available.".into()
            }
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WalkSummary {
    pub file: PathBuf,
    pub directory: PathBuf,
    pub source_project: PathBuf,
    pub topic: String,
    pub started_at_ms: u64,
    pub status: WalkStatus,
}

#[derive(Default)]
pub struct WalkSelection {
    pub file: Option<PathBuf>,
    revision: u64,
}

impl WalkSelection {
    pub fn choose(&mut self, file: Option<PathBuf>) -> u64 {
        self.revision = self.revision.wrapping_add(1);
        self.file = file;
        self.revision
    }

    pub fn accepts(&self, file: &Path, revision: u64) -> bool {
        self.revision == revision && self.file.as_deref() == Some(file)
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum NotesSource {
    Current,
    Saved(PathBuf),
}

pub fn notes_source(current_walk_present: bool, last_journal: Option<&str>) -> NotesSource {
    if !current_walk_present && let Some(file) = last_journal.filter(|file| !file.trim().is_empty())
    {
        return NotesSource::Saved(PathBuf::from(file));
    }
    NotesSource::Current
}

impl WalkSummary {
    pub fn report_ready(&self) -> bool {
        self.status == WalkStatus::Ready
    }

    pub fn is_active(&self) -> bool {
        matches!(
            self.status,
            WalkStatus::Recording | WalkStatus::Processing | WalkStatus::OwnerUnknown(_)
        )
    }
}

fn expanded_path(text: &str) -> PathBuf {
    if text == "~" || text.starts_with("~/") {
        let home = std::env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_default();
        return text
            .strip_prefix("~/")
            .map_or(home.clone(), |tail| home.join(tail));
    }
    PathBuf::from(text)
}

pub fn read_walk(file: &Path) -> Result<(WalkSummary, crate::ux_walk_journal::Journal), String> {
    let file = file
        .canonicalize()
        .map_err(|_| "This walk’s notes could not be found.")?;
    if file
        .file_name()
        .is_none_or(|name| name != "native-walk.json")
    {
        return Err("This is not a native walk journal.".into());
    }
    let journal: crate::ux_walk_journal::Journal =
        serde_json::from_slice(&fs::read(&file).map_err(|e| e.to_string())?)
            .map_err(|_| "This walk’s notes have an invalid format.")?;
    if journal.schema_version != 1 {
        return Err("This walk’s notes use an unsupported format.".into());
    }
    let directory = file.parent().ok_or("Invalid walk folder.")?.to_path_buf();
    if journal.request.directory.canonicalize().ok().as_ref() != Some(&directory) {
        return Err("This walk’s notes belong to another folder.".into());
    }
    if !journal.source_project.is_absolute() || journal.request.topic.trim().is_empty() {
        return Err("This walk’s source recording or topic is missing.".into());
    }
    let status = match journal.state.as_str() {
        "recording" => WalkStatus::Recording,
        "aborted" => WalkStatus::Interrupted,
        "complete" => processing_status(&directory),
        _ => return Err("Invalid walk state.".into()),
    };
    let summary = WalkSummary {
        file,
        directory,
        source_project: journal.source_project.clone(),
        topic: journal.request.topic.clone(),
        started_at_ms: journal.started_at_ms,
        status,
    };
    Ok((summary, journal))
}

pub fn read_summary(file: &Path) -> Result<WalkSummary, String> {
    read_walk(file).map(|(summary, _)| summary)
}

pub fn view_events(
    summary: &WalkSummary,
    journal: &crate::ux_walk_journal::Journal,
) -> Vec<crate::ux_walk_journal::Event> {
    let original = journal.events.clone();
    if !summary.report_ready() {
        return original;
    }
    let derived = (|| {
        let artifact: Value =
            serde_json::from_slice(&fs::read(summary.directory.join("walk-notes.json")).ok()?)
                .ok()?;
        if artifact["schemaVersion"].as_u64() != Some(1) {
            return None;
        }
        let file = Path::new(artifact["journal"].as_str()?);
        let source = Path::new(artifact["sourceProject"].as_str()?);
        if !file.is_absolute()
            || !source.is_absolute()
            || file.canonicalize().ok()? != summary.file
            || source.canonicalize().ok()? != journal.source_project.canonicalize().ok()?
        {
            return None;
        }
        let duration = journal.duration_ms.filter(|duration| *duration > 0)?;
        artifact["notes"]
            .as_array()?
            .iter()
            .map(|note| {
                if note
                    .get("ev")
                    .or_else(|| note.get("kind"))
                    .is_some_and(|kind| kind.as_str() != Some("note"))
                {
                    return None;
                }
                let offset_ms = note["offsetMs"]
                    .as_u64()
                    .filter(|offset| *offset <= duration)?;
                let text = note["text"].as_str()?.trim();
                let text = if text.is_empty() { "Voice note" } else { text };
                Some(crate::ux_walk_journal::Event {
                    kind: "note".into(),
                    text: text.into(),
                    offset_ms,
                })
            })
            .collect::<Option<Vec<_>>>()
    })();
    let Some(derived) = derived else {
        return original;
    };
    let mut events = original;
    let mut seen: BTreeSet<_> = events
        .iter()
        .map(|event| (event.kind.clone(), event.offset_ms, event.text.clone()))
        .collect();
    for event in derived {
        if seen.insert((event.kind.clone(), event.offset_ms, event.text.clone())) {
            events.push(event);
        }
    }
    events.sort_by_key(|event| event.offset_ms);
    events
}

#[derive(Debug, PartialEq, Eq)]
enum ProcessorOwner {
    Absent,
    Alive,
    Dead,
    Unknown,
}

fn processor_owner(directory: &Path) -> ProcessorOwner {
    let lock = directory.join(".processing-lock");
    match fs::symlink_metadata(&lock) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return ProcessorOwner::Absent;
        }
        Err(_) => return ProcessorOwner::Unknown,
        Ok(metadata) if !metadata.is_dir() => return ProcessorOwner::Unknown,
        Ok(_) => {}
    }
    let owner = fs::read(lock.join("owner.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok());
    let Some(pid) = owner
        .as_ref()
        .and_then(|owner| owner["pid"].as_u64())
        .filter(|pid| *pid > 0 && *pid <= i32::MAX as u64)
    else {
        return ProcessorOwner::Unknown;
    };
    #[cfg(unix)]
    {
        if unsafe { libc::kill(pid as i32, 0) } == 0 {
            return ProcessorOwner::Alive;
        }
        if std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH) {
            return ProcessorOwner::Dead;
        }
    }
    #[cfg(not(unix))]
    let _ = pid;
    ProcessorOwner::Unknown
}

pub fn processing_status(directory: &Path) -> WalkStatus {
    let file = directory.join("processing.json");
    let state = fs::read(&file)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok());
    let owner = processor_owner(directory);
    if owner == ProcessorOwner::Alive {
        return WalkStatus::Processing;
    }
    if owner == ProcessorOwner::Unknown {
        return WalkStatus::OwnerUnknown("The existing processor’s ownership could not be verified. Reprocess will verify exclusive ownership before changing files.".into());
    }
    if file.exists() && state.is_none() {
        return WalkStatus::Failed("The processing status could not be read.".into());
    }
    match state.as_ref().and_then(|state| state["state"].as_str()) {
        Some("processing") if owner == ProcessorOwner::Dead => WalkStatus::Failed(
            "The previous processor stopped. Reprocess this walk to continue.".into(),
        ),
        Some("processing") => WalkStatus::OwnerUnknown(
            "Processing owner information is missing. Reprocess will verify exclusive ownership before changing files."
                .into(),
        ),
        Some("failed") => WalkStatus::Failed(
            state
                .as_ref()
                .and_then(|state| state["error"].as_str())
                .unwrap_or("Try processing this walk again.")
                .to_string(),
        ),
        Some("ready") if directory.join("report.html").is_file() => WalkStatus::Ready,
        Some("ready") => WalkStatus::Failed("The report is missing. Reprocess this walk.".into()),
        _ if owner == ProcessorOwner::Dead => WalkStatus::Failed(
            "The previous processor stopped. Reprocess this walk to continue.".into(),
        ),
        _ if directory.join("report.html").is_file() && state.is_none() => WalkStatus::Ready,
        _ => WalkStatus::Saved,
    }
}

pub fn reprocess_allowed(file: &Path) -> Result<(), String> {
    let (_, journal) = read_walk(file)?;
    if journal.state != "complete" {
        return Err("Only a completed walk can be reprocessed.".into());
    }
    Ok(())
}

pub fn evidence_notice(directory: &Path) -> String {
    let session = fs::read(directory.join("session.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok());
    if let Some(coverage) = session
        .as_ref()
        .and_then(|value| value["coverage"].as_object())
    {
        return [
            ("dom", "Clicks and page details"),
            ("network", "Requests"),
            ("console", "Console"),
        ]
        .into_iter()
        .map(|(key, label)| {
            let value = coverage
                .get(key)
                .and_then(Value::as_str)
                .unwrap_or("not captured");
            format!("{label}: {}", value.chars().take(240).collect::<String>())
        })
        .collect::<Vec<_>>()
        .join(" · ");
    }
    "Copy an agent prompt to review the browser evidence available for this walk.".into()
}

pub fn index_in(roots: &[PathBuf], explicit_files: &[PathBuf]) -> BTreeMap<PathBuf, WalkSummary> {
    let mut files: BTreeSet<PathBuf> = explicit_files.iter().cloned().collect();
    for root in roots {
        if let Ok(entries) = fs::read_dir(root) {
            files.extend(
                entries
                    .flatten()
                    .map(|entry| entry.path().join("native-walk.json")),
            );
        }
    }
    let mut seen = BTreeSet::new();
    let mut walks: Vec<_> = files
        .into_iter()
        .filter_map(|file| read_summary(&file).ok())
        .filter(|walk| seen.insert(walk.file.clone()))
        .collect();
    // Several journals can reference one project; the newest start wins, with a stable path tie-break.
    walks.sort_by(|a, b| (a.started_at_ms, &a.file).cmp(&(b.started_at_ms, &b.file)));
    let mut index = BTreeMap::new();
    for mut walk in walks {
        if let Ok(source) = walk.source_project.canonicalize() {
            walk.source_project = source.clone();
            index.insert(source, walk);
        }
    }
    index
}

pub fn index() -> BTreeMap<PathBuf, WalkSummary> {
    if !cfg!(all(target_os = "macos", feature = "ux-walk")) {
        return BTreeMap::new();
    }
    let settings = crate::ux_walk::load().unwrap_or_default();
    let section = crate::store::store_section(crate::store::RECORDING_SETTINGS);
    let mut roots = vec![expanded_path(crate::ux_walk::text(&settings, "outDir"))];
    roots.extend(
        section
            .get("nativeWalkRoots")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(PathBuf::from),
    );
    let mut files: Vec<_> = section
        .get("nativeWalks")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(PathBuf::from)
        .collect();
    if let Some(file) = section
        .get("lastNativeWalk")
        .and_then(Value::as_str)
        .map(PathBuf::from)
    {
        if let Some(root) = file.parent().and_then(Path::parent) {
            roots.push(root.to_path_buf());
        }
        files.push(file);
    }
    index_in(&roots, &files)
}

fn append_path(section: &mut Map<String, Value>, key: &str, path: &Path) {
    let values = section
        .entry(key.to_string())
        .or_insert_with(|| Value::Array(Vec::new()));
    if !values.is_array() {
        *values = Value::Array(Vec::new());
    }
    let values = values.as_array_mut().expect("array replaced above");
    let value = Value::String(path.to_string_lossy().into_owned());
    if !values.contains(&value) {
        values.push(value);
    }
}

pub fn remember_journal(file: &Path) -> Result<(), String> {
    let file = file.canonicalize().map_err(|e| e.to_string())?;
    if crate::store::update_store_section(crate::store::RECORDING_SETTINGS, |section| {
        append_path(section, "nativeWalks", &file);
        true
    }) {
        Ok(())
    } else {
        Err(
            "Could not remember this walk in the library. Its recording and notes are still saved."
                .into(),
        )
    }
}

pub fn remember_root(path: &str) -> Result<(), String> {
    let path = expanded_path(path);
    let path = path.canonicalize().unwrap_or(path);
    if crate::store::update_store_section(crate::store::RECORDING_SETTINGS, |section| {
        append_path(section, "nativeWalkRoots", &path);
        true
    }) {
        Ok(())
    } else {
        Err("Could not remember the previous walk recordings folder.".into())
    }
}
