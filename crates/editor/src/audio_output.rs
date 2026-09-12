//! Persistent audio output for editor playback.
//!
//! One cpal output stream per editor session, playing silence while paused.
//! Pressing play installs a source into the live callback instead of opening
//! a new device stream per press — the device (Bluetooth included) is already
//! awake, so audio starts within one callback period of the playback clock
//! rather than after a device wake that could take seconds. The stream is
//! rebuilt only when the default output device changes or the stream errors.

use std::{
    sync::{
        Arc, Mutex, OnceLock,
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc as std_mpsc,
    },
    time::{Duration, Instant},
};

use cap_audio::{AudioData, FromSampleBytes};
#[cfg(not(target_os = "windows"))]
use cap_audio::{LatencyCorrectionConfig, LatencyCorrector, default_output_latency_hint};
use cap_media_info::AudioInfo;
use cap_project::ProjectConfiguration;
use cpal::{
    SampleFormat,
    traits::{DeviceTrait, HostTrait, StreamTrait},
};
use tokio::sync::watch;
use tracing::{error, info};

use crate::audio::{AudioSegment, MusicTracks, PrerenderedAudioBuffer};
use crate::preparing_audio::{
    PreparingAudioBuffer, PreparingAudioOutputHandle, PreparingAudioOutputSnapshot,
    PreparingAudioSources,
};

/// How long to wait for the live callback to acknowledge a newly installed
/// source before reporting "no audio". A running stream acknowledges within
/// one callback period; this bound only matters when the device dies at the
/// exact moment of install.
const SOURCE_ACK_TIMEOUT: Duration = Duration::from_secs(5);
/// Deadline for a whole play request (stream build + pre-render window + ack).
/// Freshly opened devices on slow transports (e.g. Bluetooth) can take
/// several seconds for their first callback.
const PLAY_REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
/// Bound on waiting for the initial pre-render window (normally a few ms).
const PRERENDER_READY_TIMEOUT: Duration = Duration::from_secs(2);

pub struct PlaySpec {
    pub segments: Vec<AudioSegment>,
    pub music: MusicTracks,
    pub project: ProjectConfiguration,
    pub duration_secs: f64,
    pub start_playhead_secs: f64,
    pub playhead_rx: watch::Receiver<f64>,
}

enum ControlMsg {
    Refresh {
        spec: Box<PlaySpec>,
        generation: u64,
        retire_tx: std_mpsc::Sender<ControlMsg>,
    },
    Retire(Box<dyn Send>),
    EnsureStream,
    Play {
        spec: Box<PlaySpec>,
        generation: u64,
        result_tx: std_mpsc::Sender<bool>,
    },
    PreparePlayback {
        spec: Box<PlaySpec>,
        generation: u64,
        request: Arc<PreparingAudioRequest>,
    },
    PrepareProgressivePlayback {
        sources: PreparingAudioSources,
        start_seconds: f64,
        generation: u64,
        installation: PreparingAudioInstallation,
    },
    StopPlayback {
        generation: u64,
    },
    Shutdown,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum PreparingAudioStatus {
    Pending,
    AwaitingCallback,
    Started,
    Unavailable,
    Cancelled,
}

struct PreparingAudioRequest {
    cancelled: AtomicBool,
    started: AtomicBool,
    deadline: Instant,
    ack_deadline: OnceLock<Instant>,
    status: watch::Sender<PreparingAudioStatus>,
    output: Mutex<Option<PreparingAudioOutputHandle>>,
    installed: watch::Sender<bool>,
}

impl PreparingAudioRequest {
    fn new(timeout: Duration) -> Self {
        Self {
            cancelled: AtomicBool::new(false),
            started: AtomicBool::new(false),
            deadline: Instant::now() + timeout,
            ack_deadline: OnceLock::new(),
            status: watch::channel(PreparingAudioStatus::Pending).0,
            output: Mutex::new(None),
            installed: watch::channel(true).0,
        }
    }

    fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
            || (!self.started.load(Ordering::Acquire) && Instant::now() >= self.deadline())
    }

    fn deadline(&self) -> Instant {
        self.ack_deadline.get().copied().unwrap_or(self.deadline)
    }

    fn awaiting_callback(&self) {
        let _ = self
            .ack_deadline
            .set(self.deadline.min(Instant::now() + SOURCE_ACK_TIMEOUT));
        self.status.send_if_modified(|status| {
            if *status != PreparingAudioStatus::Pending {
                return false;
            }
            *status = PreparingAudioStatus::AwaitingCallback;
            true
        });
    }

    fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
        if let Some(output) = self
            .output
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .as_ref()
        {
            output.cancel();
        }
        self.status.send_replace(PreparingAudioStatus::Cancelled);
    }

    fn complete(&self, started: bool) {
        self.status.send_if_modified(|status| {
            if !matches!(
                status,
                PreparingAudioStatus::Pending | PreparingAudioStatus::AwaitingCallback
            ) {
                return false;
            }
            *status = if self.is_cancelled() {
                PreparingAudioStatus::Cancelled
            } else if started {
                self.started.store(true, Ordering::Release);
                PreparingAudioStatus::Started
            } else {
                self.cancelled.store(true, Ordering::Release);
                PreparingAudioStatus::Unavailable
            };
            true
        });
    }
}

struct PreparingAudioInstallation {
    request: Arc<PreparingAudioRequest>,
    runtime: tokio::runtime::Handle,
    playable_until: f64,
}

impl Drop for PreparingAudioInstallation {
    fn drop(&mut self) {
        self.request.installed.send_replace(true);
    }
}

