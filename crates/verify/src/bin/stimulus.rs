//! `cap-verify-stimulus <spec json> <log path>`: see `cap_verify::stimulus`.

#[cfg(not(target_os = "macos"))]
fn main() {
    eprintln!("cap-verify-stimulus only runs on macOS");
    std::process::exit(2);
}

#[cfg(target_os = "macos")]
fn main() {
    if let Err(e) = app::run() {
        println!("error {e}");
        std::process::exit(1);
    }
}

#[cfg(target_os = "macos")]
mod app {
    use std::{
        fs::File,
        io::{BufRead, Write},
        num::NonZeroU32,
        path::PathBuf,
        sync::{
            Arc, Mutex,
            atomic::{AtomicU64, Ordering},
            mpsc,
        },
        time::{Duration, Instant},
    };

    use cap_verify::{
        audio_code::{self, AudioSource, MarkerPlacement},
        stimulus::{StimulusEvent, StimulusSpec, host_add_secs, host_now, host_secs},
        video_code::{self, FrameMarker, PixelOrder, StreamKind},
    };
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
    use winit::{
        application::ApplicationHandler,
        dpi::{LogicalPosition, LogicalSize},
        event::WindowEvent,
        event_loop::{ActiveEventLoop, ControlFlow, EventLoop, EventLoopProxy},
        window::{Fullscreen, Window, WindowId, WindowLevel},
    };

    #[derive(Debug)]
    enum Command {
        Go,
        Quit,
    }

    struct Log {
        file: Mutex<File>,
    }

    impl Log {
        fn write(&self, event: &StimulusEvent) {
            if let Ok(line) = serde_json::to_string(event)
                && let Ok(mut f) = self.file.lock()
            {
                let _ = writeln!(f, "{line}");
                let _ = f.flush();
            }
        }
    }

    fn say(word: &str) {
        let mut out = std::io::stdout();
        let _ = writeln!(out, "{word}");
        let _ = out.flush();
    }

    pub fn run() -> anyhow::Result<()> {
        let mut args = std::env::args().skip(1);
        let spec: StimulusSpec = serde_json::from_str(&args.next().unwrap_or_default())?;
        let log_path = PathBuf::from(args.next().unwrap_or_default());
        let log = Arc::new(Log {
            file: Mutex::new(File::create(&log_path)?),
        });

        use winit::platform::macos::{ActivationPolicy, EventLoopBuilderExtMacOS};
        let event_loop = EventLoop::<Command>::with_user_event()
            .with_activation_policy(ActivationPolicy::Regular)
            .with_activate_ignoring_other_apps(true)
            .build()?;
        let proxy = event_loop.create_proxy();
        spawn_stdin_reader(proxy);

        let epoch = Arc::new(AtomicU64::new(0));
        let audio = if spec.audio {
            match start_audio(&spec, epoch.clone(), log.clone()) {
                Ok(stream) => Some(stream),
                Err(reason) => {
                    log.write(&StimulusEvent::AudioUnavailable { reason });
                    None
                }
            }
        } else {
            None
        };

        let mut app = App {
            spec,
            log,
            epoch,
            go_at: None,
            window: None,
            surface: None,
            size: (0, 0),
            shown: None,
            ready: false,
            done: false,
            error: None,
            created: None,
            idle_tick: 0,
            last_idle: None,
        };
        event_loop.run_app(&mut app)?;
        drop(audio);
        if let Some(error) = app.error {
            anyhow::bail!(error);
        }
        Ok(())
    }

    fn spawn_stdin_reader(proxy: EventLoopProxy<Command>) {
        std::thread::spawn(move || {
            let stdin = std::io::stdin();
            for line in stdin.lock().lines() {
                let Ok(line) = line else { break };
                let command = match line.trim() {
                    "go" => Command::Go,
                    "quit" => Command::Quit,
                    _ => continue,
                };
                if proxy.send_event(command).is_err() {
                    return;
                }
            }
            let _ = proxy.send_event(Command::Quit);
        });
    }

    struct App {
        spec: StimulusSpec,
        log: Arc<Log>,
        epoch: Arc<AtomicU64>,
        go_at: Option<(Instant, u64)>,
        window: Option<Arc<Window>>,
        surface: Option<softbuffer::Surface<Arc<Window>, Arc<Window>>>,
        size: (u32, u32),
        shown: Option<u32>,
        ready: bool,
        done: bool,
        error: Option<String>,
        created: Option<Instant>,
        idle_tick: u32,
        last_idle: Option<Instant>,
    }

