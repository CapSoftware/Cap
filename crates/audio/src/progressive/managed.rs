use super::{DecodedAudio, LoadState, PendingBlocks, ProgressiveAudio};
use crate::AudioStream;
use cap_enc_ffmpeg::RelocatableSource;
use std::{
    fmt,
    path::{Component, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread::JoinHandle,
};
use tokio::sync::watch;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ManagedAudioError {
    InvalidInput,
    RuntimeUnavailable(String),
    ThreadSpawn(String),
}

impl fmt::Display for ManagedAudioError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidInput => {
                formatter.write_str("Managed audio requires a relative file path")
            }
            Self::RuntimeUnavailable(error) => write!(formatter, "Managed audio runtime: {error}"),
            Self::ThreadSpawn(error) => write!(formatter, "Managed audio thread: {error}"),
        }
    }
}

impl std::error::Error for ManagedAudioError {}

pub struct ManagedAudioInput {
    source: RelocatableSource,
    relative_path: PathBuf,
}

impl ManagedAudioInput {
    pub fn new(
        source: RelocatableSource,
        relative_path: PathBuf,
    ) -> Result<Self, ManagedAudioError> {
        if relative_path.as_os_str().is_empty()
            || relative_path
                .components()
                .any(|component| !matches!(component, Component::Normal(_)))
        {
            return Err(ManagedAudioError::InvalidInput);
        }
        Ok(Self {
            source,
            relative_path,
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ManagedAudioTerminal {
    Complete { frames: usize, channels: u16 },
    Failed(String),
    Cancelled,
    WorkerPanicked,
}

impl fmt::Display for ManagedAudioTerminal {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Complete { frames, channels } => {
                write!(
                    formatter,
                    "Managed audio completed: {frames} frames, {channels} channels"
                )
            }
            Self::Failed(error) => formatter.write_str(error),
            Self::Cancelled => formatter.write_str("Managed audio cancelled"),
            Self::WorkerPanicked => formatter.write_str("Managed audio worker panicked"),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ManagedAudioExit {
    pub terminal: ManagedAudioTerminal,
}

#[derive(Clone, Default)]
struct ManagedAudioState {
    terminal: Option<ManagedAudioTerminal>,
    exit: Option<ManagedAudioExit>,
}

struct ManagedAudioControl {
    cancelled: Arc<AtomicBool>,
    state: watch::Sender<ManagedAudioState>,
    join: Mutex<Option<JoinHandle<()>>>,
    runtime: tokio::runtime::Handle,
}

impl ManagedAudioControl {
    fn finish(&self, terminal: ManagedAudioTerminal) -> ManagedAudioTerminal {
        self.state.send_if_modified(|state| {
            if state.terminal.is_some() {
                false
            } else {
                state.terminal = Some(terminal.clone());
                true
            }
        });
        self.state.borrow().terminal.clone().unwrap_or(terminal)
    }

    fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
        self.finish(ManagedAudioTerminal::Cancelled);
    }

    fn joined(&self, panicked: bool) {
        let terminal = self.finish(if panicked {
            ManagedAudioTerminal::WorkerPanicked
        } else {
            ManagedAudioTerminal::Failed("Managed audio worker exited without a result".into())
        });
        self.state.send_modify(|state| {
            state.exit = Some(ManagedAudioExit { terminal });
        });
    }
}

#[derive(Clone)]
pub struct ManagedAudioStopHandle {
    control: Arc<ManagedAudioControl>,
}

impl ManagedAudioStopHandle {
    pub fn cancel(&self) {
        self.control.cancel();
    }

    pub fn terminal(&self) -> Option<ManagedAudioTerminal> {
        self.control.state.borrow().terminal.clone()
    }

    pub async fn wait(&self) -> ManagedAudioExit {
        let join = self
            .control
            .join
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
        if let Some(join) = join {
            let control = self.control.clone();
            drop(self.control.runtime.spawn_blocking(move || {
                control.joined(join.join().is_err());
            }));
        }
        let mut state = self.control.state.subscribe();
        loop {
            if let Some(exit) = state.borrow_and_update().exit.clone() {
                return exit;
            }
            state
                .changed()
                .await
                .expect("Managed audio owner retains the completion sender");
        }
    }

    pub async fn stop_and_wait(&self) -> ManagedAudioExit {
        self.cancel();
        self.wait().await
    }
}

pub struct ManagedProgressiveAudio {
    loader: ProgressiveAudio,
    stop: ManagedAudioStopHandle,
}

impl ManagedProgressiveAudio {
    pub fn spawn(input: ManagedAudioInput, label: String) -> Result<Self, ManagedAudioError> {
        Self::spawn_worker(label, move |pending, progress, cancelled| {
            let ManagedAudioInput {
                source,
                relative_path,
            } = input;
            let result =
                AudioStream::open_relocatable(&source, [relative_path.as_path()], cancelled)
                    .map_err(|error| error.to_string())
                    .and_then(|stream| ProgressiveAudio::decode_stream(stream, pending, progress));
            drop(source);
            result
        })
    }

    fn spawn_worker(
        label: String,
        decode: impl FnOnce(
            &Mutex<PendingBlocks>,
            &watch::Sender<LoadState>,
            Arc<AtomicBool>,
        ) -> Result<Arc<DecodedAudio>, String>
        + Send
        + 'static,
    ) -> Result<Self, ManagedAudioError> {
        let runtime = tokio::runtime::Handle::try_current()
            .map_err(|error| ManagedAudioError::RuntimeUnavailable(error.to_string()))?;
        let (state, _) = watch::channel(ManagedAudioState::default());
        let control = Arc::new(ManagedAudioControl {
            cancelled: Arc::new(AtomicBool::new(false)),
            state,
            join: Mutex::new(None),
            runtime,
        });
        let (progress_tx, rx) = watch::channel(LoadState::default());
        let (complete_tx, complete) = watch::channel(None);
        let pending = Arc::new(Mutex::new(PendingBlocks::default()));
        let worker_control = control.clone();
        let worker_pending = pending.clone();
        let join = std::thread::Builder::new()
            .name("cap-managed-audio".into())
            .spawn(move || {
                let decoded = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    decode(
                        &worker_pending,
                        &progress_tx,
                        worker_control.cancelled.clone(),
                    )
                }));
                let (result, proposed_terminal) = match decoded {
                    Ok(Ok(audio)) => {
                        let terminal = ManagedAudioTerminal::Complete {
                            frames: audio.sample_count(),
                            channels: audio.channels(),
                        };
                        (Ok(Some(audio)), terminal)
                    }
                    Ok(Err(error)) => {
                        let error = format!("{label} / {error}");
                        (Err(error.clone()), ManagedAudioTerminal::Failed(error))
                    }
                    Err(_) => (
                        Err(ManagedAudioTerminal::WorkerPanicked.to_string()),
                        ManagedAudioTerminal::WorkerPanicked,
                    ),
                };
                let terminal = worker_control.finish(proposed_terminal);
                let result = if matches!(terminal, ManagedAudioTerminal::Complete { .. }) {
                    result
                } else {
                    Err(terminal.to_string())
                };
                if result.is_err()
                    && let Ok(mut pending) = worker_pending.lock()
                {
                    pending.blocks.clear();
                }
                let mut state = progress_tx.borrow().clone();
                state.progress.complete = result.is_ok();
                state.progress.error = result.as_ref().err().cloned();
                if let Ok(Some(audio)) = &result {
                    state.progress.ready_frames = audio.sample_count();
                    state.progress.channels = Some(audio.channels());
                }
                state.result = Some(result.clone());
                progress_tx.send_replace(state);
                complete_tx.send_replace(Some(result));
            })
            .map_err(|error| ManagedAudioError::ThreadSpawn(error.to_string()))?;
        *control
            .join
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(join);
        Ok(Self {
            loader: ProgressiveAudio {
                rx,
                complete,
                pending,
            },
            stop: ManagedAudioStopHandle { control },
        })
    }

    pub fn loader(&self) -> &ProgressiveAudio {
        &self.loader
    }

    pub fn stop_handle(&self) -> ManagedAudioStopHandle {
        self.stop.clone()
    }
}

impl Drop for ManagedProgressiveAudio {
    fn drop(&mut self) {
        self.stop.cancel();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{AudioData, AudioSampleSource, ChunkRead};
    use std::{io::Write, path::Path, sync::mpsc, time::Duration};

    const TIMEOUT: Duration = Duration::from_secs(5);

    fn wave(path: &Path) {
        let frames = 100_003_u32;
        let channels = 2_u16;
        let bytes = frames * u32::from(channels) * 2;
        let mut file = std::fs::File::create(path).unwrap();
        file.write_all(b"RIFF").unwrap();
        file.write_all(&(bytes + 36).to_le_bytes()).unwrap();
        file.write_all(b"WAVEfmt ").unwrap();
        file.write_all(&16_u32.to_le_bytes()).unwrap();
        file.write_all(&1_u16.to_le_bytes()).unwrap();
        file.write_all(&channels.to_le_bytes()).unwrap();
        file.write_all(&48_000_u32.to_le_bytes()).unwrap();
        file.write_all(&(48_000 * u32::from(channels) * 2).to_le_bytes())
            .unwrap();
        file.write_all(&(channels * 2).to_le_bytes()).unwrap();
        file.write_all(&16_u16.to_le_bytes()).unwrap();
        file.write_all(b"data").unwrap();
        file.write_all(&bytes.to_le_bytes()).unwrap();
        for frame in 0..frames {
            for channel in 0..channels {
                let sample = ((frame * 17 + u32::from(channel) * 971) % 60_000) as i32 - 30_000;
                file.write_all(&(sample as i16).to_le_bytes()).unwrap();
            }
        }
    }

    struct Owner {
        dropped: Arc<AtomicBool>,
        gate: Option<(mpsc::Sender<()>, Mutex<mpsc::Receiver<()>>)>,
    }

    impl Drop for Owner {
        fn drop(&mut self) {
            if let Some((entered, release)) = &self.gate {
                entered.send(()).unwrap();
                release.lock().unwrap().recv_timeout(TIMEOUT).unwrap();
            }
            self.dropped.store(true, Ordering::Release);
        }
    }

    fn input(root: &Path, dropped: Arc<AtomicBool>) -> ManagedAudioInput {
        ManagedAudioInput::new(
            RelocatableSource::new_with_owner(
                root.to_path_buf(),
                Arc::new(Owner {
                    dropped,
                    gate: None,
                }),
            )
            .unwrap(),
            PathBuf::from("audio.wav"),
        )
        .unwrap()
    }

    fn assert_released(path: &Path) {
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            let file = std::fs::OpenOptions::new()
                .read(true)
                .share_mode(0)
                .open(path)
                .unwrap();
            drop(file);
        }
        let renamed = path.with_extension("retained.wav");
        std::fs::rename(path, &renamed).unwrap();
        std::fs::rename(&renamed, path).unwrap();
    }

