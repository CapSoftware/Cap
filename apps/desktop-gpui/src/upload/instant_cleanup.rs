use super::*;
use cap_project::{InstantRecordingMeta, RecordingMetaInner};
use std::io::Write;

const JOURNAL_FILE: &str = "gpui-instant-cleanup.json";
const MAX_JOURNAL_BYTES: u64 = 256 * 1024;
const MAX_ENTRIES: usize = 256;
const ENTRY_LIFETIME_SECS: i64 = 14 * 24 * 60 * 60;
const RETRY_BASE_SECS: i64 = 5 * 60;
const RETRY_MAX_SECS: i64 = 6 * 60 * 60;
const INTERRUPTED_GRACE_SECS: i64 = 30 * 60;
const SWEEP_INTERVAL: Duration = Duration::from_secs(5 * 60);
const MEDIA_SCAN_DEPTH: usize = 3;

static JOURNAL_LOCK: Mutex<()> = Mutex::new(());
static SESSION: OnceLock<String> = OnceLock::new();

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum CleanupReason {
    StartFailed,
    StartCancelled,
    Interrupted,
}

impl CleanupReason {
    fn as_str(self) -> &'static str {
        match self {
            Self::StartFailed => "start-failed",
            Self::StartCancelled => "start-cancelled",
            Self::Interrupted => "interrupted",
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum StartFailureCause {
    Permission,
    Microphone,
    Camera,
    Capture,
    Storage,
    Account,
    Network,
    Other,
}

impl StartFailureCause {
    fn as_str(self) -> &'static str {
        match self {
            Self::Permission => "permission",
            Self::Microphone => "microphone",
            Self::Camera => "camera",
            Self::Capture => "capture",
            Self::Storage => "storage",
            Self::Account => "account",
            Self::Network => "network",
            Self::Other => "other",
        }
    }
}

pub(crate) fn classify_start_failure(error: &str) -> StartFailureCause {
    let error = error.to_ascii_lowercase();
    let has = |needles: &[&str]| needles.iter().any(|needle| error.contains(needle));
    if has(&["permission", "not authorized", "not permitted", "tcc"]) {
        StartFailureCause::Permission
    } else if has(&["microphone", "mic feed", "audio input"]) {
        StartFailureCause::Microphone
    } else if has(&["camera"]) {
        StartFailureCause::Camera
    } else if has(&["sign in", "authenticat", "session has expired"]) {
        StartFailureCause::Account
    } else if has(&["storage", "disk", "no space"]) {
        StartFailureCause::Storage
    } else if has(&["timed out", "timeout", "network", "connection", "dns"]) {
        StartFailureCause::Network
    } else if has(&["screen", "capture", "display", "window", "shareable"]) {
        StartFailureCause::Capture
    } else {
        StartFailureCause::Other
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
enum Stage {
    Starting,
    Abandoned,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
struct Entry {
    video_id: String,
    server_url: String,
    owner_id: String,
    session: String,
    stage: Stage,
    reason: Option<CleanupReason>,
    cause: Option<StartFailureCause>,
    created_at: i64,
    attempts: u32,
    next_attempt_at: i64,
    #[serde(default)]
    project_dir: Option<PathBuf>,
}

impl Entry {
    fn effective_reason(&self) -> CleanupReason {
        match self.stage {
            Stage::Abandoned => self.reason.unwrap_or(CleanupReason::Interrupted),
            Stage::Starting => CleanupReason::Interrupted,
        }
    }

    fn due(&self, session: &str, now: i64) -> bool {
        let actionable = match self.stage {
            Stage::Abandoned => true,
            Stage::Starting => {
                self.session != session
                    && now.saturating_sub(self.created_at) >= INTERRUPTED_GRACE_SECS
            }
        };
        actionable && self.next_attempt_at <= now
    }

    fn expired(&self, now: i64) -> bool {
        now.saturating_sub(self.created_at) > ENTRY_LIFETIME_SECS
    }
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct Journal {
    version: u32,
    entries: Vec<Entry>,
}

fn now() -> i64 {
    chrono::Utc::now().timestamp()
}

fn session_id() -> &'static str {
    SESSION.get_or_init(crate::store::new_uuid_v4)
}

fn journal_path() -> PathBuf {
    crate::store::app_data_dir().join(JOURNAL_FILE)
}

fn current_owner_id() -> Option<String> {
    crate::store::store_section("auth")
        .get("user_id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .map(str::to_string)
}

fn retry_delay(attempts: u32) -> i64 {
    RETRY_BASE_SECS
        .saturating_mul(1_i64 << attempts.min(12))
        .min(RETRY_MAX_SECS)
}

fn read_journal(path: &Path) -> Journal {
    let bytes = match std::fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Journal::default(),
        Err(error) => {
            tracing::warn!(%error, "Instant cleanup journal is unreadable");
            return Journal::default();
        }
        Ok(metadata) if !metadata.is_file() || metadata.len() > MAX_JOURNAL_BYTES => {
            tracing::warn!("Instant cleanup journal is not a usable file");
            return Journal::default();
        }
        Ok(_) => match std::fs::read(path) {
            Ok(bytes) => bytes,
            Err(error) => {
                tracing::warn!(%error, "Instant cleanup journal is unreadable");
                return Journal::default();
            }
        },
    };
    match serde_json::from_slice::<Journal>(&bytes) {
        Ok(journal) if journal.version == 1 => journal,
        Ok(_) => Journal::default(),
        Err(error) => {
            tracing::warn!(%error, "Instant cleanup journal could not be parsed");
            Journal::default()
        }
    }
}

fn write_journal(path: &Path, journal: &Journal) -> Result<(), String> {
    let directory = path
        .parent()
        .ok_or("Instant cleanup journal has no directory")?;
    std::fs::create_dir_all(directory).map_err(|error| error.to_string())?;
    let bytes = serde_json::to_vec(journal).map_err(|error| error.to_string())?;
    let temporary = directory.join(format!(
        ".gpui-instant-cleanup-{}.tmp",
        crate::store::new_uuid_v4()
    ));
    let result = (|| {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(&bytes)?;
        drop(file);
        std::fs::rename(&temporary, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result.map_err(|error| format!("Could not save the instant cleanup journal: {error}"))
}

fn update_journal(path: &Path, change: impl FnOnce(&mut Vec<Entry>)) -> Result<(), String> {
    let _guard = JOURNAL_LOCK
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let mut journal = read_journal(path);
    journal.version = 1;
    change(&mut journal.entries);
    if journal.entries.len() > MAX_ENTRIES {
        journal.entries.sort_by_key(|entry| entry.created_at);
        let excess = journal.entries.len() - MAX_ENTRIES;
        journal.entries.drain(..excess);
    }
    write_journal(path, &journal)
}

fn begin_at(
    path: &Path,
    video_id: &str,
    project_dir: Option<PathBuf>,
    server_url: String,
    owner_id: String,
    now: i64,
) {
    let entry = Entry {
        video_id: video_id.to_string(),
        server_url,
        owner_id,
        session: session_id().to_string(),
        stage: Stage::Starting,
        reason: None,
        cause: None,
        created_at: now,
        attempts: 0,
        next_attempt_at: now,
        project_dir,
    };
    if let Err(error) = update_journal(path, |entries| {
        entries.retain(|existing| existing.video_id != video_id);
        entries.push(entry);
    }) {
        tracing::warn!(%error, video_id, "Instant cleanup could not record a starting recording");
    }
}

fn remove_at(path: &Path, video_id: &str) {
    if let Err(error) = update_journal(path, |entries| {
        entries.retain(|entry| entry.video_id != video_id);
    }) {
        tracing::warn!(%error, video_id, "Instant cleanup could not clear a journal entry");
    }
}

fn abandon_at(
    path: &Path,
    video_id: &str,
    reason: CleanupReason,
    cause: Option<StartFailureCause>,
    fallback_identity: Option<(String, String)>,
    now: i64,
) {
    if let Err(error) = update_journal(path, |entries| {
        if let Some(entry) = entries.iter_mut().find(|entry| entry.video_id == video_id) {
            entry.stage = Stage::Abandoned;
            entry.reason = Some(reason);
            entry.cause = cause;
            entry.next_attempt_at = now.saturating_add(RETRY_BASE_SECS);
        } else if let Some((server_url, owner_id)) = fallback_identity {
            entries.push(Entry {
                video_id: video_id.to_string(),
                server_url,
                owner_id,
                session: session_id().to_string(),
                stage: Stage::Abandoned,
                reason: Some(reason),
                cause,
                created_at: now,
                attempts: 0,
                next_attempt_at: now.saturating_add(RETRY_BASE_SECS),
                project_dir: None,
            });
        }
    }) {
        tracing::warn!(%error, video_id, "Instant cleanup could not record an abandoned recording");
    }
}

/// Records a pre-created Instant video before capture starts, so a crash,
/// panic or aborted discard during startup still gets its server copy
/// deleted on the next sweep. Linux keeps its own startup cleanup contract.
pub(crate) fn begin(video_id: &str, project_dir: &Path) {
    if cfg!(target_os = "linux") {
        return;
    }
    let Some(owner_id) = current_owner_id() else {
        return;
    };
    begin_at(
        &journal_path(),
        video_id,
        Some(project_dir.to_path_buf()),
        auth::server_url(),
        owner_id,
        now(),
    );
}

pub(crate) fn started(video_id: &str) {
    if cfg!(target_os = "linux") {
        return;
    }
    remove_at(&journal_path(), video_id);
}

pub(crate) fn resolved(video_id: &str) {
    if cfg!(target_os = "linux") {
        return;
    }
    remove_at(&journal_path(), video_id);
}

pub(crate) fn abandon(video_id: &str, reason: CleanupReason, cause: Option<StartFailureCause>) {
    if cfg!(target_os = "linux") {
        return;
    }
    let identity = current_owner_id().map(|owner| (auth::server_url(), owner));
    abandon_at(&journal_path(), video_id, reason, cause, identity, now());
}

pub(crate) fn delete_query(
    reason: CleanupReason,
    cause: Option<StartFailureCause>,
) -> Option<String> {
    if !crate::store::GeneralSettings::load().enable_telemetry {
        return None;
    }
    Some(match cause {
        Some(cause) => format!("reason={}&cause={}", reason.as_str(), cause.as_str()),
        None => format!("reason={}", reason.as_str()),
    })
}

fn upload_meta_video_id(meta: &RecordingMeta) -> Option<&str> {
    match meta.upload.as_ref()? {
        UploadMeta::MultipartUpload { video_id, .. }
        | UploadMeta::SinglePartUpload { video_id, .. }
        | UploadMeta::SegmentUpload { video_id, .. } => Some(video_id),
        UploadMeta::Failed { .. } | UploadMeta::Complete => None,
    }
}

/// True when the folder holds recorded media, or when part of it cannot be
/// read: media that cannot be checked counts as present. Only a missing folder
/// counts as empty.
fn has_recorded_media(directory: &Path, depth: usize) -> bool {
    let entries = match std::fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) => return error.kind() != std::io::ErrorKind::NotFound,
    };
    entries.into_iter().any(|entry| {
        let Ok(entry) = entry else {
            return true;
        };
        let path = entry.path();
        let Ok(metadata) = std::fs::symlink_metadata(&path) else {
            return true;
        };
        if metadata.is_dir() {
            return depth > 0 && has_recorded_media(&path, depth - 1);
        }
        if !metadata.is_file() || metadata.len() == 0 {
            return false;
        }
        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        name.ends_with(".m4s") || (name.ends_with(".mp4") && !name.starts_with("init"))
    })
}

fn project_needs_video(project: &Path, meta: Option<&RecordingMeta>, interrupted: bool) -> bool {
    let Some(meta) = meta else {
        return true;
    };
    !matches!(
        meta.inner,
        RecordingMetaInner::Instant(InstantRecordingMeta::InProgress { .. })
    ) || (interrupted && has_recorded_media(&project.join("content"), MEDIA_SCAN_DEPTH))
}

/// True when a local recording that must not lose its server copy points at
/// this video: anything past `InProgress`, an unreadable project that claims
/// the id, or (for interrupted starts) a project that already holds media.
/// An interrupted start whose own folder sits on storage that cannot be read
/// right now (an unmounted drive) is kept too: its media may still be there.
fn locally_protected(
    recording_dirs: &[PathBuf],
    video_id: &str,
    interrupted: bool,
    start_project: Option<&Path>,
) -> bool {
    if interrupted && let Some(project) = start_project {
        if !project
            .parent()
            .is_some_and(|parent| std::fs::read_dir(parent).is_ok())
        {
            return true;
        }
        if project.exists() {
            let meta = RecordingMeta::load_for_project(project).ok();
            if project_needs_video(project, meta.as_ref(), interrupted) {
                return true;
            }
        }
    }
    for directory in recording_dirs {
        let Ok(entries) = std::fs::read_dir(directory) else {
            continue;
        };
        for entry in entries.flatten() {
            let project = entry.path();
            let state_matches = matches!(
                queue::read_state(&project),
                Ok(Some(state)) if state.video_id() == video_id
            );
            let meta = RecordingMeta::load_for_project(&project).ok();
            let meta_matches = meta.as_ref().is_some_and(|meta| {
                meta.sharing
                    .as_ref()
                    .is_some_and(|share| share.id == video_id)
                    || upload_meta_video_id(meta) == Some(video_id)
            });
            if (state_matches || meta_matches)
                && project_needs_video(&project, meta.as_ref(), interrupted)
            {
                return true;
            }
        }
    }
    false
}

trait SweepBackend {
    fn account_ready(&self, entry: &Entry) -> bool;
    fn protected(&self, entry: &Entry) -> impl Future<Output = bool> + Send;
    fn delete(&self, entry: &Entry) -> impl Future<Output = Result<(), String>> + Send;
}

#[derive(Debug, Default, PartialEq)]
struct SweepSummary {
    deleted: usize,
    kept: usize,
    expired: usize,
    failed: usize,
}

async fn sweep(path: &Path, session: &str, now: i64, backend: &impl SweepBackend) -> SweepSummary {
    let mut summary = SweepSummary::default();
    let due: Vec<Entry> = {
        let _guard = JOURNAL_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        read_journal(path)
            .entries
            .into_iter()
            .filter(|entry| entry.expired(now) || entry.due(session, now))
            .collect()
    };
    let mut remove = Vec::new();
    let mut retry = Vec::new();
    for entry in due {
        if entry.expired(now) {
            tracing::warn!(video_id = %entry.video_id, "Instant cleanup gave up on an old entry");
            summary.expired += 1;
            remove.push(entry.video_id);
            continue;
        }
        if !backend.account_ready(&entry) {
            continue;
        }
        if backend.protected(&entry).await {
            tracing::warn!(video_id = %entry.video_id, "Instant cleanup kept a video a local recording uses");
            summary.kept += 1;
            remove.push(entry.video_id);
            continue;
        }
        match backend.delete(&entry).await {
            Ok(()) => {
                summary.deleted += 1;
                remove.push(entry.video_id);
            }
            Err(error) => {
                tracing::warn!(%error, video_id = %entry.video_id, "Instant cleanup delete will retry");
                summary.failed += 1;
                retry.push(entry.video_id);
            }
        }
    }
    if remove.is_empty() && retry.is_empty() {
        return summary;
    }
    if let Err(error) = update_journal(path, |entries| {
        entries.retain(|entry| !remove.contains(&entry.video_id));
        for entry in entries.iter_mut() {
            if retry.contains(&entry.video_id) {
                entry.attempts = entry.attempts.saturating_add(1);
                entry.next_attempt_at = now.saturating_add(retry_delay(entry.attempts));
            }
        }
    }) {
        tracing::warn!(%error, "Instant cleanup could not save sweep results");
    }
    summary
}

struct LiveSweep;

impl SweepBackend for LiveSweep {
    fn account_ready(&self, entry: &Entry) -> bool {
        auth::UploadRequestContext::for_upload(&entry.server_url, Some(&entry.owner_id)).is_ok()
    }

    async fn protected(&self, entry: &Entry) -> bool {
        let video_id = entry.video_id.clone();
        let interrupted = entry.effective_reason() == CleanupReason::Interrupted;
        let start_project = entry.project_dir.clone();
        tokio::task::spawn_blocking(move || {
            locally_protected(
                &crate::library::known_recordings_dirs(),
                &video_id,
                interrupted,
                start_project.as_deref(),
            )
        })
        .await
        .unwrap_or(true)
    }

    async fn delete(&self, entry: &Entry) -> Result<(), String> {
        let context =
            auth::UploadRequestContext::for_upload(&entry.server_url, Some(&entry.owner_id))
                .map_err(|error| error.to_string())?;
        let query = delete_query(entry.effective_reason(), entry.cause);
        context
            .run(delete_instant_video_with_query(
                &entry.video_id,
                query.as_deref(),
            ))
            .await
    }
}

async fn run() {
    loop {
        let summary = sweep(&journal_path(), session_id(), now(), &LiveSweep).await;
        if summary != SweepSummary::default() {
            tracing::info!(?summary, "Instant cleanup sweep finished");
        }
        tokio::time::sleep(SWEEP_INTERVAL).await;
    }
}

pub(crate) fn init(cx: &mut gpui::App) {
    if cfg!(target_os = "linux") {
        return;
    }
    session_id();
    gpui_tokio::Tokio::spawn(cx, run()).detach();
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    struct Fixture(tempfile::TempDir);

    impl Fixture {
        fn new() -> Self {
            Self(tempfile::tempdir().unwrap())
        }

        fn journal(&self) -> PathBuf {
            self.0.path().join("state").join(JOURNAL_FILE)
        }

        fn recordings(&self) -> PathBuf {
            let path = self.0.path().join("recordings");
            std::fs::create_dir_all(&path).unwrap();
            path
        }

        fn entries(&self) -> Vec<Entry> {
            read_journal(&self.journal()).entries
        }

        fn seed(&self, entries: Vec<Entry>) {
            write_journal(
                &self.journal(),
                &Journal {
                    version: 1,
                    entries,
                },
            )
            .unwrap();
        }
    }

    fn entry(video_id: &str, session: &str, stage: Stage, created_at: i64) -> Entry {
        Entry {
            video_id: video_id.into(),
            server_url: "https://cap.test".into(),
            owner_id: "owner".into(),
            session: session.into(),
            stage,
            reason: (stage == Stage::Abandoned).then_some(CleanupReason::StartFailed),
            cause: None,
            created_at,
            attempts: 0,
            next_attempt_at: created_at,
            project_dir: None,
        }
    }

    #[derive(Default)]
    struct FakeBackend {
        account: bool,
        protected: Vec<String>,
        failing: Vec<String>,
        deletes: Mutex<Vec<String>>,
        protected_checks: AtomicUsize,
    }

    impl FakeBackend {
        fn ready() -> Self {
            Self {
                account: true,
                ..Self::default()
            }
        }

        fn deleted(&self) -> Vec<String> {
            self.deletes.lock().unwrap().clone()
        }
    }

    impl SweepBackend for FakeBackend {
        fn account_ready(&self, _entry: &Entry) -> bool {
            self.account
        }

        async fn protected(&self, entry: &Entry) -> bool {
            self.protected_checks.fetch_add(1, Ordering::SeqCst);
            self.protected.contains(&entry.video_id)
        }

        async fn delete(&self, entry: &Entry) -> Result<(), String> {
            if self.failing.contains(&entry.video_id) {
                return Err("server unavailable".into());
            }
            self.deletes.lock().unwrap().push(entry.video_id.clone());
            Ok(())
        }
    }

    #[test]
    fn start_failures_are_classified_without_their_text() {
        let cases = [
            (
                "Screen recording permission was denied",
                StartFailureCause::Permission,
            ),
            (
                "Selected microphone 'Desk Mic' is not the connected microphone 'Other'. Please select it again.",
                StartFailureCause::Microphone,
            ),
            ("Camera feed did not start", StartFailureCause::Camera),
            (
                "Your session has expired. Please sign in again",
                StartFailureCause::Account,
            ),
            (
                "Low storage: only 0.20 GB is available",
                StartFailureCause::Storage,
            ),
            ("operation timed out", StartFailureCause::Network),
            ("Failed to start screen capture", StartFailureCause::Capture),
            ("something unexpected", StartFailureCause::Other),
        ];
        for (error, cause) in cases {
            assert_eq!(classify_start_failure(error), cause, "{error}");
        }
    }

    #[test]
    fn a_started_recording_leaves_nothing_to_clean() {
        let fixture = Fixture::new();
        begin_at(
            &fixture.journal(),
            "video",
            None,
            "https://cap.test".into(),
            "owner".into(),
            100,
        );
        assert_eq!(fixture.entries().len(), 1);
        assert_eq!(fixture.entries()[0].stage, Stage::Starting);
        remove_at(&fixture.journal(), "video");
        assert!(fixture.entries().is_empty());
    }

    #[test]
    fn abandoning_marks_the_entry_and_waits_before_the_first_retry() {
        let fixture = Fixture::new();
        begin_at(
            &fixture.journal(),
            "video",
            None,
            "https://cap.test".into(),
            "owner".into(),
            100,
        );
        abandon_at(
            &fixture.journal(),
            "video",
            CleanupReason::StartFailed,
            Some(StartFailureCause::Microphone),
            None,
            200,
        );
        let entries = fixture.entries();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].stage, Stage::Abandoned);
        assert_eq!(entries[0].reason, Some(CleanupReason::StartFailed));
        assert_eq!(entries[0].cause, Some(StartFailureCause::Microphone));
        assert_eq!(entries[0].next_attempt_at, 200 + RETRY_BASE_SECS);
    }

    #[test]
    fn abandoning_without_a_journal_entry_needs_an_identity() {
        let fixture = Fixture::new();
        abandon_at(
            &fixture.journal(),
            "video",
            CleanupReason::StartCancelled,
            None,
            None,
            100,
        );
        assert!(fixture.entries().is_empty());
        abandon_at(
            &fixture.journal(),
            "video",
            CleanupReason::StartCancelled,
            None,
            Some(("https://cap.test".into(), "owner".into())),
            100,
        );
        assert_eq!(fixture.entries().len(), 1);
        assert_eq!(fixture.entries()[0].stage, Stage::Abandoned);
    }

    #[test]
    fn corrupt_or_oversized_journals_are_treated_as_empty() {
        let fixture = Fixture::new();
        std::fs::create_dir_all(fixture.journal().parent().unwrap()).unwrap();
        std::fs::write(fixture.journal(), b"{not json").unwrap();
        assert!(fixture.entries().is_empty());
        std::fs::write(
            fixture.journal(),
            vec![b' '; MAX_JOURNAL_BYTES as usize + 1],
        )
        .unwrap();
        assert!(fixture.entries().is_empty());
        begin_at(
            &fixture.journal(),
            "video",
            None,
            "https://cap.test".into(),
            "owner".into(),
            100,
        );
        assert_eq!(fixture.entries().len(), 1);
    }

    #[test]
    fn the_journal_keeps_only_the_newest_entries() {
        let fixture = Fixture::new();
        fixture.seed(
            (0..MAX_ENTRIES as i64)
                .map(|index| entry(&format!("video-{index}"), "old", Stage::Starting, index))
                .collect(),
        );
        begin_at(
            &fixture.journal(),
            "newest",
            None,
            "https://cap.test".into(),
            "owner".into(),
            10_000,
        );
        let entries = fixture.entries();
        assert_eq!(entries.len(), MAX_ENTRIES);
        assert!(entries.iter().all(|entry| entry.video_id != "video-0"));
        assert!(entries.iter().any(|entry| entry.video_id == "newest"));
    }

    #[tokio::test]
    async fn a_start_still_running_in_this_session_is_never_deleted() {
        let fixture = Fixture::new();
        fixture.seed(vec![entry("in-flight", "current", Stage::Starting, 100)]);
        let backend = FakeBackend::ready();
        let summary = sweep(&fixture.journal(), "current", 100 + 30 * 24 * 60, &backend).await;
        assert_eq!(summary, SweepSummary::default());
        assert!(backend.deleted().is_empty());
        assert_eq!(fixture.entries().len(), 1);
    }

    #[tokio::test]
    async fn abandoned_and_interrupted_starts_are_deleted_once_due() {
        let fixture = Fixture::new();
        let mut not_yet_due = entry("later", "current", Stage::Abandoned, 100);
        not_yet_due.next_attempt_at = 100 + INTERRUPTED_GRACE_SECS + 1;
        fixture.seed(vec![
            entry("abandoned", "current", Stage::Abandoned, 100),
            entry("crashed", "previous", Stage::Starting, 100),
            not_yet_due,
        ]);
        let backend = FakeBackend::ready();
        let now = 100 + INTERRUPTED_GRACE_SECS;
        let summary = sweep(&fixture.journal(), "current", now, &backend).await;
        assert_eq!(summary.deleted, 2);
        assert_eq!(
            backend.deleted(),
            vec!["abandoned".to_string(), "crashed".to_string()]
        );
        let remaining = fixture.entries();
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].video_id, "later");
    }

    #[tokio::test]
    async fn another_running_app_gets_time_to_finish_its_start() {
        let fixture = Fixture::new();
        fixture.seed(vec![entry("other-app", "other", Stage::Starting, 100)]);
        let backend = FakeBackend::ready();
        let summary = sweep(
            &fixture.journal(),
            "current",
            100 + INTERRUPTED_GRACE_SECS - 1,
            &backend,
        )
        .await;
        assert_eq!(summary, SweepSummary::default());
        assert!(backend.deleted().is_empty());
        assert_eq!(fixture.entries().len(), 1);
    }

    #[tokio::test]
    async fn another_account_leaves_the_entry_untouched() {
        let fixture = Fixture::new();
        fixture.seed(vec![entry("video", "previous", Stage::Starting, 100)]);
        let backend = FakeBackend::default();
        let summary = sweep(
            &fixture.journal(),
            "current",
            100 + INTERRUPTED_GRACE_SECS,
            &backend,
        )
        .await;
        assert_eq!(summary, SweepSummary::default());
        assert_eq!(backend.protected_checks.load(Ordering::SeqCst), 0);
        assert!(backend.deleted().is_empty());
        assert_eq!(fixture.entries().len(), 1);
    }

    #[tokio::test]
    async fn a_protected_video_is_forgotten_without_deleting_it() {
        let fixture = Fixture::new();
        fixture.seed(vec![entry("kept", "previous", Stage::Starting, 100)]);
        let backend = FakeBackend {
            protected: vec!["kept".into()],
            ..FakeBackend::ready()
        };
        let summary = sweep(
            &fixture.journal(),
            "current",
            100 + INTERRUPTED_GRACE_SECS,
            &backend,
        )
        .await;
        assert_eq!(summary.kept, 1);
        assert!(backend.deleted().is_empty());
        assert!(fixture.entries().is_empty());
    }

    #[tokio::test]
    async fn failed_deletes_back_off_and_old_entries_expire() {
        let fixture = Fixture::new();
        let now = ENTRY_LIFETIME_SECS + 1_000;
        fixture.seed(vec![
            entry("flaky", "current", Stage::Abandoned, now - 10),
            entry("ancient", "previous", Stage::Starting, 0),
        ]);
        let backend = FakeBackend {
            failing: vec!["flaky".into()],
            ..FakeBackend::ready()
        };
        let summary = sweep(&fixture.journal(), "current", now, &backend).await;
        assert_eq!(summary.failed, 1);
        assert_eq!(summary.expired, 1);
        let remaining = fixture.entries();
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].attempts, 1);
        assert_eq!(remaining[0].next_attempt_at, now + retry_delay(1));
        assert!(retry_delay(40) <= RETRY_MAX_SECS);
    }

    #[tokio::test]
    async fn entries_cleared_during_a_sweep_are_not_brought_back() {
        let fixture = Fixture::new();
        fixture.seed(vec![entry("flaky", "current", Stage::Abandoned, 100)]);
        struct ClearsDuringDelete<'a>(&'a Path);
        impl SweepBackend for ClearsDuringDelete<'_> {
            fn account_ready(&self, _entry: &Entry) -> bool {
                true
            }
            async fn protected(&self, _entry: &Entry) -> bool {
                false
            }
            async fn delete(&self, entry: &Entry) -> Result<(), String> {
                remove_at(self.0, &entry.video_id);
                Err("server unavailable".into())
            }
        }
        let journal = fixture.journal();
        sweep(&journal, "current", 500, &ClearsDuringDelete(&journal)).await;
        assert!(fixture.entries().is_empty());
    }

    fn write_project(
        root: &Path,
        name: &str,
        video_id: &str,
        inner: RecordingMetaInner,
    ) -> PathBuf {
        let project = root.join(name);
        std::fs::create_dir_all(project.join("content/display")).unwrap();
        let video = VideoUploadInfo {
            id: video_id.into(),
            link: format!("https://cap.test/s/{video_id}"),
            config: S3UploadMeta {
                id: video_id.into(),
            },
        };
        RecordingMeta {
            platform: None,
            project_path: project.clone(),
            pretty_name: name.into(),
            sharing: None,
            inner,
            upload: Some(UploadMeta::SegmentUpload {
                video_id: video_id.into(),
                pre_created_video: video,
                recording_dir: project.clone(),
            }),
        }
        .save_for_project()
        .unwrap();
        project
    }

    fn in_progress() -> RecordingMetaInner {
        RecordingMetaInner::Instant(InstantRecordingMeta::InProgress { recording: true })
    }

    #[test]
    fn a_finished_local_recording_always_protects_its_video() {
        let fixture = Fixture::new();
        let recordings = fixture.recordings();
        write_project(
            &recordings,
            "done.cap",
            "video",
            RecordingMetaInner::Instant(InstantRecordingMeta::Complete {
                fps: 30,
                sample_rate: None,
            }),
        );
        assert!(locally_protected(
            std::slice::from_ref(&recordings),
            "video",
            false,
            None,
        ));
        assert!(locally_protected(&[recordings], "video", true, None));
    }

    #[test]
    fn a_failed_start_without_media_does_not_protect_its_video() {
        let fixture = Fixture::new();
        let recordings = fixture.recordings();
        let project = write_project(&recordings, "failed.cap", "video", in_progress());
        std::fs::write(project.join("content/display/init.mp4"), b"header").unwrap();
        assert!(!locally_protected(
            std::slice::from_ref(&recordings),
            "video",
            false,
            None,
        ));
        assert!(!locally_protected(
            std::slice::from_ref(&recordings),
            "video",
            true,
            None,
        ));
        assert!(!locally_protected(&[recordings], "other-video", true, None));
    }

    #[test]
    fn recorded_media_protects_an_interrupted_start_only() {
        let fixture = Fixture::new();
        let recordings = fixture.recordings();
        let project = write_project(&recordings, "crashed.cap", "video", in_progress());
        std::fs::write(project.join("content/display/segment_001.m4s"), b"media").unwrap();
        assert!(locally_protected(
            std::slice::from_ref(&recordings),
            "video",
            true,
            None,
        ));
        assert!(!locally_protected(&[recordings], "video", false, None));
    }

    #[cfg(unix)]
    #[test]
    fn media_that_cannot_be_read_protects_an_interrupted_start() {
        use std::os::unix::fs::PermissionsExt;
        let fixture = Fixture::new();
        let recordings = fixture.recordings();
        let project = write_project(&recordings, "locked.cap", "video", in_progress());
        let display = project.join("content/display");
        std::fs::set_permissions(&display, std::fs::Permissions::from_mode(0o000)).unwrap();
        let readable = std::fs::read_dir(&display).is_ok();
        let protected = locally_protected(std::slice::from_ref(&recordings), "video", true, None);
        let normal = locally_protected(&[recordings], "video", false, None);
        std::fs::set_permissions(&display, std::fs::Permissions::from_mode(0o755)).unwrap();
        if readable {
            return;
        }
        assert!(protected);
        assert!(!normal);
    }

    #[test]
    fn an_unreadable_project_that_claims_the_video_protects_it() {
        let fixture = Fixture::new();
        let recordings = fixture.recordings();
        let project = write_project(&recordings, "broken.cap", "video", in_progress());
        queue::record_capture(
            &project,
            &VideoUploadInfo {
                id: "video".into(),
                link: "https://cap.test/s/video".into(),
                config: S3UploadMeta { id: "video".into() },
            },
            true,
            true,
        )
        .unwrap();
        std::fs::write(project.join("recording-meta.json"), b"{broken").unwrap();
        assert!(locally_protected(&[recordings], "video", false, None));
    }

    #[test]
    fn an_interrupted_start_on_unreadable_storage_is_kept() {
        let fixture = Fixture::new();
        let recordings = fixture.recordings();
        let unmounted = fixture.0.path().join("unmounted-drive").join("start.cap");
        assert!(locally_protected(
            std::slice::from_ref(&recordings),
            "video",
            true,
            Some(&unmounted),
        ));
        assert!(!locally_protected(
            std::slice::from_ref(&recordings),
            "video",
            false,
            Some(&unmounted),
        ));
    }

    #[test]
    fn an_interrupted_start_folder_is_checked_even_without_a_reference() {
        let fixture = Fixture::new();
        let recordings = fixture.recordings();
        let project = recordings.join("orphan.cap");
        std::fs::create_dir_all(project.join("content/display")).unwrap();
        assert!(locally_protected(
            std::slice::from_ref(&recordings),
            "video",
            true,
            Some(&project),
        ));
        let deleted = recordings.join("deleted.cap");
        assert!(!locally_protected(
            std::slice::from_ref(&recordings),
            "video",
            true,
            Some(&deleted),
        ));
        let failed = write_project(&recordings, "failed.cap", "other", in_progress());
        assert!(!locally_protected(
            std::slice::from_ref(&recordings),
            "video",
            true,
            Some(&failed),
        ));
        std::fs::write(failed.join("content/display/segment_001.m4s"), b"media").unwrap();
        assert!(locally_protected(
            &[recordings],
            "video",
            true,
            Some(&failed)
        ));
    }

    #[test]
    fn begin_records_the_start_folder() {
        let fixture = Fixture::new();
        let project = fixture.recordings().join("start.cap");
        begin_at(
            &fixture.journal(),
            "video",
            Some(project.clone()),
            "https://cap.test".into(),
            "owner".into(),
            100,
        );
        assert_eq!(fixture.entries()[0].project_dir, Some(project));
    }
}