pub(crate) struct PreparingAudioPlayTicket {
    generation: u64,
    request: Arc<PreparingAudioRequest>,
    control_tx: std_mpsc::Sender<ControlMsg>,
}

impl PreparingAudioPlayTicket {
    pub(crate) fn generation(&self) -> u64 {
        self.generation
    }

    pub(crate) fn output_handle(&self) -> Option<PreparingAudioOutputHandle> {
        self.request
            .output
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    pub(crate) fn set_playable_until(&self, seconds: f64) -> Result<(), String> {
        if let Some(output) = self
            .request
            .output
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .as_ref()
        {
            output.set_playable_until(seconds)?;
        }
        Ok(())
    }

    pub(crate) fn output_status(&self, now: Instant) -> Option<PreparingAudioOutputSnapshot> {
        self.request
            .output
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .as_ref()
            .map(|output| output.status(now))
    }

    pub(crate) async fn stop_and_wait(&self) -> Result<(), String> {
        self.cancel();
        let mut installed = self.request.installed.subscribe();
        tokio::time::timeout(PLAY_REQUEST_TIMEOUT, async {
            while !*installed.borrow_and_update() {
                installed
                    .changed()
                    .await
                    .map_err(|_| "Preparing audio installation owner ended".to_string())?;
            }
            Ok::<_, String>(())
        })
        .await
        .map_err(|_| "Preparing audio installation cleanup timed out".to_string())??;
        let output = self
            .request
            .output
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        if let Some(output) = output {
            tokio::time::timeout(PLAY_REQUEST_TIMEOUT, output.stop_and_wait())
                .await
                .map_err(|_| "Preparing audio source cleanup timed out".to_string())??;
        }
        Ok(())
    }

    pub(crate) async fn wait_started(&self) -> bool {
        let mut status = self.request.status.subscribe();
        loop {
            let current = *status.borrow_and_update();
            match current {
                PreparingAudioStatus::Started if !self.request.is_cancelled() => return true,
                PreparingAudioStatus::Pending | PreparingAudioStatus::AwaitingCallback => {}
                _ => {
                    self.cancel();
                    return false;
                }
            }
            if !matches!(
                tokio::time::timeout_at(self.request.deadline().into(), status.changed()).await,
                Ok(Ok(()))
            ) {
                self.cancel();
                return false;
            }
        }
    }

    pub(crate) fn cancel(&self) {
        self.request.cancel();
        let _ = self.control_tx.send(ControlMsg::StopPlayback {
            generation: self.generation,
        });
    }
}

impl Drop for PreparingAudioPlayTicket {
    fn drop(&mut self) {
        self.cancel();
    }
}

enum SourceAcknowledgement {
    Refresh(std_mpsc::Sender<ControlMsg>),
    Ordinary(std_mpsc::Sender<()>),
    Preparing(Arc<PreparingAudioRequest>),
}

impl SourceAcknowledgement {
    fn preparing_request(&self) -> Option<Arc<PreparingAudioRequest>> {
        match self {
            Self::Ordinary(_) | Self::Refresh(_) => None,
            Self::Preparing(request) => Some(request.clone()),
        }
    }

    fn consumed(self) {
        match &self {
            Self::Refresh(_) => {}
            Self::Ordinary(sender) => {
                let _ = sender.send(());
            }
            Self::Preparing(request) => request.complete(true),
        }
    }
}

impl Drop for SourceAcknowledgement {
    fn drop(&mut self) {
        if let Self::Preparing(request) = self {
            request.complete(false);
        }
    }
}

/// Handle to the editor session's shared audio output. Owned by the editor
/// instance; playback sessions attach and detach sources through it.
pub struct AudioOutput {
    control_tx: std_mpsc::Sender<ControlMsg>,
    next_generation: AtomicU64,
}

impl Default for AudioOutput {
    fn default() -> Self {
        Self::new()
    }
}

/// Sample rate of the headless sink; matches the pipeline's master clock.
pub const HEADLESS_SAMPLE_RATE: u32 = 48_000;
/// Channel count of the headless sink.
pub const HEADLESS_CHANNELS: u16 = 2;
/// Frames per pulled block in the headless sink (a typical device period).
pub const HEADLESS_BLOCK_FRAMES: usize = 512;

/// Receives every interleaved f32 block the headless sink pulls, together
/// with the deadline at which a real output device would start playing the
/// block's first sample.
pub type HeadlessAudioTap = Box<dyn FnMut(&[f32], Instant) + Send>;

impl AudioOutput {
    pub fn new() -> Self {
        let (control_tx, control_rx) = std_mpsc::channel();

        if let Err(e) = std::thread::Builder::new()
            .name("cap-audio-output".into())
            .spawn(move || control_thread(control_rx))
        {
            // Sends will fail and playback degrades to video-only, matching
            // the behaviour when no output device exists.
            error!("Failed to spawn audio output thread: {e}");
        }

        Self {
            control_tx,
            next_generation: AtomicU64::new(0),
        }
    }

    /// An output that renders into `tap` instead of a device, pulling blocks
    /// on a real-time schedule the way a sound card would. Runs the exact
    /// production source pipeline (pre-render buffer, playhead sync policy),
    /// so sync harnesses can observe what a device would have played without
    /// needing audio hardware.
    pub fn new_headless(tap: HeadlessAudioTap) -> Self {
        let (control_tx, control_rx) = std_mpsc::channel();

        if let Err(e) = std::thread::Builder::new()
            .name("cap-audio-headless".into())
            .spawn(move || control_thread_headless(control_rx, tap))
        {
            error!("Failed to spawn headless audio output thread: {e}");
        }

        Self {
            control_tx,
            next_generation: AtomicU64::new(0),
        }
    }

