//! `cap-verify-stimulus <spec json> <log path>`: see `cap_verify::stimulus`.

#[cfg(not(any(target_os = "macos", windows)))]
fn main() {
    eprintln!("cap-verify-stimulus only runs on macOS and Windows");
    std::process::exit(2);
}

#[cfg(any(target_os = "macos", windows))]
fn main() {
    if let Err(e) = app::run() {
        println!("error {e}");
        std::process::exit(1);
    }
}

#[cfg(any(target_os = "macos", windows))]
mod app {
    use std::{
        fs::File,
        io::{BufRead, Write},
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
        sched,
        stimulus::{StimulusEvent, StimulusSpec, host_add_secs, host_now, host_secs},
        video_code::{self, FrameMarker, PixelOrder, StreamKind},
    };
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
    #[cfg(target_os = "macos")]
    use objc2_foundation::{NSActivityOptions, NSProcessInfo, NSString};
    use winit::{
        application::ApplicationHandler,
        dpi::{LogicalPosition, LogicalSize},
        event::{StartCause, WindowEvent},
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
        let sentinel = Sentinel::start(log_path.with_file_name(SENTINEL_FILE));

        #[cfg(target_os = "macos")]
        let event_loop = {
            use winit::platform::macos::{ActivationPolicy, EventLoopBuilderExtMacOS};
            EventLoop::<Command>::with_user_event()
                .with_activation_policy(ActivationPolicy::Regular)
                .with_activate_ignoring_other_apps(true)
                .build()?
        };
        #[cfg(windows)]
        let event_loop = EventLoop::<Command>::with_user_event().build()?;
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
            thread: sched::current_thread(),
            wake: (String::new(), None),
            presented_at: None,
        };
        let observer = start_observer(app.log.clone());
        let (qos, realtime) = raise_priority(app.spec.fps);
        app.log.write(&StimulusEvent::Priority { qos, realtime });
        #[cfg(target_os = "macos")]
        let result = {
            let process_info = NSProcessInfo::processInfo();
            let activity = unsafe {
                process_info.beginActivityWithOptions_reason(
                    NSActivityOptions::UserInitiated | NSActivityOptions::LatencyCritical,
                    &NSString::from_str("Present recording verification markers on schedule"),
                )
            };
            let result = event_loop.run_app(&mut app);
            unsafe { process_info.endActivity(&activity) };
            result
        };
        #[cfg(windows)]
        let result = event_loop.run_app(&mut app);
        result?;
        drop(observer);
        drop(audio);
        sentinel.finish()?;
        if let Some(error) = app.error {
            anyhow::bail!(error);
        }
        Ok(())
    }

    use cap_verify::stimulus::{SENTINEL_FILE, SENTINEL_PERIOD_SECS};

    /// A real-time thread that only wakes every `SENTINEL_PERIOD_SECS` and
    /// records each wake (host ticks), for the whole life of the stimulus.
    /// At priority 97 it preempts every timeshare thread of every process,
    /// so a long gap between its wakes means the machine itself did not run
    /// (the hypervisor descheduled the virtual CPUs, or the kernel did not
    /// schedule), not that the recorder was busy.
    struct Sentinel {
        stop: Arc<std::sync::atomic::AtomicBool>,
        thread: std::thread::JoinHandle<(sched::Realtime, Option<sched::ThreadState>, Vec<u64>)>,
        path: PathBuf,
    }

    impl Sentinel {
        fn start(path: PathBuf) -> Self {
            let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
            let thread = {
                let stop = stop.clone();
                std::thread::Builder::new()
                    .name("verify-sentinel".into())
                    .spawn(move || {
                        let realtime = sched::request_realtime(SENTINEL_PERIOD_SECS, 0.0005);
                        let me = sched::current_thread();
                        let mut wakes = Vec::with_capacity(64 * 1024);
                        let mut last = host_now();
                        wakes.push(last);
                        while !stop.load(Ordering::Acquire) {
                            sched::wait_until(host_add_secs(last, SENTINEL_PERIOD_SECS));
                            last = host_now();
                            wakes.push(last);
                        }
                        (realtime, sched::thread_state(me), wakes)
                    })
                    .expect("spawn sentinel")
            };
            Self { stop, thread, path }
        }

        /// Writes a JSON header line (scheduling, timebase, first wake),
        /// then one line per wake: ticks since the previous wake.
        fn finish(self) -> anyhow::Result<()> {
            self.stop.store(true, Ordering::Release);
            let (realtime, end, wakes) = self
                .thread
                .join()
                .map_err(|_| anyhow::anyhow!("sentinel panicked"))?;
            // Host ticks to nanoseconds: ticks * numer / denom.
            #[cfg(target_os = "macos")]
            let timebase = {
                let info = cidre::mach::TimeBaseInfo::new();
                [u64::from(info.numer), u64::from(info.denom)]
            };
            #[cfg(windows)]
            let timebase = [1_000_000_000, sched::qpc_frequency()];
            let mut out = serde_json::json!({
                "period_secs": SENTINEL_PERIOD_SECS,
                "timebase": timebase,
                "first": wakes.first(),
                "realtime": realtime,
                "end": end,
            })
            .to_string();
            out.push('\n');
            for w in wakes.windows(2) {
                out.push_str(&(w[1] - w[0]).to_string());
                out.push('\n');
            }
            std::fs::write(&self.path, out)?;
            Ok(())
        }
    }

    /// Stops the observer stream when dropped.
    struct Observer {
        stop: Arc<std::sync::atomic::AtomicBool>,
        thread: Option<std::thread::JoinHandle<()>>,
    }

    impl Drop for Observer {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::Release);
            if let Some(thread) = self.thread.take() {
                let _ = thread.join();
            }
        }
    }

    /// A small ScreenCaptureKit stream of the primary display, owned by this
    /// process: the recorder under test is a different client in a different
    /// process, so a stretch where this stream also receives no new frames
    /// while pictures are being presented is the window server or capture
    /// service stalling (the input never reached the screen or the capture
    /// service), not the recorder.
    #[cfg(windows)]
    fn start_observer(log: Arc<Log>) -> Observer {
        log.write(&StimulusEvent::ObserverUnavailable {
            reason: "no independent capture observer on Windows".into(),
        });
        Observer {
            stop: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            thread: None,
        }
    }

    #[cfg(target_os = "macos")]
    fn start_observer(log: Arc<Log>) -> Observer {
        use cidre::{ns, sc};
        let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let thread = {
            let stop = stop.clone();
            std::thread::spawn(move || {
                let fail =
                    |reason: String| log.write(&StimulusEvent::ObserverUnavailable { reason });
                let content = match futures::executor::block_on(sc::ShareableContent::current()) {
                    Ok(content) => content,
                    Err(e) => return fail(format!("shareable content: {e:?}")),
                };
                let displays = content.displays();
                let Some(display) = displays.iter().next() else {
                    return fail("no display".into());
                };
                let filter =
                    sc::ContentFilter::with_display_excluding_windows(display, &ns::Array::new());
                let config = scap_screencapturekit::StreamCfgBuilder::default()
                    .with_width(160)
                    .with_height(120)
                    .with_fps(60.0)
                    .with_queue_depth(4)
                    .with_shows_cursor(false)
                    .build();
                let observed = log.clone();
                let capturer = scap_screencapturekit::Capturer::builder(filter, config)
                    .with_output_sample_buf_cb(move |frame| {
                        if let scap_screencapturekit::Frame::Screen(frame) = frame {
                            let host = cidre::cm::Clock::convert_host_time_to_sys_units(
                                frame.sample_buf().pts(),
                            );
                            observed.write(&StimulusEvent::Observed { host });
                        }
                    })
                    .build();
                let capturer = match capturer {
                    Ok(capturer) => capturer,
                    Err(e) => return fail(format!("stream: {e:?}")),
                };
                if let Err(e) = futures::executor::block_on(capturer.start()) {
                    return fail(format!("start: {e:?}"));
                }
                while !stop.load(Ordering::Acquire) {
                    std::thread::sleep(Duration::from_millis(20));
                }
                let _ = futures::executor::block_on(capturer.stop());
            })
        };
        Observer {
            stop,
            thread: Some(thread),
        }
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
        surface: Option<canvas::Canvas>,
        size: (u32, u32),
        shown: Option<u32>,
        ready: bool,
        done: bool,
        error: Option<String>,
        created: Option<Instant>,
        idle_tick: u32,
        last_idle: Option<Instant>,
        thread: u32,
        wake: (String, Option<i64>),
        presented_at: Option<(u32, Instant)>,
    }

    /// Hosted runners start jobs at utility QoS (scheduler base priority 20)
    /// and children inherit it, so under recording load the stimulus loses
    /// the CPU to the capture and encoder services for 50-190 ms at a time.
    /// The pictures a user records come from foreground apps; the stimulus
    /// asks for the same treatment (user-interactive QoS) and a time
    /// constraint matching its frame period, so it keeps its schedule
    /// (`cap_verify::sched`, shared with the synthetic camera and
    /// microphone). Returns the kernel status of each request (0 = applied).
    fn raise_priority(fps: f64) -> (i32, i32) {
        let realtime = sched::request_realtime(1.0 / fps, 0.010);
        (realtime.qos_status, realtime.policy_status)
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
            let busy = self.spec.busy;
            let presented = canvas::present(surface, w, h, |bytes| {
                let (w, h) = (w as usize, h as usize);
                let band = if busy { h / 8 } else { 0 };
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
            });
            if presented {
                let host = host_now();
                if self.shown != Some(index) {
                    self.log.write(&StimulusEvent::Frame {
                        index,
                        host,
                        render_started: Some(render_started),
                    });
                }
                self.shown = Some(index);
                if self.go_at.is_some() {
                    self.presented_at = Some((index, Instant::now()));
                }
            }
        }
    }

    /// Where the stimulus draws BGRA pictures and presents them.
    #[cfg(target_os = "macos")]
    mod canvas {
        use super::*;
        use std::num::NonZeroU32;

        pub type Canvas = softbuffer::Surface<Arc<Window>, Arc<Window>>;

        pub fn new(window: &Arc<Window>) -> Result<Canvas, String> {
            softbuffer::Context::new(window.clone())
                .and_then(|context| softbuffer::Surface::new(&context, window.clone()))
                .map_err(|e| e.to_string())
        }

        pub fn present(canvas: &mut Canvas, w: u32, h: u32, paint: impl FnOnce(&mut [u8])) -> bool {
            if canvas
                .resize(NonZeroU32::new(w).unwrap(), NonZeroU32::new(h).unwrap())
                .is_err()
            {
                return false;
            }
            let Ok(mut buffer) = canvas.buffer_mut() else {
                return false;
            };
            let bytes: &mut [u8] = unsafe {
                std::slice::from_raw_parts_mut(
                    buffer.as_mut_ptr().cast::<u8>(),
                    w as usize * h as usize * 4,
                )
            };
            paint(bytes);
            buffer.present().is_ok()
        }
    }

    /// A layered window updated with `UpdateLayeredWindow`, which hands the
    /// compositor a whole picture. A GDI blit into the window's redirection
    /// surface (softbuffer) could be composited, and so captured by Windows
    /// Graphics Capture, half done: recordings showed markers whose top rows
    /// were the new picture and bottom rows the old one (run 39000141528),
    /// also when the blit started right after a composition pass (run
    /// 39004015045). Hosted runners' Hyper-V display rejected a flip-model
    /// DXGI swap chain (run 39002964457).
    #[cfg(windows)]
    mod canvas {
        use super::*;
        use windows::Win32::{
            Foundation::{COLORREF, HWND, POINT, SIZE},
            Graphics::Gdi::{
                BI_RGB, BITMAPINFO, BITMAPINFOHEADER, CreateCompatibleDC, CreateDIBSection,
                DIB_RGB_COLORS, DeleteObject, GetDC, HBITMAP, HDC, SelectObject,
            },
            UI::WindowsAndMessaging::{
                GWL_EXSTYLE, GetWindowLongPtrW, SetWindowLongPtrW, ULW_OPAQUE, UpdateLayeredWindow,
                WS_EX_LAYERED,
            },
        };
        use winit::raw_window_handle::{HasWindowHandle, RawWindowHandle};

        pub struct Canvas {
            hwnd: HWND,
            screen: HDC,
            memory: HDC,
            bitmap: Option<HBITMAP>,
            bits: *mut u8,
            size: (u32, u32),
        }

        pub fn new(window: &Arc<Window>) -> Result<Canvas, String> {
            let hwnd = match window.window_handle().map_err(|e| e.to_string())?.as_raw() {
                RawWindowHandle::Win32(handle) => HWND(handle.hwnd.get() as *mut core::ffi::c_void),
                other => return Err(format!("not a Win32 window: {other:?}")),
            };
            unsafe {
                let style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
                SetWindowLongPtrW(hwnd, GWL_EXSTYLE, style | WS_EX_LAYERED.0 as isize);
                let screen = GetDC(None);
                let memory = CreateCompatibleDC(Some(screen));
                Ok(Canvas {
                    hwnd,
                    screen,
                    memory,
                    bitmap: None,
                    bits: std::ptr::null_mut(),
                    size: (0, 0),
                })
            }
        }

        pub fn present(canvas: &mut Canvas, w: u32, h: u32, paint: impl FnOnce(&mut [u8])) -> bool {
            if canvas.size != (w, h) || canvas.bitmap.is_none() {
                let info = BITMAPINFO {
                    bmiHeader: BITMAPINFOHEADER {
                        biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                        biWidth: w as i32,
                        biHeight: -(h as i32),
                        biPlanes: 1,
                        biBitCount: 32,
                        biCompression: BI_RGB.0,
                        ..Default::default()
                    },
                    ..Default::default()
                };
                let mut bits = std::ptr::null_mut();
                let Ok(bitmap) = (unsafe {
                    CreateDIBSection(
                        Some(canvas.memory),
                        &info,
                        DIB_RGB_COLORS,
                        &mut bits,
                        None,
                        0,
                    )
                }) else {
                    return false;
                };
                unsafe {
                    SelectObject(canvas.memory, bitmap.into());
                    if let Some(old) = canvas.bitmap.replace(bitmap) {
                        let _ = DeleteObject(old.into());
                    }
                }
                canvas.bits = bits.cast();
                canvas.size = (w, h);
            }
            let len = w as usize * h as usize * 4;
            paint(unsafe { std::slice::from_raw_parts_mut(canvas.bits, len) });
            let size = SIZE {
                cx: w as i32,
                cy: h as i32,
            };
            let origin = POINT { x: 0, y: 0 };
            unsafe {
                UpdateLayeredWindow(
                    canvas.hwnd,
                    Some(canvas.screen),
                    None,
                    Some(&size),
                    Some(canvas.memory),
                    Some(&origin),
                    COLORREF(0),
                    None,
                    ULW_OPAQUE,
                )
            }
            .is_ok()
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
            match canvas::new(&window) {
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

        fn new_events(&mut self, _event_loop: &ActiveEventLoop, cause: StartCause) {
            let now = Instant::now();
            self.wake = match cause {
                StartCause::ResumeTimeReached {
                    requested_resume, ..
                } => (
                    "timer".into(),
                    Some(now.saturating_duration_since(requested_resume).as_micros() as i64),
                ),
                StartCause::WaitCancelled {
                    requested_resume, ..
                } => (
                    "cancelled".into(),
                    requested_resume.map(|r| now.saturating_duration_since(r).as_micros() as i64),
                ),
                // A frame is drawn on the poll pass that follows the wake;
                // keep the wake's own lateness.
                StartCause::Poll => return,
                StartCause::Init => ("init".into(), None),
            };
        }

        fn about_to_wait(&mut self, event_loop: &ActiveEventLoop) {
            let now = Instant::now();
            if let Some((index, at)) = self.presented_at.take()
                && let Some(info) = sched::thread_state(self.thread)
            {
                self.log.write(&StimulusEvent::Sched {
                    index,
                    cause: self.wake.0.clone(),
                    wake_late_us: self.wake.1,
                    post_present_us: now.saturating_duration_since(at).as_micros() as i64,
                    cur_pri: info.cur_pri,
                    base_pri: info.base_pri,
                    cpu_us: info.cpu_us,
                });
            }
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
        #[cfg(target_os = "macos")]
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
                    #[cfg(target_os = "macos")]
                    let callback_host = info.timestamp().callback.as_host_time();
                    // WASAPI stream instants are QueryPerformanceCounter
                    // readings in 100 ns units.
                    #[cfg(windows)]
                    let callback_host = {
                        use cpal::host::wasapi::StreamInstantExt;
                        let units = i128::from(info.timestamp().callback.as_performance_counter());
                        (units * i128::from(cap_verify::sched::qpc_frequency()) / 10_000_000) as u64
                    };
                    state.fill(data, callback_host);
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
