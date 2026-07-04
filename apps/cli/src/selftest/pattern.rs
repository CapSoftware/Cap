//! Main-thread test pattern for the A/V sync self-test.
//!
//! Renders a fullscreen black window that flashes white at a fixed period
//! while playing a 1 kHz beep through the default audio output at the same
//! scheduled instants. The window must run on the process main thread
//! (required by AppKit); the async side of the self-test requests a pattern
//! run through [`request_pattern`] and the real main thread services it via
//! [`serve_main_thread`].

use std::{
    num::NonZeroU32,
    sync::{
        Arc, Mutex, OnceLock,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    time::{Duration, Instant},
};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use winit::{
    application::ApplicationHandler,
    event::{ElementState, WindowEvent},
    event_loop::{ActiveEventLoop, ControlFlow, EventLoop},
    keyboard::{Key, NamedKey},
    platform::run_on_demand::EventLoopExtRunOnDemand,
    window::{Fullscreen, Window, WindowId, WindowLevel},
};

#[derive(Clone, Copy, Debug)]
pub struct PatternSpec {
    /// Time to sit black before the first event, letting capture settle.
    pub settle: Duration,
    /// Number of flash+beep events.
    pub events: u32,
    /// Time between event onsets.
    pub period: Duration,
    /// Duration of each flash / beep.
    pub flash_len: Duration,
}

impl PatternSpec {
    pub fn total_runtime(&self) -> Duration {
        self.settle + self.period * self.events + Duration::from_millis(500)
    }

    /// Event onsets relative to the pattern epoch. Nominally periodic, with a
    /// deterministic per-event jitter of up to ±300 ms: a perfectly periodic
    /// schedule would let an A/V shift of exactly one period pair every flash
    /// with the wrong beep and alias to a zero measured offset.
    pub fn event_offsets_secs(&self) -> Vec<f64> {
        (0..self.events)
            .map(|k| {
                let jitter = (u64::from(k).wrapping_mul(2_654_435_761) % 601) as f64 / 1000.0 - 0.3;
                (f64::from(k) * self.period.as_secs_f64() + jitter).max(0.0)
            })
            .collect()
    }
}

#[derive(Debug)]
pub struct PatternReport {
    /// Instants at which each flash was actually presented (post-present).
    pub flash_presents: Vec<(u32, Instant)>,
    /// Estimated instants at which each beep hit the output (DAC time).
    pub beep_outputs: Vec<(u32, Instant)>,
    /// Mean reported output latency of the audio stream, if available.
    pub audio_latency_ms: Option<f64>,
}

pub struct PatternRequest {
    pub spec: PatternSpec,
    pub reply: mpsc::Sender<Result<PatternReport, String>>,
}

static PATTERN_TX: OnceLock<Mutex<Option<mpsc::Sender<PatternRequest>>>> = OnceLock::new();

/// Called from `main()` before the runtime thread spawns, when the parsed
/// command is a self-test. Returns the receiver the main thread must serve.
pub fn install_main_thread_runner() -> mpsc::Receiver<PatternRequest> {
    let (tx, rx) = mpsc::channel();
    let _ = PATTERN_TX.set(Mutex::new(Some(tx)));
    rx
}

/// Called by the runtime thread once the command finishes, releasing the main
/// thread from its serve loop.
pub fn shutdown_main_thread_runner() {
    if let Some(slot) = PATTERN_TX.get() {
        slot.lock().unwrap().take();
    }
}

/// Runs pattern requests on the main thread until the sender is dropped via
/// [`shutdown_main_thread_runner`].
pub fn serve_main_thread(rx: mpsc::Receiver<PatternRequest>) {
    while let Ok(request) = rx.recv() {
        let result = run_pattern(request.spec);
        let _ = request.reply.send(result);
    }
}

/// Called from the async side; blocks the calling task until the pattern
/// window has run to completion on the main thread.
pub async fn request_pattern(spec: PatternSpec) -> Result<PatternReport, String> {
    let tx = PATTERN_TX
        .get()
        .and_then(|slot| slot.lock().unwrap().clone())
        .ok_or("self-test pattern runner is not installed on the main thread")?;
    tokio::task::spawn_blocking(move || {
        let (reply_tx, reply_rx) = mpsc::channel();
        tx.send(PatternRequest {
            spec,
            reply: reply_tx,
        })
        .map_err(|_| "main thread pattern runner is gone".to_string())?;
        reply_rx
            .recv()
            .map_err(|_| "main thread pattern runner dropped the request".to_string())?
    })
    .await
    .map_err(|e| format!("pattern task join error: {e}"))?
}

struct BeepState {
    epoch: Instant,
    /// Sorted (start, end) sample windows of each beep, relative to epoch.
    event_windows: Vec<(u64, u64)>,
    sample_rate: u32,
    channels: usize,
    /// Absolute sample index of pattern epoch, fixed on the first callback.
    epoch_sample: Mutex<Option<i64>>,
    samples_written: Mutex<u64>,
    beep_outputs: Mutex<Vec<(u32, Instant)>>,
    latency_sum_ms: Mutex<(f64, u64)>,
}

impl BeepState {
    fn fill(&self, data: &mut [f32], info: &cpal::OutputCallbackInfo) {
        let now = Instant::now();
        let mut written = self.samples_written.lock().unwrap();
        let buffer_start_sample = *written as i64;

        let mut epoch_sample = self.epoch_sample.lock().unwrap();
        let epoch_sample = *epoch_sample.get_or_insert_with(|| {
            let until_epoch = if self.epoch > now {
                (self.epoch - now).as_secs_f64()
            } else {
                -(now - self.epoch).as_secs_f64()
            };
            buffer_start_sample + (until_epoch * self.sample_rate as f64) as i64
        });

        let latency = info
            .timestamp()
            .playback
            .duration_since(&info.timestamp().callback);
        if let Some(latency) = latency {
            let mut acc = self.latency_sum_ms.lock().unwrap();
            acc.0 += latency.as_secs_f64() * 1000.0;
            acc.1 += 1;
        }

        let frames = data.len() / self.channels.max(1);
        for frame_idx in 0..frames {
            let abs_sample = buffer_start_sample + frame_idx as i64;
            let rel = abs_sample - epoch_sample;
            let mut value = 0.0f32;
            if rel >= 0 {
                let rel = rel as u64;
                let idx = self
                    .event_windows
                    .partition_point(|&(start, _)| start <= rel);
                if idx > 0 {
                    let (start, end) = self.event_windows[idx - 1];
                    if rel < end {
                        // 1 kHz tone with a 2 ms fade-in/out to avoid clicks while
                        // keeping the onset sharp for detection.
                        let within = rel - start;
                        let t = within as f32 / self.sample_rate as f32;
                        let fade_len = 0.002 * self.sample_rate as f32;
                        let fade_in = (within as f32 / fade_len).min(1.0);
                        let remaining = (end - rel) as f32;
                        let fade_out = (remaining / fade_len).min(1.0);
                        value = 0.4
                            * fade_in
                            * fade_out
                            * (t * 1000.0 * 2.0 * std::f32::consts::PI).sin();

                        if within == 0 {
                            let dac = now
                                + latency.unwrap_or_default()
                                + Duration::from_secs_f64(
                                    frame_idx as f64 / self.sample_rate as f64,
                                );
                            self.beep_outputs
                                .lock()
                                .unwrap()
                                .push(((idx - 1) as u32, dac));
                        }
                    }
                }
            }
            for ch in 0..self.channels {
                data[frame_idx * self.channels + ch] = value;
            }
        }

        *written += frames as u64;
    }
}

fn build_beep_stream(
    epoch: Instant,
    spec: &PatternSpec,
) -> Result<(cpal::Stream, Arc<BeepState>), String> {
    let host = cpal::default_host();
    let device = host
        .default_output_device()
        .ok_or("no default audio output device; cannot run the sync test")?;
    let config = device
        .default_output_config()
        .map_err(|e| format!("failed to query audio output config: {e}"))?;

    let sample_rate = config.sample_rate().0;
    let channels = config.channels() as usize;
    let beep_samples = (spec.flash_len.as_secs_f64() * sample_rate as f64) as u64;
    let state = Arc::new(BeepState {
        epoch,
        event_windows: spec
            .event_offsets_secs()
            .into_iter()
            .map(|offset| {
                let start = (offset * sample_rate as f64) as u64;
                (start, start + beep_samples)
            })
            .collect(),
        sample_rate,
        channels,
        epoch_sample: Mutex::new(None),
        samples_written: Mutex::new(0),
        beep_outputs: Mutex::new(Vec::new()),
        latency_sum_ms: Mutex::new((0.0, 0)),
    });

    let err_fn = |e| tracing::warn!("selftest audio stream error: {e}");
    let stream_config = config.config();

    let stream = match config.sample_format() {
        cpal::SampleFormat::F32 => {
            let state = state.clone();
            device
                .build_output_stream(
                    &stream_config,
                    move |data: &mut [f32], info: &cpal::OutputCallbackInfo| {
                        state.fill(data, info);
                    },
                    err_fn,
                    None,
                )
                .map_err(|e| format!("failed to build audio output stream: {e}"))?
        }
        cpal::SampleFormat::I16 => {
            let state = state.clone();
            let mut scratch = Vec::new();
            device
                .build_output_stream(
                    &stream_config,
                    move |data: &mut [i16], info: &cpal::OutputCallbackInfo| {
                        scratch.clear();
                        scratch.resize(data.len(), 0.0f32);
                        state.fill(&mut scratch, info);
                        for (dst, src) in data.iter_mut().zip(&scratch) {
                            *dst = (src * f32::from(i16::MAX)) as i16;
                        }
                    },
                    err_fn,
                    None,
                )
                .map_err(|e| format!("failed to build audio output stream: {e}"))?
        }
        other => {
            return Err(format!(
                "unsupported audio output sample format for the sync test: {other:?}"
            ));
        }
    };

    Ok((stream, state))
}

struct PatternApp {
    spec: PatternSpec,
    /// Event onsets in seconds from epoch, from `PatternSpec::event_offsets_secs`.
    event_offsets: Vec<f64>,
    run_start: Instant,
    epoch: Instant,
    window: Option<Arc<Window>>,
    surface: Option<softbuffer::Surface<Arc<Window>, Arc<Window>>>,
    size: (u32, u32),
    last_drawn_white: bool,
    flash_presents: Vec<(u32, Instant)>,
    aborted: Arc<AtomicBool>,
    error: Option<String>,
}

impl PatternApp {
    /// Returns whether the pattern should currently show white, and the event
    /// index if so.
    fn desired_state(&self, now: Instant) -> Option<u32> {
        if now < self.epoch {
            return None;
        }
        let rel = (now - self.epoch).as_secs_f64();
        let flash = self.spec.flash_len.as_secs_f64();
        self.event_offsets
            .iter()
            .position(|&start| rel >= start && rel < start + flash)
            .map(|idx| idx as u32)
    }

    fn next_transition(&self, now: Instant) -> Instant {
        if now < self.epoch {
            return self.epoch;
        }
        let rel = (now - self.epoch).as_secs_f64();
        let flash = self.spec.flash_len.as_secs_f64();
        let next_rel = self
            .event_offsets
            .iter()
            .flat_map(|&start| [start, start + flash])
            .filter(|&boundary| boundary > rel)
            .fold(f64::INFINITY, f64::min);
        if next_rel.is_finite() {
            self.epoch + Duration::from_secs_f64(next_rel)
        } else {
            self.done_at()
        }
    }

    fn done_at(&self) -> Instant {
        self.run_start + self.spec.total_runtime()
    }

    fn draw(&mut self, event_loop: &ActiveEventLoop) {
        let now = Instant::now();
        let desired = self.desired_state(now);
        let white = desired.is_some();

        let Some(surface) = self.surface.as_mut() else {
            return;
        };
        let (w, h) = self.size;
        if w == 0 || h == 0 {
            return;
        }
        if surface
            .resize(NonZeroU32::new(w).unwrap(), NonZeroU32::new(h).unwrap())
            .is_err()
        {
            return;
        }
        let Ok(mut buffer) = surface.buffer_mut() else {
            return;
        };
        // Keep the high byte opaque: some softbuffer backends (macOS layers)
        // treat it as alpha rather than ignoring it.
        let color: u32 = if white { 0xFFFF_FFFF } else { 0xFF00_0000 };
        buffer.fill(color);
        let presented = buffer.present().is_ok();

        if presented && white && !self.last_drawn_white {
            let event = desired.unwrap_or(0);
            if self
                .flash_presents
                .last()
                .is_none_or(|(last, _)| *last != event)
            {
                self.flash_presents.push((event, Instant::now()));
            }
        }
        self.last_drawn_white = white;

        if Instant::now() >= self.done_at() {
            event_loop.exit();
        }
    }
}

impl ApplicationHandler for PatternApp {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        if self.window.is_some() {
            return;
        }
        let attrs = Window::default_attributes()
            .with_title("Cap Sync Test")
            .with_fullscreen(Some(Fullscreen::Borderless(None)))
            .with_window_level(WindowLevel::AlwaysOnTop);
        let window = match event_loop.create_window(attrs) {
            Ok(w) => Arc::new(w),
            Err(e) => {
                self.error = Some(format!("failed to create test window: {e}"));
                event_loop.exit();
                return;
            }
        };
        let size = window.inner_size();
        self.size = (size.width, size.height);

        let context = match softbuffer::Context::new(window.clone()) {
            Ok(c) => c,
            Err(e) => {
                self.error = Some(format!("failed to create draw context: {e}"));
                event_loop.exit();
                return;
            }
        };
        match softbuffer::Surface::new(&context, window.clone()) {
            Ok(s) => self.surface = Some(s),
            Err(e) => {
                self.error = Some(format!("failed to create draw surface: {e}"));
                event_loop.exit();
                return;
            }
        }
        window.request_redraw();
        self.window = Some(window);
    }

    fn window_event(&mut self, event_loop: &ActiveEventLoop, _id: WindowId, event: WindowEvent) {
        match event {
            WindowEvent::CloseRequested => {
                self.aborted.store(true, Ordering::Release);
                event_loop.exit();
            }
            WindowEvent::KeyboardInput { event, .. } => {
                if event.state == ElementState::Pressed
                    && event.logical_key == Key::Named(NamedKey::Escape)
                {
                    self.aborted.store(true, Ordering::Release);
                    event_loop.exit();
                }
            }
            WindowEvent::Resized(size) => {
                self.size = (size.width, size.height);
            }
            WindowEvent::RedrawRequested => {
                self.draw(event_loop);
            }
            _ => {}
        }
    }

    fn about_to_wait(&mut self, event_loop: &ActiveEventLoop) {
        let now = Instant::now();
        if now >= self.done_at() {
            event_loop.exit();
            return;
        }
        let next = self.next_transition(now).min(self.done_at());
        if let Some(window) = &self.window {
            // Redraw slightly eagerly so the flip lands at (not after) the
            // scheduled transition.
            window.request_redraw();
        }
        event_loop.set_control_flow(ControlFlow::WaitUntil(next));
    }
}

