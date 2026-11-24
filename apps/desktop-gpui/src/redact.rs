//! Auto redact's background work: fetching the text model once, then
//! analysing the recording on a thread of its own while the editor shows
//! what has been found so far. A recording has at most one scan: an editor
//! that opens while one runs (started when the recording stopped) watches it
//! instead of starting another.

use std::{
    collections::HashMap,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        Arc, LazyLock, Mutex, PoisonError, Weak,
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
    },
    time::Duration,
};

use cap_project::redaction::{REDACTIONS_FILE, Redactions};
use sha2::Digest;

/// The model the analyser runs, by version, with each file's checksum.
pub const MODEL_VERSION: &str = "redact-v1.1";
const MODEL_BASE_URL: &str =
    "https://github.com/CapSoftware/transcription-models/releases/download/redact-v1.1";
const MODEL_FILES: &[(&str, &str)] = &[
    (
        "det.onnx",
        "ce4664924cc0977346c92a02483adc8aa46d0ca88cf4ee09b633e9a1a8b74017",
    ),
    (
        "rec.onnx",
        "301364fd2aef7dfdd378a6ab4726ac050d969f0caef46a2a27d0aabc62024b60",
    ),
    (
        "charset.txt",
        "0795eaab5495788af7cb3eedff39adf8c7eccb9a2d039a73f2cd7a9b50bde357",
    ),
    (
        "meta.json",
        "9271c7bc6c923e44fe56bf645b5fe9fea1322917428fcd576ef0d7431cd14e53",
    ),
    (
        "det.wgsl.json",
        "772ab15c0f748fb50bbf824d6aed18eb0f68f2258e31d2982be57a84e694bebf",
    ),
    (
        "det.wgsl.bin",
        "d69cd49f8b3510d12bc39e6ffdb35b3f1dec07b16934b52addeb7ca59b6382eb",
    ),
];

fn models_root() -> PathBuf {
    dirs::data_local_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("so.cap.desktop")
        .join("redact_models")
}

/// Where the model is, if it is on disk: `CAP_REDACT_MODEL_DIR`, a copy
/// bundled next to the app, or one fetched before.
pub fn installed_model_dir() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("CAP_REDACT_MODEL_DIR").map(PathBuf::from) {
        return dir.join("meta.json").exists().then_some(dir);
    }
    let bundled = std::env::current_exe().ok().and_then(|exe| {
        let dir = exe.parent()?;
        [
            dir.join("../Resources/redact-model"),
            dir.join("redact-model"),
            dir.join("../lib/cap/redact-model"),
        ]
        .into_iter()
        .find(|candidate| candidate.join("meta.json").exists())
    });
    bundled.or_else(|| {
        let dir = models_root().join(MODEL_VERSION);
        MODEL_FILES
            .iter()
            .all(|(name, _)| dir.join(name).exists())
            .then_some(dir)
    })
}

fn sha256_file(path: &Path) -> std::io::Result<String> {
    let mut file = std::fs::File::open(path)?;
    let mut hasher = sha2::Sha256::new();
    let mut buffer = vec![0u8; 1 << 16];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

/// Downloads the model into the app's data folder, checking every file,
/// and returns its folder.
fn download_model(cancel: &AtomicBool) -> anyhow::Result<PathBuf> {
    let root = models_root();
    let target = root.join(MODEL_VERSION);
    let staging = root.join(format!(".{MODEL_VERSION}-download"));
    std::fs::create_dir_all(&staging)?;
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(20))
        .build()?;
    for (name, sha) in MODEL_FILES {
        let path = staging.join(name);
        if path.exists() && sha256_file(&path)? == *sha {
            continue;
        }
        let url = format!("{MODEL_BASE_URL}/{name}");
        let bytes = runtime.block_on(async {
            let response = client.get(&url).send().await?.error_for_status()?;
            response.bytes().await
        })?;
        if cancel.load(Ordering::Relaxed) {
            anyhow::bail!("cancelled");
        }
        let mut file = std::fs::File::create(&path)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        drop(file);
        let got = sha256_file(&path)?;
        if got != *sha {
            let _ = std::fs::remove_file(&path);
            anyhow::bail!("{name} did not match its checksum");
        }
    }
    if target.exists() {
        std::fs::remove_dir_all(&target)?;
    }
    std::fs::rename(&staging, &target)?;
    Ok(target)
}

#[derive(Debug, Clone, PartialEq)]
pub enum JobPhase {
    Preparing,
    Scanning,
    Done,
    Failed(String),
    Cancelled,
}