    /// Opens the output stream ahead of the first play so even the first
    /// press doesn't wait on the device (Bluetooth wake, etc.). Non-blocking.
    pub fn prewarm(&self) {
        let _ = self.control_tx.send(ControlMsg::EnsureStream);
    }

    /// Starts playing `spec` on the shared stream. Blocks until the live
    /// callback acknowledges that it is consuming the source, so the caller
    /// can start the playback clock knowing audio is audible. Returns a
    /// generation token for [`AudioOutput::stop_playback`], or `None` when
    /// audio output isn't available (playback then runs video-only).
    pub fn play(&self, spec: PlaySpec) -> Option<u64> {
        let generation = self.next_generation.fetch_add(1, Ordering::Relaxed);
        let (result_tx, result_rx) = std_mpsc::channel();

        self.control_tx
            .send(ControlMsg::Play {
                spec: Box::new(spec),
                generation,
                result_tx,
            })
            .ok()?;

        match result_rx.recv_timeout(PLAY_REQUEST_TIMEOUT) {
            Ok(true) => Some(generation),
            Ok(false) => None,
            Err(_) => {
                error!("Audio play request timed out");
                None
            }
        }
    }

    pub(crate) fn prepare_playback(&self, spec: PlaySpec) -> PreparingAudioPlayTicket {
        let generation = self.next_generation.fetch_add(1, Ordering::Relaxed);
        let request = Arc::new(PreparingAudioRequest::new(PLAY_REQUEST_TIMEOUT));
        let ticket = PreparingAudioPlayTicket {
            generation,
            request: request.clone(),
            control_tx: self.control_tx.clone(),
        };
        if self
            .control_tx
            .send(ControlMsg::PreparePlayback {
                spec: Box::new(spec),
                generation,
                request: request.clone(),
            })
            .is_err()
        {
            request.complete(false);
        }
        ticket
    }

    pub(crate) fn prepare_progressive_playback(
        &self,
        sources: PreparingAudioSources,
        start_seconds: f64,
        playable_until: f64,
    ) -> PreparingAudioPlayTicket {
        let generation = self.next_generation.fetch_add(1, Ordering::Relaxed);
        let request = Arc::new(PreparingAudioRequest::new(PLAY_REQUEST_TIMEOUT));
        request.installed.send_replace(false);
        let ticket = PreparingAudioPlayTicket {
            generation,
            request: request.clone(),
            control_tx: self.control_tx.clone(),
        };
        let command = ControlMsg::PrepareProgressivePlayback {
            sources,
            start_seconds,
            generation,
            installation: PreparingAudioInstallation {
                request: request.clone(),
                runtime: tokio::runtime::Handle::current(),
                playable_until,
            },
        };
        if self.control_tx.send(command).is_err() {
            request.complete(false);
        }
        ticket
    }

    pub(crate) fn refresh_playback(&self, spec: PlaySpec, generation: u64) {
        let _ = self.control_tx.send(ControlMsg::Refresh {
            spec: Box::new(spec),
            generation,
            retire_tx: self.control_tx.clone(),
        });
    }

    /// Detaches the source installed by the `play` call that returned this
    /// generation. A newer source (from a replacing play) is left untouched,
    /// so a stale playback shutting down can't cut off its successor.
    pub fn stop_playback(&self, generation: u64) {
        let _ = self
            .control_tx
            .send(ControlMsg::StopPlayback { generation });
    }

    /// Tears down the stream and thread. Also happens on drop.
    pub fn shutdown(&self) {
        let _ = self.control_tx.send(ControlMsg::Shutdown);
    }
}

impl Drop for AudioOutput {
    fn drop(&mut self) {
        let _ = self.control_tx.send(ControlMsg::Shutdown);
    }
}

/// Per-playback state owned by the audio callback.
struct ActiveSource<T: FromSampleBytes> {
    generation: u64,
    buffer: ActiveSourceBuffer<T>,
    playhead_rx: watch::Receiver<f64>,
    ack: Option<SourceAcknowledgement>,
    preparing_request: Option<Arc<PreparingAudioRequest>>,
    #[cfg(not(target_os = "windows"))]
    latency_corrector: LatencyCorrector,
}

enum ActiveSourceBuffer<T: FromSampleBytes> {
    Ordinary(PrerenderedAudioBuffer<T>),
    Preparing(PreparingAudioBuffer<T>),
}

#[cfg(test)]
impl<T: FromSampleBytes + cpal::FromSample<f32>> ActiveSourceBuffer<T> {
    fn current_playhead_secs(&self) -> f64 {
        let Self::Ordinary(buffer) = self else {
            panic!("Preparing playback uses its consumed-span clock");
        };
        buffer.current_playhead_secs()
    }