fn run_pattern(spec: PatternSpec) -> Result<PatternReport, String> {
    #[allow(unused_mut)]
    let mut builder = EventLoop::builder();
    #[cfg(target_os = "macos")]
    {
        use winit::platform::macos::{ActivationPolicy, EventLoopBuilderExtMacOS};
        builder
            .with_activation_policy(ActivationPolicy::Regular)
            .with_activate_ignoring_other_apps(true);
    }
    let mut event_loop = builder
        .build()
        .map_err(|e| format!("failed to create event loop: {e}"))?;

    let run_start = Instant::now();
    let epoch = run_start + spec.settle;

    let (stream, beep_state) = build_beep_stream(epoch, &spec)?;
    stream
        .play()
        .map_err(|e| format!("failed to start audio output: {e}"))?;

    let mut app = PatternApp {
        event_offsets: spec.event_offsets_secs(),
        spec,
        run_start,
        epoch,
        window: None,
        surface: None,
        size: (0, 0),
        last_drawn_white: false,
        flash_presents: Vec::new(),
        aborted: Arc::new(AtomicBool::new(false)),
        error: None,
    };

    event_loop
        .run_app_on_demand(&mut app)
        .map_err(|e| format!("event loop error: {e}"))?;

    drop(stream);

    if let Some(error) = app.error {
        return Err(error);
    }
    if app.aborted.load(Ordering::Acquire) {
        return Err("cancelled".to_string());
    }

    let latency = {
        let acc = beep_state.latency_sum_ms.lock().unwrap();
        (acc.1 > 0).then(|| acc.0 / acc.1 as f64)
    };
    let beep_outputs = beep_state.beep_outputs.lock().unwrap().clone();

    Ok(PatternReport {
        flash_presents: app.flash_presents,
        beep_outputs,
        audio_latency_ms: latency,
    })
}
