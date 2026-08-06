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
        Arc,
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
    EnsureStream,
    Play {
        spec: Box<PlaySpec>,
        generation: u64,
        result_tx: std_mpsc::Sender<bool>,
    },
    StopPlayback {
        generation: u64,
    },
    Shutdown,
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
    buffer: PrerenderedAudioBuffer<T>,
    playhead_rx: watch::Receiver<f64>,
    last_video_playhead: f64,
    ack: Option<std_mpsc::Sender<()>>,
    #[cfg(not(target_os = "windows"))]
    latency_corrector: LatencyCorrector,
}

enum SourceCommand<T: FromSampleBytes> {
    Install(Box<ActiveSource<T>>),
    Remove { generation: Option<u64> },
}

/// The type-erased face of a running stream. The closures capture the typed
/// channel to the callback, chosen by the device's sample format at build.
struct TypedStreamHandle {
    _stream: cpal::Stream,
    #[allow(clippy::type_complexity)]
    install: Box<dyn Fn(Box<PlaySpec>, u64, std_mpsc::Sender<()>) -> Result<(), String>>,
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
            ControlMsg::StopPlayback { generation } => {
                if let Some(s) = &state {
                    (s.handle.remove)(Some(generation));
                }
            }
            ControlMsg::Shutdown => break,
        }
    }

    info!("Audio output thread finished");
}

/// Applies pending install/remove commands to the active source. Shared by
/// the live cpal callback and the headless sink.
fn drain_source_commands<T: FromSampleBytes>(
    active: &mut Option<ActiveSource<T>>,
    source_rx: &std_mpsc::Receiver<SourceCommand<T>>,
) {
    while let Ok(command) = source_rx.try_recv() {
        match command {
            SourceCommand::Install(source) => *active = Some(*source),
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
    if source.playhead_rx.has_changed().unwrap_or(false) {
        let video_playhead = *source.playhead_rx.borrow_and_update();
        let jump = (video_playhead - source.last_video_playhead).abs();
        let audible_playhead = source.buffer.current_audible_playhead(latency_secs);
        let drift = (video_playhead - audible_playhead).abs();

        if jump > 0.05 || drift > 0.04 {
            source.buffer.set_playhead(video_playhead + latency_secs);
        }

        source.last_video_playhead = video_playhead;
    }

    source.buffer.fill(buffer);

    if let Some(ack) = source.ack.take() {
        let _ = ack.send(());
    }
}

/// Builds the per-playback source from a play spec and hands it to the
/// output via `install_tx`. `use_device_latency_hint` is false for the
/// headless sink, which models a zero-latency device.
fn install_source<T: FromSampleBytes + cpal::FromSample<f32>>(
    spec: Box<PlaySpec>,
    generation: u64,
    ack: std_mpsc::Sender<()>,
    output_info: AudioInfo,
    use_device_latency_hint: bool,
    install_tx: &std_mpsc::Sender<SourceCommand<T>>,
) -> Result<(), String> {
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
    let mut buffer = PrerenderedAudioBuffer::<T>::new(
        segments,
        music,
        &project,
        output_info,
        duration_secs,
        start_playhead,
    );
    buffer.set_playhead(start_playhead);
    // A few ms: guarantees the callback reads real samples at the
    // playhead, never leading silence.
    buffer.wait_until_ready(PRERENDER_READY_TIMEOUT);

    install_tx
        .send(SourceCommand::Install(Box::new(ActiveSource {
            generation,
            buffer,
            playhead_rx,
            last_video_playhead: start_playhead_secs,
            ack: Some(ack),
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
                        ack_tx,
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
            ControlMsg::StopPlayback { generation } => {
                let _ = source_tx.send(SourceCommand::Remove {
                    generation: Some(generation),
                });
            }
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
    if let Err(e) = (s.handle.install)(spec, generation, ack_tx) {
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

fn build_stream<T>(
    device: cpal::Device,
    supported_config: cpal::SupportedStreamConfig,
    failed: Arc<AtomicBool>,
) -> Result<TypedStreamHandle, String>
where
    T: FromSampleBytes + cpal::SizedSample + cpal::FromSample<f32>,
{
    let mut output_info = AudioInfo::from_stream_config(&supported_config);
    output_info.sample_format = output_info.sample_format.packed();
    // Clamp for FFmpeg compatibility (max 8 channels); the stream config must
    // match what the pre-render buffer produces.
    output_info = output_info.for_ffmpeg_output();

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
        move |spec: Box<PlaySpec>, generation: u64, ack: std_mpsc::Sender<()>| {
            install_source::<T>(spec, generation, ack, output_info, true, &install_tx)
        },
    );

    let remove = Box::new(move |generation: Option<u64>| {
        let _ = source_tx.send(SourceCommand::Remove { generation });
    });

    Ok(TypedStreamHandle {
        _stream: stream,
        install,
        remove,
    })
}