    #[test]
    fn managed_input_rejects_escaping_and_empty_paths() {
        let root = tempfile::tempdir().unwrap();
        for path in ["", ".", "..", "../audio.wav", "folder/../audio.wav"] {
            assert!(matches!(
                ManagedAudioInput::new(
                    RelocatableSource::new(root.path().to_path_buf()).unwrap(),
                    PathBuf::from(path),
                ),
                Err(ManagedAudioError::InvalidInput)
            ));
        }
        assert!(matches!(
            ManagedAudioInput::new(
                RelocatableSource::new(root.path().to_path_buf()).unwrap(),
                root.path().join("audio.wav"),
            ),
            Err(ManagedAudioError::InvalidInput)
        ));
    }

    #[tokio::test]
    async fn managed_pcm_and_eof_match_ordinary_and_completed_handoff_reuses_the_arc() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("audio.wav");
        wave(&path);
        let expected = AudioData::from_file(&path).unwrap();
        let dropped = Arc::new(AtomicBool::new(false));
        let managed = ManagedProgressiveAudio::spawn(
            input(directory.path(), dropped.clone()),
            "managed test".into(),
        )
        .unwrap();
        let stop = managed.stop_handle();
        let result = tokio::time::timeout(TIMEOUT, managed.loader().get())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert!(dropped.load(Ordering::Acquire));
        assert_eq!(result.channels(), expected.channels());
        assert_eq!(result.sample_count(), expected.sample_count());
        assert!(
            result
                .sample_slices()
                .flatten()
                .zip(expected.samples())
                .all(|(actual, expected)| actual.to_bits() == expected.to_bits())
        );
        assert!(result.sample(expected.samples().len()).is_none());
        let handoff = ProgressiveAudio::from_result(Ok(Some(result.clone())));
        assert!(Arc::ptr_eq(&result, &handoff.get().await.unwrap().unwrap()));
        let exit = stop.wait().await;
        assert_eq!(
            exit.terminal,
            ManagedAudioTerminal::Complete {
                frames: expected.sample_count(),
                channels: expected.channels(),
            }
        );
        assert_released(&path);
        drop(managed);
        assert_eq!(stop.wait().await, exit);
        assert_eq!(handoff.progress().ready_frames, expected.sample_count());
    }