    impl App {
        /// The index that should be on screen now.
        fn desired(&self, now: Instant) -> u32 {
            let Some((go, _)) = self.go_at else {
                return 0;
            };
            let elapsed = now.saturating_duration_since(go).as_secs_f64();
            let last = self.spec.frame_count();
            let mut index = ((elapsed * self.spec.fps).floor() as u32 + 1).min(last);
            while index > 1 && self.spec.held(self.spec.due_secs(index)) {
                index -= 1;
            }
            index.max(self.shown.unwrap_or(0))
        }

        fn next_due(&self, now: Instant) -> Option<Instant> {
            let (go, _) = self.go_at?;
            let shown = self.shown.unwrap_or(0);
            let last = self.spec.frame_count();
            (shown + 1..=last)
                .map(|i| go + Duration::from_secs_f64(self.spec.due_secs(i)))
                .find(|&t| t > now)
                .or(Some(now))
        }

        /// Before `go` the picture keeps frame 0 but the noise bands keep
        /// moving at the frame rate, so the window server is compositing at
        /// full rate by the time the recording starts (a cold paravirtual
        /// display presents its first changes late).
        fn idle_due(&self, now: Instant) -> Option<Instant> {
            if self.go_at.is_some() {
                return None;
            }
            Some(
                self.last_idle
                    .map_or(now, |t| t + Duration::from_secs_f64(1.0 / self.spec.fps)),
            )
        }

        fn draw(&mut self, index: u32, salt: u64) {
            let render_started = host_now();
            let (w, h) = self.size;
            let Some(surface) = self.surface.as_mut() else {
                return;
            };
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
            let (w, h) = (w as usize, h as usize);
            let band = if self.spec.busy { h / 8 } else { 0 };
            {
                let bytes: &mut [u8] = unsafe {
                    std::slice::from_raw_parts_mut(buffer.as_mut_ptr().cast::<u8>(), w * h * 4)
                };
                let stride = w * 4;
                let marker = FrameMarker::new(StreamKind::Screen, 0, index);
                video_code::draw_marker(
                    marker,
                    &mut bytes[band * stride..],
                    w,
                    h - 2 * band,
                    stride,
                    PixelOrder::Bgra,
                );
                if band > 0 {
                    noise_band(&mut bytes[..band * stride], w, band, index, salt << 1);
                    noise_band(
                        &mut bytes[(h - band) * stride..],
                        w,
                        band,
                        index,
                        (salt << 1) | 1,
                    );
                }
            }
            if buffer.present().is_ok() {
                let host = host_now();
                if self.shown != Some(index) {
                    self.log.write(&StimulusEvent::Frame {
                        index,
                        host,
                        render_started: Some(render_started),
                    });
                }
                self.shown = Some(index);
            }
        }
    }

    /// Achromatic 16 px blocks whose levels change every frame.
    fn noise_band(data: &mut [u8], w: usize, h: usize, index: u32, salt: u64) {
        let stride = w * 4;
        let mut seed = (u64::from(index) + 1).wrapping_mul(0x9E37_79B9_7F4A_7C15) ^ salt;
        let blocks_x = w.div_ceil(16);
        let mut levels = vec![0u8; blocks_x * h.div_ceil(16)];
        for level in &mut levels {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            *level = 40 + (seed % 176) as u8;
        }
        for y in 0..h {
            let row = &mut data[y * stride..y * stride + w * 4];
            for (x, px) in row.chunks_exact_mut(4).enumerate() {
                let v = levels[(y / 16) * blocks_x + x / 16];
                px.copy_from_slice(&[v, v, v, 255]);
            }
        }
    }

