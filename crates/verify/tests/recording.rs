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

#![cfg(any(target_os = "macos", windows))]

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
use cap_project::{
    InstantRecordingMeta, ProjectConfiguration, RecordingMeta, RecordingMetaInner,
    StudioRecordingMeta, XY,
};
use cap_recording::{
    NativeCameraFrame, RecordingDefaults, StudioQuality,
    feeds::{
        Admission, camera::synthetic::SyntheticCamera, microphone::synthetic::SyntheticMicrophone,
    },
    instant_recording,
    recovery::RecoveryManager,
    screen_capture::ScreenCaptureTarget,
    studio_recording,
};
#[cfg(target_os = "macos")]
use cap_verify::fixture_avf;
use cap_verify::{
    audio_code::{self, AudioSource, MarkerPlacement},
    media,
    report::{self, Case, Tier},
    sched,
    stimulus::{
        SENTINEL_FILE, SentinelLog, StimulusEvent, StimulusProcess, StimulusSpec, host_add_secs,
        host_now, host_secs,
    },
    video_code::{self, FrameMarker, Readout, StreamKind},
};

use platform::{Shareable, host_timestamp};

/// What differs between the macOS and Windows hosts: the capture permission
/// check, the host clock the sources are stamped with and thread priority.
#[cfg(target_os = "macos")]
mod platform {
    use cap_timestamp::{MachAbsoluteTimestamp, Timestamp};

    pub type Shareable = cap_recording::SendableShareableContent;

    /// ScreenCaptureKit's shareable content, which also checks the Screen
    /// Recording permission.
    pub async fn shareable() -> anyhow::Result<Shareable> {
        cidre::sc::ShareableContent::current()
            .await
            .map(Shareable::from)
            .map_err(|e| {
                anyhow::anyhow!("ScreenCaptureKit unavailable ({e:?}); grant Screen Recording")
            })
    }

    pub fn host_timestamp(ticks: u64) -> Timestamp {
        Timestamp::MachAbsoluteTime(MachAbsoluteTimestamp::new(ticks))
    }

    /// Host ticks to nanoseconds: ticks * numer / denom.
    pub fn timebase() -> [u64; 2] {
        let info = cidre::mach::TimeBaseInfo::new();
        [u64::from(info.numer), u64::from(info.denom)]
    }

    pub fn raise_thread_qos() {
        const QOS_CLASS_USER_INITIATED: u32 = 0x19;
        unsafe extern "C" {
            fn pthread_set_qos_class_self_np(qos: u32, relative_priority: i32) -> i32;
        }
        unsafe { pthread_set_qos_class_self_np(QOS_CLASS_USER_INITIATED, 0) };
    }

    /// Every host has an output device for the system audio stimulus.
    pub fn system_audio_output() -> bool {
        true
    }
}

#[cfg(windows)]
mod platform {
    use cap_timestamp::{PerformanceCounterTimestamp, Timestamp};

    pub type Shareable = ();

    /// Windows Graphics Capture needs no permission; recording itself fails
    /// when the session has no desktop.
    pub async fn shareable() -> anyhow::Result<Shareable> {
        Ok(())
    }

    pub fn host_timestamp(ticks: u64) -> Timestamp {
        Timestamp::PerformanceCounter(PerformanceCounterTimestamp::new(ticks as i64))
    }

    /// Host ticks to nanoseconds: ticks * numer / denom.
    pub fn timebase() -> [u64; 2] {
        [1_000_000_000, cap_verify::sched::qpc_frequency()]
    }

    pub fn raise_thread_qos() {
        const THREAD_PRIORITY_ABOVE_NORMAL: i32 = 1;
        unsafe extern "system" {
            fn GetCurrentThread() -> isize;
            fn SetThreadPriority(thread: isize, priority: i32) -> i32;
        }
        unsafe { SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_ABOVE_NORMAL) };
    }

    /// Hosted Windows runners run the audio service with no endpoints: there
    /// is nothing to play the system audio stimulus on or to loop back.
    pub fn system_audio_output() -> bool {
        use cpal::traits::HostTrait;
        cpal::default_host().default_output_device().is_some()
    }
}

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
    let mut specs = vec![
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
    ];
    specs.extend(soak_specs());
    specs
}