    #[tokio::test]
    async fn completed_absence_and_failure_preserve_loader_semantics() {
        let absent = ProgressiveAudio::from_result(Ok(None));
        assert_eq!(absent.progress(), ProgressiveAudio::none().progress());
        assert!(absent.get().await.unwrap().is_none());
        assert!(absent.window(0..100).await.unwrap().is_none());
        let failure = ProgressiveAudio::from_result(Err("source failed".into()));
        assert!(!failure.progress().complete);
        assert_eq!(failure.progress().ready_frames, 0);
        assert_eq!(failure.progress().channels, None);
        assert_eq!(failure.progress().error.as_deref(), Some("source failed"));
        assert_eq!(failure.get().await.err().as_deref(), Some("source failed"));
        assert_eq!(
            failure.window(0..1).await.err().as_deref(),
            Some("source failed")
        );
    }

    #[tokio::test]
    async fn native_result_waits_for_owner_destruction_and_dropped_join_waiter_does_not_detach() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("audio.wav");
        wave(&path);
        let dropped = Arc::new(AtomicBool::new(false));
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let source = RelocatableSource::new_with_owner(
            directory.path().to_path_buf(),
            Arc::new(Owner {
                dropped: dropped.clone(),
                gate: Some((entered_tx, Mutex::new(release_rx))),
            }),
        )
        .unwrap();
        let managed = ManagedProgressiveAudio::spawn(
            ManagedAudioInput::new(source, PathBuf::from("audio.wav")).unwrap(),
            "owner gate".into(),
        )
        .unwrap();
        entered_rx.recv_timeout(TIMEOUT).unwrap();
        assert!(!dropped.load(Ordering::Acquire));
        assert!(!managed.loader().progress().complete);
        assert!(
            tokio::time::timeout(Duration::from_millis(10), managed.loader().get())
                .await
                .is_err()
        );
        let stop = managed.stop_handle();
        assert!(
            tokio::time::timeout(Duration::from_millis(10), stop.wait())
                .await
                .is_err()
        );
        release_tx.send(()).unwrap();
        assert!(managed.loader().get().await.unwrap().is_some());
        let exit = tokio::time::timeout(TIMEOUT, stop.wait()).await.unwrap();
        assert!(matches!(
            exit.terminal,
            ManagedAudioTerminal::Complete { .. }
        ));
        assert!(dropped.load(Ordering::Acquire));
        assert_released(&path);
    }

    #[tokio::test]
    async fn cancellation_before_native_open_and_after_native_read_joins_and_never_validates() {
        for read_first in [false, true] {
            let directory = tempfile::tempdir().unwrap();
            let path = directory.path().join("audio.wav");
            wave(&path);
            let dropped = Arc::new(AtomicBool::new(false));
            let input = input(directory.path(), dropped.clone());
            let (entered_tx, entered_rx) = mpsc::channel();
            let (release_tx, release_rx) = mpsc::channel();
            let managed = ManagedProgressiveAudio::spawn_worker(
                "cancelled native".into(),
                move |pending, progress, cancelled| {
                    if read_first {
                        let mut stream = AudioStream::open_relocatable(
                            &input.source,
                            [input.relative_path.as_path()],
                            cancelled,
                        )
                        .map_err(|error| error.to_string())?;
                        assert!(matches!(stream.read_chunk(7).unwrap(), ChunkRead::Chunk(_)));
                        entered_tx.send(()).unwrap();
                        release_rx.recv_timeout(TIMEOUT).unwrap();
                        let error = stream.read_chunk(7).unwrap_err();
                        assert!(error.is_cancelled());
                        assert_eq!(error.next_sample, 7);
                        Err(error.to_string())
                    } else {
                        entered_tx.send(()).unwrap();
                        release_rx.recv_timeout(TIMEOUT).unwrap();
                        let stream = AudioStream::open_relocatable(
                            &input.source,
                            [input.relative_path.as_path()],
                            cancelled,
                        )
                        .map_err(|error| error.to_string())?;
                        ProgressiveAudio::decode_stream(stream, pending, progress)
                    }
                },
            )
            .unwrap();
            entered_rx.recv_timeout(TIMEOUT).unwrap();
            let stop = managed.stop_handle();
            stop.cancel();
            assert!(!dropped.load(Ordering::Acquire));
            release_tx.send(()).unwrap();
            assert!(managed.loader().get().await.is_err());
            assert!(!managed.loader().progress().complete);
            assert_eq!(stop.wait().await.terminal, ManagedAudioTerminal::Cancelled);
            assert!(dropped.load(Ordering::Acquire));
            assert_released(&path);
        }
    }

    #[tokio::test]
    async fn dropping_managed_owner_cancels_without_releasing_active_source_early() {
        let directory = tempfile::tempdir().unwrap();
        let dropped = Arc::new(AtomicBool::new(false));
        let input = input(directory.path(), dropped.clone());
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let managed =
            ManagedProgressiveAudio::spawn_worker("drop owner".into(), move |_, _, cancelled| {
                entered_tx.send(()).unwrap();
                release_rx.recv_timeout(TIMEOUT).unwrap();
                assert!(cancelled.load(Ordering::Acquire));
                drop(input);
                Err("cancelled owner".into())
            })
            .unwrap();
        entered_rx.recv_timeout(TIMEOUT).unwrap();
        let loader = managed.loader().clone();
        let stop = managed.stop_handle();
        drop(managed);
        assert_eq!(stop.terminal(), Some(ManagedAudioTerminal::Cancelled));
        assert!(!dropped.load(Ordering::Acquire));
        release_tx.send(()).unwrap();
        assert!(loader.get().await.is_err());
        assert_eq!(stop.wait().await.terminal, ManagedAudioTerminal::Cancelled);
        assert!(dropped.load(Ordering::Acquire));
    }

    #[tokio::test]
    async fn native_failure_and_worker_panic_release_sources_and_preserve_errors() {
        let directory = tempfile::tempdir().unwrap();
        let dropped = Arc::new(AtomicBool::new(false));
        let managed = ManagedProgressiveAudio::spawn(
            input(directory.path(), dropped.clone()),
            "missing audio".into(),
        )
        .unwrap();
        let error = managed.loader().get().await.err().unwrap();
        assert!(error.starts_with("missing audio / input-open /"));
        assert!(dropped.load(Ordering::Acquire));
        assert_eq!(
            managed.stop_handle().wait().await.terminal,
            ManagedAudioTerminal::Failed(error)
        );
        let dropped = Arc::new(AtomicBool::new(false));
        let input = input(directory.path(), dropped.clone());
        let managed =
            ManagedProgressiveAudio::spawn_worker("panic audio".into(), move |_, _, _| {
                let _input = input;
                panic!("injected managed audio failure");
            })
            .unwrap();
        assert!(managed.loader().get().await.is_err());
        assert!(dropped.load(Ordering::Acquire));
        assert_eq!(
            managed.stop_handle().wait().await.terminal,
            ManagedAudioTerminal::WorkerPanicked
        );
    }

    #[tokio::test]
    async fn a_native_error_after_valid_pcm_never_becomes_validated_audio() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("audio.wav");
        wave(&path);
        std::fs::OpenOptions::new()
            .write(true)
            .open(&path)
            .unwrap()
            .set_len(44 + (super::super::BLOCK_FRAMES * 4) as u64 + 3)
            .unwrap();
        assert!(AudioData::from_file(&path).is_err());
        let dropped = Arc::new(AtomicBool::new(false));
        let managed = ManagedProgressiveAudio::spawn(
            input(directory.path(), dropped.clone()),
            "late native failure".into(),
        )
        .unwrap();
        assert!(managed.loader().get().await.is_err());
        let progress = managed.loader().progress();
        assert!(progress.ready_frames > 0);
        assert!(!progress.complete);
        assert!(progress.error.is_some());
        assert!(managed.loader().window(0..1).await.is_err());
        assert!(matches!(
            managed.stop_handle().wait().await.terminal,
            ManagedAudioTerminal::Failed(_)
        ));
        assert!(dropped.load(Ordering::Acquire));
        assert_released(&path);
    }

    #[tokio::test]
    async fn opened_managed_audio_reads_original_bytes_across_source_publication() {
        let directory = tempfile::tempdir().unwrap();
        let original = directory.path().join("original");
        let retained = directory.path().join("retained");
        std::fs::create_dir(&original).unwrap();
        let path = original.join("audio.wav");
        wave(&path);
        let expected = AudioData::from_file(&path).unwrap();
        let dropped = Arc::new(AtomicBool::new(false));
        let source = RelocatableSource::new_with_owner(
            original.clone(),
            Arc::new(Owner {
                dropped: dropped.clone(),
                gate: None,
            }),
        )
        .unwrap();
        let input = ManagedAudioInput::new(source.clone(), PathBuf::from("audio.wav")).unwrap();
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let managed = ManagedProgressiveAudio::spawn_worker(
            "publication".into(),
            move |pending, progress, cancelled| {
                let stream = AudioStream::open_relocatable(
                    &input.source,
                    [input.relative_path.as_path()],
                    cancelled,
                )
                .map_err(|error| error.to_string())?;
                entered_tx.send(()).unwrap();
                release_rx.recv_timeout(TIMEOUT).unwrap();
                ProgressiveAudio::decode_stream(stream, pending, progress)
            },
        )
        .unwrap();
        entered_rx.recv_timeout(TIMEOUT).unwrap();
        source.relocate(retained.clone()).unwrap();
        std::fs::create_dir(&original).unwrap();
        std::fs::write(&path, b"published replacement").unwrap();
        release_tx.send(()).unwrap();
        let audio = managed.loader().get().await.unwrap().unwrap();
        assert_eq!(audio.sample_count(), expected.sample_count());
        assert!(
            audio
                .sample_slices()
                .flatten()
                .zip(expected.samples())
                .all(|(actual, expected)| actual.to_bits() == expected.to_bits())
        );
        assert!(matches!(
            managed.stop_handle().wait().await.terminal,
            ManagedAudioTerminal::Complete { .. }
        ));
        drop(source);
        assert!(dropped.load(Ordering::Acquire));
        assert_eq!(std::fs::read(&path).unwrap(), b"published replacement");
        assert_released(&retained.join("audio.wav"));
    }

    #[tokio::test]
    #[ignore = "Requires CAP_MANAGED_AUDIO_FIXTURE_ROOT and CAP_MANAGED_AUDIO_FIXTURE_PATH"]
    async fn canonical_audio_matches_independent_stream_through_eof() {
        let root = PathBuf::from(std::env::var_os("CAP_MANAGED_AUDIO_FIXTURE_ROOT").unwrap());
        let relative = PathBuf::from(std::env::var_os("CAP_MANAGED_AUDIO_FIXTURE_PATH").unwrap());
        let canonical = root.join(&relative);
        let managed = ManagedProgressiveAudio::spawn(
            ManagedAudioInput::new(RelocatableSource::new(root).unwrap(), relative).unwrap(),
            "canonical audio".into(),
        )
        .unwrap();
        let audio = managed.loader().get().await.unwrap().unwrap();
        let mut oracle = AudioStream::open(&canonical, Arc::new(AtomicBool::new(false))).unwrap();
        let mut compared = 0_usize;
        loop {
            match oracle.read_chunk(12_000).unwrap() {
                ChunkRead::Chunk(chunk) => {
                    assert_eq!(chunk.channels, audio.channels());
                    assert_eq!(chunk.source_start_sample as usize, compared);
                    let first = compared * usize::from(chunk.channels);
                    for (index, sample) in chunk.samples.iter().enumerate() {
                        assert_eq!(
                            audio.sample(first + index).unwrap().to_bits(),
                            sample.to_bits()
                        );
                    }
                    compared += chunk.samples.len() / usize::from(chunk.channels);
                }
                ChunkRead::Eof { next_sample } => {
                    assert_eq!(next_sample as usize, compared);
                    assert_eq!(audio.sample_count(), compared);
                    break;
                }
            }
        }
        assert!(compared > 0);
        assert!(matches!(
            managed.stop_handle().wait().await.terminal,
            ManagedAudioTerminal::Complete { .. }
        ));
    }
}