    impl ApplicationHandler<Command> for App {
        fn resumed(&mut self, event_loop: &ActiveEventLoop) {
            if self.window.is_some() {
                return;
            }
            let mut attrs = Window::default_attributes()
                .with_title("Cap Verify Stimulus")
                .with_window_level(WindowLevel::AlwaysOnTop);
            attrs = match self.spec.window {
                None => attrs
                    .with_fullscreen(Some(Fullscreen::Borderless(event_loop.primary_monitor()))),
                Some((x, y, w, h)) => attrs
                    .with_decorations(false)
                    .with_resizable(false)
                    .with_position(LogicalPosition::new(x, y))
                    .with_inner_size(LogicalSize::new(w, h)),
            };
            let window = match event_loop.create_window(attrs) {
                Ok(w) => Arc::new(w),
                Err(e) => {
                    self.error = Some(format!("window: {e}"));
                    event_loop.exit();
                    return;
                }
            };
            let size = window.inner_size();
            self.size = (size.width, size.height);
            let surface = softbuffer::Context::new(window.clone())
                .and_then(|context| softbuffer::Surface::new(&context, window.clone()));
            match surface {
                Ok(s) => self.surface = Some(s),
                Err(e) => {
                    self.error = Some(format!("surface: {e}"));
                    event_loop.exit();
                    return;
                }
            }
            window.request_redraw();
            self.window = Some(window);
        }

        fn user_event(&mut self, event_loop: &ActiveEventLoop, command: Command) {
            match command {
                Command::Go if self.go_at.is_none() => {
                    let host = host_now();
                    self.go_at = Some((Instant::now(), host));
                    self.epoch.store(host, Ordering::Release);
                    self.log.write(&StimulusEvent::Go { host });
                    if let Some(window) = &self.window {
                        window.request_redraw();
                    }
                }
                Command::Go => {}
                Command::Quit => event_loop.exit(),
            }
        }

        fn window_event(
            &mut self,
            event_loop: &ActiveEventLoop,
            _id: WindowId,
            event: WindowEvent,
        ) {
            match event {
                WindowEvent::CloseRequested => event_loop.exit(),
                WindowEvent::Resized(size) => {
                    self.size = (size.width, size.height);
                    if let Some(window) = &self.window {
                        window.request_redraw();
                    }
                }
                WindowEvent::RedrawRequested => {
                    let now = Instant::now();
                    let created = *self.created.get_or_insert(now);
                    let index = self.desired(now);
                    if self.go_at.is_none() {
                        if self.idle_due(now).is_some_and(|due| due <= now) {
                            self.idle_tick += 1;
                            self.last_idle = Some(now);
                            self.draw(0, u64::from(self.idle_tick));
                        }
                    } else if self.shown != Some(index) {
                        self.draw(index, 0);
                    }
                    let warm = now.duration_since(created).as_secs_f64() >= self.spec.warmup;
                    if !self.ready && warm && self.shown == Some(0) {
                        self.ready = true;
                        let scale = self.window.as_ref().map_or(1.0, |w| w.scale_factor());
                        self.log.write(&StimulusEvent::Ready {
                            host: host_now(),
                            width: self.size.0,
                            height: self.size.1,
                            scale,
                        });
                        say("ready");
                    }
                    if !self.done
                        && self.go_at.is_some()
                        && self.shown == Some(self.spec.frame_count())
                    {
                        self.done = true;
                        self.log.write(&StimulusEvent::Done { host: host_now() });
                        say("done");
                    }
                }
                _ => {}
            }
        }

        fn about_to_wait(&mut self, event_loop: &ActiveEventLoop) {
            let now = Instant::now();
            if let Some(due) = self.idle_due(now) {
                if due <= now
                    && let Some(window) = &self.window
                {
                    window.request_redraw();
                }
                event_loop.set_control_flow(ControlFlow::WaitUntil(due.max(now)));
                return;
            }
            if self.done {
                event_loop.set_control_flow(ControlFlow::Wait);
                return;
            }
            if let Some(window) = &self.window
                && self.desired(now) != self.shown.unwrap_or(0)
            {
                window.request_redraw();
                event_loop.set_control_flow(ControlFlow::Poll);
                return;
            }
            match self.next_due(now) {
                Some(next) => event_loop.set_control_flow(ControlFlow::WaitUntil(next)),
                None => event_loop.set_control_flow(ControlFlow::Wait),
            }
        }
    }

    struct AudioState {
        sample_rate: u32,
        channels: usize,
        epoch: Arc<AtomicU64>,
        schedule_origin: u64,
        lead_secs: f64,
        seconds: f64,
        markers: Vec<(MarkerPlacement, Vec<f32>)>,
        written: u64,
        anchor: Option<(i64, u64)>,
        events: mpsc::Sender<StimulusEvent>,
    }

