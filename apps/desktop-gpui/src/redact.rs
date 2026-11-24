//! Auto redact's background work: fetching the text model once, then
//! analysing the recording on a thread of its own while the editor shows
//! what has been found so far.

use std::{
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex, PoisonError,
        atomic::{AtomicBool, Ordering},
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
    snapshot: Option<Arc<Redactions>>,
    snapshot_generation: u64,
}

/// What the editor reads back on each poll.
pub struct JobUpdate {
    pub phase: JobPhase,
    pub progress: f32,
    pub snapshot: Option<Arc<Redactions>>,
}

pub struct RedactJob {
    shared: Arc<Mutex<Shared>>,
    cancel: Arc<AtomicBool>,
    seen_generation: u64,
}

impl RedactJob {
    /// Starts analysing `project`, whose display videos last `durations`
    /// seconds each, on a background thread.
    pub fn start(project: PathBuf, durations: Vec<f64>) -> Self {
        let shared = Arc::new(Mutex::new(Shared {
            phase: JobPhase::Preparing,
            progress: 0.0,
            snapshot: None,
            snapshot_generation: 0,
        }));
        let cancel = Arc::new(AtomicBool::new(false));
        let thread_shared = shared.clone();
        let thread_cancel = cancel.clone();
        let spawned = std::thread::Builder::new()
            .name("cap-auto-redact".into())
            .stack_size(16 * 1024 * 1024)
            .spawn(move || {
                let result = run(&project, &durations, &thread_shared, &thread_cancel);
                let mut shared = thread_shared.lock().unwrap_or_else(PoisonError::into_inner);
                shared.phase = match result {
                    Ok(()) => JobPhase::Done,
                    Err(_) if thread_cancel.load(Ordering::Relaxed) => JobPhase::Cancelled,
                    Err(error) => {
                        tracing::warn!(%error, "Auto redact analysis failed");
                        JobPhase::Failed(format!("{error:#}"))
                    }
                };
            });
        if let Err(error) = spawned {
            shared.lock().unwrap_or_else(PoisonError::into_inner).phase =
                JobPhase::Failed(error.to_string());
        }
        Self {
            shared,
            cancel,
            seen_generation: 0,
        }
    }

    pub fn poll(&mut self) -> JobUpdate {
        let shared = self.shared.lock().unwrap_or_else(PoisonError::into_inner);
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

    pub fn cancel(&self) {
        self.cancel.store(true, Ordering::Relaxed);
    }
}

impl Drop for RedactJob {
    fn drop(&mut self) {
        self.cancel();
    }
}

fn run(
    project: &Path,
    durations: &[f64],
    shared: &Arc<Mutex<Shared>>,
    cancel: &Arc<AtomicBool>,
) -> anyhow::Result<()> {
    let model_dir = match installed_model_dir() {
        Some(dir) => dir,
        None => download_model(cancel)?,
    };
    let mut model = cap_redact::OcrModel::load(&model_dir)?;
    let sources = cap_redact::segment_sources(project)?;
    let previous = Redactions::load(project);
    let total: f64 = durations.iter().sum::<f64>().max(1e-3);
    let mut stats = cap_redact::Stats::default();
    shared.lock().unwrap_or_else(PoisonError::into_inner).phase = JobPhase::Scanning;
    let mut analyzer = cap_redact::Analyzer::new(&mut model);
    analyzer.cancel = cancel.clone();
    let result = analyzer.analyze(
        &sources,
        previous.as_ref(),
        |progress| {
            let before: f64 = durations.iter().take(progress.segment as usize).sum();
            let fraction = ((before + progress.source_time) / total).clamp(0.0, 1.0) as f32;
            let mut shared = shared.lock().unwrap_or_else(PoisonError::into_inner);
            shared.progress = fraction;
            shared.snapshot = Some(Arc::new(progress.snapshot.clone()));
            shared.snapshot_generation += 1;
        },
        &mut stats,
    )?;
    result
        .save(project)
        .map_err(|error| anyhow::anyhow!("save {}: {error}", REDACTIONS_FILE))?;
    tracing::info!(
        regions = result.regions.len(),
        seconds = stats.total.as_secs_f64(),
        source_seconds = stats.source_seconds,
        "Auto redact analysis finished"
    );
    let mut shared = shared.lock().unwrap_or_else(PoisonError::into_inner);
    shared.progress = 1.0;
    shared.snapshot = Some(Arc::new(result));
    shared.snapshot_generation += 1;
    Ok(())
}
