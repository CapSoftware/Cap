//! Real-capture recording oracle (macOS).
//!
//! A helper process shows the screen marker of a monotonically increasing
//! frame index at a fixed rate and plays system-audio markers; synthetic
//! camera and microphone feeds deliver their own markers with exact capture
//! times. Cap's real Studio and Instant pipelines record it all through
//! ScreenCaptureKit and VideoToolbox, stop and finalize exactly like the app
//! and the CLI, and every output frame and audio marker is then checked
//! against the host-clock truth logged by the sources.
//!
//! Capture mode (`CAP_VERIFY_CAPTURE`): `display` records the primary display
//! with a fullscreen stimulus (CI); `window` records only the stimulus window
//! (default on a developer Mac, so other screen activity cannot leak in);
//! `off` skips. Without Screen Recording permission the cases skip unless
//! `CAP_VERIFY_REQUIRE_CAPTURE=1`.

#![cfg(target_os = "macos")]

use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::Duration,
};

use cap_media_info::{RawVideoFormat, VideoInfo};
use cap_project::{InstantRecordingMeta, RecordingMeta, RecordingMetaInner, StudioRecordingMeta};
use cap_recording::{
    NativeCameraFrame, RecordingDefaults, SendableShareableContent, StudioQuality,
    feeds::{camera::synthetic::SyntheticCamera, microphone::synthetic::SyntheticMicrophone},
    instant_recording,
    recovery::RecoveryManager,
    screen_capture::ScreenCaptureTarget,
    studio_recording,
};
use cap_timestamp::{MachAbsoluteTimestamp, Timestamp};
use cap_verify::{
    audio_code::{self, AudioSource, MarkerPlacement},
    fixture_avf, media,
    report::{self, Case, Tier},
    stimulus::{StimulusEvent, StimulusProcess, StimulusSpec, host_add_secs, host_now, host_secs},
    video_code::{self, FrameMarker, Readout, StreamKind},
};

static ATTEMPT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

const MIC_RATE: u32 = 48_000;
const MIC_CHUNK: usize = 480;
const CAMERA_FPS: u32 = 30;
const CAMERA_SIZE: (usize, usize) = (640, 360);
const AUDIO_PERIOD: f64 = 0.5;
const WINDOW_TITLE: &str = "Cap Verify Stimulus";
const SYSTEM_AUDIO_STARTUP: f64 = 1.0;
const START_CUE_MS: u64 = 400;
/// Frames a track may lose while its encoder starts (the capture pool is full
/// until VideoToolbox is ready; #2573 measured 0-6 per run).
const STARTUP_SECS: f64 = 1.0;
const STARTUP_DROPS: usize = 6;
const SCREEN_MISS_FRACTION: f64 = 0.03;
/// Video frames are stamped from their source capture time until the drift
/// anchor, two seconds into the track (`VideoDriftTracker` in
/// crates/recording/src/output_pipeline/core.rs); after it, from the
/// processing wall clock.
const DRIFT_ANCHOR_SECS: f64 = 2.0;
/// Stimulus rate for cases captured at 30 fps (Instant, Studio with a
/// camera). A picture is only guaranteed a sample when it stays on screen
/// for one capture interval plus one refresh (50 ms at 30 fps); 20 fps
/// pictures last exactly that long, so about half of them were excused from
/// the drop checks. At 15 fps every picture lasts 67 ms and must be captured.
const STIMULUS_FPS_30: f64 = 15.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Mode {
    Studio {
        fragmented: bool,
        camera: bool,
    },
    Instant,
    /// Fragmented Studio whose on-disk state is snapshotted mid-recording
    /// (an APFS clone of the project, exactly what a crash leaves behind:
    /// in-progress meta, finished fragments, the fragment being written),
    /// then recovered the way the app recovers it.
    StudioCrashed,
}

#[derive(Clone, Debug)]
struct Spec {
    id: &'static str,
    tier: Tier,
    mode: Mode,
    seconds: f64,
    stimulus_fps: f64,
    holds: Vec<(f64, f64)>,
    /// Pairs of consecutive camera frames dropped this many seconds after
    /// the recording started (the start-up drops #2573 fixed).
    camera_drops_at: Vec<f64>,
    /// The app's start sequence: the recording is built behind a
    /// `RecordingStartGate` that the start cue arms a moment later.
    gated: bool,
    /// The microphone delivers its first sample this long after the
    /// recording started (a device that wakes late).
    mic_delay: f64,
    mic: bool,
    system_audio: bool,
}