struct Shared {
    phase: JobPhase,
    progress: f32,
    /// Each display video's length, for the progress fraction; the editor
    /// supplies them when it attaches to a scan started without one.
    durations: Option<Vec<f64>>,
    snapshot: Option<Arc<Redactions>>,
    snapshot_generation: u64,
}

struct Scan {
    project: PathBuf,
    shared: Mutex<Shared>,
    cancel: Arc<AtomicBool>,
    /// Started for a recording that just finished: it runs to the end even
    /// when no editor watches it.
    background: AtomicBool,
    watchers: AtomicUsize,
}

impl Scan {
    fn lock(&self) -> std::sync::MutexGuard<'_, Shared> {
        self.shared.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

static SCANS: LazyLock<Mutex<HashMap<PathBuf, Weak<Scan>>>> = LazyLock::new(Default::default);

fn scan_key(project: &Path) -> PathBuf {
    std::fs::canonicalize(project).unwrap_or_else(|_| project.to_path_buf())
}

/// What the editor reads back on each poll.
pub struct JobUpdate {
    pub phase: JobPhase,
    pub progress: f32,
    pub snapshot: Option<Arc<Redactions>>,
}

/// An editor's handle on a recording's scan.
pub struct RedactJob {
    scan: Arc<Scan>,
    seen_generation: u64,
}

impl RedactJob {
    /// Watches the scan of `project`, starting one if none is running.
    /// `durations` are the display videos' lengths in seconds.
    pub fn attach_or_start(project: PathBuf, durations: Vec<f64>) -> Self {
        let scan = scan_for(project, Some(durations), false);
        scan.watchers.fetch_add(1, Ordering::AcqRel);
        Self {
            scan,
            seen_generation: 0,
        }
    }

    pub fn poll(&mut self) -> JobUpdate {
        let shared = self.scan.lock();
        let snapshot = (shared.snapshot_generation != self.seen_generation)
            .then(|| shared.snapshot.clone())
            .flatten();
        self.seen_generation = shared.snapshot_generation;
        JobUpdate {
            phase: shared.phase.clone(),
            progress: shared.progress,
            snapshot,
        }
    }