    impl AudioState {
        fn fill(&mut self, data: &mut [f32], callback_host: u64) {
            data.fill(0.0);
            let frames = data.len() / self.channels.max(1);
            let start = self.written as i64;
            self.written += frames as u64;
            let go = self.epoch.load(Ordering::Acquire);
            if go == 0 {
                return;
            }
            let rate = f64::from(self.sample_rate);
            let (anchor_sample, anchor_host) = *self.anchor.get_or_insert((start, callback_host));
            let end = start + frames as i64;
            for (placement, wave) in &self.markers {
                let host = host_add_secs(self.schedule_origin, placement.time_secs);
                let after_go = host_secs(host, go);
                if after_go < self.lead_secs || after_go > self.seconds {
                    continue;
                }
                let first = anchor_sample + (host_secs(host, anchor_host) * rate).round() as i64;
                let last = first + wave.len() as i64;
                if last <= start || first >= end {
                    continue;
                }
                if first >= start {
                    let offset = (first - start) as f64 / rate;
                    let _ = self.events.send(StimulusEvent::Audio {
                        index: placement.index,
                        host: host_add_secs(callback_host, offset),
                    });
                }
                for i in 0..frames {
                    let at = start + i as i64;
                    if at < first || at >= last {
                        continue;
                    }
                    let v = wave[(at - first) as usize] * audio_code::DEFAULT_AMPLITUDE;
                    for c in 0..self.channels {
                        data[i * self.channels + c] += v;
                    }
                }
            }
        }
    }

    fn start_audio(
        spec: &StimulusSpec,
        epoch: Arc<AtomicU64>,
        log: Arc<Log>,
    ) -> Result<cpal::Stream, String> {
        use cpal::host::coreaudio::StreamInstantExt;

        let host = cpal::default_host();
        let device = match std::env::var("CAP_VERIFY_AUDIO_OUTPUT") {
            Ok(name) if !name.is_empty() => host
                .output_devices()
                .map_err(|e| format!("output devices: {e}"))?
                .find(|d| d.name().is_ok_and(|n| n == name))
                .ok_or_else(|| format!("no output device named {name}"))?,
            _ => host
                .default_output_device()
                .ok_or("no default output device")?,
        };
        let config = device
            .default_output_config()
            .map_err(|e| format!("output config: {e}"))?;
        if config.sample_format() != cpal::SampleFormat::F32 {
            return Err(format!("unsupported format {:?}", config.sample_format()));
        }
        let sample_rate = config.sample_rate().0;
        let channels = config.channels();
        let schedule_origin = if spec.audio_origin == 0 {
            host_now()
        } else {
            spec.audio_origin
        };
        // The schedule shares its origin with the other marker sources of
        // the case, so the per-source phases keep markers from overlapping.
        let horizon = host_secs(host_now(), schedule_origin).max(0.0) + 120.0 + spec.seconds;
        let markers = audio_code::standard_schedule(
            AudioSource::System,
            0.0,
            horizon.min(f64::from(audio_code::MAX_AUDIO_INDEX) * spec.audio_period),
            spec.audio_period,
        )
        .into_iter()
        .map(|p| {
            let wave = audio_code::marker_waveform(AudioSource::System, p.index, sample_rate);
            (p, wave)
        })
        .collect();
        let (tx, rx) = mpsc::channel::<StimulusEvent>();
        {
            let log = log.clone();
            std::thread::spawn(move || {
                for event in rx {
                    log.write(&event);
                }
            });
        }
        let mut state = AudioState {
            sample_rate,
            channels: usize::from(channels),
            epoch,
            schedule_origin,
            lead_secs: 0.25,
            seconds: spec.seconds,
            markers,
            written: 0,
            anchor: None,
            events: tx,
        };
        let stream = device
            .build_output_stream(
                &config.config(),
                move |data: &mut [f32], info: &cpal::OutputCallbackInfo| {
                    state.fill(data, info.timestamp().callback.as_host_time());
                },
                |e| eprintln!("stimulus audio error: {e}"),
                None,
            )
            .map_err(|e| format!("output stream: {e}"))?;
        stream.play().map_err(|e| format!("play: {e}"))?;
        log.write(&StimulusEvent::AudioStarted {
            device: device.name().unwrap_or_default(),
            sample_rate,
            channels,
        });
        Ok(stream)
    }
}