fn specs() -> Vec<Spec> {
    vec![
        Spec {
            id: "recording/studio-screen/fragmented",
            tier: Tier::Fast,
            mode: Mode::Studio {
                fragmented: true,
                camera: false,
            },
            seconds: 8.0,
            stimulus_fps: 20.0,
            holds: vec![],
            camera_drops_at: vec![],
            gated: false,
            mic_delay: 0.0,
            mic: true,
            system_audio: true,
        },
        Spec {
            id: "recording/studio-camera/startup-drops",
            tier: Tier::Fast,
            mode: Mode::Studio {
                fragmented: true,
                camera: true,
            },
            seconds: 8.0,
            stimulus_fps: STIMULUS_FPS_30,
            holds: vec![],
            camera_drops_at: vec![0.3, 1.1],
            gated: false,
            mic_delay: 0.0,
            mic: true,
            system_audio: true,
        },
        Spec {
            id: "recording/instant/screen-mic-system",
            tier: Tier::Fast,
            mode: Mode::Instant,
            seconds: 8.0,
            stimulus_fps: STIMULUS_FPS_30,
            holds: vec![],
            camera_drops_at: vec![],
            gated: false,
            mic_delay: 0.0,
            mic: true,
            system_audio: true,
        },
        Spec {
            id: "recording/studio-screen/gated",
            tier: Tier::Fast,
            mode: Mode::Studio {
                fragmented: true,
                camera: false,
            },
            seconds: 8.0,
            stimulus_fps: 20.0,
            holds: vec![],
            camera_drops_at: vec![],
            gated: true,
            mic_delay: 0.0,
            mic: true,
            system_audio: true,
        },
        Spec {
            id: "recording/instant/gated",
            tier: Tier::Fast,
            mode: Mode::Instant,
            seconds: 8.0,
            stimulus_fps: STIMULUS_FPS_30,
            holds: vec![],
            camera_drops_at: vec![],
            gated: true,
            mic_delay: 0.0,
            mic: true,
            system_audio: true,
        },
        Spec {
            id: "recording/instant/late-mic",
            tier: Tier::Fast,
            mode: Mode::Instant,
            seconds: 8.0,
            stimulus_fps: STIMULUS_FPS_30,
            holds: vec![],
            camera_drops_at: vec![],
            gated: false,
            mic_delay: 1.0,
            mic: true,
            system_audio: false,
        },
        Spec {
            id: "recording/instant/system-only",
            tier: Tier::Fast,
            mode: Mode::Instant,
            seconds: 8.0,
            stimulus_fps: STIMULUS_FPS_30,
            holds: vec![],
            camera_drops_at: vec![],
            gated: false,
            mic_delay: 0.0,
            mic: false,
            system_audio: true,
        },
        Spec {
            id: "recording/studio-screen/late-mic",
            tier: Tier::Full,
            mode: Mode::Studio {
                fragmented: true,
                camera: false,
            },
            seconds: 8.0,
            stimulus_fps: 20.0,
            holds: vec![],
            camera_drops_at: vec![],
            gated: false,
            mic_delay: 0.3,
            mic: true,
            system_audio: true,
        },
        Spec {
            id: "recording/studio-recovery/crash",
            tier: Tier::Fast,
            mode: Mode::StudioCrashed,
            seconds: 8.0,
            stimulus_fps: 20.0,
            holds: vec![],
            camera_drops_at: vec![],
            gated: false,
            mic_delay: 0.0,
            mic: true,
            system_audio: true,
        },
        Spec {
            id: "recording/studio-screen/mp4-holds",
            tier: Tier::Full,
            mode: Mode::Studio {
                fragmented: false,
                camera: false,
            },
            seconds: 30.0,
            stimulus_fps: 20.0,
            holds: vec![(5.0, 2.0), (12.0, 0.5), (20.0, 4.0)],
            camera_drops_at: vec![],
            gated: false,
            mic_delay: 0.0,
            mic: true,
            system_audio: true,
        },
        Spec {
            id: "recording/studio-camera/long",
            tier: Tier::Full,
            mode: Mode::Studio {
                fragmented: true,
                camera: true,
            },
            seconds: 30.0,
            stimulus_fps: STIMULUS_FPS_30,
            holds: vec![(10.0, 3.0)],
            camera_drops_at: vec![0.5, 1.5, 12.0],
            gated: false,
            mic_delay: 0.0,
            mic: true,
            system_audio: true,
        },
        Spec {
            id: "recording/instant/long-holds",
            tier: Tier::Full,
            mode: Mode::Instant,
            seconds: 30.0,
            stimulus_fps: STIMULUS_FPS_30,
            holds: vec![(6.0, 2.0), (18.0, 5.0)],
            camera_drops_at: vec![],
            gated: false,
            mic_delay: 0.0,
            mic: true,
            system_audio: true,
        },
    ]
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CaptureMode {
    Display,
    Window,
}

fn capture_mode() -> Option<CaptureMode> {
    match std::env::var("CAP_VERIFY_CAPTURE").as_deref() {
        Ok("display") => Some(CaptureMode::Display),
        Ok("window") => Some(CaptureMode::Window),
        Ok("off") => None,
        _ if std::env::var_os("CI").is_some() => Some(CaptureMode::Display),
        _ => Some(CaptureMode::Window),
    }
}

/// System audio is required on a developer Mac and, with
/// `CAP_VERIFY_REQUIRE_SYSTEM_AUDIO=1`, anywhere.
fn require_system_audio() -> bool {
    match std::env::var("CAP_VERIFY_REQUIRE_SYSTEM_AUDIO").as_deref() {
        Ok("1") | Ok("true") => true,
        Ok(_) => false,
        Err(_) => std::env::var_os("CI").is_none(),
    }
}

fn env_flag(name: &str) -> bool {
    matches!(std::env::var(name).as_deref(), Ok("1") | Ok("true"))
}

/// Hosted runners start jobs at utility QoS (scheduler priority 20) and
/// every thread of the test inherits it, below what an app the user is
/// running gets. The runtime also drives the synthetic camera and
/// microphone, which stand in for capture callbacks the system delivers at
/// high priority; at utility priority a loaded runner delays them and their
/// lateness shows up as recording timing errors. Run the runtime at the
/// priority the product itself asks for its recording threads.
#[cfg(target_os = "macos")]
fn raise_thread_qos() {
    const QOS_CLASS_USER_INITIATED: u32 = 0x19;
    unsafe extern "C" {
        fn pthread_set_qos_class_self_np(qos: u32, relative_priority: i32) -> i32;
    }
    unsafe { pthread_set_qos_class_self_np(QOS_CLASS_USER_INITIATED, 0) };
}

fn runtime() -> tokio::runtime::Runtime {
    raise_thread_qos();
    tokio::runtime::Builder::new_multi_thread()
        .on_thread_start(raise_thread_qos)
        .worker_threads(4)
        .thread_stack_size(16 * 1024 * 1024)
        .enable_all()
        .build()
        .expect("runtime")
}

fn init() {
    media::init();
    if std::env::var_os("RUST_LOG").is_some() {
        let _ = tracing_subscriber::fmt()
            .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
            .with_writer(std::io::stderr)
            .try_init();
    }
}

#[test]
fn real_capture() {
    init();
    let Some(capture) = capture_mode() else {
        eprintln!("[cap-verify] recording: CAP_VERIFY_CAPTURE=off, skipping");
        return;
    };
    let rt = runtime();
    let shareable = match rt.block_on(cidre::sc::ShareableContent::current()) {
        Ok(content) => SendableShareableContent::from(content),
        Err(e) => {
            let message = format!("ScreenCaptureKit unavailable ({e:?}); grant Screen Recording");
            if env_flag("CAP_VERIFY_REQUIRE_CAPTURE") {
                panic!("{message}");
            }
            eprintln!("[cap-verify] recording: {message}, skipping");
            return;
        }
    };
    let tier = report::tier();
    let repeat: usize = std::env::var("CAP_VERIFY_REPEAT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(1);
    // A cold runner (WindowServer, ScreenCaptureKit, VideoToolbox) delivers
    // its first recording late and irregularly; one discarded recording
    // brings every case onto the steady state a user's machine is in.
    if specs()
        .iter()
        .any(|s| report::selected(s.id) && (s.tier == Tier::Fast || tier == Tier::Full))
    {
        let warmup = Spec {
            id: "recording/warmup",
            tier: Tier::Fast,
            mode: Mode::Studio {
                fragmented: true,
                camera: false,
            },
            seconds: 2.0,
            stimulus_fps: 20.0,
            holds: vec![],
            camera_drops_at: vec![],
            gated: false,
            mic_delay: 0.0,
            mic: true,
            system_audio: true,
        };
        let mut case = Case::new(warmup.id);
        let started = std::time::Instant::now();
        let result = rt.block_on(async {
            let scratch = scratch_root().join("warmup");
            let _ = std::fs::remove_dir_all(&scratch);
            std::fs::create_dir_all(&scratch)?;
            let recorded = record(
                &warmup,
                capture,
                &shareable,
                &scratch,
                host_now(),
                &mut case,
            )
            .await;
            let _ = std::fs::remove_dir_all(&scratch);
            recorded.map(|_| ())
        });
        eprintln!(
            "[cap-verify] warm-up recording {} in {:.1}s",
            if result.is_ok() { "done" } else { "failed" },
            started.elapsed().as_secs_f64()
        );
    }
    let mut failures = Vec::new();
    for spec in specs() {
        if !report::selected(spec.id) || (spec.tier == Tier::Full && tier == Tier::Fast) {
            continue;
        }
        if !spec.mic && !require_system_audio() {
            eprintln!(
                "[cap-verify] {}: skipped, system audio is its only audio and this host's output is not capturable",
                spec.id
            );
            continue;
        }
        for attempt in 0..repeat {
            ATTEMPT.store(attempt + 1, Ordering::Relaxed);
            let mut case = Case::new(spec.id);
            if repeat > 1 {
                case.note(format!("repeat {}/{repeat}", attempt + 1));
            }
            if let Err(e) = rt.block_on(run_case(&spec, capture, &shareable, &mut case)) {
                case.problem("error", format!("{e:#}"));
            }
            for note in &case.notes {
                eprintln!("  note: {note}");
            }
            if let Err(e) = report::settle(case) {
                failures.push(e);
            }
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

/// Host-clock truth for one source: marker index -> host time (seconds from
/// the case reference).
type Truth = BTreeMap<u32, f64>;

struct Feeds {
    mic: Arc<SyntheticMicrophone>,
    camera: Option<Arc<SyntheticCamera>>,
    stop: Arc<AtomicBool>,
    started: Arc<AtomicU64>,
    mic_truth: Truth,
    mic_task: tokio::task::JoinHandle<SourceLag>,
    camera_task: Option<tokio::task::JoinHandle<(Truth, Vec<u32>, SourceLag)>>,
}

/// Hand-offs a synthetic source made late: (seconds from the reference when
/// the frame or chunk was due, seconds late). Only lateness above 20 ms is
/// kept.
#[derive(Clone, Debug, Default)]
struct SourceLag(Vec<(f64, f64)>);

impl SourceLag {
    fn observe(&mut self, due: u64, reference: u64) {
        let late = host_secs(host_now(), due);
        if late > 0.02 {
            self.0.push((host_secs(due, reference), late));
        }
    }

    /// The latest hand-off inside the window.
    fn worst_in(&self, window: (f64, f64)) -> Option<(f64, f64)> {
        self.0
            .iter()
            .copied()
            .filter(|(at, _)| *at >= window.0 && *at <= window.1)
            .max_by(|a, b| a.1.total_cmp(&b.1))
    }
}

/// Synthetic sources stand in for capture devices, which the system feeds
/// from its own high-priority threads. They run on dedicated threads at
/// user-interactive QoS (not on the recorder's async runtime) and block on
/// their feed the way a device callback would.
fn source_thread_qos() {
    const QOS_CLASS_USER_INTERACTIVE: u32 = 0x21;
    unsafe extern "C" {
        fn pthread_set_qos_class_self_np(qos: u32, relative_priority: i32) -> i32;
    }
    unsafe { pthread_set_qos_class_self_np(QOS_CLASS_USER_INTERACTIVE, 0) };
}

fn sleep_until_host_blocking(host: u64) {
    let secs = host_secs(host, host_now());
    if secs > 0.0 {
        std::thread::sleep(Duration::from_secs_f64(secs));
    }
}

fn start_feeds(
    reference: u64,
    max_secs: f64,
    camera: bool,
    drops_at: Vec<f64>,
    mic_delay: f64,
) -> Feeds {
    let stop = Arc::new(AtomicBool::new(false));
    let started = Arc::new(AtomicU64::new(0));
    let mic = Arc::new(SyntheticMicrophone::spawn(
        "Cap Verify Synthetic Microphone",
        MIC_RATE,
        1,
    ));
    let origin = host_now();
    // Marker times count from the case reference, like the system audio
    // stimulus, so the two sources' phases never overlap.
    let base = host_secs(origin, reference);
    let schedule: Vec<MarkerPlacement> =
        audio_code::standard_schedule(AudioSource::Mic, 0.0, base + max_secs, AUDIO_PERIOD)
            .into_iter()
            .filter(|p| p.time_secs >= base + 0.3)
            .map(|p| MarkerPlacement {
                index: p.index,
                time_secs: p.time_secs - base,
            })
            .collect();
    let rate = f64::from(MIC_RATE);
    let mic_truth: Truth = schedule
        .iter()
        .map(|p| (p.index, base + (p.time_secs * rate).round() / rate))
        .collect();
    let handle = tokio::runtime::Handle::current();
    let mic_task = {
        let mic = mic.clone();
        let stop = stop.clone();
        let started = started.clone();
        let handle = handle.clone();
        tokio::task::spawn_blocking(move || {
            source_thread_qos();
            let mut lag = SourceLag::default();
            let mut signal = vec![0.0f32; (max_secs * f64::from(MIC_RATE)) as usize];
            audio_code::render_markers(
                &mut signal,
                MIC_RATE,
                AudioSource::Mic,
                &schedule,
                audio_code::DEFAULT_AMPLITUDE,
            );
            for (n, chunk) in signal.chunks(MIC_CHUNK).enumerate() {
                if stop.load(Ordering::Acquire) {
                    break;
                }
                let first = n * MIC_CHUNK;
                let capture = host_add_secs(origin, first as f64 / f64::from(MIC_RATE));
                let delivered =
                    host_add_secs(origin, (first + chunk.len()) as f64 / f64::from(MIC_RATE));
                sleep_until_host_blocking(delivered);
                if mic_delay > 0.0 {
                    let start = started.load(Ordering::Acquire);
                    if start == 0 || host_secs(capture, start) < mic_delay {
                        continue;
                    }
                }
                if started.load(Ordering::Acquire) != 0 {
                    lag.observe(delivered, reference);
                }
                handle.block_on(mic.push(
                    chunk,
                    Timestamp::MachAbsoluteTime(MachAbsoluteTimestamp::new(capture)),
                ));
            }
            lag
        })
    };
    let (camera, camera_task) = if camera {
        let info = VideoInfo::from_raw(
            RawVideoFormat::Nv12,
            CAMERA_SIZE.0 as u32,
            CAMERA_SIZE.1 as u32,
            CAMERA_FPS,
        );
        let feed = Arc::new(SyntheticCamera::spawn("Cap Verify Synthetic Camera", info));
        let task = {
            let feed = feed.clone();
            let stop = stop.clone();
            let started = started.clone();
            let handle = handle.clone();
            tokio::task::spawn_blocking(move || {
                source_thread_qos();
                let mut lag = SourceLag::default();
                let origin = host_now();
                let base = host_secs(origin, reference);
                let mut truth = Truth::new();
                let mut dropped = Vec::new();
                let mut drop_slots: Option<Vec<u32>> = None;
                for slot in 0..(max_secs * f64::from(CAMERA_FPS)) as u32 {
                    if stop.load(Ordering::Acquire) {
                        break;
                    }
                    let secs = f64::from(slot) / f64::from(CAMERA_FPS);
                    let capture = host_add_secs(origin, secs);
                    sleep_until_host_blocking(capture);
                    let start = started.load(Ordering::Acquire);
                    if drop_slots.is_none() && start != 0 {
                        let since = host_secs(start, origin);
                        drop_slots = Some(
                            drops_at
                                .iter()
                                .flat_map(|at| {
                                    let s = ((since + at) * f64::from(CAMERA_FPS)).ceil() as u32;
                                    [s, s + 1]
                                })
                                .collect(),
                        );
                    }
                    if drop_slots.as_ref().is_some_and(|d| d.contains(&slot)) {
                        dropped.push(slot);
                        continue;
                    }
                    let Some(frame) = camera_frame(slot, capture) else {
                        continue;
                    };
                    if start != 0 {
                        lag.observe(capture, reference);
                    }
                    handle.block_on(feed.push_native(frame));
                    truth.insert(slot, base + secs);
                }
                (truth, dropped, lag)
            })
        };
        (Some(feed), Some(task))
    } else {
        (None, None)
    };
    Feeds {
        mic,
        mic_truth,
        camera,
        stop,
        started,
        mic_task,
        camera_task,
    }
}

fn camera_frame(slot: u32, capture: u64) -> Option<NativeCameraFrame> {
    let (w, h) = CAMERA_SIZE;
    let rgba = video_code::marker_rgba(FrameMarker::new(StreamKind::Camera, 0, slot), w, h);
    let sample_buf = camera_sample(&rgba, w, h, capture).ok()?;
    Some(NativeCameraFrame {
        sample_buf,
        timestamp: Timestamp::MachAbsoluteTime(MachAbsoluteTimestamp::new(capture)),
    })
}

fn camera_sample(
    rgba: &[u8],
    w: usize,
    h: usize,
    host: u64,
) -> anyhow::Result<cidre::arc::R<cidre::cm::SampleBuf>> {
    use cidre::cm;
    let buf = fixture_avf::pixel_buffer(w, h, rgba)?;
    let format_desc = cm::VideoFormatDesc::with_image_buf(&buf)
        .map_err(|e| anyhow::anyhow!("format description: {e:?}"))?;
    let nanos = (host_secs(host, 0) * 1e9).round() as i64;
    let timing = cm::SampleTimingInfo {
        duration: cm::Time::new(1, CAMERA_FPS as i32),
        pts: cm::Time::new(nanos, 1_000_000_000),
        dts: cm::Time::invalid(),
    };
    cm::SampleBuf::with_image_buf(&buf, true, None, std::ptr::null(), &format_desc, &timing)
        .map_err(|e| anyhow::anyhow!("sample buffer: {e:?}"))
}

enum Handle {
    Studio(studio_recording::ActorHandle),
    Instant(instant_recording::ActorHandle),
}

/// Capture target plus every window except the stimulus, which is excluded
/// from the capture filter so system prompts and the developer's apps never
/// reach the recording.
async fn capture_setup(
    capture: CaptureMode,
) -> anyhow::Result<(
    ScreenCaptureTarget,
    Vec<scap_targets::WindowId>,
    SendableShareableContent,
)> {
    let stimulus_window = find_window(WINDOW_TITLE);
    let excluded = scap_targets::Window::list()
        .into_iter()
        .map(|w| w.id())
        .filter(|id| Some(id) != stimulus_window.as_ref())
        .collect();
    let shareable = cidre::sc::ShareableContent::current()
        .await
        .map_err(|e| anyhow::anyhow!("shareable content: {e:?}"))?
        .into();
    let target = match capture {
        CaptureMode::Display => ScreenCaptureTarget::Display {
            id: scap_targets::Display::primary().id(),
        },
        CaptureMode::Window => ScreenCaptureTarget::Window {
            id: stimulus_window.ok_or_else(|| anyhow::anyhow!("stimulus window not found"))?,
        },
    };
    Ok((target, excluded, shareable))
}

/// The app's Studio builder (`RecordingDefaults::apply_to_studio_builder`)
/// with the capture-independent settings pinned: no keyboard capture (it
/// would prompt for Input Monitoring) and Balanced quality on every host.
fn studio_builder(
    project: PathBuf,
    target: ScreenCaptureTarget,
    excluded: Vec<scap_targets::WindowId>,
    fragmented: bool,
    camera: bool,
    system_audio: bool,
) -> (studio_recording::ActorBuilder, u32) {
    let defaults = RecordingDefaults::default();
    let builder = defaults
        .apply_to_studio_builder(
            studio_recording::Actor::builder(project, target).with_system_audio(system_audio),
            camera,
            None,
        )
        .with_excluded_windows(excluded)
        .with_keyboard_capture(false)
        .with_fragmented(fragmented)
        .with_quality(StudioQuality::Balanced);
    (builder, defaults.studio_max_fps(camera, None))
}

fn stimulus_binary() -> PathBuf {
    std::env::var_os("CAP_VERIFY_STIMULUS_BIN")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            // Built by `cargo build -p cap-verify-stimulus` into the same
            // target directory as this test (target/<profile>/deps/..).
            let exe = std::env::current_exe().expect("test executable path");
            let path = exe
                .parent()
                .and_then(|deps| deps.parent())
                .expect("target profile directory")
                .join("cap-verify-stimulus");
            assert!(
                path.exists(),
                "{} not found: build it first with `cargo build -p cap-verify-stimulus` (same profile), or set CAP_VERIFY_STIMULUS_BIN",
                path.display()
            );
            path
        })
}

fn find_window(title: &str) -> Option<scap_targets::WindowId> {
    scap_targets::Window::list()
        .into_iter()
        .find(|w| w.name().as_deref() == Some(title))
        .map(|w| w.id())
}

struct Recorded {
    project: PathBuf,
    started: f64,
    stopped: f64,
    stimulus: Vec<StimulusEvent>,
    mic_truth: Truth,
    camera: Option<(Truth, Vec<u32>)>,
    max_fps: u32,
    mic_delay: f64,
    /// The stimulus's scripted holds and rate, to locate the first picture
    /// after each hold.
    holds: Vec<(f64, f64)>,
    stimulus_fps: f64,
    /// Late hand-offs of the synthetic microphone and camera.
    source_lag: Vec<(&'static str, SourceLag)>,
    /// Recovery after a crash may lose at most this many seconds before the
    /// crash (the in-flight fragment).
    loss_budget: Option<f64>,
}

async fn run_case(
    spec: &Spec,
    capture: CaptureMode,
    shareable: &SendableShareableContent,
    case: &mut Case,
) -> anyhow::Result<()> {
    let scratch = scratch_root().join(format!(
        "{}-r{}",
        spec.id.replace('/', "-"),
        ATTEMPT.load(Ordering::Relaxed)
    ));
    let _ = std::fs::remove_dir_all(&scratch);
    let mut tries = 0;
    let (recorded, reference) = loop {
        tries += 1;
        let attempt_scratch = scratch.join(format!("attempt-{tries}"));
        std::fs::create_dir_all(&attempt_scratch)?;
        let reference = host_now();
        let recorded = record(spec, capture, shareable, &attempt_scratch, reference, case).await?;
        match inconclusive(spec, &recorded) {
            Some(reason) if tries < 2 => {
                case.note(format!("inconclusive, retrying: {reason}"));
            }
            Some(reason) => {
                case.problem("environment", format!("stimulus starved twice: {reason}"));
                case.note(format!("artifacts kept at {}", scratch.display()));
                return Ok(());
            }
            None => break (recorded, reference),
        }
    };
    analyze(&recorded, reference, case)?;
    if self_check_enabled() {
        self_check(&recorded, reference, case)?;
    }
    if !case.failed() && !env_flag("CAP_VERIFY_KEEP") {
        let _ = std::fs::remove_dir_all(&scratch);
    } else {
        case.note(format!("artifacts kept at {}", scratch.display()));
    }
    Ok(())
}

/// A synthetic source that hands a frame or chunk over this late did not
/// produce its input on time: no capture device delivers this late, so the
/// host stalled the source (a VM-wide stall measured 286 ms; with the
/// sources on their own threads, steady hand-offs are within a few ms).
const SOURCE_STALL_SECS: f64 = 0.1;

/// A run whose input was faulty, proven by a log independent of the
/// recorder, cannot tell a capture problem from a harness problem: it is
/// retried once, and a case that stays inconclusive fails as `environment`.
/// - the stimulus was starved (it skipped or stalled its own pictures);
/// - the stimulus's own ScreenCaptureKit stream (another client, another
///   process) received no new frame for more than four stimulus periods
///   while pictures were being presented: the window server or capture
///   service stalled, so the pictures never reached any recorder;
/// - a synthetic source handed over input more than `SOURCE_STALL_SECS`
///   late inside the recording.
fn inconclusive(spec: &Spec, rec: &Recorded) -> Option<String> {
    if let Some(reason) = starved(spec, &rec.stimulus) {
        return Some(reason);
    }
    if let Some(reason) = compositor_stall(spec, &rec.stimulus) {
        return Some(reason);
    }
    let window = (rec.started, rec.stopped);
    rec.source_lag.iter().find_map(|(name, lag)| {
        lag.worst_in(window)
            .filter(|(_, late)| *late > SOURCE_STALL_SECS)
            .map(|(at, late)| {
                format!(
                    "{name} source stalled: handed over {:.0} ms late at {:.2}s",
                    late * 1000.0,
                    at
                )
            })
    })
}

/// Longest stretch without a new frame on the stimulus's own capture stream
/// while the stimulus was changing its picture (outside scripted holds and
/// the period after them, where a capture stream legitimately resumes late).
fn compositor_stall(spec: &Spec, events: &[StimulusEvent]) -> Option<String> {
    let go = events.iter().find_map(|e| match e {
        StimulusEvent::Go { host } => Some(*host),
        _ => None,
    })?;
    let done = events.iter().find_map(|e| match e {
        StimulusEvent::Done { host } => Some(host_secs(*host, go)),
        _ => None,
    })?;
    let observed: Vec<f64> = events
        .iter()
        .filter_map(|e| match e {
            StimulusEvent::Observed { host } => Some(host_secs(*host, go)),
            _ => None,
        })
        .collect();
    if observed.is_empty() {
        return None;
    }
    let period = 1.0 / spec.stimulus_fps;
    let quiet = |t: f64| {
        spec.holds
            .iter()
            .any(|&(s, l)| t > s - period && t < s + l + 4.0 * period)
    };
    let mut points: Vec<f64> = observed
        .into_iter()
        .filter(|t| *t >= 0.0 && *t <= done)
        .collect();
    points.insert(0, 0.0);
    points.push(done);
    let (gap, at) = points
        .windows(2)
        .filter(|w| !quiet(w[0]) && !quiet(w[1]))
        .map(|w| (w[1] - w[0], w[0]))
        .fold((0.0f64, 0.0f64), |m, x| if x.0 > m.0 { x } else { m });
    (gap > 4.0 * period).then(|| {
        format!(
            "screen capture stalled for every client: the stimulus's own capture stream received no frame for {:.0} ms at {:.2}s after go",
            gap * 1000.0,
            at
        )
    })
}

/// The stimulus is the truth source: when the host starves it (it skipped
/// frames or stalled outside the scripted holds) a run cannot tell capture
/// problems from harness problems, so it is retried once.
fn starved(spec: &Spec, events: &[StimulusEvent]) -> Option<String> {
    let go = events.iter().find_map(|e| match e {
        StimulusEvent::Go { host } => Some(*host),
        _ => None,
    })?;
    let frames: Vec<(u32, f64)> = events
        .iter()
        .filter_map(|e| match e {
            StimulusEvent::Frame { index, host, .. } if *index > 0 => {
                Some((*index, host_secs(*host, go)))
            }
            _ => None,
        })
        .collect();
    let expected = (1..=(spec.seconds * spec.stimulus_fps).round() as u32)
        .filter(|index| {
            let time = f64::from(index - 1) / spec.stimulus_fps;
            !spec
                .holds
                .iter()
                .any(|&(start, length)| time > start && time < start + length)
        })
        .count();
    let longest_draw = events
        .iter()
        .filter_map(|event| match event {
            StimulusEvent::Frame {
                host,
                render_started: Some(start),
                ..
            } => Some(host_secs(*host, *start)),
            _ => None,
        })
        .fold(0.0f64, f64::max);
    let draw_note = format!("longest draw {:.0} ms", longest_draw * 1000.0);
    if frames.len() * 10 < expected * 9 {
        return Some(format!(
            "presented {} of {expected} frames; {draw_note}",
            frames.len()
        ));
    }
    let period = 1.0 / spec.stimulus_fps;
    let held = |t: f64| {
        spec.holds
            .iter()
            .any(|&(s, l)| t > s - period && t < s + l + period)
    };
    let stall = frames
        .windows(2)
        .filter(|w| !held(w[0].1) && !held(w[1].1))
        .map(|w| w[1].1 - w[0].1)
        .fold(0.0f64, f64::max);
    (stall > 4.0 * period).then(|| {
        format!(
            "stalled {:.0} ms between frames; {draw_note}",
            stall * 1000.0
        )
    })
}

#[test]
fn scripted_holds_do_not_count_as_stimulus_starvation() {
    let mut spec = specs().remove(0);
    spec.seconds = 2.0;
    spec.holds = vec![(0.5, 0.5)];
    let reference = host_now();
    let mut events = vec![StimulusEvent::Go { host: reference }];
    for index in (1..=11).chain(21..=40) {
        events.push(StimulusEvent::Frame {
            index,
            host: host_add_secs(reference, f64::from(index - 1) / spec.stimulus_fps),
            render_started: None,
        });
    }
    assert_eq!(starved(&spec, &events), None);
}

#[test]
fn capture_service_stalls_are_inconclusive_but_hold_resumes_are_not() {
    let spec = &specs()[0];
    let go = host_now();
    let period = 1.0 / spec.stimulus_fps;
    let mut events = vec![StimulusEvent::Go { host: go }];
    let observe = |events: &mut Vec<StimulusEvent>, from: f64, to: f64| {
        let mut t = from;
        while t < to {
            events.push(StimulusEvent::Observed {
                host: host_add_secs(go, t),
            });
            t += period;
        }
    };
    observe(&mut events, 0.0, 2.0);
    observe(&mut events, 3.05, spec.seconds);
    events.push(StimulusEvent::Done {
        host: host_add_secs(go, spec.seconds),
    });
    assert!(compositor_stall(spec, &events).is_some_and(|r| r.contains("1100 ms at 1.95s")));
    let mut held = spec.clone();
    held.holds = vec![(2.0, 1.0)];
    assert_eq!(compositor_stall(&held, &events), None);
}

#[test]
fn source_lag_counts_only_inside_the_recording() {
    let lag = SourceLag(vec![(0.5, 0.3), (4.0, 0.05), (9.0, 0.4)]);
    assert_eq!(lag.worst_in((1.0, 8.0)), Some((4.0, 0.05)));
    assert_eq!(lag.worst_in((0.0, 10.0)), Some((9.0, 0.4)));
}

#[test]
fn unscripted_stimulus_stalls_remain_failures() {
    let spec = &specs()[0];
    let reference = host_now();
    let mut events = vec![StimulusEvent::Go { host: reference }];
    for index in 1..=(spec.seconds * spec.stimulus_fps).round() as u32 {
        if (80..85).contains(&index) {
            continue;
        }
        events.push(StimulusEvent::Frame {
            index,
            host: host_add_secs(reference, f64::from(index - 1) / spec.stimulus_fps),
            render_started: None,
        });
    }
    assert!(starved(spec, &events).is_some_and(|reason| reason.starts_with("stalled")));
    events.retain(|event| !matches!(event, StimulusEvent::Frame { index: 90..110, .. }));
    assert!(starved(spec, &events).is_some_and(|reason| reason.starts_with("presented")));
}

fn scratch_root() -> PathBuf {
    std::env::var_os("CAP_VERIFY_SCRATCH")
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::temp_dir().join("cap-verify-recording"))
}

async fn record(
    spec: &Spec,
    capture: CaptureMode,
    _preflight: &SendableShareableContent,
    scratch: &Path,
    reference: u64,
    case: &mut Case,
) -> anyhow::Result<Recorded> {
    let stimulus_spec = StimulusSpec {
        fps: spec.stimulus_fps,
        seconds: spec.seconds,
        holds: spec.holds.clone(),
        busy: true,
        audio: spec.system_audio,
        warmup: match capture {
            CaptureMode::Display => 2.0,
            CaptureMode::Window => 2.0,
        },
        audio_period: AUDIO_PERIOD,
        audio_origin: reference,
        window: match capture {
            CaptureMode::Display => None,
            CaptureMode::Window => Some((80, 120, 640, 400)),
        },
    };
    let mut stimulus = tokio::task::block_in_place(|| {
        StimulusProcess::spawn(
            &stimulus_binary(),
            &stimulus_spec,
            &scratch.join("stimulus.jsonl"),
        )
    })?;
    tokio::task::block_in_place(|| stimulus.wait_for("ready", Duration::from_secs(30)))?;
    let (target, excluded, shareable) = capture_setup(capture).await?;

    let camera = matches!(spec.mode, Mode::Studio { camera: true, .. });
    let feeds = start_feeds(
        reference,
        spec.seconds + 30.0,
        camera,
        spec.camera_drops_at.clone(),
        spec.mic_delay,
    );
    let mic_lock = Arc::new(feeds.mic.lock().await?);
    let camera_lock = match &feeds.camera {
        Some(camera) => Some(Arc::new(camera.lock().await?)),
        None => None,
    };
    // Real cameras and microphones are already streaming when a recording
    // starts.
    tokio::time::sleep(Duration::from_millis(300)).await;

    let project = scratch.join("recording.cap");
    let defaults = RecordingDefaults::default();
    let gate = spec.gated.then(cap_recording::RecordingStartGate::new);
    let (handle, max_fps) = match spec.mode {
        Mode::Studio { fragmented, .. } => {
            let (builder, max_fps) = studio_builder(
                project.clone(),
                target,
                excluded,
                fragmented,
                camera,
                spec.system_audio,
            );
            let mut builder = builder;
            if spec.mic {
                builder = builder.with_mic_feed(mic_lock.clone());
            }
            if let Some(gate) = &gate {
                builder = builder.with_start_gate(gate.clone());
            }
            if let Some(lock) = &camera_lock {
                builder = builder.with_camera_feed(lock.clone());
            }
            (
                Handle::Studio(builder.build(Some(shareable.clone())).await?),
                max_fps,
            )
        }
        Mode::Instant => {
            let builder = instant_recording::Actor::builder(project.clone(), target)
                .with_system_audio(spec.system_audio)
                .with_max_output_size(defaults.instant_mode_max_resolution)
                .with_excluded_windows(excluded);
            let builder = if spec.mic {
                builder.with_mic_feed(mic_lock.clone())
            } else {
                builder
            };
            let builder = match &gate {
                Some(gate) => builder.with_start_gate(gate.clone()),
                None => builder,
            };
            (
                Handle::Instant(builder.build(Some(shareable.clone())).await?),
                cap_recording::DEFAULT_INSTANT_MODE_FPS,
            )
        }
        Mode::StudioCrashed => {
            let (builder, max_fps) = studio_builder(
                project.clone(),
                target,
                excluded,
                true,
                false,
                spec.system_audio,
            );
            let builder = builder.with_mic_feed(mic_lock.clone());
            (
                Handle::Studio(builder.build(Some(shareable.clone())).await?),
                max_fps,
            )
        }
    };
    let started_host = match &gate {
        Some(gate) => {
            // The app arms the gate when its start cue finishes playing.
            tokio::time::sleep(Duration::from_millis(START_CUE_MS)).await;
            let at = host_now();
            gate.arm();
            at
        }
        None => host_now(),
    };
    feeds.started.store(started_host, Ordering::Release);
    tokio::task::block_in_place(|| stimulus.send("go"))?;
    let waited = tokio::task::block_in_place(|| {
        stimulus.wait_for("done", Duration::from_secs_f64(spec.seconds + 20.0))
    });
    tokio::time::sleep(Duration::from_millis(400)).await;
    let stopped_host = host_now();
    let crashed = if spec.mode == Mode::StudioCrashed {
        let snapshot = scratch.join("crash-snapshot.cap");
        let snapshot_started = host_now();
        let status = std::process::Command::new("cp")
            .arg("-cR")
            .arg(&project)
            .arg(&snapshot)
            .status()?;
        anyhow::ensure!(status.success(), "snapshot of the live recording failed");
        case.note(format!(
            "crash snapshot at {:.3}s, cloned in {:.3}s",
            host_secs(snapshot_started, reference),
            host_secs(host_now(), snapshot_started)
        ));
        Some(snapshot)
    } else {
        None
    };
    let stop_started = std::time::Instant::now();
    let project_path = match handle {
        Handle::Studio(handle) => {
            let completed = handle.stop().await?;
            let path = completed.project_path.clone();
            let finalize = std::time::Instant::now();
            let remux_path = path.clone();
            tokio::task::spawn_blocking(move || RecoveryManager::remux_if_needed(&remux_path))
                .await??;
            case.note(format!(
                "stop {:.2}s, remux {:.2}s",
                (finalize - stop_started).as_secs_f64(),
                finalize.elapsed().as_secs_f64()
            ));
            path
        }
        Handle::Instant(handle) => {
            let mut completed = handle.stop().await?;
            let finalize = std::time::Instant::now();
            finalize_instant(&mut completed).await?;
            case.note(format!(
                "stop {:.2}s, finalize {:.2}s",
                (finalize - stop_started).as_secs_f64(),
                finalize.elapsed().as_secs_f64()
            ));
            completed.project_path
        }
    };
    feeds.stop.store(true, Ordering::Release);
    drop(mic_lock);
    drop(camera_lock);
    let mut source_lag = vec![("microphone", feeds.mic_task.await?)];
    let mic_truth = if spec.mic {
        feeds.mic_truth
    } else {
        Truth::new()
    };
    let camera_truth = match feeds.camera_task {
        Some(task) => {
            let (truth, dropped, lag) = task.await?;
            source_lag.push(("camera", lag));
            Some((truth, dropped))
        }
        None => None,
    };
    drop(feeds.camera);
    let events = tokio::task::block_in_place(|| stimulus.finish())?;
    waited?;
    let (project_path, loss_budget) = match crashed {
        Some(snapshot) => {
            let recovery_copy = scratch.join("crashed.cap");
            let status = std::process::Command::new("cp")
                .arg("-cR")
                .arg(&snapshot)
                .arg(&recovery_copy)
                .status()?;
            anyhow::ensure!(
                status.success(),
                "copy of the preserved crash snapshot failed"
            );
            let started = std::time::Instant::now();
            let recovered = tokio::task::spawn_blocking(move || {
                let incomplete = RecoveryManager::inspect_recording(&recovery_copy)
                    .ok_or_else(|| anyhow::anyhow!("crash snapshot is not recoverable"))?;
                RecoveryManager::recover(&incomplete).map_err(|e| anyhow::anyhow!("recover: {e}"))
            })
            .await??;
            case.note(format!(
                "recovered the crash snapshot in {:.2}s",
                started.elapsed().as_secs_f64()
            ));
            (recovered.project_path, Some(CRASH_LOSS_BUDGET))
        }
        None => (project_path, None),
    };
    Ok(Recorded {
        project: project_path,
        started: host_secs(started_host, reference),
        stopped: host_secs(stopped_host, reference),
        stimulus: events,
        mic_truth,
        camera: camera_truth,
        max_fps,
        mic_delay: spec.mic_delay,
        holds: spec.holds.clone(),
        stimulus_fps: spec.stimulus_fps,
        source_lag,
        loss_budget,
    })
}

/// Seconds of capture a crash may cost: the fragment being written (Studio
/// fragments are 2 s, see `MacOSFragmentedM4SMuxerConfig`) plus the encoder
/// pipeline still in flight.
const CRASH_LOSS_BUDGET: f64 = 3.0;

async fn finalize_instant(
    recording: &mut instant_recording::CompletedRecording,
) -> anyhow::Result<()> {
    let completion = recording.clean_completion.take();
    let project = recording.project_path.clone();
    let output = project.join("content/output.mp4");
    let audio_dir = project.join("content/audio");
    let display_dir = project.join("content/display");
    let already = std::fs::metadata(&output).is_ok_and(|m| m.len() > 0) && !audio_dir.exists();
    if !already {
        tokio::task::spawn_blocking(move || match completion {
            Some(completion) => RecoveryManager::finalize_completed_instant_output(
                &display_dir,
                &audio_dir,
                &output,
                completion,
            ),
            None => RecoveryManager::finalize_instant_output(&display_dir, &audio_dir, &output),
        })
        .await??;
    }
    let meta = match &recording.meta {
        InstantRecordingMeta::InProgress { .. } => InstantRecordingMeta::Failed {
            error: "instant recording stopped before completion".to_string(),
        },
        other => other.clone(),
    };
    RecordingMeta {
        platform: Some(cap_project::Platform::default()),
        project_path: project.clone(),
        pretty_name: "Cap Verify".to_string(),
        sharing: None,
        inner: RecordingMetaInner::Instant(meta),
        upload: None,
    }
    .save_for_project()
    .map_err(|e| anyhow::anyhow!("save meta: {e}"))?;
    Ok(())
}

/// One recorded track located through recording-meta.json.
struct Track {
    path: PathBuf,
    /// `start_time` from the meta: the editor aligns tracks by it.
    start: f64,
}

struct Layout {
    display: Track,
    camera: Option<Track>,
    mic: Option<Track>,
    system: Option<Track>,
    /// Instant mode muxes every source into the display file.
    muxed_audio: bool,
}

fn layout(project: &Path, case: &mut Case) -> anyhow::Result<Layout> {
    let meta = RecordingMeta::load_for_project(project)
        .map_err(|e| anyhow::anyhow!("recording-meta.json: {e}"))?;
    match &meta.inner {
        RecordingMetaInner::Instant(instant) => {
            if !matches!(instant, InstantRecordingMeta::Complete { .. }) {
                case.problem(
                    "finalize",
                    format!("instant meta is not complete: {instant:?}"),
                );
            }
            Ok(Layout {
                display: Track {
                    path: project.join("content/output.mp4"),
                    start: 0.0,
                },
                camera: None,
                mic: None,
                system: None,
                muxed_audio: true,
            })
        }
        RecordingMetaInner::Studio(studio) => {
            let StudioRecordingMeta::MultipleSegments { inner } = &**studio else {
                anyhow::bail!("expected a multi-segment studio recording");
            };
            if !matches!(
                studio.status(),
                cap_project::StudioRecordingStatus::Complete
            ) {
                case.problem(
                    "finalize",
                    format!("studio status after finalize: {:?}", studio.status()),
                );
            }
            if inner.segments.len() != 1 {
                case.problem(
                    "finalize",
                    format!("{} segments, expected 1", inner.segments.len()),
                );
            }
            let segment = inner
                .segments
                .first()
                .ok_or_else(|| anyhow::anyhow!("no segments"))?;
            let mut display = meta.path(&segment.display.path);
            if display.is_dir() {
                case.problem(
                    "finalize",
                    format!(
                        "display path still points at fragments after finalize: {}",
                        display.display()
                    ),
                );
                display = display.with_extension("mp4");
            }
            // The editor places each track at its start_time; without one it
            // aligns the track at 0, offsetting it by its start-up delay.
            let unplaced: Vec<&str> = [
                ("display", Some(segment.display.start_time)),
                ("camera", segment.camera.as_ref().map(|c| c.start_time)),
                ("mic", segment.mic.as_ref().map(|m| m.start_time)),
                (
                    "system audio",
                    segment.system_audio.as_ref().map(|s| s.start_time),
                ),
            ]
            .into_iter()
            .filter_map(|(name, start)| matches!(start, Some(None)).then_some(name))
            .collect();
            if !unplaced.is_empty() {
                case.problem(
                    "sync",
                    format!(
                        "recording-meta.json has no start_time for {}: the editor aligns them at 0 instead of where they started",
                        unplaced.join(", ")
                    ),
                );
            }
            let track = |path: &relative_path::RelativePathBuf, start: Option<f64>| Track {
                path: meta.path(path),
                start: start.unwrap_or(0.0),
            };
            Ok(Layout {
                display: track(&segment.display.path, segment.display.start_time),
                camera: segment
                    .camera
                    .as_ref()
                    .map(|c| track(&c.path, c.start_time)),
                mic: segment.mic.as_ref().map(|m| track(&m.path, m.start_time)),
                system: segment
                    .system_audio
                    .as_ref()
                    .map(|s| track(&s.path, s.start_time)),
                muxed_audio: false,
            })
            .map(|mut l| {
                l.display.path = display;
                l
            })
        }
    }
}

/// Offsets of every observed marker: recorded (editor) time minus host truth.
#[derive(Default, Clone)]
struct Offsets(Vec<(f64, f64)>);

impl Offsets {
    fn median(&self) -> Option<f64> {
        let mut v: Vec<f64> = self.0.iter().map(|(_, d)| *d).collect();
        if v.is_empty() {
            return None;
        }
        v.sort_by(f64::total_cmp);
        Some(v[v.len() / 2])
    }

    fn last_truth(&self) -> Option<f64> {
        self.0
            .iter()
            .map(|(t, _)| *t)
            .fold(None, |m, t| Some(m.map_or(t, |m: f64| m.max(t))))
    }

    fn spread(&self) -> f64 {
        let v: Vec<f64> = self.0.iter().map(|(_, d)| *d).collect();
        let max = v.iter().copied().fold(f64::MIN, f64::max);
        let min = v.iter().copied().fold(f64::MAX, f64::min);
        if v.is_empty() { 0.0 } else { max - min }
    }

    /// Least-squares slope of offset over truth time, in ms per minute.
    fn drift_ms_per_min(&self) -> f64 {
        let n = self.0.len() as f64;
        if n < 3.0 {
            return 0.0;
        }
        let mx = self.0.iter().map(|(t, _)| t).sum::<f64>() / n;
        let my = self.0.iter().map(|(_, d)| d).sum::<f64>() / n;
        let sxy: f64 = self.0.iter().map(|(t, d)| (t - mx) * (d - my)).sum();
        let sxx: f64 = self.0.iter().map(|(t, _)| (t - mx).powi(2)).sum();
        if sxx == 0.0 {
            0.0
        } else {
            sxy / sxx * 60_000.0
        }
    }

    fn describe(&self) -> String {
        format!(
            "n={} median {:+.1} ms, spread {:.1} ms, drift {:+.2} ms/min",
            self.0.len(),
            self.median().unwrap_or(f64::NAN) * 1000.0,
            self.spread() * 1000.0,
            self.drift_ms_per_min()
        )
    }
}

/// Capture faults injected into a finished real recording's decoded screen
/// frames, after the fact, to prove on this very host and capture that the
/// oracle still reports them: what a pipeline that drops, freezes, re-emits
/// or delays frames would have written. Thresholds are the production ones.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Injection {
    /// Three consecutive presented frames never reach the file.
    DropRun,
    /// The frame before them is repeated in their place (a frozen capture).
    Freeze,
    /// An already written frame is emitted again five frames later.
    Stale,
    /// The whole screen track lands 150 ms late against the audio: more than
    /// the width of any screen sync window, so a working sync measurement
    /// reports it from any in-window baseline.
    Late,
}

thread_local! {
    static INJECTION: std::cell::Cell<Option<Injection>> = const { std::cell::Cell::new(None) };
    /// Whether the last injection found frames to act on.
    static INJECTED: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

const INJECTIONS: [Injection; 4] = [
    Injection::DropRun,
    Injection::Freeze,
    Injection::Stale,
    Injection::Late,
];
const INJECTED_LATENESS: f64 = 0.15;

impl Injection {
    fn label(self) -> &'static str {
        match self {
            Injection::DropRun => "drop 3 consecutive frames",
            Injection::Freeze => "freeze over 3 frames",
            Injection::Stale => "re-emit a stale frame",
            Injection::Late => "screen 150 ms late",
        }
    }

    /// Class and problem prefix the oracle must report for this fault.
    fn expected(self) -> (&'static str, &'static str) {
        match self {
            Injection::DropRun | Injection::Freeze => ("missing", "screen:"),
            Injection::Stale => ("timestamps", "screen:"),
            Injection::Late => ("sync", "screen vs"),
        }
    }

    /// First of three consecutive presented indices, around 60 % of the
    /// recording, that were all captured and each stayed on screen long
    /// enough that the capture rate guarantees a sample.
    fn target(frames: &[(f64, Readout)], check: &VideoCheck) -> Option<u32> {
        let mut seen: Vec<u32> = Vec::new();
        for (_, readout) in frames {
            if let Readout::Marker { marker, .. } = readout
                && marker.kind == StreamKind::Screen
                && seen.last() != Some(&marker.index)
            {
                seen.push(marker.index);
            }
        }
        let captured: std::collections::BTreeSet<u32> = seen.iter().copied().collect();
        let start = seen.len() * 3 / 5;
        seen[start.min(seen.len())..].iter().copied().find(|&i| {
            i > 1
                && captured.contains(&(i - 1))
                && (i..i + 3).all(|j| {
                    captured.contains(&j) && check.truth.contains_key(&j) && !(check.may_skip)(j)
                })
        })
    }

    fn apply(self, frames: &mut Vec<(f64, Readout)>, check: &VideoCheck) {
        let before = frames.clone();
        self.mutate(frames, check);
        INJECTED.set(*frames != before);
    }

    fn mutate(self, frames: &mut Vec<(f64, Readout)>, check: &VideoCheck) {
        let index_of = |r: &Readout| match r {
            Readout::Marker { marker, .. } => Some(marker.index),
            _ => None,
        };
        match self {
            Injection::Late => {
                for (pts, _) in frames.iter_mut() {
                    *pts += INJECTED_LATENESS;
                }
            }
            Injection::DropRun | Injection::Freeze => {
                let Some(first) = Self::target(frames, check) else {
                    return;
                };
                let run = first..first + 3;
                if self == Injection::DropRun {
                    frames.retain(|(_, r)| !index_of(r).is_some_and(|i| run.contains(&i)));
                } else if let Some(before) = frames
                    .iter()
                    .rev()
                    .find(|(_, r)| index_of(r) == Some(first - 1))
                    .map(|(_, r)| r.clone())
                {
                    for (_, r) in frames.iter_mut() {
                        if index_of(r).is_some_and(|i| run.contains(&i)) {
                            *r = before.clone();
                        }
                    }
                }
            }
            Injection::Stale => {
                let Some(first) = Self::target(frames, check) else {
                    return;
                };
                let Some(stale) = frames
                    .iter()
                    .find(|(_, r)| index_of(r) == Some(first))
                    .map(|(_, r)| r.clone())
                else {
                    return;
                };
                let Some(after) = frames
                    .iter()
                    .position(|(_, r)| index_of(r).is_some_and(|i| i >= first + 5))
                else {
                    return;
                };
                if after + 1 < frames.len() {
                    let pts = (frames[after].0 + frames[after + 1].0) / 2.0;
                    frames.insert(after + 1, (pts, stale));
                }
            }
        }
    }
}

fn self_check_enabled() -> bool {
    match std::env::var("CAP_VERIFY_SELF_CHECK").as_deref() {
        Ok("0") | Ok("false") => false,
        Ok(_) => true,
        Err(_) => std::env::var_os("CI").is_some(),
    }
}

/// Re-analyzes the real recording with each injected fault and fails the
/// case when the oracle does not report one: proof, per run, that a starved
/// or otherwise unusual capture has not blinded the checks.
fn self_check(rec: &Recorded, reference: u64, case: &mut Case) -> anyhow::Result<()> {
    let mut caught = Vec::new();
    for injection in INJECTIONS {
        let (class, prefix) = injection.expected();
        if injection == Injection::Late && case.classes.contains("sync") {
            caught.push(format!("{}: n/a (already out of sync)", injection.label()));
            continue;
        }
        let mut probe = Case::new(format!("{} (self-check: {})", case.id, injection.label()));
        INJECTED.set(false);
        INJECTION.set(Some(injection));
        let result = analyze(rec, reference, &mut probe);
        INJECTION.set(None);
        result?;
        let new: Vec<&String> = probe
            .problems
            .iter()
            .filter(|p| p.starts_with(prefix) && !case.problems.contains(p))
            .collect();
        if !INJECTED.get() {
            case.problem(
                "oracle",
                format!(
                    "self-check: no frames to inject '{}' into: no 3 consecutive pictures the capture rate must sample",
                    injection.label()
                ),
            );
        } else if probe.classes.contains(class) && !new.is_empty() {
            caught.push(format!(
                "{}: caught ({class}: {})",
                injection.label(),
                new[0].chars().take(110).collect::<String>()
            ));
        } else {
            case.problem(
                "oracle",
                format!(
                    "self-check: injected fault '{}' was not reported (expected class {class})",
                    injection.label()
                ),
            );
        }
    }
    case.note(format!("self-check: {}", caught.join("; ")));
    Ok(())
}

fn first_presented(events: &[StimulusEvent], reference: u64) -> Truth {
    let mut truth = Truth::new();
    for event in events {
        if let StimulusEvent::Frame { index, host, .. } = event {
            truth.entry(*index).or_insert(host_secs(*host, reference));
        }
    }
    truth
}

struct VideoCheck<'a> {
    name: &'a str,
    kind: StreamKind,
    truth: &'a Truth,
    /// Indices that were never delivered to the recorder.
    not_sent: &'a [u32],
    /// Indices the source showed too briefly for the capture rate to
    /// guarantee a sample (screen only).
    may_skip: Box<dyn Fn(u32) -> bool + 'a>,
    allow_duplicates: bool,
    /// Pictures that must each be in the recording, outside any loss budget:
    /// the first picture after each scripted hold (a change after a static
    /// screen, the moment a viewer is waiting for).
    required: Vec<(u32, String)>,
}

fn check_video(case: &mut Case, track: &Track, check: VideoCheck) -> anyhow::Result<Offsets> {
    let mut frames: Vec<(f64, Readout)> = Vec::new();
    media::decode_video(&track.path, |picture| {
        let readout = video_code::read_stream(&picture.view(), check.kind);
        frames.push((picture.pts_secs, readout));
    })?;
    if check.kind == StreamKind::Screen
        && let Some(injection) = INJECTION.get()
    {
        injection.apply(&mut frames, &check);
    }
    let name = check.name;
    if frames.is_empty() {
        case.problem("missing", format!("{name}: no frames"));
        return Ok(Offsets::default());
    }
    let mut bad = Vec::new();
    let mut indices = Vec::new();
    for (i, (pts, readout)) in frames.iter().enumerate() {
        match readout {
            Readout::Marker { marker, .. } if marker.kind == check.kind && marker.segment == 0 => {
                indices.push((*pts, marker.index));
            }
            other => bad.push(format!("frame {i} at {pts:.3}s: {other:?}")),
        }
    }
    if !bad.is_empty() {
        case.problem(
            "unreadable",
            format!(
                "{name}: {} of {} frames carry no valid marker, first: {}",
                bad.len(),
                frames.len(),
                bad.iter().take(3).cloned().collect::<Vec<_>>().join("; ")
            ),
        );
    }
    let mut backwards = Vec::new();
    let mut duplicates = 0;
    let mut pts_problems = Vec::new();
    for w in indices.windows(2) {
        let ((pa, a), (pb, b)) = (w[0], w[1]);
        if pb <= pa {
            pts_problems.push(format!("{pa:.4}->{pb:.4}"));
        }
        if b < a {
            backwards.push(format!("{a}->{b} at {pb:.3}s"));
        } else if b == a {
            duplicates += 1;
        }
    }
    if !pts_problems.is_empty() {
        case.problem(
            "timestamps",
            format!(
                "{name}: non-increasing pts x{}: {}",
                pts_problems.len(),
                pts_problems
                    .iter()
                    .take(3)
                    .cloned()
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
        );
    }
    if !backwards.is_empty() {
        case.problem(
            "timestamps",
            format!(
                "{name}: frame index went backwards x{}: {}",
                backwards.len(),
                backwards
                    .iter()
                    .take(3)
                    .cloned()
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
        );
    }
    if duplicates > 0 && !check.allow_duplicates {
        case.problem(
            "timestamps",
            format!("{name}: {duplicates} duplicated frames"),
        );
    }
    let mut first_seen: BTreeMap<u32, f64> = BTreeMap::new();
    for &(pts, index) in &indices {
        first_seen.entry(index).or_insert(pts);
    }
    let unknown: Vec<u32> = first_seen
        .keys()
        .filter(|i| !check.truth.contains_key(i))
        .copied()
        .collect();
    if !unknown.is_empty() {
        case.problem(
            "unexpected",
            format!(
                "{name}: {} recorded indices were never produced: {:?}",
                unknown.len(),
                &unknown[..unknown.len().min(8)]
            ),
        );
    }
    let (Some(&lo), Some(&hi)) = (first_seen.keys().next(), first_seen.keys().next_back()) else {
        return Ok(Offsets::default());
    };
    let mut skipped = Vec::new();
    let mut startup = Vec::new();
    let mut explained = 0;
    let startup_end = check.truth.get(&lo).copied().unwrap_or(f64::MIN) + STARTUP_SECS;
    for (&index, &truth) in check.truth.range(lo + 1..hi) {
        if first_seen.contains_key(&index) || check.not_sent.contains(&index) {
            continue;
        }
        if (check.may_skip)(index) {
            explained += 1;
        } else if truth < startup_end {
            startup.push(index);
        } else {
            skipped.push(index);
        }
    }
    if startup.len() > STARTUP_DROPS {
        skipped.extend(startup.iter().copied());
    } else if !startup.is_empty() {
        case.note(format!(
            "{name}: {} start-up drops {:?} (allowed {STARTUP_DROPS} in the first {STARTUP_SECS}s)",
            startup.len(),
            startup
        ));
    }
    // The truth for a screen frame is when the stimulus handed it to the
    // window server, not when the display showed it: on a loaded virtual
    // display a frame can be replaced before it is ever composited. A small
    // budget of isolated misses is that; a pipeline that drops frames loses
    // runs of them or many.
    let budget = if check.kind == StreamKind::Screen {
        ((first_seen.len() as f64) * SCREEN_MISS_FRACTION).ceil() as usize
    } else {
        0
    };
    let longest_run = skipped
        .iter()
        .fold((0usize, 0usize, None::<u32>), |(best, run, prev), &i| {
            let run = if prev.is_some_and(|p| p + 1 == i) {
                run + 1
            } else {
                1
            };
            (best.max(run), run, Some(i))
        })
        .0;
    for (index, what) in &check.required {
        if check.truth.contains_key(index)
            && *index > lo
            && *index < hi
            && !first_seen.contains_key(index)
        {
            case.problem(
                "missing-after-hold",
                format!("{name}: {what} (index {index}) is missing from the recording"),
            );
        }
    }
    if skipped.len() > budget || longest_run >= 3 {
        case.problem(
            "missing",
            format!(
                "{name}: {} produced frames missing from the recording (budget {budget}, longest run {longest_run}): {:?}",
                skipped.len(),
                &skipped[..skipped.len().min(12)]
            ),
        );
    } else if !skipped.is_empty() {
        case.note(format!(
            "{name}: {} isolated misses within budget {budget}: {:?}",
            skipped.len(),
            skipped
        ));
    }
    if let Some(dir) = std::env::var_os("CAP_VERIFY_DUMP").filter(|_| INJECTION.get().is_none()) {
        let rows: Vec<String> = indices
            .iter()
            .map(|(pts, i)| {
                let truth = check.truth.get(i).copied().unwrap_or(f64::NAN);
                format!("{pts:.6},{i},{truth:.6},{:.6}", pts + track.start - truth)
            })
            .collect();
        let _ = std::fs::write(
            Path::new(&dir).join(format!(
                "{}-r{}-{name}.csv",
                case.id.replace('/', "-"),
                ATTEMPT.load(Ordering::Relaxed)
            )),
            format!("pts,index,truth,offset\n{}\n", rows.join("\n")),
        );
    }
    let mut offsets = Offsets::default();
    let mut snapped = Vec::new();
    for (&index, &pts) in &first_seen {
        if index == 0 {
            continue;
        }
        let Some(&truth) = check.truth.get(&index) else {
            continue;
        };
        // The documented cadence rule (#2573): after a source gap the first
        // frame may stay on the skipped slot, so it can land up to the gap
        // early. It is reported, and excluded from the steady-state offsets.
        let gap = (0..index)
            .rev()
            .take_while(|i| check.not_sent.contains(i))
            .count();
        if gap > 0 {
            snapped.push((index, pts + track.start - truth));
            continue;
        }
        offsets.0.push((truth, pts + track.start - truth));
    }
    let first_truth = first_seen
        .keys()
        .filter_map(|i| check.truth.get(i))
        .copied()
        .fold(f64::MAX, f64::min);
    // Steady offsets on each side of the drift anchor (see sync_checks).
    let side_median = |past: bool| {
        Offsets(
            offsets
                .0
                .iter()
                .copied()
                .filter(|(t, _)| (*t >= first_truth + DRIFT_ANCHOR_SECS) == past)
                .collect(),
        )
        .median()
    };
    if let Some(median) = offsets.median() {
        let period = 1.0 / f64::from(CAMERA_FPS);
        for &(index, offset) in &snapped {
            let past = check
                .truth
                .get(&index)
                .is_some_and(|t| *t >= first_truth + DRIFT_ANCHOR_SECS);
            let median = side_median(past).unwrap_or(median);
            let early = median - offset;
            let gap = (0..index)
                .rev()
                .take_while(|i| check.not_sent.contains(i))
                .count() as f64;
            let past_anchor = past;
            // Late past the drift anchor is the processing-clock stamping
            // (class camera-clock); early beyond the gap, or late before the
            // anchor, is a timestamp defect.
            let class = if early < -0.004 && past_anchor {
                "camera-clock"
            } else {
                "timestamps"
            };
            if early < -0.004 || early > gap * period + 0.004 {
                case.problem(class, format!(
                    "{name}: frame {index} after a {gap}-frame source gap is {:+.1} ms off the steady offset (allowed 0..{:.1} early)",
                    -early * 1000.0,
                    gap * period * 1000.0
                ));
            }
        }
        if !snapped.is_empty() {
            case.note(format!(
                "{name}: first frames after source gaps: {}",
                snapped
                    .iter()
                    .map(|(i, o)| format!("{i} {:+.1} ms", (o - median) * 1000.0))
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
        }
    }
    case.note(format!(
        "{name}: {} frames, indices {lo}..={hi}, {} distinct, {duplicates} repeats, {} skips explained by display timing, offset {}",
        frames.len(),
        first_seen.len(),
        explained,
        offsets.describe()
    ));
    Ok(offsets)
}

struct AudioCheck<'a> {
    name: &'a str,
    source: AudioSource,
    truth: &'a Truth,
    /// Truth window inside which every marker must be present.
    window: (f64, f64),
}

fn check_audio(
    case: &mut Case,
    decoded: &media::DecodedAudio,
    start: f64,
    check: AudioCheck,
) -> Offsets {
    let name = check.name;
    let mono = decoded.mono();
    let located = audio_code::locate_markers(&mono, decoded.sample_rate, check.source);
    if check.source == AudioSource::System && located.is_empty() && !require_system_audio() {
        // Hosted runners' virtual output devices hand ScreenCaptureKit pure
        // digital silence; a developer Mac checks this stream.
        case.note(format!(
            "{name}: no system audio reached the recording (runner output is not capturable); not checked"
        ));
        return Offsets::default();
    }
    let mut found: BTreeMap<u32, f64> = BTreeMap::new();
    let mut damaged = 0;
    let mut repeated = Vec::new();
    for marker in &located {
        let at = marker.time_secs + decoded.start_secs + start;
        let Some(index) = marker.index else {
            let track_secs = mono.len() as f64 / f64::from(decoded.sample_rate);
            if marker.time_secs > 0.15
                && marker.time_secs + audio_code::MARKER_SECS < track_secs - 0.15
            {
                damaged += 1;
            }
            continue;
        };
        if found.insert(index, at).is_some() {
            repeated.push(index);
        }
    }
    if damaged > 0 {
        case.problem(
            "unreadable",
            format!("{name}: {damaged} markers inside the track located but undecodable"),
        );
    }
    if !repeated.is_empty() {
        case.problem(
            "timestamps",
            format!("{name}: markers repeated {repeated:?}"),
        );
    }
    let unknown: Vec<u32> = found
        .keys()
        .filter(|i| !check.truth.contains_key(i))
        .copied()
        .collect();
    if !unknown.is_empty() {
        case.problem(
            "unexpected",
            format!("{name}: unexpected marker indices {unknown:?}"),
        );
    }
    let missing: Vec<u32> = check
        .truth
        .iter()
        .filter(|(i, t)| **t > check.window.0 && **t < check.window.1 && !found.contains_key(i))
        .map(|(i, _)| *i)
        .collect();
    if !missing.is_empty() {
        case.problem(
            "missing",
            format!(
                "{name}: {} markers inside the recording window are missing: {:?}",
                missing.len(),
                &missing[..missing.len().min(12)]
            ),
        );
    }
    let mut order = found.iter().collect::<Vec<_>>();
    order.sort_by(|a, b| a.1.total_cmp(b.1));
    if order.windows(2).any(|w| w[1].0 < w[0].0) {
        case.problem("timestamps", format!("{name}: markers out of order"));
    }
    if let Some(dir) = std::env::var_os("CAP_VERIFY_DUMP").filter(|_| INJECTION.get().is_none()) {
        let rows: Vec<String> = located
            .iter()
            .map(|m| {
                let at = m.time_secs + decoded.start_secs + start;
                let truth = m
                    .index
                    .and_then(|i| check.truth.get(&i))
                    .copied()
                    .unwrap_or(f64::NAN);
                format!("{at:.6},{:?},{truth:.6},{:.3}", m.index, m.correlation)
            })
            .chain(
                check
                    .truth
                    .iter()
                    .map(|(i, t)| format!("truth,{i},{t:.6},")),
            )
            .collect();
        let _ = std::fs::write(
            Path::new(&dir).join(format!(
                "{}-r{}-{name}.csv",
                case.id.replace('/', "-"),
                ATTEMPT.load(Ordering::Relaxed)
            )),
            format!(
                "at,index,truth,correlation (start {start:.6}, file start {:.6}, window {:.3}..{:.3})\n{}\n",
                decoded.start_secs,
                check.window.0,
                check.window.1,
                rows.join("\n")
            ),
        );
    }
    let mut offsets = Offsets::default();
    for (index, at) in &found {
        if let Some(&truth) = check.truth.get(index) {
            offsets.0.push((truth, at - truth));
        }
    }
    let peak = mono.iter().fold(0.0f32, |m, v| m.max(v.abs()));
    case.note(format!(
        "{name}: {} markers ({} expected in window), {:.2}s at peak {peak:.3}, offset {}",
        found.len(),
        check
            .truth
            .values()
            .filter(|t| **t > check.window.0 && **t < check.window.1)
            .count(),
        mono.len() as f64 / f64::from(decoded.sample_rate),
        offsets.describe()
    ));
    offsets
}

/// The first presented picture after each scripted hold.
fn after_holds(rec: &Recorded, truth: &Truth) -> Vec<(u32, String)> {
    rec.holds
        .iter()
        .filter_map(|&(start, length)| {
            let first = ((start + length) * rec.stimulus_fps).ceil() as u32 + 1;
            truth.range(first..).next().map(|(&index, _)| {
                (
                    index,
                    format!("first picture after the {length} s hold at {start} s"),
                )
            })
        })
        .collect()
}

fn analyze(rec: &Recorded, reference: u64, case: &mut Case) -> anyhow::Result<()> {
    let layout = layout(&rec.project, case)?;
    let screen_truth = first_presented(&rec.stimulus, reference);
    let presented: Vec<(u32, f64)> = screen_truth.iter().map(|(i, t)| (*i, *t)).collect();
    let capture_interval = 1.0 / f64::from(rec.max_fps);
    // SCK delivers a changed display at most once per minimum frame
    // interval. A picture is guaranteed to be sampled only when it stays on
    // screen for a full interval plus one display refresh of phase.
    let refresh = 1.0 / 60.0;
    let on_screen: BTreeMap<u32, f64> = presented
        .windows(2)
        .map(|w| (w[0].0, w[1].1 - w[0].1))
        .collect();
    let screen = check_video(
        case,
        &layout.display,
        VideoCheck {
            name: "screen",
            kind: StreamKind::Screen,
            truth: &screen_truth,
            not_sent: &[],
            may_skip: Box::new(|index| {
                on_screen
                    .get(&index)
                    .is_some_and(|d| *d < capture_interval + refresh)
            }),
            allow_duplicates: true,
            required: after_holds(rec, &screen_truth),
        },
    )?;
    let camera = match (&layout.camera, &rec.camera) {
        (Some(track), Some((truth, dropped))) => {
            case.note(format!("camera: dropped at source {dropped:?}"));
            Some(check_video(
                case,
                track,
                VideoCheck {
                    name: "camera",
                    kind: StreamKind::Camera,
                    truth,
                    not_sent: dropped,
                    may_skip: Box::new(|_| false),
                    allow_duplicates: false,
                    required: Vec::new(),
                },
            )?)
        }
        (None, Some(_)) => {
            case.problem(
                "missing",
                "camera feed attached but no camera track recorded",
            );
            None
        }
        _ => None,
    };
    let end = rec.stopped - rec.loss_budget.unwrap_or(0.3);
    let window = (rec.started + 0.3, end);
    if rec.loss_budget.is_some() {
        let last_presented = screen_truth.range(1..).next_back().map(|(_, t)| *t);
        match (screen.last_truth(), last_presented) {
            (Some(last), Some(presented)) if last < end.min(presented) => {
                case.problem(
                    "missing",
                    format!(
                        "screen: recovery kept frames up to {:.2}s before the crash, budget {:.1}s",
                        rec.stopped - last,
                        rec.loss_budget.unwrap_or_default()
                    ),
                );
            }
            _ => {}
        }
    }
    // ScreenCaptureKit starts delivering system audio some time after the
    // stream starts (measured 0.2-0.6 s); Cap fills that span with silence.
    let system_window = (rec.started + SYSTEM_AUDIO_STARTUP, window.1);
    let mic_window = (window.0 + rec.mic_delay, window.1);
    let system_truth: Truth = rec
        .stimulus
        .iter()
        .filter_map(|e| match e {
            StimulusEvent::Audio { index, host } => Some((*index, host_secs(*host, reference))),
            _ => None,
        })
        .collect();
    let audio_unavailable = rec.stimulus.iter().find_map(|e| match e {
        StimulusEvent::AudioUnavailable { reason } => Some(reason.clone()),
        _ => None,
    });
    if let Some(reason) = &audio_unavailable {
        case.note(format!("system audio stimulus unavailable: {reason}"));
        if require_system_audio() {
            case.problem(
                "missing",
                format!("system audio required but unavailable: {reason}"),
            );
        }
    }
    let (mic, system) = if layout.muxed_audio {
        let decoded = media::decode_audio(&layout.display.path, Some(48_000))?;
        let mic = (!rec.mic_truth.is_empty()).then(|| {
            check_audio(
                case,
                &decoded,
                0.0,
                AudioCheck {
                    name: "mic",
                    source: AudioSource::Mic,
                    truth: &rec.mic_truth,
                    window: mic_window,
                },
            )
        });
        let system = (!system_truth.is_empty()).then(|| {
            check_audio(
                case,
                &decoded,
                0.0,
                AudioCheck {
                    name: "system",
                    source: AudioSource::System,
                    truth: &system_truth,
                    window: system_window,
                },
            )
        });
        (mic, system)
    } else {
        let mic = match &layout.mic {
            Some(track) => {
                let decoded = media::decode_audio(&track.path, Some(48_000))?;
                Some(check_audio(
                    case,
                    &decoded,
                    track.start,
                    AudioCheck {
                        name: "mic",
                        source: AudioSource::Mic,
                        truth: &rec.mic_truth,
                        window: mic_window,
                    },
                ))
            }
            None if rec.mic_truth.is_empty() => None,
            None => {
                case.problem("missing", "no mic track recorded");
                None
            }
        };
        let system = match (&layout.system, system_truth.is_empty()) {
            (Some(track), false) => {
                let decoded = media::decode_audio(&track.path, Some(48_000))?;
                Some(check_audio(
                    case,
                    &decoded,
                    track.start,
                    AudioCheck {
                        name: "system",
                        source: AudioSource::System,
                        truth: &system_truth,
                        window: system_window,
                    },
                ))
            }
            (None, false) => {
                case.problem(
                    "missing",
                    "system audio was playing but no system audio track was recorded",
                );
                None
            }
            _ => None,
        };
        (mic, system)
    };
    sync_checks(
        rec.max_fps,
        case,
        &screen,
        camera.as_ref(),
        mic.as_ref(),
        system.as_ref(),
    );
    Ok(())
}

/// Tolerances, from first principles:
/// - Synthetic camera and microphone carry exact capture times, so their
///   offsets must be constant (spread within one audio chunk / encoder
///   rounding) and must agree with each other to within one camera frame
///   period's rounding.
/// - The screen truth is the time the stimulus handed a frame to the window
///   server; the display shows it at a later refresh, so the screen offset may
///   exceed the exact sources' by up to a few refresh intervals, never less.
fn sync_checks(
    max_fps: u32,
    case: &mut Case,
    screen: &Offsets,
    camera: Option<&Offsets>,
    mic: Option<&Offsets>,
    system: Option<&Offsets>,
) {
    const EXACT_SPREAD: f64 = 0.004;
    const CAMERA_SUSTAINED_FRAMES: usize = 3;
    const CAMERA_VS_MIC: f64 = 1.0 / CAMERA_FPS as f64;
    // Screen: the recorded frame may trail its hand-off by the display
    // latency (up to 4 refreshes plus half a refresh of phase: the
    // paravirtual runner display measured up to +54 ms) and, at 60 fps, the cadence ladder may
    // place a variable-rate frame (20 fps content) up to two 16.7 ms slots
    // early (measured floor: -29 ms on a developer Mac, -17 ms on hosted
    // runners; at 30 fps capture the floor is +5 ms).
    let screen_latency: (f64, f64) = if max_fps > 30 {
        (-0.040, 0.075)
    } else {
        (-0.010, 0.075)
    };
    const SYSTEM_VS_MIC: f64 = 0.030;
    // System audio truth adds the output device's latency (measured -4 to
    // +21 ms against the microphone on a developer Mac).
    let slack = |name: &str| if name == "mic" { 0.0 } else { 0.015 };

    let ms = |s: f64| s * 1000.0;
    if let Some(mic) = mic
        && mic.spread() > EXACT_SPREAD
    {
        case.problem("timestamps", format!(
            "mic: marker offsets vary by {:.1} ms (limit {:.1}): audio timing is not continuous",
            ms(mic.spread()),
            ms(EXACT_SPREAD)
        ));
    }
    // Camera frames carry exact capture times. Until the drift anchor the
    // recorder stamps them with those times, so their offsets must be
    // constant: a frame more than three periods off, or three consecutive
    // frames more than a period off (a ladder that froze a whole-slot lag,
    // #2573: 66.7 ms for 22 frames), is a timestamp defect. Past the anchor
    // the recorder stamps frames from the processing wall clock instead
    // (`VideoDriftTracker::calculate_timestamp`), so every frame carries its
    // processing delay; that is reported as class camera-clock, together
    // with the same frame checks applied to those frames.
    let camera_parts = camera.map(|camera| {
        let first = camera.0.iter().map(|(t, _)| *t).fold(f64::MAX, f64::min);
        let (pre, post): (Vec<_>, Vec<_>) = camera
            .0
            .iter()
            .copied()
            .partition(|(t, _)| *t < first + DRIFT_ANCHOR_SECS);
        (Offsets(pre), Offsets(post))
    });
    if let Some((pre, post)) = &camera_parts {
        let period = 1.0 / f64::from(CAMERA_FPS);
        for (part, class, label) in [
            (pre, "timestamps", "before the drift anchor"),
            (post, "camera-clock", "past the drift anchor"),
        ] {
            let Some(median) = part.median() else {
                continue;
            };
            let mut run = 0;
            let mut worst_run = (0, 0.0f64, 0.0f64);
            let mut isolated = Vec::new();
            for &(truth, offset) in &part.0 {
                let d = offset - median;
                if d.abs() > 3.0 * period {
                    isolated.push(format!("{:.2}s {:+.1} ms", truth, ms(d)));
                }
                if d.abs() > period {
                    run += 1;
                    if run > worst_run.0 {
                        worst_run = (run, truth, d);
                    }
                } else {
                    run = 0;
                }
            }
            if worst_run.0 >= CAMERA_SUSTAINED_FRAMES {
                case.problem(
                    class,
                    format!(
                        "camera {label}: {} consecutive frames off the steady offset by more than a frame period (until {:.2}s, {:+.1} ms)",
                        worst_run.0,
                        worst_run.1,
                        ms(worst_run.2)
                    ),
                );
            }
            if !isolated.is_empty() {
                case.problem(
                    class,
                    format!(
                        "camera {label}: {} frames more than three periods off the steady offset: {}",
                        isolated.len(),
                        isolated
                            .iter()
                            .take(4)
                            .cloned()
                            .collect::<Vec<_>>()
                            .join(", ")
                    ),
                );
            }
        }
        if post.0.len() > 1 && post.spread() > EXACT_SPREAD {
            case.problem(
                "camera-clock",
                format!(
                    "camera past the drift anchor: frame offsets vary by {:.1} ms (limit {:.1}): frames are stamped from the processing clock, not their capture times",
                    ms(post.spread()),
                    ms(EXACT_SPREAD)
                ),
            );
        }
    }
    let mic_m = mic.and_then(Offsets::median);
    let screen_m = screen.median();
    let system_m = system.and_then(Offsets::median);
    // Camera against the microphone, separately before and past the drift
    // anchor (past it the camera carries processing delays, class
    // camera-clock).
    if let (Some((pre, post)), Some(mic_m)) = (&camera_parts, mic_m) {
        for (part, class, label) in [
            (pre, "sync", "before the drift anchor"),
            (post, "camera-clock", "past the drift anchor"),
        ] {
            let Some(camera_m) = part.median() else {
                continue;
            };
            let d = camera_m - mic_m;
            case.note(format!("sync camera-mic {label} {:+.1} ms", ms(d)));
            if d.abs() > CAMERA_VS_MIC {
                case.problem(
                    class,
                    format!(
                        "camera {label} vs mic out of sync: {:+.1} ms (limit +-{:.0})",
                        ms(d),
                        ms(CAMERA_VS_MIC)
                    ),
                );
            }
        }
    }
    if let (Some(system_m), Some(mic_m)) = (system_m, mic_m) {
        // Both carry host-clock truth: the microphone's exactly, system
        // audio from the output callback's host time.
        let d = system_m - mic_m;
        case.note(format!("sync system-mic {:+.1} ms", ms(d)));
        if d.abs() > SYSTEM_VS_MIC {
            case.problem(
                "sync",
                format!(
                    "system audio vs mic out of sync: {:+.1} ms (limit +-{:.0})",
                    ms(d),
                    ms(SYSTEM_VS_MIC)
                ),
            );
        }
    }
    let Some(screen_m) = screen_m else {
        return;
    };
    for (name, audio_m) in [("mic", mic_m), ("system audio", system_m)] {
        let Some(audio_m) = audio_m else {
            continue;
        };
        let d = screen_m - audio_m;
        case.note(format!(
            "sync screen-{} {:+.1} ms",
            name.split(' ').next().unwrap_or(name),
            ms(d)
        ));
        if d < screen_latency.0 - slack(name) || d > screen_latency.1 + slack(name) {
            case.problem(
                "sync",
                format!(
                    "screen vs {name} out of sync: {:+.1} ms (allowed {:+.0}..{:+.0}: display latency)",
                    ms(d),
                    ms(screen_latency.0 - slack(name)),
                    ms(screen_latency.1 + slack(name))
                ),
            );
        }
    }
}