/// `CAP_VERIFY_SOAK_SECS`: at most 1800 s, because the microphone's 12-bit
/// marker index (one marker every 0.5 s) runs out past 34 minutes.
fn soak_specs() -> Vec<Spec> {
    let Some(value) = std::env::var("CAP_VERIFY_SOAK_SECS")
        .ok()
        .filter(|v| !v.trim().is_empty())
    else {
        return vec![];
    };
    let seconds = value
        .trim()
        .parse::<f64>()
        .ok()
        .filter(|s| s.is_finite() && *s > 0.0)
        .unwrap_or_else(|| {
            panic!("CAP_VERIFY_SOAK_SECS={value:?} is not a positive number of seconds")
        });
    let seconds = seconds.min(1800.0);
    vec![
        Spec {
            id: "recording/soak/studio-camera",
            tier: Tier::Full,
            mode: Mode::Studio {
                fragmented: true,
                camera: true,
            },
            seconds,
            stimulus_fps: STIMULUS_FPS_30,
            // Every hold ends by five sixths of the length: the stimulus
            // cannot show its last picture during one.
            holds: vec![
                (seconds / 3.0, (seconds / 10.0).min(3.0)),
                (2.0 * seconds / 3.0, (seconds / 6.0).min(10.0)),
            ],
            camera_drops_at: vec![],
            gated: true,
            mic_delay: 0.0,
            mic: true,
            system_audio: true,
        },
        Spec {
            id: "recording/soak/instant",
            tier: Tier::Full,
            mode: Mode::Instant,
            seconds,
            stimulus_fps: STIMULUS_FPS_30,
            holds: vec![(seconds / 2.0, (seconds / 6.0).min(5.0))],
            camera_drops_at: vec![],
            gated: true,
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

/// `CAP_VERIFY_STIMULUS_AUDIO=0` keeps the stimulus silent, so the system
/// audio track carries no markers and is not checked (unless system audio
/// is required). On a host whose output device does reach
/// ScreenCaptureKit but whose system-audio timing is not yet characterised
/// (Blacksmith with BlackHole), this keeps the run equivalent to hosted
/// runners, where the output devices give ScreenCaptureKit only silence.
fn stimulus_plays_system_audio() -> bool {
    !matches!(
        std::env::var("CAP_VERIFY_STIMULUS_AUDIO").as_deref(),
        Ok("0") | Ok("false")
    )
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
fn raise_thread_qos() {
    platform::raise_thread_qos();
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
    let shareable = match rt.block_on(platform::shareable()) {
        Ok(content) => content,
        Err(e) => {
            let message = format!("{e:#}");
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
            // Recorded, so the summary shows it (and CI's
            // CAP_VERIFY_REQUIRE_SUPPORTED fails it unless allowlisted).
            let mut case = Case::new(spec.id);
            case.unsupported(
                "system audio is this case's only audio and this host does not play and require system audio (CAP_VERIFY_REQUIRE_SYSTEM_AUDIO unset)",
            );
            if let Err(e) = report::settle(case) {
                failures.push(e);
            }
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
    mic_task: std::thread::JoinHandle<SourceTrace>,
    camera_task: Option<std::thread::JoinHandle<(Truth, Vec<u32>, SourceTrace)>>,
}

/// Computation budget per period of the synthetic sources' time
/// constraint: a camera frame (marker, NV12 pixel buffer, sample) took
/// 1.6 ms median, 4.7 ms p95 on hosted runners (run 38766191045); a mic
/// chunk is pre-rendered and only copied.
const CAMERA_COMPUTATION_SECS: f64 = 0.010;
const MIC_COMPUTATION_SECS: f64 = 0.001;

/// One hand-off of a synthetic source (host ticks).
#[derive(Clone, Copy, Debug)]
struct Handoff {
    /// Camera slot or microphone chunk number.
    index: u32,
    /// When the frame was captured, or the chunk's last sample was.
    due: u64,
    /// When the source's wait for `due` returned.
    wake: u64,
    /// When the frame or chunk was ready to hand over.
    built: u64,
    /// When the hand-off returned.
    pushed: u64,
    admission: Admission,
    /// The source thread's scheduler priority when it woke.
    pri: i32,
}

/// Every hand-off of one synthetic source plus its scheduling: the
/// independent evidence for a source verdict, persisted per attempt.
#[derive(Clone, Debug)]
struct SourceTrace {
    name: &'static str,
    realtime: sched::Realtime,
    /// Scheduling state after the last hand-off.
    end: Option<sched::ThreadState>,
    handoffs: Vec<Handoff>,
}

impl SourceTrace {
    fn start(name: &'static str, period: f64, computation: f64, capacity: usize) -> (Self, u32) {
        let realtime = sched::request_realtime(period, computation);
        (
            Self {
                name,
                realtime,
                end: None,
                handoffs: Vec::with_capacity(capacity),
            },
            sched::current_thread(),
        )
    }

    /// Hands over through `push`, timing each step.
    fn handoff(
        &mut self,
        index: u32,
        due: u64,
        wake: u64,
        pri: i32,
        push: impl FnOnce() -> Admission,
    ) -> Admission {
        let built = host_now();
        let admission = push();
        self.handoffs.push(Handoff {
            index,
            due,
            wake,
            built,
            pushed: host_now(),
            admission,
            pri,
        });
        admission
    }
}

/// Waits for `due` on the source thread and samples its priority.
fn wait_for(thread: u32, due: u64) -> (u64, i32) {
    sched::wait_until(due);
    let wake = host_now();
    (wake, sched::thread_state(thread).map_or(-1, |s| s.cur_pri))
}

/// Synthetic sources stand in for capture devices, which the system feeds
/// from its own real-time threads and which never wait for the recorder:
/// each runs on a dedicated thread under a time constraint of its own
/// period (`cap_verify::sched`, shared with the stimulus) and hands over
/// with `try_send`, exactly like the device callbacks. A feed that cannot
/// keep up therefore shows as rejected hand-offs (a product failure), and a
/// late hand-off can only come from the source thread itself.
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
    let mic_task = {
        let mic = mic.clone();
        let stop = stop.clone();
        let started = started.clone();
        std::thread::Builder::new()
            .name("verify-synthetic-mic".into())
            .spawn(move || {
                // Render the whole signal before going real-time: the
                // constrained loop only copies chunks.
                let mut signal = vec![0.0f32; (max_secs * f64::from(MIC_RATE)) as usize];
                audio_code::render_markers(
                    &mut signal,
                    MIC_RATE,
                    AudioSource::Mic,
                    &schedule,
                    audio_code::DEFAULT_AMPLITUDE,
                );
                let (mut trace, thread) = SourceTrace::start(
                    "microphone",
                    MIC_CHUNK as f64 / f64::from(MIC_RATE),
                    MIC_COMPUTATION_SECS,
                    signal.len() / MIC_CHUNK + 1,
                );
                for (n, chunk) in signal.chunks(MIC_CHUNK).enumerate() {
                    if stop.load(Ordering::Acquire) {
                        break;
                    }
                    let first = n * MIC_CHUNK;
                    let capture = host_add_secs(origin, first as f64 / f64::from(MIC_RATE));
                    let delivered =
                        host_add_secs(origin, (first + chunk.len()) as f64 / f64::from(MIC_RATE));
                    let (wake, pri) = wait_for(thread, delivered);
                    if mic_delay > 0.0 {
                        let start = started.load(Ordering::Acquire);
                        if start == 0 || host_secs(capture, start) < mic_delay {
                            continue;
                        }
                    }
                    trace.handoff(n as u32, delivered, wake, pri, || {
                        mic.try_push(chunk, host_timestamp(capture))
                    });
                }
                trace.end = sched::thread_state(thread);
                trace
            })
            .expect("spawn synthetic microphone")
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
            std::thread::Builder::new()
                .name("verify-synthetic-camera".into())
                .spawn(move || {
                    let slots = (max_secs * f64::from(CAMERA_FPS)) as u32;
                    let (mut trace, thread) = SourceTrace::start(
                        "camera",
                        1.0 / f64::from(CAMERA_FPS),
                        CAMERA_COMPUTATION_SECS,
                        slots as usize,
                    );
                    let origin = host_now();
                    let base = host_secs(origin, reference);
                    let mut truth = Truth::new();
                    let mut dropped = Vec::new();
                    let mut drop_slots: Option<Vec<u32>> = None;
                    for slot in 0..slots {
                        if stop.load(Ordering::Acquire) {
                            break;
                        }
                        let secs = f64::from(slot) / f64::from(CAMERA_FPS);
                        let capture = host_add_secs(origin, secs);
                        let (wake, pri) = wait_for(thread, capture);
                        let start = started.load(Ordering::Acquire);
                        if drop_slots.is_none() && start != 0 {
                            let since = host_secs(start, origin);
                            drop_slots = Some(
                                drops_at
                                    .iter()
                                    .flat_map(|at| {
                                        let s =
                                            ((since + at) * f64::from(CAMERA_FPS)).ceil() as u32;
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
                        trace.handoff(slot, capture, wake, pri, || feed.try_push_native(frame));
                        // Intended frames stay in the truth even when the
                        // feed rejected them: the recording must not
                        // silently lack them.
                        truth.insert(slot, base + secs);
                    }
                    trace.end = sched::thread_state(thread);
                    (truth, dropped, trace)
                })
                .expect("spawn synthetic camera")
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

struct StopOnDrop(Arc<AtomicBool>);

impl Drop for StopOnDrop {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Release);
    }
}

/// The product classes a synthetic source's hand-offs can fail with.
fn ingress_class(source: &str) -> &'static str {
    match source {
        "camera" => "camera-ingress",
        _ => "mic-ingress",
    }
}

/// What one source's hand-offs inside the recording window show.
#[derive(Debug, Default)]
struct SourceVerdict {
    /// Product failures: (class, message).
    product: Vec<(&'static str, String)>,
    /// The source itself handed over more than `SOURCE_STALL_SECS` late
    /// (the host stalled its thread): (lateness, inconclusive reason).
    stalled: Option<(f64, String)>,
    /// Worst lateness inside the window, seconds.
    worst: f64,
    /// Hand-offs inside the window, and those the feed rejected outside it
    /// (before the recording started or after it stopped).
    inside: usize,
    rejected_outside: usize,
}

/// Judges one source over the recording window (seconds from `reference`,
/// by due time). A hand-off is late by `built - due`, as before.
///
/// A rejected hand-off (feed mailbox full or closed) is a product failure:
/// the real capture callbacks `try_send` the same way and lose the frame.
/// A late hand-off is attributed by its debt chain: while a hand-off was
/// due before the previous one returned, the time spent inside the feed's
/// hand-offs is the feed's. When the lateness without that time stays within
/// `SOURCE_STALL_SECS`, Cap delayed the source: a product failure, never
/// inconclusive. Otherwise the source thread itself woke or ran late.
fn judge_source(trace: &SourceTrace, reference: u64, window: (f64, f64)) -> SourceVerdict {
    let class = ingress_class(trace.name);
    let mut verdict = SourceVerdict::default();
    let mut rejected: Vec<(u32, f64, Admission)> = Vec::new();
    let mut cap_debt = 0.0f64;
    let mut held = 0usize;
    let mut held_worst: Option<(f64, String)> = None;
    let mut previous: Option<&Handoff> = None;
    for h in &trace.handoffs {
        let busy = previous.is_some_and(|p| p.pushed > h.due);
        cap_debt = match previous {
            Some(p) if busy => cap_debt + host_secs(p.pushed, p.built),
            _ => 0.0,
        };
        let due = host_secs(h.due, reference);
        let inside = due >= window.0 && due <= window.1;
        if h.admission != Admission::Accepted {
            if inside {
                rejected.push((h.index, due, h.admission));
            } else {
                verdict.rejected_outside += 1;
            }
        }
        if inside {
            verdict.inside += 1;
            let late = host_secs(h.built, h.due);
            verdict.worst = verdict.worst.max(late);
            if late > SOURCE_STALL_SECS {
                let cap = cap_debt.min(late);
                let asleep_from = previous.map_or(h.due, |p| p.pushed.max(h.due));
                let breakdown = format!(
                    "woke {:.1} ms past its deadline at scheduler priority {}, built in {:.1} ms, \
                     {:.1} ms inside Cap's hand-offs of earlier frames",
                    host_secs(h.wake, asleep_from).max(0.0) * 1000.0,
                    h.pri,
                    host_secs(h.built, h.wake) * 1000.0,
                    cap * 1000.0
                );
                if late - cap <= SOURCE_STALL_SECS {
                    held += 1;
                    if held_worst.as_ref().is_none_or(|(worst, _)| late > *worst) {
                        held_worst = Some((
                            late,
                            format!(
                                "hand-off {} due at {due:.2}s, {:.0} ms late: {breakdown}",
                                h.index,
                                late * 1000.0
                            ),
                        ));
                    }
                } else if verdict
                    .stalled
                    .as_ref()
                    .is_none_or(|(worst, _)| late > *worst)
                {
                    verdict.stalled = Some((
                        late,
                        format!(
                            "{} source stalled: hand-off {} due at {due:.2}s was {:.0} ms late ({breakdown})",
                            trace.name,
                            h.index,
                            late * 1000.0
                        ),
                    ));
                }
            }
        }
        previous = Some(h);
    }
    if let Some((_, worst)) = held_worst {
        verdict.product.push((
            class,
            format!(
                "Cap's {} feed held the source: {held} hand-offs more than {:.0} ms late because of time spent inside the feed; worst {worst}",
                trace.name,
                SOURCE_STALL_SECS * 1000.0
            ),
        ));
    }
    if let Some((index, at, admission)) = rejected.first() {
        let full = rejected
            .iter()
            .filter(|(_, _, a)| *a == Admission::Full)
            .count();
        verdict.product.push((
            class,
            format!(
                "Cap's {} feed rejected {} of {} hand-offs inside the recording ({full} mailbox full, {} closed); first {index} at {at:.2}s ({admission:?})",
                trace.name,
                rejected.len(),
                verdict.inside,
                rejected.len() - full
            ),
        ));
    }
    verdict
}

/// `Err` when a source did not run under its real-time constraint for the
/// whole recording: its timing would not stand in for a capture device.
fn source_scheduling(
    trace: &SourceTrace,
    reference: u64,
    window: (f64, f64),
) -> Result<(), String> {
    trace.realtime.obtained().map_err(|e| {
        format!(
            "{} source: real-time scheduling not obtained: {e}",
            trace.name
        )
    })?;
    sched::state_is_realtime(trace.end).map_err(|e| {
        format!(
            "{} source: real-time scheduling lost by the end: {e}",
            trace.name
        )
    })?;
    if let Some(h) = trace.handoffs.iter().find(|h| {
        let due = host_secs(h.due, reference);
        due >= window.0 && due <= window.1 && h.pri < sched::REALTIME_PRIORITY
    }) {
        return Err(format!(
            "{} source: hand-off {} ran at scheduler priority {}, below the real-time band",
            trace.name, h.index, h.pri
        ));
    }
    Ok(())
}

/// Writes every source's scheduling and hand-offs for one attempt (all
/// attempts, including discarded retries) and returns the file.
fn persist_sources(
    stem: &str,
    reference: u64,
    rec: &Recorded,
    verdicts: &[SourceVerdict],
    fallback: &Path,
) -> PathBuf {
    let dir = std::env::var_os("CAP_VERIFY_DUMP")
        .map(|d| PathBuf::from(d).join("sources"))
        .unwrap_or_else(|| fallback.to_path_buf());
    let path = dir.join(format!("{stem}.json"));
    let sources: Vec<serde_json::Value> = rec
        .sources
        .iter()
        .zip(verdicts)
        .map(|(trace, verdict)| {
            serde_json::json!({
                "name": trace.name,
                "realtime": trace.realtime,
                "end": trace.end,
                "worst_late_ms": verdict.worst * 1000.0,
                "stalled": verdict.stalled.as_ref().map(|(_, reason)| reason),
                "product": verdict.product.iter().map(|(class, text)| format!("{class}: {text}")).collect::<Vec<_>>(),
                "handoffs": trace.handoffs.iter().map(|h| (
                    h.index,
                    h.due,
                    h.wake,
                    h.built,
                    h.pushed,
                    match h.admission {
                        Admission::Accepted => "ok",
                        Admission::Full => "full",
                        Admission::Closed => "closed",
                    },
                    h.pri,
                )).collect::<Vec<_>>(),
            })
        })
        .collect();
    let value = serde_json::json!({
        "attempt": stem,
        "timebase": platform::timebase(),
        "reference": reference,
        "window_secs": [rec.started, rec.stopped],
        "columns": ["index", "due", "wake", "built", "pushed", "admission", "pri"],
        "sources": sources,
    });
    let written =
        std::fs::create_dir_all(&dir).and_then(|()| std::fs::write(&path, value.to_string()));
    if let Err(e) = written {
        eprintln!("[cap-verify] could not write {}: {e}", path.display());
    }
    path
}

#[cfg(target_os = "macos")]
fn camera_frame(slot: u32, capture: u64) -> Option<NativeCameraFrame> {
    let (w, h) = CAMERA_SIZE;
    let rgba = video_code::marker_rgba(FrameMarker::new(StreamKind::Camera, 0, slot), w, h);
    let sample_buf = camera_sample(&rgba, w, h, capture).ok()?;
    Some(NativeCameraFrame {
        sample_buf,
        timestamp: host_timestamp(capture),
    })
}

/// An NV12 frame in a Media Foundation memory buffer, as the Windows camera
/// feed hands native frames to the encoder.
#[cfg(windows)]
fn camera_frame(slot: u32, capture: u64) -> Option<NativeCameraFrame> {
    use cap_mediafoundation_utils::IMFMediaBufferExt;
    use windows::Win32::Media::MediaFoundation::MFCreateMemoryBuffer;

    let (w, h) = CAMERA_SIZE;
    let rgba = video_code::marker_rgba(FrameMarker::new(StreamKind::Camera, 0, slot), w, h);
    let nv12 = video_code::rgba_to_nv12(&rgba, w, h);
    let buffer = unsafe { MFCreateMemoryBuffer(nv12.len() as u32) }.ok()?;
    buffer.lock_for_write().ok()?.copy_from_slice(&nv12);
    unsafe { buffer.SetCurrentLength(nv12.len() as u32) }.ok()?;
    #[allow(clippy::arc_with_non_send_sync)]
    let buffer = Arc::new(std::sync::Mutex::new(buffer));
    Some(NativeCameraFrame {
        buffer,
        pixel_format: cap_camera_windows::PixelFormat::NV12,
        width: w as u32,
        height: h as u32,
        is_bottom_up: false,
        timestamp: host_timestamp(capture),
    })
}

#[cfg(target_os = "macos")]
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
) -> anyhow::Result<(ScreenCaptureTarget, Vec<scap_targets::WindowId>, Shareable)> {
    let stimulus_window = find_window(WINDOW_TITLE);
    let excluded = scap_targets::Window::list()
        .into_iter()
        .map(|w| w.id())
        .filter(|id| Some(id) != stimulus_window.as_ref())
        .collect();
    let shareable = platform::shareable().await?;
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
    let builder = defaults.apply_to_studio_builder(
        studio_recording::Actor::builder(project, target).with_system_audio(system_audio),
        camera,
        None,
    );
    // Windows Graphics Capture records the display without per-window
    // exclusion; the stimulus covers it full screen.
    #[cfg(target_os = "macos")]
    let builder = builder.with_excluded_windows(excluded);
    #[cfg(windows)]
    let _ = excluded;
    let builder = builder
        .with_keyboard_capture(false)
        .with_fragmented(fragmented)
        .with_quality(StudioQuality::Balanced);
    (builder, defaults.studio_max_fps(camera, None))
}

async fn build_studio(
    builder: studio_recording::ActorBuilder,
    shareable: &Shareable,
) -> anyhow::Result<studio_recording::ActorHandle> {
    #[cfg(target_os = "macos")]
    return builder.build(Some(shareable.clone())).await;
    #[cfg(windows)]
    {
        let () = *shareable;
        builder.build().await
    }
}

async fn build_instant(
    builder: instant_recording::ActorBuilder,
    shareable: &Shareable,
) -> anyhow::Result<instant_recording::ActorHandle> {
    #[cfg(target_os = "macos")]
    return builder.build(Some(shareable.clone())).await;
    #[cfg(windows)]
    {
        let () = *shareable;
        builder.build().await
    }
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
                .join(format!("cap-verify-stimulus{}", std::env::consts::EXE_SUFFIX));
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
    /// Every hand-off of the synthetic microphone and camera.
    sources: Vec<SourceTrace>,
    /// The stimulus process's real-time sentinel.
    sentinel: Result<SentinelLog, String>,
    /// Recovery after a crash may lose at most this many seconds before the
    /// crash (the in-flight fragment).
    loss_budget: Option<f64>,
}

async fn run_case(
    spec: &Spec,
    capture: CaptureMode,
    shareable: &Shareable,
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
        let window = (recorded.started, recorded.stopped);
        let verdicts: Vec<SourceVerdict> = recorded
            .sources
            .iter()
            .map(|trace| judge_source(trace, reference, window))
            .collect();
        let stem = format!(
            "{}-r{}-a{tries}",
            spec.id.replace('/', "-"),
            ATTEMPT.load(Ordering::Relaxed)
        );
        let evidence = persist_sources(&stem, reference, &recorded, &verdicts, &attempt_scratch);
        case.note(format!(
            "attempt {tries} sources ({}): {}",
            evidence.display(),
            recorded
                .sources
                .iter()
                .zip(&verdicts)
                .map(|(trace, verdict)| format!(
                    "{} {} hand-offs, worst {:.1} ms late, priority {}",
                    trace.name,
                    verdict.inside,
                    verdict.worst * 1000.0,
                    trace.realtime.state.map_or(-1, |s| s.base_pri)
                ))
                .collect::<Vec<_>>()
                .join("; ")
        ));
        for (trace, verdict) in recorded.sources.iter().zip(&verdicts) {
            if verdict.rejected_outside > 0 {
                case.note(format!(
                    "{} feed rejected {} hand-offs outside the recording",
                    trace.name, verdict.rejected_outside
                ));
            }
        }
        if let Some(reason) = recorded
            .sources
            .iter()
            .find_map(|trace| source_scheduling(trace, reference, window).err())
        {
            case.problem(
                "harness",
                format!("{reason}; evidence {}", evidence.display()),
            );
            case.note(format!("artifacts kept at {}", scratch.display()));
            return Ok(());
        }
        let sentinel = match &recorded.sentinel {
            Ok(log) => log,
            Err(e) => {
                case.problem("harness", format!("stimulus sentinel log unavailable: {e}"));
                case.note(format!("artifacts kept at {}", scratch.display()));
                return Ok(());
            }
        };
        let sentinel_evidence = keep_sentinel_log(&attempt_scratch, &stem);
        if let Err(e) = sentinel
            .realtime
            .obtained()
            .and_then(|()| sched::state_is_realtime(sentinel.end))
        {
            case.problem(
                "harness",
                format!("stimulus sentinel: real-time scheduling not obtained or lost: {e}"),
            );
            case.note(format!("artifacts kept at {}", scratch.display()));
            return Ok(());
        }
        let freezes = machine_freezes(sentinel, reference, window);
        case.note(format!(
            "attempt {tries} sentinel ({}): {}",
            sentinel_evidence.display(),
            describe_sentinel(sentinel, reference, window)
        ));
        let product: Vec<&(&str, String)> = verdicts.iter().flat_map(|v| &v.product).collect();
        let product_failed = !product.is_empty();
        // The recorder's own feed failed its source: a product failure that
        // a retry must not hide. The output checks still run.
        for (class, text) in product {
            case.problem(class, format!("{text}; evidence {}", evidence.display()));
        }
        if !product_failed && let Some(reason) = inconclusive(spec, &recorded, &verdicts) {
            let reason = format!("{reason}; evidence {}", evidence.display());
            keep_stimulus_log(&attempt_scratch, &stem);
            if tries < 2 {
                case.note(format!("inconclusive, retrying: {reason}"));
                continue;
            }
            case.problem("environment", format!("inconclusive twice: {reason}"));
            case.note(format!("artifacts kept at {}", scratch.display()));
            return Ok(());
        }
        let before = case.checkpoint();
        IMPLICATED.with(|m| m.borrow_mut().clear());
        analyze(&recorded, reference, case)?;
        if matches!(spec.mode, Mode::Studio { .. }) {
            check_export(&recorded, case).await?;
        }
        let implicated = IMPLICATED.with(|m| std::mem::take(&mut *m.borrow_mut()));
        let excuse = (!product_failed)
            .then(|| frozen_failures(case, before.problems(), &implicated, &freezes))
            .flatten();
        let Some(reason) = excuse else {
            break (recorded, reference);
        };
        // Every unexpected failure lies inside a machine freeze: the
        // recording cannot tell Cap from the host. Discard the analysis.
        case.rollback(before);
        let reason = format!("{reason}; evidence {}", sentinel_evidence.display());
        keep_stimulus_log(&attempt_scratch, &stem);
        if tries < 2 {
            case.note(format!("inconclusive, retrying: {reason}"));
            continue;
        }
        case.problem("environment", format!("inconclusive twice: {reason}"));
        case.note(format!("artifacts kept at {}", scratch.display()));
        return Ok(());
    };
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
/// - a synthetic source's own thread handed over input more than
///   `SOURCE_STALL_SECS` late inside the recording (`judge_source`; time
///   spent inside Cap's feed is a product failure instead).
fn inconclusive(spec: &Spec, rec: &Recorded, verdicts: &[SourceVerdict]) -> Option<String> {
    if let Some(reason) = starved(spec, &rec.stimulus) {
        return Some(reason);
    }
    if let Some(reason) = compositor_stall(spec, &rec.stimulus) {
        return Some(reason);
    }
    verdicts
        .iter()
        .find_map(|v| v.stalled.as_ref().map(|(_, reason)| reason.clone()))
}

/// A gap this long between wakes of the stimulus's real-time sentinel
/// means the whole machine stopped running (see `Sentinel` in the stimulus).
/// Nothing the recorder does can delay a priority-97 thread of another
/// process that long: it preempts every timeshare thread, the recorder's
/// real-time threads (audio and capture callbacks, the synthetic sources)
/// each run a few ms per period and are demoted by the kernel if they
/// overrun their computation budget, so only a host that runs no virtual
/// CPU, or a kernel that schedules nothing, leaves the sentinel asleep.
const SENTINEL_FREEZE_SECS: f64 = 0.1;
/// Failures attributed to a freeze: frames or markers captured from shortly
/// before it (in flight when it began) until shortly after it (the burst of
/// frames the recorder catches up with).
const FREEZE_MARGIN_BEFORE: f64 = 0.15;
const FREEZE_MARGIN_AFTER: f64 = 0.3;

/// Sentinel gaps over `SENTINEL_FREEZE_SECS` that overlap the recording
/// window: (start, end) in seconds from the reference.
fn machine_freezes(log: &SentinelLog, reference: u64, window: (f64, f64)) -> Vec<(f64, f64)> {
    log.gaps()
        .filter(|(_, gap)| *gap > SENTINEL_FREEZE_SECS)
        .map(|(start, gap)| {
            let start = host_secs(start, reference);
            (start, start + gap)
        })
        .filter(|(start, end)| *end >= window.0 && *start <= window.1)
        .collect()
}

fn describe_sentinel(log: &SentinelLog, reference: u64, window: (f64, f64)) -> String {
    let gaps: Vec<f64> = log
        .gaps()
        .filter(|(start, _)| {
            let at = host_secs(*start, reference);
            at >= window.0 && at <= window.1
        })
        .map(|(_, gap)| gap)
        .collect();
    let max = gaps.iter().copied().fold(0.0f64, f64::max);
    format!(
        "{} wakes in the recording, priority {}, longest gap {:.1} ms, {} over 10 ms, {} over {:.0} ms",
        gaps.len(),
        log.realtime.state.map_or(-1, |s| s.base_pri),
        max * 1000.0,
        gaps.iter().filter(|g| **g > 0.010).count(),
        gaps.iter().filter(|g| **g > SENTINEL_FREEZE_SECS).count(),
        SENTINEL_FREEZE_SECS * 1000.0
    )
}

/// `Some(reason)` when the analysis added unexpected failures (classes the
/// case has no xfail for) and every one of them is localized to frames or
/// markers captured within a machine freeze. Failures that are not
/// localized (sync medians, spreads, unreadable or unknown frames) are never
/// attributed to a freeze, and a case without a freeze keeps every failure.
fn frozen_failures(
    case: &Case,
    from: usize,
    implicated: &BTreeMap<usize, Vec<f64>>,
    freezes: &[(f64, f64)],
) -> Option<String> {
    if freezes.is_empty() {
        return None;
    }
    let expected: Vec<String> = report::xfails_for(&case.id)
        .into_iter()
        .map(|x| x.class)
        .collect();
    let unexpected: Vec<usize> = (from..case.problems.len())
        .filter(|&i| {
            case.problem_classes[i]
                .split(',')
                .any(|class| !expected.iter().any(|e| e == class))
        })
        .collect();
    if unexpected.is_empty() {
        return None;
    }
    let inside = |t: f64| {
        freezes.iter().any(|&(start, end)| {
            t >= start - FREEZE_MARGIN_BEFORE && t <= end + FREEZE_MARGIN_AFTER
        })
    };
    for &i in &unexpected {
        let times = implicated.get(&i)?;
        if times.is_empty() || !times.iter().all(|&t| inside(t)) {
            return None;
        }
    }
    Some(format!(
        "machine froze (stimulus sentinel asleep {}) and every unexpected failure lies within it: {}",
        freezes
            .iter()
            .map(|(start, end)| format!("{:.0} ms at {start:.2}s", (end - start) * 1000.0))
            .collect::<Vec<_>>()
            .join(", "),
        unexpected
            .iter()
            .map(|&i| format!("{}: {}", case.problem_classes[i], case.problems[i]))
            .collect::<Vec<_>>()
            .join("; ")
    ))
}

/// Keeps every attempt's sentinel log with the source evidence.
fn keep_sentinel_log(attempt_scratch: &Path, stem: &str) -> PathBuf {
    let Some(dir) = std::env::var_os("CAP_VERIFY_DUMP") else {
        return attempt_scratch.join(SENTINEL_FILE);
    };
    let dir = PathBuf::from(dir).join("sources");
    let path = dir.join(format!("{stem}-sentinel.txt"));
    let _ = std::fs::create_dir_all(&dir);
    let _ = std::fs::copy(attempt_scratch.join(SENTINEL_FILE), &path);
    path
}

thread_local! {
    /// Capture times (seconds from the reference) of the frames or markers
    /// behind each localized problem, by its index in `Case::problems`.
    static IMPLICATED: std::cell::RefCell<BTreeMap<usize, Vec<f64>>> =
        const { std::cell::RefCell::new(BTreeMap::new()) };
}

/// Localizes the problem just added to `case`.
fn implicate(case: &Case, times: impl IntoIterator<Item = f64>) {
    if let Some(index) = case.problems.len().checked_sub(1) {
        IMPLICATED.with(|m| m.borrow_mut().insert(index, times.into_iter().collect()));
    }
}

/// Keeps a discarded attempt's stimulus log (its independent capture
/// observer) next to the source evidence: the case's scratch directory is
/// removed when a retry passes.
fn keep_stimulus_log(attempt_scratch: &Path, stem: &str) {
    if let Some(dir) = std::env::var_os("CAP_VERIFY_DUMP") {
        let dir = PathBuf::from(dir).join("sources");
        let _ = std::fs::create_dir_all(&dir);
        let _ = std::fs::copy(
            attempt_scratch.join("stimulus.jsonl"),
            dir.join(format!("{stem}-stimulus.jsonl")),
        );
    }
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
fn observer_silence_excuses_only_a_covered_window() {
    let truth: Truth = (0..10u32).map(|i| (i, f64::from(i) * 0.05)).collect();
    let check = |observed: Vec<f64>| VideoCheck {
        name: "screen",
        kind: StreamKind::Screen,
        truth: &truth,
        not_sent: &[],
        may_skip: Box::new(|_| false),
        allow_duplicates: true,
        required: Vec::new(),
        window: (0.0, 1.0),
        observed,
    };
    // Picture 4 is on screen from 0.20 to 0.25 s.
    let around: Vec<f64> = (0..20)
        .map(|k| f64::from(k) * 0.0167)
        .filter(|t| !(0.199..=0.251).contains(t))
        .collect();
    assert!(check(around.clone()).dropped_for_every_client(4));
    assert!(!check(around.iter().copied().chain([0.22]).collect()).dropped_for_every_client(4));
    let only_before: Vec<f64> = around.iter().copied().filter(|t| *t < 0.2).collect();
    assert!(
        !check(only_before).dropped_for_every_client(4),
        "the observer must cover the window"
    );
    assert!(!check(Vec::new()).dropped_for_every_client(4));
}

#[test]
fn post_hold_pictures_are_excused_only_when_the_reference_missed_them() {
    // 20 fps pictures, held from 0.5 s to 1.5 s: picture 10 stays on screen
    // and picture 31 is the first change after the hold.
    let truth: Truth = (1..=10u32)
        .chain(31..=50)
        .map(|i| (i, f64::from(i - 1) * 0.05))
        .collect();
    let required = vec![(
        31u32,
        "first picture after the 1 s hold at 0.5 s".to_string(),
    )];
    let check = |observed: Vec<f64>| VideoCheck {
        name: "screen",
        kind: StreamKind::Screen,
        truth: &truth,
        not_sent: &[],
        may_skip: Box::new(|_| false),
        allow_duplicates: true,
        required: required.clone(),
        window: (0.0, 2.5),
        observed,
    };
    let recorded_except = |lost: &'static [u32]| move |i: u32| !lost.contains(&i);
    // The reference stream receives each picture 20 ms after it is presented
    // and nothing during the hold, as on a quiet screen.
    let prompt: Vec<f64> = truth.values().map(|t| t + 0.02).collect();
    // The capture service resumes 70 ms after the hold: its first frame
    // already shows picture 32, so picture 31 reached no client.
    let late: Vec<f64> = prompt
        .iter()
        .map(|&t| if (1.51..1.53).contains(&t) { 1.57 } else { t })
        .collect();

    let resumed_late = check(late);
    assert!(resumed_late.dropped_for_every_client(31));
    let (missing, dropped) = resumed_late.missing_required(recorded_except(&[31]), 1, 50);
    assert!(missing.is_empty(), "excused: {missing:?}");
    assert_eq!(dropped, vec![31]);
    // The first picture after the hold that reached the reference must be
    // recorded in its place.
    let (missing, _) = resumed_late.missing_required(recorded_except(&[31, 32]), 1, 50);
    assert_eq!(missing.iter().map(|m| m.0).collect::<Vec<_>>(), vec![32]);

    // The reference received picture 31: the recorder lost it.
    let resumed_in_time = check(prompt);
    assert!(!resumed_in_time.dropped_for_every_client(31));
    let (missing, dropped) = resumed_in_time.missing_required(recorded_except(&[31]), 1, 50);
    assert_eq!(missing.iter().map(|m| m.0).collect::<Vec<_>>(), vec![31]);
    assert!(dropped.is_empty());
    assert!(
        resumed_in_time
            .missing_required(recorded_except(&[]), 1, 50)
            .0
            .is_empty()
    );

    // Without a reference stream (Windows) nothing is excused.
    let (missing, _) = check(Vec::new()).missing_required(recorded_except(&[31]), 1, 50);
    assert_eq!(missing.iter().map(|m| m.0).collect::<Vec<_>>(), vec![31]);
}

fn test_trace(name: &'static str, handoffs: Vec<Handoff>) -> SourceTrace {
    let constraint = sched::Constraint {
        period_ms: 33.333,
        computation_ms: 16.667,
        constraint_ms: 33.333,
        preemptible: true,
    };
    let state = sched::ThreadState {
        policy: 2,
        base_pri: sched::REALTIME_PRIORITY,
        cur_pri: sched::REALTIME_PRIORITY,
        max_pri: 63,
        cpu_us: 0,
    };
    SourceTrace {
        name,
        realtime: sched::Realtime {
            requested: sched::Constraint {
                computation_ms: 10.0,
                ..constraint
            },
            qos_status: 0,
            policy_status: 0,
            readback_status: 0,
            readback_default: false,
            granted: Some(constraint),
            state: Some(state),
        },
        end: Some(state),
        handoffs,
    }
}

/// Camera hand-offs every 33 ms from `reference`; `late(slot)` gives the
/// wake delay and `push(slot)` the time inside the feed, in seconds. A
/// source behind schedule wakes as soon as its previous hand-off returns.
fn simulated_handoffs(
    reference: u64,
    slots: u32,
    late: impl Fn(u32) -> f64,
    push: impl Fn(u32) -> f64,
    admission: impl Fn(u32) -> Admission,
) -> Vec<Handoff> {
    let mut free = reference;
    (0..slots)
        .map(|slot| {
            let due = host_add_secs(reference, f64::from(slot) / 30.0);
            let wake = host_add_secs(due.max(free), late(slot));
            let built = host_add_secs(wake, 0.003);
            let pushed = host_add_secs(built, push(slot));
            free = pushed;
            Handoff {
                index: slot,
                due,
                wake,
                built,
                pushed,
                admission: admission(slot),
                pri: sched::REALTIME_PRIORITY,
            }
        })
        .collect()
}

#[test]
fn source_lateness_is_attributed_to_the_source_or_to_cap() {
    let reference = host_now();
    let window = (1.0, 8.0);
    let ok = |_| Admission::Accepted;
    // The source overslept 151 ms at slot 90 (3.0 s) and caught up in a
    // burst: the host stalled it, inconclusive with its breakdown.
    let overslept = test_trace(
        "camera",
        simulated_handoffs(
            reference,
            300,
            |s| if s == 90 { 0.151 } else { 0.0005 },
            |_| 0.00004,
            ok,
        ),
    );
    let verdict = judge_source(&overslept, reference, window);
    assert!(verdict.product.is_empty(), "{:?}", verdict.product);
    let (late, reason) = verdict.stalled.expect("stall");
    assert!((late - 0.154).abs() < 0.002, "{late}");
    assert!(
        reason.contains("woke 151.0 ms past its deadline"),
        "{reason}"
    );
    // Outside the recording window it does not count.
    assert!(
        judge_source(&overslept, reference, (3.5, 8.0))
            .stalled
            .is_none()
    );
    // Cap's feed held the source for 200 ms inside hand-off 90: the later
    // hand-offs are late because of Cap, never inconclusive.
    let blocked = test_trace(
        "camera",
        simulated_handoffs(
            reference,
            300,
            |_| 0.0005,
            |s| if s == 90 { 0.2 } else { 0.00004 },
            ok,
        ),
    );
    let verdict = judge_source(&blocked, reference, window);
    assert!(verdict.stalled.is_none(), "{:?}", verdict.stalled);
    assert_eq!(verdict.product.len(), 1, "{:?}", verdict.product);
    assert_eq!(verdict.product[0].0, "camera-ingress");
    assert!(
        verdict.product[0].1.contains("hand-off 91"),
        "{:?}",
        verdict.product
    );
    // A rejected hand-off fails as ingress inside the window and is only
    // counted outside it.
    let full = |s| {
        if s == 15 || s == 150 {
            Admission::Full
        } else {
            Admission::Accepted
        }
    };
    let rejected = test_trace(
        "microphone",
        simulated_handoffs(reference, 300, |_| 0.0005, |_| 0.00004, full),
    );
    let verdict = judge_source(&rejected, reference, window);
    assert_eq!(verdict.rejected_outside, 1);
    assert_eq!(verdict.product.len(), 1);
    assert_eq!(verdict.product[0].0, "mic-ingress");
    assert!(
        verdict.product[0].1.contains("rejected 1 of"),
        "{:?}",
        verdict.product
    );
    // A source below the real-time band is a harness failure.
    let mut demoted = overslept.clone();
    demoted.handoffs[100].pri = sched::REALTIME_PRIORITY - 1;
    assert!(source_scheduling(&demoted, reference, window).is_err());
    assert!(source_scheduling(&overslept, reference, window).is_ok());
}

#[test]
#[cfg_attr(
    not(target_os = "macos"),
    ignore = "its expected class is a macOS expectation (recording/instant/screen-mic-system sync-screen-mic)"
)]
fn sentinel_freezes_excuse_only_failures_localized_inside_them() {
    let reference = host_now();
    // A sentinel log with a 300 ms gap at 9.9 s and a 60 ms gap at 5 s.
    let mut wakes = vec![host_add_secs(reference, 1.0)];
    let mut t: f64 = 1.0;
    while t < 12.0 {
        t += if (t - 9.9).abs() < 0.001 {
            0.3
        } else if (t - 5.0).abs() < 0.001 {
            0.06
        } else {
            0.002
        };
        t = (t * 1000.0).round() / 1000.0;
        wakes.push(host_add_secs(reference, t));
    }
    let realtime = test_trace("camera", vec![]).realtime;
    let mut text = serde_json::json!({
        "period_secs": 0.002,
        "first": wakes[0],
        "realtime": realtime,
        "end": realtime.state,
    })
    .to_string();
    for w in wakes.windows(2) {
        text.push_str(&format!("\n{}", w[1] - w[0]));
    }
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join(SENTINEL_FILE);
    std::fs::write(&path, text).unwrap();
    let log = SentinelLog::read(&path).unwrap();
    assert_eq!(log.wakes, wakes);
    let freezes = machine_freezes(&log, reference, (2.0, 11.0));
    assert_eq!(freezes.len(), 1);
    assert!((freezes[0].0 - 9.9).abs() < 1e-3 && (freezes[0].1 - 10.2).abs() < 1e-3);
    assert!(machine_freezes(&log, reference, (2.0, 9.0)).is_empty());

    let excuse = |problems: &[(&str, Option<Vec<f64>>)], freezes: &[(f64, f64)]| {
        let mut case = Case::new("recording/instant/screen-mic-system");
        IMPLICATED.with(|m| m.borrow_mut().clear());
        for (class, times) in problems {
            case.problem(class, format!("{class} problem"));
            if let Some(times) = times {
                implicate(&case, times.iter().copied());
            }
        }
        let implicated = IMPLICATED.with(|m| std::mem::take(&mut *m.borrow_mut()));
        frozen_failures(&case, 0, &implicated, freezes)
    };
    let lost = ("missing", Some(vec![9.8, 10.0, 10.4]));
    // Expected classes (sync-screen-mic here) never need an excuse.
    let clock = ("sync-screen-mic", None);
    assert!(excuse(&[lost.clone(), clock.clone()], &freezes).is_some());
    // Without a freeze, or outside it, a loss stays a Cap failure.
    assert!(excuse(&[lost.clone()], &[]).is_none());
    assert!(excuse(&[("missing", Some(vec![10.0, 10.6]))], &freezes).is_none());
    assert!(excuse(&[("missing", Some(vec![9.7]))], &freezes).is_none());
    // A failure that is not localized (a sync median) is never excused.
    assert!(excuse(&[lost, ("sync-screen-system", None)], &freezes).is_none());
    // Only expected failures: nothing to excuse.
    assert!(excuse(&[clock], &freezes).is_none());
}

/// A feed that stops taking frames (scripted slow consumer: its actor is
/// blocked for 4 s) must be reported as a product failure of class
/// `camera-ingress` / `mic-ingress`, never as a late, inconclusive source.
/// Runs the real synthetic sources, under the real-time constraint this
/// host grants, against the real feed actors.
#[test]
fn injected_feed_backpressure_is_ingress_not_inconclusive() {
    let rt = runtime();
    rt.block_on(async {
        let reference = host_now();
        let feeds = start_feeds(reference, 8.0, true, vec![], 0.0);
        tokio::time::sleep(Duration::from_millis(500)).await;
        let started = host_now();
        feeds.started.store(started, Ordering::Release);
        let camera = feeds.camera.clone().expect("camera");
        assert_eq!(camera.stall(Duration::from_secs(4)), Admission::Accepted);
        assert_eq!(feeds.mic.stall(Duration::from_secs(4)), Admission::Accepted);
        tokio::time::sleep(Duration::from_secs(3)).await;
        let stopped = host_now();
        feeds.stop.store(true, Ordering::Release);
        let mic = tokio::task::block_in_place(|| feeds.mic_task.join()).expect("mic source");
        let (truth, _, cam) =
            tokio::task::block_in_place(|| feeds.camera_task.expect("camera").join())
                .expect("camera source");
        let window = (host_secs(started, reference), host_secs(stopped, reference));
        let mut case = Case::new("recording/self-check/feed-backpressure");
        for trace in [&cam, &mic] {
            source_scheduling(trace, reference, window).expect("real-time sources");
            let verdict = judge_source(trace, reference, window);
            eprintln!(
                "  {}: {} hand-offs, worst {:.1} ms late, priority {:?}, stalled {:?}",
                trace.name,
                verdict.inside,
                verdict.worst * 1000.0,
                trace.realtime.state.map(|s| s.base_pri),
                verdict.stalled
            );
            // run_case reports product verdicts before (and instead of)
            // any inconclusive retry.
            assert!(
                !verdict.product.is_empty(),
                "{} rejections not reported",
                trace.name
            );
            for (class, text) in verdict.product {
                eprintln!("  {class}: {text}");
                case.problem(class, text);
            }
        }
        assert_eq!(
            case.classes.iter().map(String::as_str).collect::<Vec<_>>(),
            ["camera-ingress", "mic-ingress"]
        );
        let rejected: Vec<u32> = cam
            .handoffs
            .iter()
            .filter(|h| h.admission == Admission::Full)
            .map(|h| h.index)
            .collect();
        assert!(!rejected.is_empty());
        assert!(rejected.iter().all(|slot| truth.contains_key(slot)));
    });
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
    _preflight: &Shareable,
    scratch: &Path,
    reference: u64,
    case: &mut Case,
) -> anyhow::Result<Recorded> {
    let system_output = platform::system_audio_output();
    if spec.system_audio && require_system_audio() && !system_output {
        case.problem(
            "missing",
            "system audio required but this host has no audio output device",
        );
    }
    let stimulus_spec = StimulusSpec {
        fps: spec.stimulus_fps,
        seconds: spec.seconds,
        holds: spec.holds.clone(),
        busy: true,
        audio: spec.system_audio && stimulus_plays_system_audio() && system_output,
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
    // The real-time source threads must not outlive a failed attempt.
    let _stop_sources = StopOnDrop(feeds.stop.clone());
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
    let system_audio = spec.system_audio && platform::system_audio_output();
    if spec.system_audio && !system_audio {
        case.note("no audio output device: recorded without system audio");
    }
    let gate = spec.gated.then(cap_recording::RecordingStartGate::new);
    let (handle, max_fps) = match spec.mode {
        Mode::Studio { fragmented, .. } => {
            let (builder, max_fps) = studio_builder(
                project.clone(),
                target,
                excluded,
                fragmented,
                camera,
                system_audio,
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
                Handle::Studio(build_studio(builder, &shareable).await?),
                max_fps,
            )
        }
        Mode::Instant => {
            let builder = instant_recording::Actor::builder(project.clone(), target)
                .with_system_audio(system_audio)
                .with_max_output_size(defaults.instant_mode_max_resolution);
            #[cfg(target_os = "macos")]
            let builder = builder.with_excluded_windows(excluded);
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
                Handle::Instant(build_instant(builder, &shareable).await?),
                cap_recording::DEFAULT_INSTANT_MODE_FPS,
            )
        }
        Mode::StudioCrashed => {
            let (builder, max_fps) =
                studio_builder(project.clone(), target, excluded, true, false, system_audio);
            let builder = builder.with_mic_feed(mic_lock.clone());
            (
                Handle::Studio(build_studio(builder, &shareable).await?),
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
        copy_project(&project, &snapshot)
            .map_err(|e| anyhow::anyhow!("snapshot of the live recording failed: {e:#}"))?;
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
    let join = |name: &str| anyhow::anyhow!("synthetic {name} source panicked");
    let mut sources = vec![
        tokio::task::block_in_place(|| feeds.mic_task.join()).map_err(|_| join("microphone"))?,
    ];
    let mic_truth = if spec.mic {
        feeds.mic_truth
    } else {
        Truth::new()
    };
    let camera_truth = match feeds.camera_task {
        Some(task) => {
            let (truth, dropped, trace) =
                tokio::task::block_in_place(|| task.join()).map_err(|_| join("camera"))?;
            sources.push(trace);
            Some((truth, dropped))
        }
        None => None,
    };
    drop(feeds.camera);
    let events = tokio::task::block_in_place(|| stimulus.finish())?;
    let sentinel = SentinelLog::read(&scratch.join(SENTINEL_FILE)).map_err(|e| format!("{e:#}"));
    waited?;
    let (project_path, loss_budget) = match crashed {
        Some(snapshot) => {
            let recovery_copy = scratch.join("crashed.cap");
            copy_project(&snapshot, &recovery_copy).map_err(|e| {
                anyhow::anyhow!("copy of the preserved crash snapshot failed: {e:#}")
            })?;
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
        sources,
        sentinel,
        loss_budget,
    })
}

/// Seconds of capture a crash may cost: the fragment being written (Studio
/// fragments are 2 s, see `MacOSFragmentedM4SMuxerConfig`) plus the encoder
/// pipeline still in flight.
const CRASH_LOSS_BUDGET: f64 = 3.0;

/// Copies a project directory: APFS clones on macOS; a file-by-file copy on
/// Windows, where a live recorder's files are open for shared reading. Taken
/// of a live project, the copy is what a crash leaves on disk.
fn copy_project(from: &Path, to: &Path) -> anyhow::Result<()> {
    #[cfg(target_os = "macos")]
    {
        let status = std::process::Command::new("cp")
            .arg("-cR")
            .arg(from)
            .arg(to)
            .status()?;
        anyhow::ensure!(status.success(), "cp -cR failed");
        Ok(())
    }
    #[cfg(windows)]
    {
        fn copy_dir(from: &Path, to: &Path) -> std::io::Result<()> {
            std::fs::create_dir_all(to)?;
            let mut copied = std::collections::HashSet::new();
            // The recorder renames `.tmp` fragments as it finishes them: a
            // file listed can be gone by the time it is opened, under a name
            // the next listing has.
            for _ in 0..5 {
                let mut vanished = false;
                for entry in std::fs::read_dir(from)? {
                    let entry = entry?;
                    let name = entry.file_name();
                    if copied.contains(&name) {
                        continue;
                    }
                    let target = to.join(&name);
                    let result = if entry.file_type()?.is_dir() {
                        copy_dir(&entry.path(), &target)
                    } else {
                        std::fs::copy(entry.path(), &target).map(|_| ())
                    };
                    match result {
                        Ok(()) => {
                            copied.insert(name);
                        }
                        Err(e) if e.kind() == std::io::ErrorKind::NotFound => vanished = true,
                        Err(e) => return Err(e),
                    }
                }
                if !vanished {
                    return Ok(());
                }
            }
            Err(std::io::Error::other(format!(
                "files in {} kept disappearing while it was copied",
                from.display()
            )))
        }
        copy_dir(from, to).map_err(Into::into)
    }
}

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
                    "start-time",
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
    /// The last second of the screen track is lost (a final segment that
    /// never reached the file).
    TruncateEnd,
    /// The first second of the screen track is lost (a late start).
    LateStart,
    /// The first picture after a scripted hold is lost although the
    /// stimulus's own capture stream received it: a recorder drop, which
    /// must fail even where the capture service resumes late after a hold.
    DropAfterHold,
}

thread_local! {
    static INJECTION: std::cell::Cell<Option<Injection>> = const { std::cell::Cell::new(None) };
    /// Whether the last injection found frames to act on.
    static INJECTED: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

const INJECTIONS: [Injection; 7] = [
    Injection::DropRun,
    Injection::Freeze,
    Injection::Stale,
    Injection::Late,
    Injection::TruncateEnd,
    Injection::LateStart,
    Injection::DropAfterHold,
];
const INJECTED_LATENESS: f64 = 0.15;

impl Injection {
    fn label(self) -> &'static str {
        match self {
            Injection::DropRun => "drop 3 consecutive frames",
            Injection::Freeze => "freeze over 3 frames",
            Injection::Stale => "re-emit a stale frame",
            Injection::Late => "screen 150 ms late",
            Injection::TruncateEnd => "lose the last second",
            Injection::LateStart => "start one second late",
            Injection::DropAfterHold => "lose a picture after a hold that reached the reference",
        }
    }

    /// Class and problem prefix the oracle must report for this fault.
    fn expected(self) -> (&'static str, &'static str) {
        match self {
            Injection::DropRun | Injection::Freeze => ("missing", "screen:"),
            Injection::Stale => ("timestamps", "screen:"),
            Injection::Late => ("sync-screen-mic", "screen vs"),
            Injection::TruncateEnd | Injection::LateStart => ("coverage", "screen:"),
            Injection::DropAfterHold => ("missing-after-hold", "screen:"),
        }
    }

    /// First of three consecutive presented indices, around 60 % of the
    /// recording, that were all captured, each stayed on screen long
    /// enough that the capture rate guarantees a sample, and each reached
    /// the stimulus's own capture stream (a picture that did not would be
    /// excused as a capture-service drop once removed).
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
                    captured.contains(&j)
                        && check.truth.contains_key(&j)
                        && !(check.may_skip)(j)
                        && !check.dropped_for_every_client(j)
                })
        })
    }

    fn apply(self, frames: &mut Vec<(f64, Readout)>, check: &mut VideoCheck) {
        let before = frames.clone();
        let observed = check.observed.len();
        if self == Injection::DropAfterHold {
            Self::drop_after_hold(frames, check);
        } else {
            self.mutate(frames, check);
        }
        INJECTED.set(*frames != before || check.observed.len() != observed);
    }

    /// Takes the first required picture after a hold that lies inside the
    /// recording (one the recorder captured if there is one), removes it
    /// from the recording and gives the stimulus's own capture stream a
    /// frame while it was on screen.
    fn drop_after_hold(frames: &mut Vec<(f64, Readout)>, check: &mut VideoCheck) {
        let index_of = |r: &Readout| match r {
            Readout::Marker { marker, .. } if marker.kind == StreamKind::Screen => {
                Some(marker.index)
            }
            _ => None,
        };
        let recorded: std::collections::BTreeSet<u32> =
            frames.iter().filter_map(|(_, r)| index_of(r)).collect();
        let (Some(&lo), Some(&hi)) = (recorded.first(), recorded.last()) else {
            return;
        };
        let inside: Vec<u32> = check
            .required
            .iter()
            .map(|(index, _)| *index)
            .filter(|index| *index > lo && *index < hi)
            .collect();
        let Some(index) = inside
            .iter()
            .copied()
            .find(|index| recorded.contains(index))
            .or_else(|| inside.first().copied())
        else {
            return;
        };
        let (Some(&shown), Some((_, &replaced))) = (
            check.truth.get(&index),
            check.truth.range(index + 1..).next(),
        ) else {
            return;
        };
        frames.retain(|(_, r)| index_of(r) != Some(index));
        let at = (shown + replaced) / 2.0;
        let position = check.observed.partition_point(|t| *t < at);
        check.observed.insert(position, at);
    }

    fn mutate(self, frames: &mut Vec<(f64, Readout)>, check: &VideoCheck) {
        let index_of = |r: &Readout| match r {
            Readout::Marker { marker, .. } => Some(marker.index),
            _ => None,
        };
        match self {
            Injection::DropAfterHold => {}
            Injection::Late => {
                for (pts, _) in frames.iter_mut() {
                    *pts += INJECTED_LATENESS;
                }
            }
            Injection::TruncateEnd => {
                if let Some(last) = frames.last().map(|(pts, _)| *pts) {
                    frames.retain(|(pts, _)| *pts < last - 1.0);
                }
            }
            Injection::LateStart => {
                if let Some(first) = frames.first().map(|(pts, _)| *pts) {
                    frames.retain(|(pts, _)| *pts > first + 1.0);
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
        if injection == Injection::TruncateEnd && rec.loss_budget.is_some() {
            caught.push(format!(
                "{}: n/a (a crash case may lose its end within its loss budget)",
                injection.label()
            ));
            continue;
        }
        if injection == Injection::DropAfterHold && rec.holds.is_empty() {
            continue;
        }
        if injection == Injection::Late && case.unobserved.contains_key(class) {
            caught.push(format!("{}: unobserved (track absent)", injection.label()));
            continue;
        }
        if injection == Injection::Late
            && case.classes.iter().any(|c| c.starts_with("sync-screen-"))
        {
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
                    "self-check: no frames to inject '{}' into: {}",
                    injection.label(),
                    if injection == Injection::DropAfterHold {
                        "no picture after a hold inside the recording"
                    } else {
                        "no 3 consecutive pictures the capture rate must sample"
                    }
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
    /// (recording start, end of the kept span) in truth seconds: the
    /// recording must hold the pictures shown from shortly after the start
    /// to the end (see `START_COVERAGE_SECS`).
    window: (f64, f64),
    /// Frame times (truth seconds, sorted) of the stimulus's own,
    /// independent ScreenCaptureKit stream (screen only; empty otherwise).
    observed: Vec<f64>,
}

/// Margin around a picture's time on screen within which the independent
/// observer must have frames for its silence in between to count.
const OBSERVER_COVER_SECS: f64 = 0.5;

impl VideoCheck<'_> {
    /// Whether the stimulus's own capture stream received a frame while
    /// `index` was on screen.
    fn observed_while_shown(&self, index: u32) -> bool {
        let (Some(&shown), Some((_, &replaced))) =
            (self.truth.get(&index), self.truth.range(index + 1..).next())
        else {
            return false;
        };
        self.observed.iter().any(|&t| t >= shown && t <= replaced)
    }

    /// A picture the capture service never delivered to any client: the
    /// stimulus's own capture stream received no frame while it was on
    /// screen, although that stream delivered frames on both sides of it
    /// (so it covered exactly that window). The stream receives frames only
    /// when the screen changes, so its frames before the picture are looked
    /// for from the previous picture on: after a scripted hold that is when
    /// the screen went static, and during the hold the stream is silent.
    fn dropped_for_every_client(&self, index: u32) -> bool {
        let Some(&shown) = self.truth.get(&index) else {
            return false;
        };
        let Some((_, &replaced)) = self.truth.range(index + 1..).next() else {
            return false;
        };
        let since = self
            .truth
            .range(..index)
            .next_back()
            .map_or(shown, |(_, &previous)| previous.min(shown));
        let before = self
            .observed
            .iter()
            .any(|&t| t < shown && t >= since - OBSERVER_COVER_SECS);
        let after = self
            .observed
            .iter()
            .any(|&t| t > replaced && t <= replaced + OBSERVER_COVER_SECS);
        before && after && !self.observed_while_shown(index)
    }

    /// Required pictures missing from the recording (indices strictly
    /// between `lo` and `hi`, the first and last recorded), with their
    /// description, and the required pictures excused because the capture
    /// service dropped them for every client. An excused picture is
    /// replaced by the first later one, within `OBSERVER_COVER_SECS`, that
    /// the stimulus's own capture stream received while it was on screen
    /// and that the capture rate must sample: the first change after the
    /// hold that reached any client must be in the recording.
    fn missing_required(
        &self,
        recorded: impl Fn(u32) -> bool,
        lo: u32,
        hi: u32,
    ) -> (Vec<(u32, String)>, Vec<u32>) {
        let mut missing = Vec::new();
        let mut dropped = Vec::new();
        for (index, what) in &self.required {
            let index = *index;
            let Some(&shown) = self.truth.get(&index) else {
                continue;
            };
            if index <= lo || index >= hi || recorded(index) {
                continue;
            }
            if !self.dropped_for_every_client(index) {
                missing.push((index, what.clone()));
                continue;
            }
            dropped.push(index);
            let stand_in = self
                .truth
                .range(index + 1..hi)
                .take_while(|(_, t)| **t <= shown + OBSERVER_COVER_SECS)
                .map(|(i, _)| *i)
                .find(|&i| self.observed_while_shown(i) && !(self.may_skip)(i));
            if let Some(stand_in) = stand_in.filter(|&i| !recorded(i)) {
                missing.push((
                    stand_in,
                    format!(
                        "{what} to reach the stimulus's own capture stream (index {index} reached no client)"
                    ),
                ));
            }
        }
        (missing, dropped)
    }
}

/// How late after the recording starts its first picture may be: the
/// documented start-up drops (`STARTUP_DROPS` frames at the slowest capture
/// rate, 30 fps: 200 ms) plus the display's presentation latency (up to
/// 75 ms, see `sync_checks`). Measured on hosted macOS 15 and 26: the first
/// recorded picture is the first one presented, 9 to 69 ms after the start.
const START_COVERAGE_SECS: f64 = 0.3;

fn check_video(case: &mut Case, track: &Track, mut check: VideoCheck) -> anyhow::Result<Offsets> {
    let mut frames: Vec<(f64, Readout)> = Vec::new();
    media::decode_video(&track.path, |picture| {
        let readout = video_code::read_stream(&picture.view(), check.kind);
        frames.push((picture.pts_secs, readout));
    })?;
    if check.kind == StreamKind::Screen
        && let Some(injection) = INJECTION.get()
    {
        injection.apply(&mut frames, &mut check);
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
    let mut backwards_at = Vec::new();
    let mut duplicates = 0;
    let mut pts_problems = Vec::new();
    for w in indices.windows(2) {
        let ((pa, a), (pb, b)) = (w[0], w[1]);
        if pb <= pa {
            pts_problems.push(format!("{pa:.4}->{pb:.4}"));
        }
        if b < a {
            backwards.push(format!("{a}->{b} at {pb:.3}s"));
            backwards_at.extend([a, b].iter().filter_map(|i| check.truth.get(i).copied()));
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
        implicate(case, backwards_at);
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
    // Start and end coverage, from the stimulus's truth: missing pictures
    // between the first and last recorded ones are counted below, so a late
    // start or a lost final segment needs its own check.
    let countable = |i: &u32| !check.not_sent.contains(i) && !(check.may_skip)(*i);
    let (start, end) = check.window;
    if let Some((&first_due, &due_at)) = check
        .truth
        .iter()
        .find(|(i, t)| **t >= start + START_COVERAGE_SECS && countable(i))
        && lo > first_due
    {
        let late = check.truth.get(&lo).map_or(f64::NAN, |t| t - start);
        case.measure(
            "coverage",
            &format!("{name}-start-late-ms"),
            (late * 1000.0).round(),
        );
        case.problem(
            "coverage",
            format!(
                "{name}: the recording starts {:.0} ms after the recording start (first recorded index {lo}); index {first_due}, shown {:.0} ms after the start, is missing (allowed {:.0} ms)",
                late * 1000.0,
                (due_at - start) * 1000.0,
                START_COVERAGE_SECS * 1000.0
            ),
        );
        implicate(case, Some(due_at));
    }
    if let Some((&last_due, &due_at)) = check
        .truth
        .iter()
        .rev()
        .find(|(i, t)| **t <= end && **t >= start && countable(i))
        && hi < last_due
    {
        let lost = check
            .truth
            .range(hi + 1..=last_due)
            .filter(|(i, _)| countable(i))
            .count();
        case.measure("coverage", &format!("{name}-end-lost"), lost as f64);
        case.problem(
            "coverage",
            format!(
                "{name}: the recording ends at index {hi}; {lost} pictures shown before the stop are missing (last due: index {last_due}, {:.0} ms before the end of the kept span)",
                (end - due_at) * 1000.0
            ),
        );
        implicate(case, Some(due_at));
    }
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
    // Pictures the capture service dropped for every client (approved
    // policy): counted and reported, never a threshold change.
    // The first picture after a hold that reached no client counts here too
    // (see `missing_required`).
    let (mut for_every_client, rest): (Vec<u32>, Vec<u32>) = skipped
        .into_iter()
        .partition(|&index| check.dropped_for_every_client(index));
    skipped = rest;
    let (missing_required, dropped_required) =
        check.missing_required(|index| first_seen.contains_key(&index), lo, hi);
    for_every_client.extend(dropped_required);
    for_every_client.sort_unstable();
    for_every_client.dedup();
    if !for_every_client.is_empty() {
        case.note(format!(
            "capture-service drops: {name}: {} missing pictures also never reached the stimulus's own capture stream, which covered their window: {:?}",
            for_every_client.len(),
            for_every_client
        ));
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
    for (index, what) in &missing_required {
        case.count("missing-after-hold", &format!("{name}-pictures"), 1.0);
        case.problem(
            "missing-after-hold",
            format!("{name}: {what} (index {index}) is missing from the recording"),
        );
        implicate(case, check.truth.get(index).copied());
    }
    if skipped.len() > budget || longest_run >= 3 {
        case.count("missing", &format!("{name}-frames"), skipped.len() as f64);
        case.problem(
            "missing",
            format!(
                "{name}: {} produced frames missing from the recording (budget {budget}, longest run {longest_run}): {:?}",
                skipped.len(),
                &skipped[..skipped.len().min(12)]
            ),
        );
        implicate(
            case,
            skipped.iter().filter_map(|i| check.truth.get(i).copied()),
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
                implicate(case, check.truth.get(&index).copied());
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
    let mut cut = Vec::new();
    let track_secs = mono.len() as f64 / f64::from(decoded.sample_rate);
    for marker in &located {
        let at = marker.time_secs + decoded.start_secs + start;
        // Starting or stopping a recording may cut a marker; the rest of
        // the track can be silence (encoder padding). A cut marker's payload
        // is meaningless: undecodable, or a CRC-valid index of near-silence
        // (index 0, chirp correlation 0.56, run 38780355968). Markers inside
        // the track must decode to a known index.
        let interior = marker.time_secs > 0.15
            && marker.time_secs + audio_code::MARKER_SECS < track_secs - 0.15;
        let Some(index) = marker.index else {
            if interior {
                damaged += 1;
            }
            continue;
        };
        if !interior && !check.truth.contains_key(&index) {
            cut.push((index, marker.time_secs, marker.correlation));
            continue;
        }
        if found.insert(index, at).is_some() {
            repeated.push(index);
        }
    }
    if !cut.is_empty() {
        case.note(format!(
            "{name}: ignored markers cut by the track's start or end (index, at, chirp correlation): {}",
            cut.iter()
                .map(|(i, t, c)| format!("({i}, {t:.3}s, {c:.3})"))
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }
    if damaged > 0 {
        case.count("unreadable", &format!("{name}-markers"), f64::from(damaged));
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
        case.count("missing", &format!("{name}-markers"), missing.len() as f64);
        for i in &missing {
            if let Some(t) = check.truth.get(i) {
                case.measure(
                    "missing",
                    &format!("{name}-after-start-s"),
                    ((t - check.window.0) * 100.0).round() / 100.0,
                );
            }
        }
        case.problem(
            "missing",
            format!(
                "{name}: {} markers inside the recording window are missing: {:?}",
                missing.len(),
                &missing[..missing.len().min(12)]
            ),
        );
        implicate(
            case,
            missing.iter().filter_map(|i| check.truth.get(i).copied()),
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
    let mut observed: Vec<f64> = rec
        .stimulus
        .iter()
        .filter_map(|e| match e {
            StimulusEvent::Observed { host } => Some(host_secs(*host, reference)),
            _ => None,
        })
        .collect();
    observed.sort_by(f64::total_cmp);
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
    // The span whose pictures and markers must all be in the recording. A
    // crash-recovery case has its own end check against its loss budget
    // (below), so the video end coverage does not apply there.
    let end = rec.stopped - rec.loss_budget.unwrap_or(0.3);
    let coverage_end = if rec.loss_budget.is_some() {
        f64::NEG_INFINITY
    } else {
        end
    };
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
            window: (rec.started, coverage_end),
            observed,
        },
    )?;
    let camera = match (&layout.camera, &rec.camera) {
        (Some(track), Some((truth, dropped))) if track.path.is_file() => {
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
                    window: (rec.started, coverage_end),
                    observed: Vec::new(),
                },
            )?)
        }
        (_, Some(_)) => {
            case.problem(
                "missing",
                "camera feed attached but no camera track recorded",
            );
            case.required_track_absent("camera");
            None
        }
        _ => None,
    };
    let window = (rec.started + 0.3, end);
    if rec.loss_budget.is_some() {
        let last_presented = screen_truth.range(1..).next_back().map(|(_, t)| *t);
        match (screen.last_truth(), last_presented) {
            (Some(last), Some(presented)) if last < end.min(presented) => {
                case.measure(
                    "missing",
                    "screen-lost-s",
                    ((rec.stopped - last) * 100.0).round() / 100.0,
                );
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
        let has_audio = ffmpeg::format::input(&layout.display.path)?
            .streams()
            .best(ffmpeg::media::Type::Audio)
            .is_some();
        if has_audio {
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
            for (source, required) in [
                ("mic", !rec.mic_truth.is_empty()),
                ("system", !system_truth.is_empty()),
            ] {
                if required {
                    case.problem("missing", format!("no {source} track recorded"));
                    case.required_track_absent(source);
                }
            }
            (None, None)
        }
    } else {
        let mic = match &layout.mic {
            Some(track) if track.path.is_file() => {
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
            _ if rec.mic_truth.is_empty() => None,
            _ => {
                case.problem("missing", "no mic track recorded");
                case.required_track_absent("mic");
                None
            }
        };
        let system = match (&layout.system, system_truth.is_empty()) {
            (Some(track), false) if track.path.is_file() => {
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
            (_, false) => {
                case.problem(
                    "missing",
                    "system audio was playing but no system audio track was recorded",
                );
                case.required_track_absent("system");
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

/// Marker index to the first time a track shows it, on the recording's
/// timeline (seconds after the recording started), and frames without a
/// readable screen marker.
fn screen_first_seen(path: &Path, offset: f64) -> anyhow::Result<(BTreeMap<u32, f64>, usize)> {
    let (samples, unreadable) = screen_samples(path)?;
    let mut first = BTreeMap::new();
    for (index, pts) in samples {
        first.entry(index).or_insert(offset + pts);
    }
    Ok((first, unreadable))
}

/// Every decoded frame's screen marker index and pts, in decode order, and
/// frames without a readable screen marker.
fn screen_samples(path: &Path) -> anyhow::Result<(Vec<(u32, f64)>, usize)> {
    let mut samples = Vec::new();
    let mut unreadable = 0;
    media::decode_video(path, |picture| {
        match video_code::read_stream(&picture.view(), StreamKind::Screen) {
            Readout::Marker { marker, .. } if marker.kind == StreamKind::Screen => {
                samples.push((marker.index, picture.pts_secs));
            }
            _ => unreadable += 1,
        }
    })?;
    Ok((samples, unreadable))
}

/// The first export frame at `export_fps` that shows the source picture
/// labelled `label`, under the decoder contract described in `check_export`.
fn contract_first_frame(label: f64, source_fps: f64, export_fps: f64, screen_offset: f64) -> f64 {
    let request = |frame: f64| {
        let time = (frame / export_fps + screen_offset) as f32;
        let step = f32::from_bits(time.abs().to_bits() + 1) - time.abs();
        let slack = (f64::from(step) * 4.0 * source_fps).min(0.25);
        (f64::from(time) * source_fps + slack).floor()
    };
    let mut frame = ((label / source_fps - screen_offset) * export_fps).floor() - 2.0;
    while request(frame) < label {
        frame += 1.0;
    }
    frame
}

#[test]
fn contract_first_frame_follows_the_decoder_request_rule_for_long_recordings() {
    // Up to three hours in, with screen offsets on and between export
    // frames: the export frame the check expects is the first one whose
    // request the decoder answers with the picture.
    for (fps, offset_frames) in [(30u32, 0.0), (30, 0.99), (60, 18.95), (60, 0.5)] {
        let fps_f = f64::from(fps);
        let offset = offset_frames / fps_f;
        for label in (0..3 * 3600 * fps).step_by(997).map(f64::from) {
            let expected = contract_first_frame(label, fps_f, fps_f, offset);
            let asks = |frame: f64| {
                let time = (frame / fps_f + offset) as f32;
                f64::from(cap_rendering::decoder::request_frame(time, fps))
            };
            assert!(
                asks(expected) >= label,
                "{label} at {fps} fps, offset {offset_frames}"
            );
            // Export frames start at 0; the decoder clamps earlier times.
            assert!(
                expected < 1.0 || asks(expected - 1.0) < label,
                "{label} at {fps} fps, offset {offset_frames}"
            );
        }
    }
}

fn picture_start_labels(samples: &[(u32, f64)], source_fps: f64) -> BTreeMap<u32, Vec<f64>> {
    let mut pictures: Vec<(Vec<f64>, Vec<f64>)> = Vec::new();
    let mut positions: BTreeMap<u32, usize> = BTreeMap::new();
    for &(index, pts) in samples {
        let slot = pts * source_fps;
        let labels = if (slot - slot.floor() - 0.5).abs() < 1e-6 {
            vec![slot.floor(), slot.ceil()]
        } else {
            vec![slot.round()]
        };
        match positions.get(&index).copied() {
            Some(position) => pictures[position].1.extend(labels),
            None => {
                positions.insert(index, pictures.len());
                pictures.push((labels.clone(), labels));
            }
        }
    }
    positions
        .into_iter()
        .map(|(index, position)| {
            let (first, _) = &pictures[position];
            let mut labels = first.clone();
            if position > 0 {
                // A cached predecessor may own a shared label. The next request
                // releases it even when no source sample carries that label.
                labels.extend(
                    first
                        .iter()
                        .filter(|label| pictures[position - 1].1.contains(label))
                        .map(|label| label + 1.0),
                );
            }
            labels.sort_by(f64::total_cmp);
            labels.dedup();
            (index, labels)
        })
        .collect()
}

#[test]
fn picture_start_labels_include_the_first_unshared_request_after_a_collision() {
    for samples in [
        vec![(59, 2350.0 / 600.0), (60, 2360.0 / 600.0)],
        vec![(135, 9.017711), (136, 9.048956), (136, 9.095833)],
    ] {
        let index = samples[1].0;
        let first = (samples[1].1 * 30.0_f64).round();
        assert_eq!(
            picture_start_labels(&samples, 30.0)[&index],
            vec![first, first + 1.0]
        );
    }
}

#[test]
fn picture_start_labels_reject_late_requests_after_a_collision() {
    let samples = [(1, 10.1 / 30.0), (2, 10.2 / 30.0), (2, 14.0 / 30.0)];
    assert_eq!(picture_start_labels(&samples, 30.0)[&2], vec![10.0, 11.0]);
}

#[test]
fn picture_start_labels_keep_unshared_requests_exact() {
    let samples = [(1, 9.0 / 30.0), (2, 10.0 / 30.0), (2, 14.0 / 30.0)];
    assert_eq!(picture_start_labels(&samples, 30.0)[&2], vec![10.0]);
}

#[test]
fn picture_start_labels_preserve_half_frame_ties() {
    assert_eq!(
        picture_start_labels(&[(1, 10.5 / 30.0)], 30.0)[&1],
        vec![10.0, 11.0]
    );
}

fn display_fps(project: &Path) -> anyhow::Result<u32> {
    let meta = RecordingMeta::load_for_project(project).map_err(|e| anyhow::anyhow!("{e}"))?;
    match meta.studio_meta() {
        Some(StudioRecordingMeta::MultipleSegments { inner }) => inner
            .segments
            .first()
            .map(|segment| segment.display.fps)
            .ok_or_else(|| anyhow::anyhow!("recording has no segments")),
        Some(StudioRecordingMeta::SingleSegment { segment }) => Ok(segment.display.fps),
        None => anyhow::bail!("not a studio recording"),
    }
}

/// Microphone marker index to its start on the recording's timeline, and
/// where the track ends.
fn mic_markers(path: &Path, offset: f64) -> anyhow::Result<(BTreeMap<u32, f64>, f64)> {
    let decoded = media::decode_audio(path, Some(48_000))?;
    let mono = decoded.mono();
    let end = offset + decoded.start_secs + mono.len() as f64 / f64::from(decoded.sample_rate);
    let markers = audio_code::locate_markers(&mono, decoded.sample_rate, AudioSource::Mic)
        .into_iter()
        .filter_map(|m| Some((m.index?, offset + decoded.start_secs + m.time_secs)))
        .collect();
    Ok((markers, end))
}

/// Exports a finished Studio recording at its capture rate and checks the
/// export against the recording's own tracks, so it fails only for what the
/// editor and exporter do to them:
/// - every screen picture the display track shows for at least one export
///   frame interval is in the export;
/// - each is first shown on a frame allowed by the decoder's grid contract;
/// - each microphone marker plays at its recorded time.
///
/// Finalization once stored the display track's average rate as its fps.
/// Decoders placed frames on that coarse grid, so exports dropped pictures
/// and drifted from the audio while the tracks themselves were fine.
async fn check_export(rec: &Recorded, case: &mut Case) -> anyhow::Result<()> {
    const EDGE_SECS: f64 = 0.3;
    const SLACK_SECS: f64 = 0.002;
    const MIC_TOLERANCE_SECS: f64 = 0.005;

    let layout = layout(&rec.project, case)?;
    // The editor's timeline starts where the last track started.
    let timeline_start = [
        Some(&layout.display),
        layout.camera.as_ref(),
        layout.mic.as_ref(),
        layout.system.as_ref(),
    ]
    .into_iter()
    .flatten()
    .map(|track| track.start)
    .fold(layout.display.start, f64::max);
    let (raw, _) = screen_first_seen(&layout.display.path, layout.display.start)?;
    let (width, height) = {
        let input = ffmpeg::format::input(&layout.display.path)?;
        let stream = input
            .streams()
            .best(ffmpeg::media::Type::Video)
            .ok_or_else(|| anyhow::anyhow!("display track has no video stream"))?;
        let video = ffmpeg::codec::Context::from_parameters(stream.parameters())?
            .decoder()
            .video()?;
        (video.width(), video.height())
    };
    let fps = rec.max_fps;
    let interval = 1.0 / f64::from(fps);
    let out = rec.project.join("verify-export.mp4");
    let config = ProjectConfiguration::load(&rec.project).unwrap_or_default();
    let base = cap_export::ExporterBase::builder(rec.project.clone())
        .with_config(config)
        .with_output_path(out.clone())
        .build()
        .await
        .map_err(|e| anyhow::anyhow!("exporter build: {e}"))?;
    let exported = cap_export::mp4::Mp4ExportSettings {
        fps,
        resolution_base: XY::new(width, height),
        compression: cap_export::mp4::ExportCompression::Social,
        custom_bpp: None,
        force_ffmpeg_decoder: false,
        optimize_filesize: false,
    }
    .export(base, |_| true)
    .await;
    let path = match exported {
        Ok(path) => path,
        Err(e) => {
            case.problem("export", format!("export failed: {e}"));
            return Ok(());
        }
    };
    let (shown, unreadable) = screen_first_seen(&path, timeline_start)?;

    let raw_end = raw.values().copied().fold(f64::MIN, f64::max);
    let ordered: Vec<(u32, f64)> = {
        let mut v: Vec<(u32, f64)> = raw.iter().map(|(i, t)| (*i, *t)).collect();
        v.sort_by(|a, b| a.1.total_cmp(&b.1));
        v
    };
    let required: Vec<(u32, f64)> = ordered
        .windows(2)
        .filter(|w| w[1].1 - w[0].1 >= interval + SLACK_SECS)
        .map(|w| w[0])
        .filter(|(_, t)| *t >= timeline_start + EDGE_SECS && *t <= raw_end - EDGE_SECS)
        .collect();
    let missing: Vec<u32> = required
        .iter()
        .filter(|(i, _)| !shown.contains_key(i))
        .map(|(i, _)| *i)
        .collect();
    let pct = |n: usize| (n as f64 * 1000.0 / required.len().max(1) as f64).round() / 10.0;
    if !missing.is_empty() {
        case.measure("export-missing", "missing-pct", pct(missing.len()));
        case.problem(
            "export-missing",
            format!(
                "export: {} of {} screen pictures the display track shows for at least one {fps} fps frame are not in the export, first {:?}",
                missing.len(),
                required.len(),
                &missing[..missing.len().min(8)]
            ),
        );
    }

    let delays: Vec<(u32, f64)> = required
        .iter()
        .filter_map(|(i, t)| shown.get(i).map(|e| (*i, e - t)))
        .collect();
    let worst_delay = delays
        .iter()
        .map(|(_, d)| *d)
        .max_by(|a, b| a.abs().total_cmp(&b.abs()));
    case.note(format!(
        "export: {fps} fps, {} screen pictures, {unreadable} frames without a screen marker, {} of {} required pictures missing, worst {:+.1} ms from the recorded time",
        shown.len(),
        missing.len(),
        required.len(),
        worst_delay.unwrap_or(f64::NAN) * 1e3
    ));
    // Where the decoder contract puts each picture: the display track is
    // read `screen_offset` into its own time, and a picture is labelled
    // round(pts * source_fps). A request is an f32 time t asking for grid
    // frame floor(t * source_fps), with t lifted by four f32 steps, at most
    // a quarter frame, so the f32 rounding of frame times never asks for the
    // frame before (crates/rendering/src/decoder/mod.rs, request_frame).
    // Written out here rather than called, so a decoder that breaks the
    // contract disagrees with it. A picture first shows on the first export
    // frame whose request reaches its label.
    let source_fps = f64::from(display_fps(&rec.project)?);
    let screen_offset = timeline_start - layout.display.start;
    let first_frame =
        |label: f64| contract_first_frame(label, source_fps, f64::from(fps), screen_offset);
    let (samples, _) = screen_samples(&layout.display.path)?;
    let legal_labels = picture_start_labels(&samples, source_fps);
    let off_contract: Vec<String> = required
        .iter()
        .filter_map(|(i, t)| {
            let shown_at = shown.get(i)?;
            let labels = legal_labels.get(i)?;
            let frame = ((shown_at - timeline_start) * f64::from(fps)).round();
            let expected = first_frame(labels[0]);
            (!labels.iter().any(|label| first_frame(*label) == frame)).then(|| {
                format!(
                    "{i} at frame {frame} instead of {expected} (display pts {:.3} s)",
                    t - layout.display.start
                )
            })
        })
        .collect();
    if !off_contract.is_empty() {
        case.measure("export-timing", "late-pct", pct(off_contract.len()));
        case.problem(
            "export-timing",
            format!(
                "export: {} screen pictures not on the export frame the decoder contract puts them on ({source_fps} fps source read {:.1} ms in), first {}",
                off_contract.len(),
                screen_offset * 1e3,
                off_contract[..off_contract.len().min(5)].join(", ")
            ),
        );
    }

    if let Some(track) = layout.mic.as_ref().filter(|t| t.path.is_file())
        && !rec.mic_truth.is_empty()
    {
        let (raw_mic, _) = mic_markers(&track.path, track.start)?;
        let (export_mic, export_end) = mic_markers(&path, timeline_start)?;
        let inside: Vec<(u32, f64)> = raw_mic
            .iter()
            .filter(|(_, t)| {
                **t >= timeline_start + EDGE_SECS
                    && **t + audio_code::MARKER_SECS <= export_end - EDGE_SECS
            })
            .map(|(i, t)| (*i, *t))
            .collect();
        let lost: Vec<u32> = inside
            .iter()
            .filter(|(i, _)| !export_mic.contains_key(i))
            .map(|(i, _)| *i)
            .collect();
        if !lost.is_empty() {
            case.measure("export-audio-missing", "missing", lost.len() as f64);
            case.problem(
                "export-audio-missing",
                format!(
                    "export: {} of {} microphone markers inside the export are not in its audio, first {:?}",
                    lost.len(),
                    inside.len(),
                    &lost[..lost.len().min(8)]
                ),
            );
        }
        let offsets: Vec<f64> = inside
            .iter()
            .filter_map(|(i, t)| export_mic.get(i).map(|e| e - t))
            .collect();
        if let Some(worst) = offsets
            .iter()
            .copied()
            .max_by(|a, b| a.abs().total_cmp(&b.abs()))
        {
            let mut sorted = offsets.clone();
            sorted.sort_by(f64::total_cmp);
            case.note(format!(
                "export: {} microphone markers, offsets min {:+.1} median {:+.1} max {:+.1} ms from the recorded time",
                offsets.len(),
                sorted[0] * 1e3,
                sorted[sorted.len() / 2] * 1e3,
                sorted[sorted.len() - 1] * 1e3
            ));
            if worst.abs() > MIC_TOLERANCE_SECS {
                case.measure("export-sync-mic", "offset-ms", (worst * 1e4).round() / 10.0);
                case.problem(
                    "export-sync-mic",
                    format!(
                        "export: microphone markers play up to {:+.1} ms from their recorded time ({} compared)",
                        worst * 1e3,
                        offsets.len()
                    ),
                );
            }
        } else {
            case.problem(
                "export-sync-mic",
                "export: no microphone marker matched the mic track",
            );
        }
    }
    let _ = std::fs::remove_file(&path);
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
        case.measure(
            "timestamps",
            "mic-spread-ms",
            (ms(mic.spread()) * 10.0).round() / 10.0,
        );
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
            let mut isolated_at = Vec::new();
            let mut off_at = Vec::new();
            for &(truth, offset) in &part.0 {
                let d = offset - median;
                if d.abs() > 3.0 * period {
                    isolated.push(format!("{:.2}s {:+.1} ms", truth, ms(d)));
                    isolated_at.push(truth);
                }
                if d.abs() > period {
                    off_at.push(truth);
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
                implicate(case, off_at);
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
                implicate(case, isolated_at);
            }
        }
        // Stamped with their capture times, camera frames keep one offset:
        // before the anchor every one of 20 runs had a spread of exactly 0
        // (run 38780355968), so any spread of a file tick (1.7 ms) or more
        // past it is the processing clock. The microphone's 4 ms limit
        // missed it in 2 of those 20 runs once the synthetic camera ran on
        // time (spread 3.3 ms; 3.3 to 30 ms in the others).
        const CAMERA_EXACT_SPREAD: f64 = 0.001;
        if post.0.len() > 1 && post.spread() > CAMERA_EXACT_SPREAD {
            case.problem(
                "camera-clock",
                format!(
                    "camera past the drift anchor: frame offsets vary by {:.1} ms (limit {:.1}): frames are stamped from the processing clock, not their capture times",
                    ms(post.spread()),
                    ms(CAMERA_EXACT_SPREAD)
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
            (pre, "sync-camera-mic", "before the drift anchor"),
            (post, "camera-clock", "past the drift anchor"),
        ] {
            let Some(camera_m) = part.median() else {
                continue;
            };
            let d = camera_m - mic_m;
            case.note(format!("sync camera-mic {label} {:+.1} ms", ms(d)));
            if d.abs() > CAMERA_VS_MIC {
                case.measure(class, "camera-mic-ms", (ms(d) * 10.0).round() / 10.0);
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
            case.measure(
                "sync-system-mic",
                "offset-ms",
                (ms(d) * 10.0).round() / 10.0,
            );
            case.problem(
                "sync-system-mic",
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
            // One class per pair, so a known offset of one source cannot
            // excuse another's.
            let class = if name == "mic" {
                "sync-screen-mic"
            } else {
                "sync-screen-system"
            };
            case.measure(class, "offset-ms", (ms(d) * 10.0).round() / 10.0);
            case.problem(
                class,
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