    fn current_audible_playhead(&self, latency_seconds: f64) -> f64 {
        let Self::Ordinary(buffer) = self else {
            panic!("Preparing playback uses its consumed-span clock");
        };
        buffer.current_audible_playhead(latency_seconds)
    }
}

type InstallProgressiveAudio =
    dyn Fn(PreparingAudioSources, f64, u64, &PreparingAudioInstallation) -> Result<(), String>;

enum SourceCommand<T: FromSampleBytes> {
    Refresh {
        source: Box<ActiveSource<T>>,
        retire_tx: std_mpsc::Sender<ControlMsg>,
    },
    Install(Box<ActiveSource<T>>),
    Remove {
        generation: Option<u64>,
    },
}

/// The type-erased face of a running stream. The closures capture the typed
/// channel to the callback, chosen by the device's sample format at build.
struct TypedStreamHandle {
    _stream: cpal::Stream,
    #[allow(clippy::type_complexity)]
    install: Box<dyn Fn(Box<PlaySpec>, u64, SourceAcknowledgement) -> Result<(), String>>,
    install_progressive: Box<InstallProgressiveAudio>,
    remove: Box<dyn Fn(Option<u64>)>,
}

struct StreamState {
    device_name: Option<String>,
    failed: Arc<AtomicBool>,
    handle: TypedStreamHandle,
}

fn control_thread(control_rx: std_mpsc::Receiver<ControlMsg>) {
    // cpal streams aren't Send; this thread owns the stream for its lifetime.
    let mut state: Option<StreamState> = None;

    while let Ok(msg) = control_rx.recv() {
        match msg {
            ControlMsg::Refresh {
                spec,
                generation,
                retire_tx,
            } => {
                if let Some(stream) = &state
                    && let Err(error) = (stream.handle.install)(
                        spec,
                        generation,
                        SourceAcknowledgement::Refresh(retire_tx),
                    )
                {
                    error!(%error, "Could not update microphone enhancement during playback");
                }
            }
            ControlMsg::EnsureStream => {
                ensure_stream(&mut state);
            }
            ControlMsg::Play {
                spec,
                generation,
                result_tx,
            } => {
                let ok = handle_play(&mut state, spec, generation);
                let _ = result_tx.send(ok);
            }
            ControlMsg::PreparePlayback {
                spec,
                generation,
                request,
            } => {
                if request.is_cancelled() || !ensure_stream(&mut state) || request.is_cancelled() {
                    request.complete(false);
                    continue;
                }
                let Some(stream) = state.as_ref() else {
                    request.complete(false);
                    continue;
                };
                if let Err(error) = (stream.handle.install)(
                    spec,
                    generation,
                    SourceAcknowledgement::Preparing(request.clone()),
                ) {
                    error!("Failed to install preparing audio source: {error}");
                    request.complete(false);
                }
            }
            ControlMsg::PrepareProgressivePlayback {
                sources,
                start_seconds,
                generation,
                installation,
            } => {
                let request = &installation.request;
                if request.is_cancelled() || !ensure_stream(&mut state) || request.is_cancelled() {
                    request.complete(false);
                    continue;
                }
                let Some(stream) = state.as_ref() else {
                    request.complete(false);
                    continue;
                };
                if let Err(error) = (stream.handle.install_progressive)(
                    sources,
                    start_seconds,
                    generation,
                    &installation,
                ) {
                    error!("Failed to install progressive preparing audio: {error}");
                    request.complete(false);
                }
            }
            ControlMsg::StopPlayback { generation } => {
                stop_stream_state(
                    &mut state,
                    generation,
                    |stream| stream.failed.load(Ordering::Acquire),
                    |stream, generation| (stream.handle.remove)(Some(generation)),
                );
            }
            ControlMsg::Retire(source) => drop(source),
            ControlMsg::Shutdown => break,
        }
    }

    info!("Audio output thread finished");
}

fn stop_stream_state<S>(
    state: &mut Option<S>,
    generation: u64,
    is_failed: impl FnOnce(&S) -> bool,
    remove: impl FnOnce(&S, u64),
) {
    if state.as_ref().is_some_and(is_failed) {
        drop(state.take());
    } else if let Some(stream) = state.as_ref() {
        remove(stream, generation);
    }
}

/// Applies pending install/remove commands to the active source. Shared by
/// the live cpal callback and the headless sink.
fn drain_source_commands<T: FromSampleBytes>(
    active: &mut Option<ActiveSource<T>>,
    source_rx: &std_mpsc::Receiver<SourceCommand<T>>,
) {
    while let Ok(command) = source_rx.try_recv() {
        match command {
            SourceCommand::Refresh { source, retire_tx } => {
                let retired = if active
                    .as_ref()
                    .is_some_and(|current| current.generation == source.generation)
                {
                    active.replace(*source).map(Box::new)
                } else {
                    Some(source)
                };
                if let Some(retired) = retired {
                    let _ = retire_tx.send(ControlMsg::Retire(retired));
                }
            }
            SourceCommand::Install(source) => {
                if !source
                    .preparing_request
                    .as_ref()
                    .is_some_and(|request| request.is_cancelled())
                {
                    *active = Some(*source);
                }
            }
            SourceCommand::Remove { generation } => {
                let matches = generation.is_none()
                    || active
                        .as_ref()
                        .map(|s| Some(s.generation) == generation)
                        .unwrap_or(false);
                if matches {
                    *active = None;
                }
            }
        }
    }
    if active.as_ref().is_some_and(|source| {
        source
            .preparing_request
            .as_ref()
            .is_some_and(|request| request.is_cancelled())
    }) {
        *active = None;
    }
}

/// Renders one output block from the active source: applies the video
/// playhead sync policy, fills the buffer and acknowledges the first
/// consumed block. Shared by the live cpal callback and the headless sink so
/// harnesses exercise the exact production logic.
fn render_source_block<T: FromSampleBytes + cpal::FromSample<f32>>(
    source: &mut ActiveSource<T>,
    buffer: &mut [T],
    latency_secs: f64,
) {
    if source
        .preparing_request
        .as_ref()
        .is_some_and(|request| request.is_cancelled())
    {
        buffer.fill(T::EQUILIBRIUM);
        return;
    }
    match &mut source.buffer {
        ActiveSourceBuffer::Ordinary(audio) => {
            if source.playhead_rx.has_changed().unwrap_or(false) {
                let video_playhead = *source.playhead_rx.borrow_and_update();
                let audible_playhead = audio.current_audible_playhead(latency_secs);
                let drift = (video_playhead - audible_playhead).abs();

                if drift > 0.04 {
                    audio.set_playhead(video_playhead + latency_secs);
                }
            }
            audio.fill(buffer);
        }
        ActiveSourceBuffer::Preparing(audio) => {
            if audio.fill(buffer, latency_secs) == 0 {
                if audio.is_terminal()
                    && let Some(request) = &source.preparing_request
                {
                    request.complete(false);
                }
                return;
            }
        }
    }

    if source
        .preparing_request
        .as_ref()
        .is_some_and(|request| request.is_cancelled())
    {
        buffer.fill(T::EQUILIBRIUM);
        return;
    }

    if let Some(ack) = source.ack.take() {
        ack.consumed();
    }
}

/// Builds the per-playback source from a play spec and hands it to the
/// output via `install_tx`. `use_device_latency_hint` is false for the
/// headless sink, which models a zero-latency device.
fn install_source<T: FromSampleBytes + cpal::FromSample<f32>>(
    spec: Box<PlaySpec>,
    generation: u64,
    ack: SourceAcknowledgement,
    output_info: AudioInfo,
    use_device_latency_hint: bool,
    install_tx: &std_mpsc::Sender<SourceCommand<T>>,
) -> Result<(), String> {
    let preparing_request = ack.preparing_request();
    if preparing_request
        .as_ref()
        .is_some_and(|request| request.is_cancelled())
    {
        return Err("Preparing audio request cancelled".into());
    }
    let PlaySpec {
        segments,
        music,
        project,
        duration_secs,
        start_playhead_secs,
        playhead_rx,
    } = *spec;

    if !(duration_secs.is_finite() && duration_secs > 0.0) {
        return Err(format!(
            "Invalid audio pre-render duration: {duration_secs}"
        ));
    }

    #[cfg(not(target_os = "windows"))]
    let latency_corrector = {
        let hint = if use_device_latency_hint {
            default_output_latency_hint(output_info.sample_rate, output_info.buffer_size)
        } else {
            None
        };
        if let Some(hint) = hint
            && hint.latency_secs > 0.0
        {
            if hint.transport.is_wireless() {
                info!(
                    "Applying wireless audio output latency hint: {:.1} ms",
                    hint.latency_secs * 1_000.0
                );
            } else {
                info!(
                    "Applying audio output latency hint: {:.1} ms",
                    hint.latency_secs * 1_000.0
                );
            }
        }
        LatencyCorrector::new(hint, LatencyCorrectionConfig::default())
    };
    #[cfg(not(target_os = "windows"))]
    let initial_latency_secs = latency_corrector.initial_output_latency_secs();
    #[cfg(target_os = "windows")]
    let initial_latency_secs = {
        let _ = use_device_latency_hint;
        0.0
    };

    let start_playhead = start_playhead_secs + initial_latency_secs;
    let mut buffer = if matches!(ack, SourceAcknowledgement::Refresh(_)) {
        PrerenderedAudioBuffer::<T>::bounded(segments, music, &project, output_info, start_playhead)
    } else {
        PrerenderedAudioBuffer::<T>::new(
            segments,
            music,
            &project,
            output_info,
            duration_secs,
            start_playhead,
        )
    };
    if !matches!(ack, SourceAcknowledgement::Refresh(_)) {
        buffer.set_playhead(start_playhead);
    }
    // A few ms: guarantees the callback reads real samples at the
    // playhead, never leading silence.
    buffer.wait_until_ready(PRERENDER_READY_TIMEOUT);

    if preparing_request
        .as_ref()
        .is_some_and(|request| request.is_cancelled())
    {
        return Err("Preparing audio request cancelled".into());
    }

    if let Some(request) = &preparing_request {
        request.awaiting_callback();
    }

    let retire_tx = match &ack {
        SourceAcknowledgement::Refresh(sender) => Some(sender.clone()),
        _ => None,
    };
    let source = Box::new(ActiveSource {
        generation,
        buffer: ActiveSourceBuffer::Ordinary(buffer),
        playhead_rx,
        ack: Some(ack),
        preparing_request,
        #[cfg(not(target_os = "windows"))]
        latency_corrector,
    });
    install_tx
        .send(if let Some(retire_tx) = retire_tx {
            SourceCommand::Refresh { source, retire_tx }
        } else {
            SourceCommand::Install(source)
        })
        .map_err(|_| "Audio callback channel closed".to_string())
}

fn install_progressive_source<T: FromSampleBytes + cpal::FromSample<f32>>(
    sources: PreparingAudioSources,
    start_seconds: f64,
    generation: u64,
    installation: &PreparingAudioInstallation,
    output_info: AudioInfo,
    use_device_latency_hint: bool,
    install_tx: &std_mpsc::Sender<SourceCommand<T>>,
) -> Result<(), String> {
    let request = &installation.request;
    if request.is_cancelled() {
        return Err("Preparing audio request cancelled".into());
    }
    #[cfg(not(target_os = "windows"))]
    let latency_corrector = LatencyCorrector::new(
        if use_device_latency_hint {
            default_output_latency_hint(output_info.sample_rate, output_info.buffer_size)
        } else {
            None
        },
        LatencyCorrectionConfig::default(),
    );
    #[cfg(target_os = "windows")]
    let _ = use_device_latency_hint;
    let (buffer, output) = PreparingAudioBuffer::<T>::spawn(
        sources,
        output_info,
        start_seconds,
        installation.runtime.clone(),
    )?;
    *request
        .output
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(output.clone());
    output.set_playable_until(installation.playable_until)?;
    if request.is_cancelled() {
        return Err("Preparing audio request cancelled".into());
    }
    let (_, playhead_rx) = watch::channel(start_seconds);
    request.awaiting_callback();
    install_tx
        .send(SourceCommand::Install(Box::new(ActiveSource {
            generation,
            buffer: ActiveSourceBuffer::Preparing(buffer),
            playhead_rx,
            ack: Some(SourceAcknowledgement::Preparing(request.clone())),
            preparing_request: Some(request.clone()),
            #[cfg(not(target_os = "windows"))]
            latency_corrector,
        })))
        .map_err(|_| "Audio callback channel closed".to_string())
}

/// Control loop for the headless sink: a pump thread pulls blocks on a
/// real-time schedule (as a device would) and hands every block to `tap`.
fn control_thread_headless(control_rx: std_mpsc::Receiver<ControlMsg>, mut tap: HeadlessAudioTap) {
    let output_info = AudioInfo::new_raw(
        AudioData::SAMPLE_FORMAT,
        HEADLESS_SAMPLE_RATE,
        HEADLESS_CHANNELS,
    );

    let (source_tx, source_rx) = std_mpsc::channel::<SourceCommand<f32>>();
    let stop = Arc::new(AtomicBool::new(false));

    let pump = {
        let stop = stop.clone();
        let channels = usize::from(HEADLESS_CHANNELS);
        std::thread::Builder::new()
            .name("cap-audio-headless-pump".into())
            .spawn(move || {
                let mut buffer = vec![0.0f32; HEADLESS_BLOCK_FRAMES * channels];
                let mut active: Option<ActiveSource<f32>> = None;
                let block = Duration::from_secs_f64(
                    HEADLESS_BLOCK_FRAMES as f64 / f64::from(HEADLESS_SAMPLE_RATE),
                );
                let start = Instant::now();
                let mut n: u32 = 0;

                while !stop.load(Ordering::Acquire) {
                    // Absolute schedule: a device consumes samples isochronously,
                    // so late wakeups must not stretch the sample clock.
                    let deadline = start + block * n;
                    let now = Instant::now();
                    if deadline > now {
                        std::thread::sleep(deadline - now);
                    }

                    drain_source_commands(&mut active, &source_rx);
                    match active.as_mut() {
                        Some(source) => render_source_block(source, &mut buffer, 0.0),
                        None => buffer.fill(0.0),
                    }
                    tap(&buffer, deadline);
                    n = n.saturating_add(1);
                }
            })
    };
    let pump = match pump {
        Ok(handle) => Some(handle),
        Err(e) => {
            error!("Failed to spawn headless audio pump: {e}");
            None
        }
    };

    while let Ok(msg) = control_rx.recv() {
        match msg {
            ControlMsg::Refresh {
                spec,
                generation,
                retire_tx,
            } => {
                if let Err(error) = install_source::<f32>(
                    spec,
                    generation,
                    SourceAcknowledgement::Refresh(retire_tx),
                    output_info,
                    false,
                    &source_tx,
                ) {
                    error!(%error, "Could not update headless audio playback");
                }
            }
            ControlMsg::EnsureStream => {}
            ControlMsg::Play {
                spec,
                generation,
                result_tx,
            } => {
                let (ack_tx, ack_rx) = std_mpsc::channel();
                let ok = pump.is_some()
                    && match install_source::<f32>(
                        spec,
                        generation,
                        SourceAcknowledgement::Ordinary(ack_tx),
                        output_info,
                        false,
                        &source_tx,
                    ) {
                        Ok(()) => ack_rx.recv_timeout(SOURCE_ACK_TIMEOUT).is_ok(),
                        Err(e) => {
                            error!("Failed to install headless audio source: {e}");
                            false
                        }
                    };
                let _ = result_tx.send(ok);
            }
            ControlMsg::PreparePlayback {
                spec,
                generation,
                request,
            } => {
                if request.is_cancelled() || pump.is_none() {
                    request.complete(false);
                    continue;
                }
                if let Err(error) = install_source::<f32>(
                    spec,
                    generation,
                    SourceAcknowledgement::Preparing(request.clone()),
                    output_info,
                    false,
                    &source_tx,
                ) {
                    error!("Failed to install preparing headless audio source: {error}");
                    request.complete(false);
                }
            }
            ControlMsg::PrepareProgressivePlayback {
                sources,
                start_seconds,
                generation,
                installation,
            } => {
                let request = &installation.request;
                if request.is_cancelled() || pump.is_none() {
                    request.complete(false);
                    continue;
                }
                if let Err(error) = install_progressive_source::<f32>(
                    sources,
                    start_seconds,
                    generation,
                    &installation,
                    output_info,
                    false,
                    &source_tx,
                ) {
                    error!("Failed to install progressive headless audio: {error}");
                    request.complete(false);
                }
            }
            ControlMsg::StopPlayback { generation } => {
                let _ = source_tx.send(SourceCommand::Remove {
                    generation: Some(generation),
                });
            }
            ControlMsg::Retire(source) => drop(source),
            ControlMsg::Shutdown => break,
        }
    }

    stop.store(true, Ordering::Release);
    if let Some(pump) = pump {
        let _ = pump.join();
    }

    info!("Headless audio output thread finished");
}

fn handle_play(state: &mut Option<StreamState>, spec: Box<PlaySpec>, generation: u64) -> bool {
    if !ensure_stream(state) {
        return false;
    }
    let Some(s) = state.as_ref() else {
        return false;
    };

    let (ack_tx, ack_rx) = std_mpsc::channel();
    if let Err(e) = (s.handle.install)(spec, generation, SourceAcknowledgement::Ordinary(ack_tx)) {
        error!("Failed to install audio source: {e}");
        return false;
    }

    match ack_rx.recv_timeout(SOURCE_ACK_TIMEOUT) {
        Ok(()) => true,
        Err(_) => {
            error!("Audio output did not consume the new source in time");
            (s.handle.remove)(Some(generation));
            // Force a rebuild on the next play; the device likely died.
            s.failed.store(true, Ordering::Release);
            false
        }
    }
}

/// Returns true when a healthy stream for the current default device exists
/// (building one if needed).
fn ensure_stream(state: &mut Option<StreamState>) -> bool {
    let host = cpal::default_host();
    let Some(device) = host.default_output_device() else {
        error!("No default output device found");
        *state = None;
        return false;
    };
    let device_name = device.name().ok();

    if let Some(s) = state.as_ref() {
        if !s.failed.load(Ordering::Acquire) && s.device_name == device_name {
            return true;
        }
        info!("Rebuilding audio output stream (device changed or stream failed)");
    }
    *state = None;

    let supported_config = match device.default_output_config() {
        Ok(config) => config,
        Err(e) => {
            error!("Failed to get default output config: {e}");
            return false;
        }
    };

    let failed = Arc::new(AtomicBool::new(false));
    let result = match supported_config.sample_format() {
        SampleFormat::I16 => build_stream::<i16>(device, supported_config, failed.clone()),
        SampleFormat::I32 => build_stream::<i32>(device, supported_config, failed.clone()),
        SampleFormat::F32 => build_stream::<f32>(device, supported_config, failed.clone()),
        SampleFormat::I64 => build_stream::<i64>(device, supported_config, failed.clone()),
        SampleFormat::U8 => build_stream::<u8>(device, supported_config, failed.clone()),
        SampleFormat::F64 => build_stream::<f64>(device, supported_config, failed.clone()),
        format => {
            error!("Unsupported output sample format {format:?}");
            return false;
        }
    };

    match result {
        Ok(handle) => {
            info!(device = ?device_name, "Audio output stream ready");
            *state = Some(StreamState {
                device_name,
                failed,
                handle,
            });
            true
        }
        Err(e) => {
            error!("Failed to create audio output stream: {e}");
            false
        }
    }
}

fn playback_output_info(config: &cpal::SupportedStreamConfig) -> AudioInfo {
    // ALSA's supported maximum is not the queue size used by BufferSize::Default.
    let buffer_size = cfg!(target_os = "linux").then_some(1024);
    let mut info = AudioInfo::from_stream_config_with_buffer(config, buffer_size);
    info.sample_format = info.sample_format.packed();
    info.for_ffmpeg_output()
}

fn build_stream<T>(
    device: cpal::Device,
    supported_config: cpal::SupportedStreamConfig,
    failed: Arc<AtomicBool>,
) -> Result<TypedStreamHandle, String>
where
    T: FromSampleBytes + cpal::SizedSample + cpal::FromSample<f32>,
{
    let output_info = playback_output_info(&supported_config);
    // Clamp for FFmpeg compatibility (max 8 channels); the stream config must
    // match what the pre-render buffer produces.
    let mut config = supported_config.config();
    config.channels = output_info.channels as u16;

    let (source_tx, source_rx) = std_mpsc::channel::<SourceCommand<T>>();

    let mut active: Option<ActiveSource<T>> = None;
    let stream = device
        .build_output_stream(
            &config,
            move |buffer: &mut [T], info| {
                drain_source_commands(&mut active, &source_rx);

                let Some(source) = active.as_mut() else {
                    buffer.fill(T::EQUILIBRIUM);
                    return;
                };

                #[cfg(not(target_os = "windows"))]
                let latency_secs = source.latency_corrector.update_from_callback(info);
                #[cfg(target_os = "windows")]
                let latency_secs = {
                    let _ = info;
                    0.0
                };

                render_source_block(source, buffer, latency_secs);
            },
            {
                let failed = failed.clone();
                move |err| {
                    failed.store(true, Ordering::Release);
                    error!("Audio stream error: {err}");
                }
            },
            None,
        )
        .map_err(|e| format!("Failed to build audio output stream: {e}"))?;

    stream
        .play()
        .map_err(|e| format!("Failed to start audio output stream: {e}"))?;

    let install_tx = source_tx.clone();
    let install = Box::new(
        move |spec: Box<PlaySpec>, generation: u64, ack: SourceAcknowledgement| {
            install_source::<T>(spec, generation, ack, output_info, true, &install_tx)
        },
    );

    let progressive_tx = source_tx.clone();
    let install_progressive = Box::new(
        move |sources, start_seconds, generation, installation: &PreparingAudioInstallation| {
            install_progressive_source::<T>(
                sources,
                start_seconds,
                generation,
                installation,
                output_info,
                true,
                &progressive_tx,
            )
        },
    );

    let remove = Box::new(move |generation: Option<u64>| {
        let _ = source_tx.send(SourceCommand::Remove { generation });
    });

    Ok(TypedStreamHandle {
        _stream: stream,
        install,
        install_progressive,
        remove,
    })
}

#[cfg(test)]
mod native_tests;

#[cfg(test)]
mod tests {
    use super::*;