    /// Stops the scan, including one started when the recording stopped.
    pub fn cancel(&self) {
        self.scan.background.store(false, Ordering::Release);
        self.scan.cancel.store(true, Ordering::Relaxed);
    }
}

impl Drop for RedactJob {
    fn drop(&mut self) {
        let last = self.scan.watchers.fetch_sub(1, Ordering::AcqRel) == 1;
        if last && !self.scan.background.load(Ordering::Acquire) {
            self.scan.cancel.store(true, Ordering::Relaxed);
        }
    }
}

/// Scans a recording that just finished, at low priority, with no editor
/// watching; an editor opened on it later attaches to this scan.
pub fn start_background(project: PathBuf) {
    scan_for(project, None, true);
}

/// Whether a scan of `project` is running now.
#[cfg(test)]
fn is_scanning(project: &Path) -> bool {
    SCANS
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .get(&scan_key(project))
        .and_then(Weak::upgrade)
        .is_some_and(|scan| matches!(scan.lock().phase, JobPhase::Preparing | JobPhase::Scanning))
}

fn scan_for(project: PathBuf, durations: Option<Vec<f64>>, background: bool) -> Arc<Scan> {
    let key = scan_key(&project);
    let mut scans = SCANS.lock().unwrap_or_else(PoisonError::into_inner);
    scans.retain(|_, scan| scan.strong_count() > 0);
    if let Some(scan) = scans.get(&key).and_then(Weak::upgrade)
        && !scan.cancel.load(Ordering::Relaxed)
        && !matches!(scan.lock().phase, JobPhase::Failed(_) | JobPhase::Cancelled)
    {
        tracing::info!(background, "Auto redact joined the running scan");
        if background {
            scan.background.store(true, Ordering::Release);
        }
        if let Some(durations) = durations {
            let mut shared = scan.lock();
            if shared.durations.is_none() {
                shared.durations = Some(durations);
            }
        }
        return scan;
    }
    let scan = Arc::new(Scan {
        project,
        shared: Mutex::new(Shared {
            phase: JobPhase::Preparing,
            progress: 0.0,
            durations,
            snapshot: None,
            snapshot_generation: 0,
        }),
        cancel: Arc::new(AtomicBool::new(false)),
        background: AtomicBool::new(background),
        watchers: AtomicUsize::new(0),
    });
    scans.insert(key, Arc::downgrade(&scan));
    drop(scans);
    tracing::info!(background, "Auto redact scan started");
    let thread_scan = scan.clone();
    let spawned = std::thread::Builder::new()
        .name("cap-auto-redact".into())
        .stack_size(16 * 1024 * 1024)
        .spawn(move || {
            // Below the editor and the recorder, so playback and the next
            // recording keep their frames; the model's worker threads start
            // on this thread and inherit it on macOS and Linux.
            crate::transcription::refine::lower_thread_priority();
            let result = run(&thread_scan);
            let cancelled = thread_scan.cancel.load(Ordering::Relaxed);
            let mut shared = thread_scan.lock();
            shared.phase = match result {
                Ok(()) => JobPhase::Done,
                Err(_) if cancelled => JobPhase::Cancelled,
                Err(error) => {
                    tracing::warn!(%error, "Auto redact analysis failed");
                    JobPhase::Failed(format!("{error:#}"))
                }
            };
        });
    if let Err(error) = spawned {
        scan.lock().phase = JobPhase::Failed(error.to_string());
    }
    scan
}

/// The model of the last scan, kept loaded for two minutes so a scan right
/// after another (auto redact off and on again, the next recording) skips
/// loading it.
struct WarmModel {
    dir: PathBuf,
    model: cap_redact::OcrModel,
    generation: u64,
}

static WARM_MODEL: Mutex<Option<WarmModel>> = Mutex::new(None);
static WARM_GENERATION: AtomicU64 = AtomicU64::new(0);
const WARM_FOR: Duration = Duration::from_secs(120);

fn take_model(dir: &Path) -> anyhow::Result<cap_redact::OcrModel> {
    let warm = WARM_MODEL
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .take();
    match warm {
        Some(warm) if warm.dir == dir => Ok(warm.model),
        _ => cap_redact::OcrModel::load(dir),
    }
}

fn keep_model(dir: PathBuf, model: cap_redact::OcrModel) {
    let generation = WARM_GENERATION.fetch_add(1, Ordering::Relaxed) + 1;
    *WARM_MODEL.lock().unwrap_or_else(PoisonError::into_inner) = Some(WarmModel {
        dir,
        model,
        generation,
    });
    let spawned = std::thread::Builder::new()
        .name("cap-auto-redact-warm".into())
        .spawn(move || {
            std::thread::sleep(WARM_FOR);
            let mut warm = WARM_MODEL.lock().unwrap_or_else(PoisonError::into_inner);
            if warm
                .as_ref()
                .is_some_and(|warm| warm.generation == generation)
            {
                *warm = None;
            }
        });
    if let Err(error) = spawned {
        tracing::warn!(%error, "Could not schedule the auto redact model release");
        WARM_MODEL
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
    }
}

fn model_version(model_dir: Option<&Path>) -> String {
    model_dir
        .and_then(|dir| std::fs::read(dir.join("meta.json")).ok())
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        .and_then(|meta| meta.get("version")?.as_str().map(str::to_string))
        .unwrap_or_else(|| MODEL_VERSION.to_string())
}

fn first_frame_fingerprint(path: &Path) -> anyhow::Result<String> {
    let mut frames = cap_redact::frames::FrameSource::open(path)?;
    let mut first = None;
    frames.for_each(|frames, frame| {
        first = Some(frames.gray(&frame.video)?);
        Ok(false)
    })?;
    let first = first.ok_or_else(|| anyhow::anyhow!("video has no frames"))?;
    Ok(cap_redact::frames::fingerprint(path, &first))
}

/// The saved scan when it already covers every segment as recorded now,
/// with this model, so opening the editor needs no model at all.
fn reusable_scan(
    previous: Option<&Redactions>,
    sources: &[cap_redact::SegmentSource],
    model: &str,
) -> bool {
    let Some(previous) = previous else {
        return false;
    };
    if previous.model != model || !previous.is_complete() || sources.is_empty() {
        return false;
    }
    sources.iter().all(|source| {
        previous.segment(source.index).is_some_and(|segment| {
            first_frame_fingerprint(&source.path)
                .is_ok_and(|fingerprint| fingerprint == segment.fingerprint)
        })
    })
}

fn publish(scan: &Scan, snapshot: Redactions, progress: f32) {
    let mut shared = scan.lock();
    shared.progress = progress;
    shared.snapshot = Some(Arc::new(snapshot));
    shared.snapshot_generation += 1;
}

fn run(scan: &Scan) -> anyhow::Result<()> {
    let project = scan.project.as_path();
    let cancel = &scan.cancel;
    let sources = cap_redact::segment_sources(project)?;
    let previous = Redactions::load(project);
    let installed = installed_model_dir();
    if reusable_scan(
        previous.as_ref(),
        &sources,
        &model_version(installed.as_deref()),
    ) && let Some(previous) = previous.clone()
    {
        tracing::info!(
            segments = sources.len(),
            "Auto redact reused the saved scan"
        );
        publish(scan, previous, 1.0);
        return Ok(());
    }
    let model_dir = match installed {
        Some(dir) => dir,
        None => download_model(cancel)?,
    };
    let mut model = take_model(&model_dir)?;
    let mut stats = cap_redact::Stats::default();
    scan.lock().phase = JobPhase::Scanning;
    let mut analyzer = cap_redact::Analyzer::new(&mut model);
    analyzer.cancel = cancel.clone();
    let analyzed = analyzer.analyze(
        &sources,
        previous.as_ref(),
        |progress| {
            let fraction = scan.lock().durations.as_ref().map_or(0.0, |durations| {
                let before: f64 = durations.iter().take(progress.segment as usize).sum();
                let total: f64 = durations.iter().sum::<f64>().max(1e-3);
                ((before + progress.source_time) / total).clamp(0.0, 1.0) as f32
            });
            publish(scan, progress.snapshot.clone(), fraction);
        },
        &mut stats,
    );
    drop(analyzer);
    keep_model(model_dir, model);
    let result = analyzed?;
    result
        .save(project)
        .map_err(|error| anyhow::anyhow!("save {}: {error}", REDACTIONS_FILE))?;
    tracing::info!(
        regions = result.regions.len(),
        frames = stats.frames,
        seconds = stats.total.as_secs_f64(),
        source_seconds = stats.source_seconds,
        "Auto redact analysis finished"
    );
    publish(scan, result, 1.0);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_scan(project: &Path, background: bool) -> Arc<Scan> {
        let scan = Arc::new(Scan {
            project: project.to_path_buf(),
            shared: Mutex::new(Shared {
                phase: JobPhase::Scanning,
                progress: 0.25,
                durations: None,
                snapshot: None,
                snapshot_generation: 0,
            }),
            cancel: Arc::new(AtomicBool::new(false)),
            background: AtomicBool::new(background),
            watchers: AtomicUsize::new(0),
        });
        SCANS
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(scan_key(project), Arc::downgrade(&scan));
        scan
    }

    /// An editor opened on a recording whose scan is already running
    /// watches that scan, hands it the durations it lacked, and leaves it
    /// running when it closes; an editor-started scan stops with its editor.
    #[test]
    fn editor_attaches_to_a_running_background_scan() {
        let dir = tempfile::tempdir().unwrap();
        let running = test_scan(dir.path(), true);
        let job = RedactJob::attach_or_start(dir.path().to_path_buf(), vec![12.0]);
        assert!(Arc::ptr_eq(&job.scan, &running));
        assert_eq!(running.lock().durations, Some(vec![12.0]));
        assert!(is_scanning(dir.path()));
        drop(job);
        assert!(!running.cancel.load(Ordering::Relaxed));

        let other = tempfile::tempdir().unwrap();
        let editor_scan = test_scan(other.path(), false);
        let job = RedactJob::attach_or_start(other.path().to_path_buf(), vec![3.0]);
        assert!(Arc::ptr_eq(&job.scan, &editor_scan));
        drop(job);
        assert!(editor_scan.cancel.load(Ordering::Relaxed));
    }

    /// Turning auto redact off in the editor stops a background scan too.
    #[test]
    fn cancel_stops_a_background_scan() {
        let dir = tempfile::tempdir().unwrap();
        let running = test_scan(dir.path(), true);
        let job = RedactJob::attach_or_start(dir.path().to_path_buf(), vec![1.0]);
        job.cancel();
        drop(job);
        assert!(running.cancel.load(Ordering::Relaxed));
        assert!(!running.background.load(Ordering::Relaxed));
    }

    /// A saved scan is reused only when it is complete, made by this model,
    /// and covers every segment.
    #[test]
    fn saved_scan_needs_this_model_and_every_segment() {
        let complete = Redactions {
            version: cap_project::redaction::REDACTIONS_VERSION,
            model: "m1".into(),
            segments: vec![cap_project::redaction::RedactionSegment {
                index: 0,
                source_frames: 30,
                fps: 30.0,
                width: 1920,
                height: 1080,
                fingerprint: "1-2-3".into(),
                complete: true,
            }],
            regions: Vec::new(),
            scanner: 0,
        };
        assert!(complete.is_complete());
        assert!(!reusable_scan(None, &[], "m1"));
        assert!(!reusable_scan(Some(&complete), &[], "m1"));
        let source = cap_redact::SegmentSource {
            index: 0,
            path: PathBuf::from("/nonexistent/display.mp4"),
        };
        assert!(!reusable_scan(
            Some(&complete),
            std::slice::from_ref(&source),
            "m1"
        ));
        assert!(!reusable_scan(
            Some(&complete),
            std::slice::from_ref(&source),
            "m2"
        ));
    }
}