    pub(super) fn source(sample_rate: u32) -> (ActiveSource<f32>, watch::Sender<f64>) {
        source_with_info(
            AudioInfo::new_raw(AudioData::SAMPLE_FORMAT, sample_rate, 2),
            false,
        )
    }

    fn source_with_info(
        output_info: AudioInfo,
        use_device_latency_hint: bool,
    ) -> (ActiveSource<f32>, watch::Sender<f64>) {
        ffmpeg::init().unwrap();
        let (playhead_tx, playhead_rx) = watch::channel(0.0);
        let (install_tx, install_rx) = std_mpsc::channel();
        let (ack_tx, _ack_rx) = std_mpsc::channel();
        install_source(
            Box::new(PlaySpec {
                segments: Vec::new(),
                music: MusicTracks::new(),
                project: ProjectConfiguration::default(),
                duration_secs: 2.0,
                start_playhead_secs: 0.0,
                playhead_rx,
            }),
            0,
            SourceAcknowledgement::Ordinary(ack_tx),
            output_info,
            use_device_latency_hint,
            &install_tx,
        )
        .unwrap();
        let SourceCommand::Install(source) = install_rx.recv().unwrap() else {
            panic!("expected installed audio source");
        };
        (*source, playhead_tx)
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn supported_buffer_maximum_does_not_skip_the_start_of_playback() {
        for sample_rate in [44_100, 48_000] {
            let config = cpal::SupportedStreamConfig::new(
                2,
                cpal::SampleRate(sample_rate),
                cpal::SupportedBufferSize::Range {
                    min: 1,
                    max: 4_194_304,
                },
                SampleFormat::F32,
            );
            let (source, _) = source_with_info(playback_output_info(&config), true);
            let playhead = source.buffer.current_playhead_secs();
            assert!(
                (playhead - 0.03).abs() < 1.0 / f64::from(sample_rate),
                "sample_rate={sample_rate}, playhead={playhead}"
            );
        }
    }

    #[test]
    fn enhancement_refresh_only_replaces_its_active_playback_generation() {
        let (mut original, _playhead) = source(48_000);
        original.generation = 7;
        let mut active = Some(original);
        let (tx, rx) = std_mpsc::channel();
        let (retire_tx, retire_rx) = std_mpsc::channel();
        for (generation, should_replace) in [(7, true), (6, false), (8, false)] {
            let (mut replacement, _playhead) = source(48_000);
            replacement.generation = generation;
            let ActiveSourceBuffer::Ordinary(buffer) = &mut replacement.buffer else {
                panic!("expected ordinary source");
            };
            buffer.set_playhead(0.5);
            let ActiveSourceBuffer::Ordinary(buffer) = &mut active.as_mut().unwrap().buffer else {
                panic!("expected ordinary source");
            };
            buffer.set_playhead(0.0);
            tx.send(SourceCommand::Refresh {
                source: Box::new(replacement),
                retire_tx: retire_tx.clone(),
            })
            .unwrap();
            drain_source_commands(&mut active, &rx);
            assert!(matches!(
                retire_rx.try_recv().unwrap(),
                ControlMsg::Retire(_)
            ));
            let actual = active.as_ref().unwrap();
            assert_eq!(actual.generation, 7);
            assert_eq!(actual.buffer.current_playhead_secs() >= 0.5, should_replace);
        }
        tx.send(SourceCommand::Remove {
            generation: Some(7),
        })
        .unwrap();
        let (mut replacement, _playhead) = source(48_000);
        replacement.generation = 7;
        tx.send(SourceCommand::Refresh {
            source: Box::new(replacement),
            retire_tx: retire_tx.clone(),
        })
        .unwrap();
        drain_source_commands(&mut active, &rx);
        assert!(active.is_none());
    }

    #[test]
    fn coalesced_video_updates_preserve_synchronized_audio_position() {
        for sample_rate in [44_100, 48_000] {
            for latency_secs in [0.0, 0.025, 0.15] {
                let (mut source, playhead_tx) = source(sample_rate);
                let mut elapsed = vec![0.0; sample_rate as usize / 4 * 2];
                render_source_block(&mut source, &mut elapsed, latency_secs);
                let before = source.buffer.current_playhead_secs();
                let audible = source.buffer.current_audible_playhead(latency_secs);
                playhead_tx.send(audible - 0.02).unwrap();
                playhead_tx.send(audible - 0.002).unwrap();

                let mut block = [0.0; 512 * 2];
                render_source_block(&mut source, &mut block, latency_secs);

                let expected = before + 512.0 / f64::from(sample_rate);
                let actual = source.buffer.current_playhead_secs();
                assert!(
                    (actual - expected).abs() < 1.0 / f64::from(sample_rate),
                    "sample_rate={sample_rate}, latency={latency_secs}, expected={expected}, actual={actual}"
                );
            }
        }
    }

    #[test]
    fn video_drift_reseats_audio_for_forward_and_backward_seeks() {
        for sample_rate in [44_100, 48_000] {
            for latency_secs in [0.0, 0.025, 0.15] {
                let (mut source, playhead_tx) = source(sample_rate);
                let mut elapsed = vec![0.0; sample_rate as usize / 4 * 2];
                render_source_block(&mut source, &mut elapsed, latency_secs);
                let mut block = [0.0; 512 * 2];

                for target in [0.03, 0.6, 0.1] {
                    playhead_tx.send(target).unwrap();
                    render_source_block(&mut source, &mut block, latency_secs);
                    let expected = target + latency_secs + 512.0 / f64::from(sample_rate);
                    let actual = source.buffer.current_playhead_secs();
                    assert!(
                        (actual - expected).abs() <= 1.0 / f64::from(sample_rate),
                        "sample_rate={sample_rate}, latency={latency_secs}, target={target}, expected={expected}, actual={actual}"
                    );
                }
            }
        }
    }
}
