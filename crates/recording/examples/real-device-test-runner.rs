use anyhow::{Context, bail};
use cap_project::{Platform, RecordingMeta, RecordingMetaInner, StudioRecordingMeta};
use cap_recording::{
    CameraFeed, MicrophoneFeed,
    feeds::{camera, microphone},
    screen_capture::ScreenCaptureTarget,
    studio_recording,
};
use chrono::{Local, Utc};
use clap::{Parser, Subcommand};
use kameo::Actor as _;
use scap_targets::Display;
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant},
};
use tracing_subscriber::{EnvFilter, fmt, prelude::*};

#[cfg(windows)]
fn default_output_dir() -> PathBuf {
    std::env::temp_dir().join("cap-real-device-tests")
}

#[cfg(not(windows))]
fn default_output_dir() -> PathBuf {
    PathBuf::from("/tmp/cap-real-device-tests")
}

#[derive(Parser)]
#[command(name = "real-device-test-runner")]
#[command(about = "Run end-to-end recording tests with real hardware devices")]
struct Cli {
    #[command(subcommand)]
    command: Option<Commands>,

    #[arg(long, global = true, default_value_os_t = default_output_dir())]
    output_dir: PathBuf,

    #[arg(long, global = true)]
    keep_outputs: bool,

    #[arg(long, global = true)]
    no_camera: bool,

    #[arg(long, global = true)]
    fragmented_only: bool,

    #[arg(long, global = true)]
    mp4_only: bool,

    #[arg(long, global = true, help = "Write benchmark results to BENCHMARKS.md")]
    benchmark_output: bool,

    #[arg(
        long,
        global = true,
        help = "Optional notes to include with this benchmark run"
    )]
    notes: Option<String>,

    #[arg(
        long,
        global = true,
        default_value = "30",
        help = "Screen recording frame rate (e.g., 30 or 60)"
    )]
    fps: u32,
}

#[derive(Subcommand)]
enum Commands {
    Full,
    Baseline,
    SinglePause,
    MultiplePauses,
    ListDevices,
    CheckPermissions,
}

#[derive(Clone)]
struct AvailableDevices {
    primary_display: Display,
    default_microphone: Option<String>,
    cameras: Vec<cap_camera::CameraInfo>,
}

impl AvailableDevices {
    fn discover() -> anyhow::Result<Self> {
        let primary_display = Display::primary();

        let default_microphone = MicrophoneFeed::default_device().map(|(label, _, _)| label);

        let cameras: Vec<_> = cap_camera::list_cameras().collect();

        Ok(Self {
            primary_display,
            default_microphone,
            cameras,
        })
    }

    fn print(&self) {
        println!("\nAvailable Devices:");
        let size_str = self
            .primary_display
            .physical_size()
            .map(|s| format!("{}x{}", s.width(), s.height()))
            .unwrap_or_else(|| "unknown".to_string());
        println!(
            "  Primary Display: {} ({})",
            self.primary_display.id(),
            size_str
        );

        if let Some(mic) = &self.default_microphone {
            println!("  Default Microphone: {mic}");
        } else {
            println!("  Default Microphone: None");
        }

        if self.cameras.is_empty() {
            println!("  Cameras: None");
        } else {
            println!("  Cameras:");
            for camera in &self.cameras {
                println!("    - {}", camera.display_name());
            }
        }
    }
}

#[derive(Clone)]
enum TestAction {
    Record(Duration),
    Pause(Duration),
    Resume,
}

#[derive(Clone)]
struct TestScenario {
    name: String,
    actions: Vec<TestAction>,
    expected_segments: usize,
}

impl TestScenario {
    fn baseline() -> Self {
        Self {
            name: "Baseline".to_string(),
            actions: vec![TestAction::Record(Duration::from_secs(5))],
            expected_segments: 1,
        }
    }

    fn single_pause() -> Self {
        Self {
            name: "Single Pause".to_string(),
            actions: vec![
                TestAction::Record(Duration::from_secs(3)),
                TestAction::Pause(Duration::from_secs(2)),
                TestAction::Resume,
                TestAction::Record(Duration::from_secs(3)),
            ],
            expected_segments: 2,
        }
    }

    fn multiple_pauses() -> Self {
        Self {
            name: "Multiple Pauses".to_string(),
            actions: vec![
                TestAction::Record(Duration::from_secs(2)),
                TestAction::Pause(Duration::from_secs(1)),
                TestAction::Resume,
                TestAction::Record(Duration::from_secs(2)),
                TestAction::Pause(Duration::from_secs(1)),
                TestAction::Resume,
                TestAction::Record(Duration::from_secs(2)),
            ],
            expected_segments: 3,
        }
    }

    fn total_recording_duration(&self) -> Duration {
        self.actions
            .iter()
            .filter_map(|action| match action {
                TestAction::Record(d) => Some(*d),
                _ => None,
            })
            .sum()
    }

    fn segment_durations(&self) -> Vec<Duration> {
        let mut durations = vec![];
        let mut current_segment_duration = Duration::ZERO;

        for action in &self.actions {
            match action {
                TestAction::Record(d) => {
                    current_segment_duration += *d;
                }
                TestAction::Pause(_) => {
                    if current_segment_duration > Duration::ZERO {
                        durations.push(current_segment_duration);
                        current_segment_duration = Duration::ZERO;
                    }
                }
                TestAction::Resume => {}
            }
        }

        if current_segment_duration > Duration::ZERO {
            durations.push(current_segment_duration);
        }

        durations
    }
}

#[derive(Debug, Clone, Default)]
struct SegmentTimingIssue {
    segment_index: usize,
    stream_type: String,
    start_time: f64,
}

#[derive(Debug, Clone, Default)]
struct SegmentTimingValidation {
    all_valid: bool,
    issues: Vec<SegmentTimingIssue>,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Default)]
struct StreamSyncMetrics {
    display_start: Option<f64>,
    camera_start: Option<f64>,
    mic_start: Option<f64>,
    system_audio_start: Option<f64>,
    display_camera_drift: Option<f64>,
    display_mic_drift: Option<f64>,
    camera_mic_drift: Option<f64>,
}

const SYNC_TOLERANCE_MS: f64 = 50.0;

#[derive(Debug, Clone, Default)]
struct AVSyncValidation {
    all_synced: bool,
    segments: Vec<SegmentSyncResult>,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Default)]
struct SegmentSyncResult {
    index: usize,
    metrics: StreamSyncMetrics,
    camera_mic_sync_ok: bool,
    display_camera_sync_ok: bool,
    display_mic_sync_ok: bool,
}

#[derive(Debug, Clone, Default)]
struct CameraOutputValidation {
    valid: bool,
    has_camera: bool,
    is_fragmented: bool,
    has_init_mp4: bool,
    fragment_count: usize,
    issues: Vec<String>,
}

#[derive(Debug, Clone, Default)]
struct DurationValidation {
    total_ok: bool,
    expected_total: Duration,
    actual_total: Duration,
    segment_results: Vec<SegmentDurationResult>,
}

#[derive(Debug, Clone, Default)]
struct FrameRateAnalysis {
    valid: bool,
    expected_fps: f64,
    segments: Vec<SegmentFrameRateResult>,
}

#[derive(Debug, Clone, Default)]
struct SegmentFrameRateResult {
    index: usize,
    actual_fps: f64,
    frame_count: usize,
    expected_frame_count: usize,
    dropped_frames: usize,
    avg_frame_interval_ms: f64,
    max_frame_interval_ms: f64,
    min_frame_interval_ms: f64,
    jitter_ms: f64,
    fps_ok: bool,
    jitter_ok: bool,
    dropped_ok: bool,
}

const FPS_TOLERANCE: f64 = 2.0;
const JITTER_TOLERANCE_MS: f64 = 15.0;
const MAX_DROPPED_FRAME_PERCENT: f64 = 2.0;

#[derive(Debug, Clone, Default)]
struct AudioTimingAnalysis {
    valid: bool,
    segments: Vec<SegmentAudioTimingResult>,
}

#[derive(Debug, Clone, Default)]
struct SegmentAudioTimingResult {
    index: usize,
    mic: Option<AudioStreamMetrics>,
    system_audio: Option<AudioStreamMetrics>,
    mic_video_duration_diff_ms: Option<f64>,
    system_audio_video_duration_diff_ms: Option<f64>,
    mic_duration_ok: bool,
    system_audio_duration_ok: bool,
}

#[derive(Debug, Clone, Default)]
struct AudioStreamMetrics {
    duration_secs: f64,
    sample_rate: u32,
    channels: u16,
    total_samples: u64,
    expected_samples: u64,
    sample_deficit_percent: f64,
    has_gaps: bool,
    gap_count: usize,
    total_gap_duration_ms: f64,
}

const AUDIO_VIDEO_DURATION_TOLERANCE_MS: f64 = 100.0;

#[derive(Debug, Clone, Default)]
struct SegmentDurationResult {
    index: usize,
    expected: Duration,
    actual: Duration,
    ok: bool,
}

#[derive(Debug, Clone, Default)]
struct TestReport {
    scenario: String,
    fragmented: bool,
    include_camera: bool,
    passed: bool,
    segment_count_ok: bool,
    expected_segments: usize,
    actual_segments: usize,
    segment_timing: SegmentTimingValidation,
    av_sync: AVSyncValidation,
    camera_output: CameraOutputValidation,
    duration_validation: DurationValidation,
    frame_rate: FrameRateAnalysis,
    audio_timing: AudioTimingAnalysis,
    elapsed: Duration,
    errors: Vec<String>,
}

impl TestReport {
    fn print(&self) {
        let status = if self.passed { "PASS" } else { "FAIL" };
        let format_type = if self.fragmented { "fragmented" } else { "mp4" };
        let camera_str = if self.include_camera { "+camera" } else { "" };

        println!(
            "\n[{}] {} ({}{}) ",
            status, self.scenario, format_type, camera_str
        );
        println!(
            "  Segments: {}/{} expected ({})",
            self.actual_segments,
            self.expected_segments,
            if self.segment_count_ok { "OK" } else { "FAIL" }
        );

        if self.segment_timing.all_valid {
            println!("  Start times: All segments have start_time near 0 - OK");
        } else {
            println!("  Start times: FAILED - Bug detected!");
            for issue in &self.segment_timing.issues {
                println!(
                    "    Segment {} ({}): start_time={:.2}s (expected ~0)",
                    issue.segment_index, issue.stream_type, issue.start_time
                );
            }
        }

        if self.include_camera {
            println!(
                "  A/V Sync (camera<->mic): {} (tolerance: {}ms)",
                if self.av_sync.all_synced {
                    "OK"
                } else {
                    "FAIL"
                },
                SYNC_TOLERANCE_MS
            );
            for seg in &self.av_sync.segments {
                let cam_mic_drift_str = seg
                    .metrics
                    .camera_mic_drift
                    .map(|d| format!("{:.1}ms", d * 1000.0))
                    .unwrap_or_else(|| "N/A".to_string());
                let disp_cam_drift_str = seg
                    .metrics
                    .display_camera_drift
                    .map(|d| format!("{:.1}ms", d * 1000.0))
                    .unwrap_or_else(|| "N/A".to_string());
                let disp_mic_drift_str = seg
                    .metrics
                    .display_mic_drift
                    .map(|d| format!("{:.1}ms", d * 1000.0))
                    .unwrap_or_else(|| "N/A".to_string());

                println!(
                    "    Segment {}: camera<->mic={} display<->camera={} display<->mic={}",
                    seg.index, cam_mic_drift_str, disp_cam_drift_str, disp_mic_drift_str
                );

                if !seg.camera_mic_sync_ok {
                    println!("      WARN: Camera-Mic sync exceeds tolerance!");
                }
            }

            if self.fragmented {
                println!(
                    "  Camera output: {}",
                    if self.camera_output.valid {
                        "OK"
                    } else {
                        "FAIL"
                    }
                );
                if self.camera_output.has_camera {
                    if self.camera_output.is_fragmented {
                        println!(
                            "    Fragmented: init.mp4={} fragments={}",
                            if self.camera_output.has_init_mp4 {
                                "yes"
                            } else {
                                "NO"
                            },
                            self.camera_output.fragment_count
                        );
                    } else {
                        println!("    Format: single MP4 file");
                    }
                } else {
                    println!("    No camera output found");
                }
                for issue in &self.camera_output.issues {
                    println!("    ISSUE: {issue}");
                }
            }
        }

        println!(
            "  Duration: {:.2}s/{:.2}s ({})",
            self.duration_validation.actual_total.as_secs_f64(),
            self.duration_validation.expected_total.as_secs_f64(),
            if self.duration_validation.total_ok {
                "OK"
            } else {
                "FAIL"
            }
        );

        for seg in &self.duration_validation.segment_results {
            println!(
                "    Segment {}: {:.2}s/{:.2}s ({})",
                seg.index,
                seg.actual.as_secs_f64(),
                seg.expected.as_secs_f64(),
                if seg.ok { "OK" } else { "FAIL" }
            );
        }

        println!(
            "  Frame Rate: {} (expected {:.0}fps, tolerance: ±{:.0}fps)",
            if self.frame_rate.valid { "OK" } else { "FAIL" },
            self.frame_rate.expected_fps,
            FPS_TOLERANCE
        );
        for seg in &self.frame_rate.segments {
            let drop_percent = if seg.expected_frame_count > 0 {
                (seg.dropped_frames as f64 / seg.expected_frame_count as f64) * 100.0
            } else {
                0.0
            };
            println!(
                "    Segment {}: {:.1}fps frames={} dropped={} ({:.1}%) jitter={:.1}ms interval=[{:.1}-{:.1}ms]",
                seg.index,
                seg.actual_fps,
                seg.frame_count,
                seg.dropped_frames,
                drop_percent,
                seg.jitter_ms,
                seg.min_frame_interval_ms,
                seg.max_frame_interval_ms
            );
            if !seg.fps_ok {
                println!("      WARN: FPS outside tolerance!");
            }
            if !seg.jitter_ok {
                println!("      WARN: Frame jitter exceeds {JITTER_TOLERANCE_MS}ms!");
            }
            if !seg.dropped_ok {
                println!("      WARN: Dropped frames exceed {MAX_DROPPED_FRAME_PERCENT}%!");
            }
        }

        println!(
            "  Audio Timing: {} (tolerance: ±{:.0}ms vs video)",
            if self.audio_timing.valid {
                "OK"
            } else {
                "FAIL"
            },
            AUDIO_VIDEO_DURATION_TOLERANCE_MS
        );
        for seg in &self.audio_timing.segments {
            if let Some(ref mic) = seg.mic {
                let diff_str = seg
                    .mic_video_duration_diff_ms
                    .map(|d| format!("{d:.1}ms"))
                    .unwrap_or_else(|| "N/A".to_string());
                let gap_str = if mic.has_gaps {
                    format!(
                        " gaps={} ({:.1}ms total)",
                        mic.gap_count, mic.total_gap_duration_ms
                    )
                } else {
                    String::new()
                };
                println!(
                    "    Segment {} mic: {:.2}s diff={} {}Hz {}ch{}",
                    seg.index, mic.duration_secs, diff_str, mic.sample_rate, mic.channels, gap_str
                );
                if !seg.mic_duration_ok {
                    println!("      WARN: Mic duration differs from video!");
                }
                if mic.has_gaps {
                    println!("      WARN: Audio gaps detected!");
                }
            }
            if let Some(ref sys) = seg.system_audio {
                let diff_str = seg
                    .system_audio_video_duration_diff_ms
                    .map(|d| format!("{d:.1}ms"))
                    .unwrap_or_else(|| "N/A".to_string());
                let gap_str = if sys.has_gaps {
                    format!(
                        " gaps={} ({:.1}ms total)",
                        sys.gap_count, sys.total_gap_duration_ms
                    )
                } else {
                    String::new()
                };
                println!(
                    "    Segment {} system: {:.2}s diff={} {}Hz {}ch{}",
                    seg.index, sys.duration_secs, diff_str, sys.sample_rate, sys.channels, gap_str
                );
                if !seg.system_audio_duration_ok {
                    println!("      WARN: System audio duration differs from video!");
                }
                if sys.has_gaps {
                    println!("      WARN: Audio gaps detected!");
                }
            }
        }

        if !self.errors.is_empty() {
            println!("  Errors:");
            for error in &self.errors {
                println!("    - {error}");
            }
        }

        println!("  Elapsed: {:.2}s", self.elapsed.as_secs_f64());
    }
}

const START_TIME_THRESHOLD: f64 = 0.5;
const DURATION_TOLERANCE: Duration = Duration::from_millis(1000);

fn validate_av_sync(meta: &RecordingMeta) -> AVSyncValidation {
    let mut result = AVSyncValidation {
        all_synced: true,
        segments: vec![],
    };

    let RecordingMetaInner::Studio(studio_meta) = &meta.inner else {
        return result;
    };

    if let StudioRecordingMeta::MultipleSegments { inner } = studio_meta.as_ref() {
        for (idx, segment) in inner.segments.iter().enumerate() {
            let display_start = segment.display.start_time;
            let camera_start = segment.camera.as_ref().and_then(|c| c.start_time);
            let mic_start = segment.mic.as_ref().and_then(|m| m.start_time);
            let system_audio_start = segment.system_audio.as_ref().and_then(|s| s.start_time);

            let display_camera_drift = display_start.zip(camera_start).map(|(d, c)| (d - c).abs());
            let display_mic_drift = display_start.zip(mic_start).map(|(d, m)| (d - m).abs());
            let camera_mic_drift = camera_start.zip(mic_start).map(|(c, m)| (c - m).abs());

            let metrics = StreamSyncMetrics {
                display_start,
                camera_start,
                mic_start,
                system_audio_start,
                display_camera_drift,
                display_mic_drift,
                camera_mic_drift,
            };

            let tolerance_secs = SYNC_TOLERANCE_MS / 1000.0;

            let camera_mic_sync_ok = metrics
                .camera_mic_drift
                .map(|d| d <= tolerance_secs)
                .unwrap_or(true);

            let display_camera_sync_ok = metrics
                .display_camera_drift
                .map(|d| d <= tolerance_secs)
                .unwrap_or(true);

            let display_mic_sync_ok = metrics
                .display_mic_drift
                .map(|d| d <= tolerance_secs)
                .unwrap_or(true);

            if !camera_mic_sync_ok || !display_camera_sync_ok || !display_mic_sync_ok {
                result.all_synced = false;
            }

            result.segments.push(SegmentSyncResult {
                index: idx,
                metrics,
                camera_mic_sync_ok,
                display_camera_sync_ok,
                display_mic_sync_ok,
            });
        }
    }

    result
}

fn validate_camera_output(meta: &RecordingMeta, fragmented: bool) -> CameraOutputValidation {
    let mut result = CameraOutputValidation {
        valid: true,
        ..Default::default()
    };

    let RecordingMetaInner::Studio(studio_meta) = &meta.inner else {
        return result;
    };

    if let StudioRecordingMeta::MultipleSegments { inner } = studio_meta.as_ref() {
        for (idx, segment) in inner.segments.iter().enumerate() {
            let Some(camera) = &segment.camera else {
                continue;
            };

            result.has_camera = true;
            let camera_path = meta.path(&camera.path);

            if fragmented {
                if camera_path.is_dir() {
                    result.is_fragmented = true;

                    let init_segment = camera_path.join("init.mp4");
                    result.has_init_mp4 = init_segment.exists();

                    if !result.has_init_mp4 {
                        result.valid = false;
                        result.issues.push(format!(
                            "Segment {idx}: Missing init.mp4 in camera fragmented output"
                        ));
                    }

                    if let Ok(entries) = std::fs::read_dir(&camera_path) {
                        result.fragment_count = entries
                            .filter_map(|e| e.ok())
                            .filter(|e| e.path().extension().is_some_and(|ext| ext == "m4s"))
                            .count();
                    }

                    if result.fragment_count == 0 {
                        result.valid = false;
                        result
                            .issues
                            .push(format!("Segment {idx}: No .m4s fragments in camera output"));
                    }
                } else if camera_path.is_file() {
                    result.valid = false;
                    result.issues.push(format!(
                        "Segment {idx}: Camera output is a single file, expected fragmented directory"
                    ));
                } else {
                    result.valid = false;
                    result.issues.push(format!(
                        "Segment {idx}: Camera output path does not exist: {camera_path:?}"
                    ));
                }
            }
        }
    }

    if fragmented && !result.has_camera {
        result.valid = false;
        result.issues.push("No camera segments found".to_string());
    }

    result
}

fn validate_segment_timing(meta: &RecordingMeta) -> SegmentTimingValidation {
    let mut result = SegmentTimingValidation {
        all_valid: true,
        issues: vec![],
    };

    let RecordingMetaInner::Studio(studio_meta) = &meta.inner else {
        return result;
    };

    if let StudioRecordingMeta::MultipleSegments { inner } = studio_meta.as_ref() {
        for (idx, segment) in inner.segments.iter().enumerate() {
            if let Some(start_time) = segment.display.start_time
                && start_time.abs() > START_TIME_THRESHOLD
            {
                result.all_valid = false;
                result.issues.push(SegmentTimingIssue {
                    segment_index: idx,
                    stream_type: "display".to_string(),
                    start_time,
                });
            }

            if let Some(ref mic) = segment.mic
                && let Some(start_time) = mic.start_time
                && start_time.abs() > START_TIME_THRESHOLD
            {
                result.all_valid = false;
                result.issues.push(SegmentTimingIssue {
                    segment_index: idx,
                    stream_type: "mic".to_string(),
                    start_time,
                });
            }

            if let Some(ref camera) = segment.camera
                && let Some(start_time) = camera.start_time
                && start_time.abs() > START_TIME_THRESHOLD
            {
                result.all_valid = false;
                result.issues.push(SegmentTimingIssue {
                    segment_index: idx,
                    stream_type: "camera".to_string(),
                    start_time,
                });
            }

            if let Some(ref system_audio) = segment.system_audio
                && let Some(start_time) = system_audio.start_time
                && start_time.abs() > START_TIME_THRESHOLD
            {
                result.all_valid = false;
                result.issues.push(SegmentTimingIssue {
                    segment_index: idx,
                    stream_type: "system_audio".to_string(),
                    start_time,
                });
            }
        }
    }

    result
}

fn get_segment_count(meta: &RecordingMeta) -> usize {
    match &meta.inner {
        RecordingMetaInner::Studio(studio_meta) => match studio_meta.as_ref() {
            StudioRecordingMeta::SingleSegment { .. } => 1,
            StudioRecordingMeta::MultipleSegments { inner } => inner.segments.len(),
        },
        RecordingMetaInner::Instant(_) => 1,
    }
}

async fn probe_media_duration(path: &Path) -> anyhow::Result<Duration> {
    if path.is_dir() {
        let init_segment = path.join("init.mp4");
        if !init_segment.exists() {
            bail!("Missing init.mp4 in fragmented output");
        }

        let mut fragments: Vec<PathBuf> = std::fs::read_dir(path)?
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| p.extension().is_some_and(|ext| ext == "m4s"))
            .collect();
        fragments.sort();

        if fragments.is_empty() {
            return Ok(Duration::ZERO);
        }

        let combined_path = path.join("_combined_for_probe.mp4");
        let mut combined_data = std::fs::read(&init_segment)?;
        for fragment in &fragments {
            combined_data.extend(std::fs::read(fragment)?);
        }
        std::fs::write(&combined_path, &combined_data)?;

        let result = probe_single_file_duration(&combined_path).await;
        let _ = std::fs::remove_file(&combined_path);
        result
    } else {
        probe_single_file_duration(path).await
    }
}

async fn probe_single_file_duration(path: &Path) -> anyhow::Result<Duration> {
    let input = ffmpeg::format::input(path).context("Failed to open media file")?;

    let raw_duration = input.duration();
    if raw_duration > 0 {
        let secs = raw_duration as f64 / ffmpeg::ffi::AV_TIME_BASE as f64;
        return Ok(Duration::from_secs_f64(secs));
    }

    for stream in input.streams() {
        if stream.parameters().medium() == ffmpeg::media::Type::Video {
            let time_base = stream.time_base();
            if let Some(duration) = stream.duration().checked_mul(time_base.0 as i64) {
                let secs = duration as f64 / time_base.1 as f64;
                return Ok(Duration::from_secs_f64(secs.max(0.0)));
            }
        }
    }

    Ok(Duration::ZERO)
}

fn analyze_frame_rate_for_file(
    path: &Path,
    expected_fps: f64,
    expected_duration: Duration,
) -> anyhow::Result<SegmentFrameRateResult> {
    let mut result = SegmentFrameRateResult {
        expected_frame_count: (expected_duration.as_secs_f64() * expected_fps) as usize,
        ..Default::default()
    };

    let input = ffmpeg::format::input(path).context("Failed to open video file")?;

    let video_stream = input
        .streams()
        .best(ffmpeg::media::Type::Video)
        .context("No video stream found")?;

    let stream_index = video_stream.index();
    let time_base = video_stream.time_base();
    let time_base_secs = time_base.0 as f64 / time_base.1 as f64;

    let mut frame_timestamps: Vec<f64> = Vec::new();

    let mut ictx = ffmpeg::format::input(path)?;
    for (stream, packet) in ictx.packets() {
        if stream.index() == stream_index
            && let Some(pts) = packet.pts()
        {
            let timestamp_secs = pts as f64 * time_base_secs;
            frame_timestamps.push(timestamp_secs);
        }
    }

    frame_timestamps.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));

    result.frame_count = frame_timestamps.len();

    if frame_timestamps.len() < 2 {
        return Ok(result);
    }

    let mut intervals: Vec<f64> = Vec::with_capacity(frame_timestamps.len() - 1);
    for i in 1..frame_timestamps.len() {
        let interval = frame_timestamps[i] - frame_timestamps[i - 1];
        if interval > 0.0 {
            intervals.push(interval * 1000.0);
        }
    }

    if intervals.is_empty() {
        return Ok(result);
    }

    let total_interval: f64 = intervals.iter().sum();
    result.avg_frame_interval_ms = total_interval / intervals.len() as f64;
    result.max_frame_interval_ms = intervals.iter().cloned().fold(0.0, f64::max);
    result.min_frame_interval_ms = intervals.iter().cloned().fold(f64::INFINITY, f64::min);

    let duration_secs = frame_timestamps.last().unwrap() - frame_timestamps.first().unwrap();
    if duration_secs > 0.0 {
        result.actual_fps = (frame_timestamps.len() - 1) as f64 / duration_secs;
    }

    let mean_interval = result.avg_frame_interval_ms;
    let variance: f64 = intervals
        .iter()
        .map(|i| (i - mean_interval).powi(2))
        .sum::<f64>()
        / intervals.len() as f64;
    result.jitter_ms = variance.sqrt();

    let expected_interval_ms = 1000.0 / expected_fps;
    let drop_threshold_ms = expected_interval_ms * 1.8;

    result.dropped_frames = intervals
        .iter()
        .filter(|&&interval| interval > drop_threshold_ms)
        .map(|&interval| ((interval / expected_interval_ms).round() as usize).saturating_sub(1))
        .sum();

    result.fps_ok = (result.actual_fps - expected_fps).abs() <= FPS_TOLERANCE;
    result.jitter_ok = result.jitter_ms <= JITTER_TOLERANCE_MS;

    let drop_percent = if result.expected_frame_count > 0 {
        (result.dropped_frames as f64 / result.expected_frame_count as f64) * 100.0
    } else {
        0.0
    };
    result.dropped_ok = drop_percent <= MAX_DROPPED_FRAME_PERCENT;

    Ok(result)
}

async fn analyze_frame_rate(
    meta: &RecordingMeta,
    scenario: &TestScenario,
    expected_fps: f64,
) -> FrameRateAnalysis {
    let mut result = FrameRateAnalysis {
        valid: true,
        expected_fps,
        segments: vec![],
    };

    let expected_durations = scenario.segment_durations();

    let RecordingMetaInner::Studio(studio_meta) = &meta.inner else {
        return result;
    };

    match studio_meta.as_ref() {
        StudioRecordingMeta::SingleSegment { segment } => {
            let display_path = meta.path(&segment.display.path);
            let expected_dur = expected_durations.first().copied().unwrap_or_default();

            let file_path = if display_path.is_dir() {
                let combined = display_path.join("_combined_for_fps.mp4");
                if let Ok(()) = combine_fragmented_to_file(&display_path, &combined) {
                    combined
                } else {
                    return result;
                }
            } else {
                display_path
            };

            match analyze_frame_rate_for_file(&file_path, expected_fps, expected_dur) {
                Ok(mut seg_result) => {
                    seg_result.index = 0;
                    if !seg_result.fps_ok || !seg_result.jitter_ok || !seg_result.dropped_ok {
                        result.valid = false;
                    }
                    result.segments.push(seg_result);
                }
                Err(e) => {
                    tracing::warn!("Failed to analyze frame rate for segment 0: {}", e);
                    result.valid = false;
                }
            }

            if file_path
                .file_name()
                .is_some_and(|n| n == "_combined_for_fps.mp4")
            {
                let _ = std::fs::remove_file(&file_path);
            }
        }
        StudioRecordingMeta::MultipleSegments { inner } => {
            for (idx, segment) in inner.segments.iter().enumerate() {
                let display_path = meta.path(&segment.display.path);
                let expected_dur = expected_durations.get(idx).copied().unwrap_or_default();

                let file_path = if display_path.is_dir() {
                    let combined = display_path.join("_combined_for_fps.mp4");
                    if let Ok(()) = combine_fragmented_to_file(&display_path, &combined) {
                        combined
                    } else {
                        result.valid = false;
                        continue;
                    }
                } else {
                    display_path
                };

                match analyze_frame_rate_for_file(&file_path, expected_fps, expected_dur) {
                    Ok(mut seg_result) => {
                        seg_result.index = idx;
                        if !seg_result.fps_ok || !seg_result.jitter_ok || !seg_result.dropped_ok {
                            result.valid = false;
                        }
                        result.segments.push(seg_result);
                    }
                    Err(e) => {
                        tracing::warn!("Failed to analyze frame rate for segment {}: {}", idx, e);
                        result.valid = false;
                    }
                }

                if file_path
                    .file_name()
                    .is_some_and(|n| n == "_combined_for_fps.mp4")
                {
                    let _ = std::fs::remove_file(&file_path);
                }
            }
        }
    }

    result
}

fn combine_fragmented_to_file(dir: &Path, output: &Path) -> anyhow::Result<()> {
    let init_segment = dir.join("init.mp4");
    if !init_segment.exists() {
        bail!("Missing init.mp4");
    }

    let mut fragments: Vec<PathBuf> = std::fs::read_dir(dir)?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|ext| ext == "m4s"))
        .collect();
    fragments.sort();

    let mut combined_data = std::fs::read(&init_segment)?;
    for fragment in &fragments {
        combined_data.extend(std::fs::read(fragment)?);
    }
    std::fs::write(output, combined_data)?;

    Ok(())
}

fn analyze_audio_stream(
    path: &Path,
    video_duration_secs: f64,
) -> anyhow::Result<AudioStreamMetrics> {
    let mut metrics = AudioStreamMetrics::default();

    let input = ffmpeg::format::input(path).context("Failed to open audio file")?;

    let audio_stream = input
        .streams()
        .best(ffmpeg::media::Type::Audio)
        .context("No audio stream found")?;

    let codec_params = audio_stream.parameters();
    metrics.sample_rate = unsafe { (*codec_params.as_ptr()).sample_rate as u32 };
    metrics.channels = unsafe { (*codec_params.as_ptr()).ch_layout.nb_channels as u16 };

    let time_base = audio_stream.time_base();
    let time_base_secs = time_base.0 as f64 / time_base.1 as f64;
    let stream_index = audio_stream.index();

    let raw_duration = input.duration();
    if raw_duration > 0 {
        metrics.duration_secs = raw_duration as f64 / ffmpeg::ffi::AV_TIME_BASE as f64;
    } else if let Some(stream_duration) = audio_stream.duration().checked_mul(time_base.0 as i64) {
        metrics.duration_secs = stream_duration as f64 / time_base.1 as f64;
    }

    if metrics.sample_rate > 0 {
        metrics.expected_samples = (video_duration_secs * metrics.sample_rate as f64) as u64;
    }

    let mut packet_timestamps: Vec<(f64, f64)> = Vec::new();
    let mut ictx = ffmpeg::format::input(path)?;

    for (stream, packet) in ictx.packets() {
        if stream.index() == stream_index
            && let Some(pts) = packet.pts()
        {
            let start_secs = pts as f64 * time_base_secs;
            let dur_secs = packet.duration() as f64 * time_base_secs;
            packet_timestamps.push((start_secs, dur_secs));
        }
    }

    packet_timestamps.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));

    let gap_threshold_secs = 0.05;
    for i in 1..packet_timestamps.len() {
        let prev_end = packet_timestamps[i - 1].0 + packet_timestamps[i - 1].1;
        let curr_start = packet_timestamps[i].0;
        let gap = curr_start - prev_end;

        if gap > gap_threshold_secs {
            metrics.has_gaps = true;
            metrics.gap_count += 1;
            metrics.total_gap_duration_ms += gap * 1000.0;
        }
    }

    if metrics.sample_rate > 0 && metrics.duration_secs > 0.0 {
        metrics.total_samples = (metrics.duration_secs * metrics.sample_rate as f64) as u64;

        if metrics.expected_samples > 0 {
            let deficit = metrics
                .expected_samples
                .saturating_sub(metrics.total_samples);
            metrics.sample_deficit_percent =
                (deficit as f64 / metrics.expected_samples as f64) * 100.0;
        }
    }

    Ok(metrics)
}

async fn analyze_audio_timing(
    meta: &RecordingMeta,
    scenario: &TestScenario,
) -> AudioTimingAnalysis {
    let mut result = AudioTimingAnalysis {
        valid: true,
        segments: vec![],
    };

    let expected_durations = scenario.segment_durations();

    let RecordingMetaInner::Studio(studio_meta) = &meta.inner else {
        return result;
    };

    match studio_meta.as_ref() {
        StudioRecordingMeta::SingleSegment { segment } => {
            let mut seg_result = SegmentAudioTimingResult {
                index: 0,
                mic_duration_ok: true,
                system_audio_duration_ok: true,
                ..Default::default()
            };

            let display_path = meta.path(&segment.display.path);
            let video_duration_secs = probe_media_duration(&display_path)
                .await
                .map(|d| d.as_secs_f64())
                .unwrap_or_else(|_| {
                    expected_durations
                        .first()
                        .copied()
                        .unwrap_or_default()
                        .as_secs_f64()
                });

            if let Some(ref audio) = segment.audio {
                let audio_path = meta.path(&audio.path);
                match analyze_audio_stream(&audio_path, video_duration_secs) {
                    Ok(metrics) => {
                        let diff_ms = (metrics.duration_secs - video_duration_secs).abs() * 1000.0;
                        seg_result.mic_video_duration_diff_ms = Some(diff_ms);
                        seg_result.mic_duration_ok = diff_ms <= AUDIO_VIDEO_DURATION_TOLERANCE_MS;

                        if !seg_result.mic_duration_ok || metrics.has_gaps {
                            result.valid = false;
                        }
                        seg_result.mic = Some(metrics);
                    }
                    Err(e) => {
                        tracing::warn!("Failed to analyze audio: {}", e);
                    }
                }
            }

            result.segments.push(seg_result);
        }
        StudioRecordingMeta::MultipleSegments { inner } => {
            for (idx, segment) in inner.segments.iter().enumerate() {
                let mut seg_result = SegmentAudioTimingResult {
                    index: idx,
                    mic_duration_ok: true,
                    system_audio_duration_ok: true,
                    ..Default::default()
                };

                let display_path = meta.path(&segment.display.path);
                let video_duration_secs = probe_media_duration(&display_path)
                    .await
                    .map(|d| d.as_secs_f64())
                    .unwrap_or_else(|_| {
                        expected_durations
                            .get(idx)
                            .copied()
                            .unwrap_or_default()
                            .as_secs_f64()
                    });

                if let Some(ref mic) = segment.mic {
                    let mic_path = meta.path(&mic.path);
                    match analyze_audio_stream(&mic_path, video_duration_secs) {
                        Ok(metrics) => {
                            let diff_ms =
                                (metrics.duration_secs - video_duration_secs).abs() * 1000.0;
                            seg_result.mic_video_duration_diff_ms = Some(diff_ms);
                            seg_result.mic_duration_ok =
                                diff_ms <= AUDIO_VIDEO_DURATION_TOLERANCE_MS;

                            if !seg_result.mic_duration_ok || metrics.has_gaps {
                                result.valid = false;
                            }
                            seg_result.mic = Some(metrics);
                        }
                        Err(e) => {
                            tracing::warn!(
                                "Failed to analyze mic audio for segment {}: {}",
                                idx,
                                e
                            );
                        }
                    }
                }

                if let Some(ref sys_audio) = segment.system_audio {
                    let sys_path = meta.path(&sys_audio.path);
                    match analyze_audio_stream(&sys_path, video_duration_secs) {
                        Ok(metrics) => {
                            let diff_ms =
                                (metrics.duration_secs - video_duration_secs).abs() * 1000.0;
                            seg_result.system_audio_video_duration_diff_ms = Some(diff_ms);
                            seg_result.system_audio_duration_ok =
                                diff_ms <= AUDIO_VIDEO_DURATION_TOLERANCE_MS;

                            if !seg_result.system_audio_duration_ok || metrics.has_gaps {
                                result.valid = false;
                            }
                            seg_result.system_audio = Some(metrics);
                        }
                        Err(e) => {
                            tracing::warn!(
                                "Failed to analyze system audio for segment {}: {}",
                                idx,
                                e
                            );
                        }
                    }
                }

                result.segments.push(seg_result);
            }
        }
    }

    result
}

async fn validate_duration(
    meta: &RecordingMeta,
    scenario: &TestScenario,
) -> anyhow::Result<DurationValidation> {
    let mut result = DurationValidation {
        expected_total: scenario.total_recording_duration(),
        ..Default::default()
    };

    let expected_durations = scenario.segment_durations();

    match &meta.inner {
        RecordingMetaInner::Studio(studio_meta) => match studio_meta.as_ref() {
            StudioRecordingMeta::SingleSegment { segment } => {
                let display_path = meta.path(&segment.display.path);
                let actual = probe_media_duration(&display_path)
                    .await
                    .unwrap_or_default();
                result.actual_total = actual;

                let expected = expected_durations.first().copied().unwrap_or_default();
                let ok = actual.abs_diff(expected) <= DURATION_TOLERANCE;
                result.segment_results.push(SegmentDurationResult {
                    index: 0,
                    expected,
                    actual,
                    ok,
                });
            }
            StudioRecordingMeta::MultipleSegments { inner } => {
                for (idx, segment) in inner.segments.iter().enumerate() {
                    let display_path = meta.path(&segment.display.path);
                    let actual = probe_media_duration(&display_path)
                        .await
                        .unwrap_or_default();
                    result.actual_total += actual;

                    let expected = expected_durations.get(idx).copied().unwrap_or_default();
                    let ok = actual.abs_diff(expected) <= DURATION_TOLERANCE;
                    result.segment_results.push(SegmentDurationResult {
                        index: idx,
                        expected,
                        actual,
                        ok,
                    });
                }
            }
        },
        RecordingMetaInner::Instant(_) => {}
    }

    result.total_ok = result.actual_total.abs_diff(result.expected_total) <= DURATION_TOLERANCE;

    Ok(result)
}

async fn execute_recording(
    scenario: &TestScenario,
    output_dir: &Path,
    devices: &AvailableDevices,
    fragmented: bool,
    include_camera: bool,
    screen_fps: u32,
) -> anyhow::Result<PathBuf> {
    let recording_dir = output_dir.join(format!(
        "{}_{}",
        scenario.name.to_lowercase().replace(' ', "_"),
        if fragmented { "fragmented" } else { "mp4" }
    ));

    if recording_dir.exists() {
        std::fs::remove_dir_all(&recording_dir)?;
    }
    std::fs::create_dir_all(&recording_dir)?;

    let (error_tx, _error_rx) = flume::bounded(1);

    let mic_lock = if let Some(mic_label) = &devices.default_microphone {
        let mic_feed = MicrophoneFeed::spawn(MicrophoneFeed::new(error_tx));
        mic_feed
            .ask(microphone::SetInput {
                label: mic_label.clone(),
            })
            .await?
            .await?;

        tokio::time::sleep(Duration::from_millis(100)).await;
        Some(Arc::new(mic_feed.ask(microphone::Lock).await?))
    } else {
        None
    };

    let camera_lock = if include_camera && !devices.cameras.is_empty() {
        let camera_info = &devices.cameras[0];
        let camera_feed = CameraFeed::spawn(CameraFeed::default());
        camera_feed
            .ask(camera::SetInput {
                id: camera::DeviceOrModelID::from_info(camera_info),
            })
            .await?
            .await?;

        tokio::time::sleep(Duration::from_millis(100)).await;
        Some(Arc::new(camera_feed.ask(camera::Lock).await?))
    } else {
        None
    };

    #[cfg(target_os = "macos")]
    let shareable_content = cap_recording::SendableShareableContent::from(
        cidre::sc::ShareableContent::current().await?,
    );

    let mut builder = studio_recording::Actor::builder(
        recording_dir.clone(),
        ScreenCaptureTarget::Display {
            id: devices.primary_display.id(),
        },
    )
    .with_system_audio(true)
    .with_fragmented(fragmented)
    .with_max_fps(screen_fps);

    if let Some(mic) = mic_lock {
        builder = builder.with_mic_feed(mic);
    }

    if let Some(camera) = camera_lock {
        builder = builder.with_camera_feed(camera);
    }

    let handle = builder
        .build(
            #[cfg(target_os = "macos")]
            Some(shareable_content),
        )
        .await?;

    for action in &scenario.actions {
        match action {
            TestAction::Record(duration) => {
                tokio::time::sleep(*duration).await;
            }
            TestAction::Pause(duration) => {
                handle.pause().await?;
                tokio::time::sleep(*duration).await;
            }
            TestAction::Resume => {
                handle.resume().await?;
            }
        }
    }

    let completed = handle.stop().await?;

    let pretty_name = Local::now().format("Cap %Y-%m-%d at %H.%M.%S").to_string();
    let meta = RecordingMeta {
        platform: Some(Platform::default()),
        project_path: recording_dir.clone(),
        pretty_name,
        sharing: None,
        inner: RecordingMetaInner::Studio(Box::new(completed.meta)),
        upload: None,
    };
    meta.save_for_project()
        .map_err(|e| anyhow::anyhow!("Failed to save recording metadata: {:?}", e))?;

    Ok(recording_dir)
}

async fn run_test(
    scenario: &TestScenario,
    output_dir: &Path,
    devices: &AvailableDevices,
    fragmented: bool,
    include_camera: bool,
    screen_fps: u32,
) -> TestReport {
    let start = Instant::now();

    let mut report = TestReport {
        scenario: scenario.name.clone(),
        fragmented,
        include_camera,
        expected_segments: scenario.expected_segments,
        ..Default::default()
    };

    let recording_result = execute_recording(
        scenario,
        output_dir,
        devices,
        fragmented,
        include_camera,
        screen_fps,
    )
    .await;

    let recording_dir = match recording_result {
        Ok(dir) => dir,
        Err(e) => {
            report.errors.push(format!("Recording failed: {e}"));
            report.elapsed = start.elapsed();
            return report;
        }
    };

    let meta = match RecordingMeta::load_for_project(&recording_dir) {
        Ok(m) => m,
        Err(e) => {
            report
                .errors
                .push(format!("Failed to load recording metadata: {e}"));
            report.elapsed = start.elapsed();
            return report;
        }
    };

    report.actual_segments = get_segment_count(&meta);
    report.segment_count_ok = report.actual_segments == report.expected_segments;

    report.segment_timing = validate_segment_timing(&meta);

    if include_camera {
        report.av_sync = validate_av_sync(&meta);

        if fragmented {
            report.camera_output = validate_camera_output(&meta, fragmented);
        }
    }

    match validate_duration(&meta, scenario).await {
        Ok(duration_validation) => {
            report.duration_validation = duration_validation;
        }
        Err(e) => {
            report
                .errors
                .push(format!("Duration validation failed: {e}"));
        }
    }

    let expected_fps = screen_fps as f64;
    report.frame_rate = analyze_frame_rate(&meta, scenario, expected_fps).await;

    report.audio_timing = analyze_audio_timing(&meta, scenario).await;

    let av_sync_ok = !include_camera || report.av_sync.all_synced;
    let camera_output_ok = !include_camera || !fragmented || report.camera_output.valid;

    report.passed = report.segment_count_ok
        && report.segment_timing.all_valid
        && report.duration_validation.total_ok
        && report.frame_rate.valid
        && report.audio_timing.valid
        && av_sync_ok
        && camera_output_ok
        && report.errors.is_empty();

    report.elapsed = start.elapsed();
    report
}

#[cfg(target_os = "macos")]
async fn check_permissions() -> anyhow::Result<()> {
    println!("\nChecking macOS permissions...\n");

    match cidre::sc::ShareableContent::current().await {
        Ok(_) => println!("  Screen Recording: GRANTED"),
        Err(_) => {
            println!("  Screen Recording: DENIED");
            println!("\n  Please grant Screen Recording permission in:");
            println!("  System Preferences > Security & Privacy > Privacy > Screen Recording");
        }
    }

    if MicrophoneFeed::default_device().is_some() {
        println!("  Microphone: AVAILABLE (permission will be requested on first use)");
    } else {
        println!("  Microphone: NO DEVICE FOUND");
    }

    if cap_camera::list_cameras().next().is_some() {
        println!("  Camera: AVAILABLE (permission will be requested on first use)");
    } else {
        println!("  Camera: NO DEVICE FOUND");
    }

    println!();
    Ok(())
}

#[cfg(windows)]
async fn check_permissions() -> anyhow::Result<()> {
    println!("\nChecking Windows device availability...\n");

    println!("  Screen Recording: Windows does not require explicit permission");

    if MicrophoneFeed::default_device().is_some() {
        println!("  Microphone: AVAILABLE");
    } else {
        println!("  Microphone: NO DEVICE FOUND");
    }

    if cap_camera::list_cameras().next().is_some() {
        println!("  Camera: AVAILABLE");
    } else {
        println!("  Camera: NO DEVICE FOUND");
    }

    println!();
    Ok(())
}

#[cfg(target_os = "linux")]
async fn check_permissions() -> anyhow::Result<()> {
    println!("\nChecking Linux device availability...\n");

    let display = std::env::var("DISPLAY").unwrap_or_default();
    if display.is_empty() {
        println!("  Screen Recording: NO DISPLAY (set $DISPLAY)");
    } else {
        println!("  Screen Recording: AVAILABLE (X11 display: {display})");
    }

    if MicrophoneFeed::default_device().is_some() {
        println!("  Microphone: AVAILABLE");
    } else {
        println!("  Microphone: NO DEVICE FOUND");
    }

    if cap_camera::list_cameras().next().is_some() {
        println!("  Camera: AVAILABLE");
    } else {
        println!("  Camera: NO DEVICE FOUND");
    }

    println!();
    Ok(())
}

fn print_summary(reports: &[TestReport]) {
    println!("\n{}", "=".repeat(70));
    println!("CAP REAL-DEVICE RECORDING TEST RESULTS");
    println!("{}", "=".repeat(70));

    for report in reports {
        report.print();
    }

    let passed = reports.iter().filter(|r| r.passed).count();
    let total = reports.len();

    println!("\n{}", "=".repeat(70));
    println!("SUMMARY: {passed}/{total} tests passed");

    if passed < total {
        println!("\nFailed tests:");
        for report in reports.iter().filter(|r| !r.passed) {
            let format_type = if report.fragmented {
                "fragmented"
            } else {
                "mp4"
            };
            let camera_str = if report.include_camera { "+camera" } else { "" };
            print!("  - {} ({}{})", report.scenario, format_type, camera_str);

            if !report.segment_timing.all_valid {
                print!(" [SEGMENT TIMING BUG]");
            }
            if !report.segment_count_ok {
                print!(" [SEGMENT COUNT]");
            }
            if !report.duration_validation.total_ok {
                print!(" [DURATION]");
            }
            if !report.frame_rate.valid {
                print!(" [FRAME RATE]");
            }
            if !report.audio_timing.valid {
                print!(" [AUDIO TIMING]");
            }
            if report.include_camera && !report.av_sync.all_synced {
                print!(" [A/V SYNC]");
            }
            if report.include_camera && report.fragmented && !report.camera_output.valid {
                print!(" [CAMERA OUTPUT]");
            }
            if !report.errors.is_empty() {
                print!(" [ERRORS]");
            }
            println!();
        }
    }
}

#[derive(Debug, Clone)]
struct SystemInfo {
    os: String,
    os_version: String,
    arch: String,
    cpu: String,
    primary_display_resolution: String,
    default_microphone: Option<String>,
    camera: Option<String>,
    rust_version: String,
}

impl SystemInfo {
    fn collect(devices: &AvailableDevices) -> Self {
        let os = std::env::consts::OS.to_string();
        let arch = std::env::consts::ARCH.to_string();

        let os_version = get_os_version();
        let cpu = get_cpu_info();

        let primary_display_resolution = devices
            .primary_display
            .physical_size()
            .map(|s| format!("{}x{}", s.width(), s.height()))
            .unwrap_or_else(|| "unknown".to_string());

        let default_microphone = devices.default_microphone.clone();
        let camera = devices
            .cameras
            .first()
            .map(|c| c.display_name().to_string());

        let rust_version = env!("CARGO_PKG_RUST_VERSION").to_string();

        Self {
            os,
            os_version,
            arch,
            cpu,
            primary_display_resolution,
            default_microphone,
            camera,
            rust_version,
        }
    }

    fn to_markdown(&self) -> String {
        let mut md = String::new();
        md.push_str("| Property | Value |\n");
        md.push_str("|----------|-------|\n");
        md.push_str(&format!("| OS | {} {} |\n", self.os, self.os_version));
        md.push_str(&format!("| Architecture | {} |\n", self.arch));
        md.push_str(&format!("| CPU | {} |\n", self.cpu));
        md.push_str(&format!(
            "| Display | {} |\n",
            self.primary_display_resolution
        ));
        md.push_str(&format!(
            "| Microphone | {} |\n",
            self.default_microphone.as_deref().unwrap_or("None")
        ));
        md.push_str(&format!(
            "| Camera | {} |\n",
            self.camera.as_deref().unwrap_or("None")
        ));
        md.push_str(&format!("| Rust Version | {} |\n", self.rust_version));
        md
    }
}

fn get_os_version() -> String {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("sw_vers")
            .arg("-productVersion")
            .output()
            .ok()
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .map(|s| s.trim().to_string())
            .unwrap_or_else(|| "unknown".to_string())
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/C", "ver"])
            .output()
            .ok()
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .map(|s| s.trim().to_string())
            .unwrap_or_else(|| "unknown".to_string())
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        "unknown".to_string()
    }
}

fn get_cpu_info() -> String {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("sysctl")
            .arg("-n")
            .arg("machdep.cpu.brand_string")
            .output()
            .ok()
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .map(|s| s.trim().to_string())
            .unwrap_or_else(|| "unknown".to_string())
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("wmic")
            .args(["cpu", "get", "name"])
            .output()
            .ok()
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .and_then(|s| s.lines().nth(1).map(|l| l.trim().to_string()))
            .unwrap_or_else(|| "unknown".to_string())
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        "unknown".to_string()
    }
}

fn get_failure_tags(report: &TestReport) -> Vec<&'static str> {
    let mut tags = vec![];

    if !report.segment_timing.all_valid {
        tags.push("SEGMENT_TIMING");
    }
    if !report.segment_count_ok {
        tags.push("SEGMENT_COUNT");
    }
    if !report.duration_validation.total_ok {
        tags.push("DURATION");
    }
    if !report.frame_rate.valid {
        tags.push("FRAME_RATE");
    }
    if !report.audio_timing.valid {
        tags.push("AUDIO_TIMING");
    }
    if report.include_camera && !report.av_sync.all_synced {
        tags.push("AV_SYNC");
    }
    if report.include_camera && report.fragmented && !report.camera_output.valid {
        tags.push("CAMERA_OUTPUT");
    }
    if !report.errors.is_empty() {
        tags.push("ERRORS");
    }

    tags
}

fn report_to_markdown(report: &TestReport) -> String {
    let mut md = String::new();

    let status = if report.passed {
        "✅ PASS"
    } else {
        "❌ FAIL"
    };
    let format_type = if report.fragmented {
        "fragmented"
    } else {
        "mp4"
    };
    let camera_str = if report.include_camera { "+camera" } else { "" };

    md.push_str(&format!(
        "#### {} {} ({}{})\n\n",
        status, report.scenario, format_type, camera_str
    ));

    if !report.passed {
        let tags = get_failure_tags(report);
        if !tags.is_empty() {
            md.push_str(&format!("**Failure Tags:** `{}`\n\n", tags.join("`, `")));
        }
    }

    md.push_str("| Metric | Result | Details |\n");
    md.push_str("|--------|--------|--------|\n");

    md.push_str(&format!(
        "| Segments | {} | {}/{} expected |\n",
        if report.segment_count_ok {
            "✅"
        } else {
            "❌"
        },
        report.actual_segments,
        report.expected_segments
    ));

    md.push_str(&format!(
        "| Start Times | {} | {} |\n",
        if report.segment_timing.all_valid {
            "✅"
        } else {
            "❌"
        },
        if report.segment_timing.all_valid {
            "All segments near 0"
        } else {
            "Bug detected"
        }
    ));

    if report.include_camera {
        md.push_str(&format!(
            "| A/V Sync | {} | tolerance: {}ms |\n",
            if report.av_sync.all_synced {
                "✅"
            } else {
                "❌"
            },
            SYNC_TOLERANCE_MS
        ));

        for seg in &report.av_sync.segments {
            let cam_mic_drift_str = seg
                .metrics
                .camera_mic_drift
                .map(|d| format!("{:.1}ms", d * 1000.0))
                .unwrap_or_else(|| "N/A".to_string());
            let disp_cam_drift_str = seg
                .metrics
                .display_camera_drift
                .map(|d| format!("{:.1}ms", d * 1000.0))
                .unwrap_or_else(|| "N/A".to_string());
            let disp_mic_drift_str = seg
                .metrics
                .display_mic_drift
                .map(|d| format!("{:.1}ms", d * 1000.0))
                .unwrap_or_else(|| "N/A".to_string());

            md.push_str(&format!(
                "| ↳ Seg {} Sync | {} | cam↔mic={} disp↔cam={} disp↔mic={} |\n",
                seg.index,
                if seg.camera_mic_sync_ok { "✅" } else { "❌" },
                cam_mic_drift_str,
                disp_cam_drift_str,
                disp_mic_drift_str
            ));
        }
    }

    md.push_str(&format!(
        "| Duration | {} | {:.2}s/{:.2}s |\n",
        if report.duration_validation.total_ok {
            "✅"
        } else {
            "❌"
        },
        report.duration_validation.actual_total.as_secs_f64(),
        report.duration_validation.expected_total.as_secs_f64()
    ));

    md.push_str(&format!(
        "| Frame Rate | {} | expected {:.0}fps ±{:.0} |\n",
        if report.frame_rate.valid {
            "✅"
        } else {
            "❌"
        },
        report.frame_rate.expected_fps,
        FPS_TOLERANCE
    ));

    for seg in &report.frame_rate.segments {
        let drop_percent = if seg.expected_frame_count > 0 {
            (seg.dropped_frames as f64 / seg.expected_frame_count as f64) * 100.0
        } else {
            0.0
        };

        let seg_status = if seg.fps_ok && seg.jitter_ok && seg.dropped_ok {
            "✅"
        } else {
            "❌"
        };

        md.push_str(&format!(
            "| ↳ Seg {} FPS | {} | {:.1}fps frames={} dropped={} ({:.1}%) jitter={:.1}ms |\n",
            seg.index,
            seg_status,
            seg.actual_fps,
            seg.frame_count,
            seg.dropped_frames,
            drop_percent,
            seg.jitter_ms
        ));

        if !seg.fps_ok {
            md.push_str(&format!("| | ⚠️ | FPS outside tolerance |\n"));
        }
        if !seg.jitter_ok {
            md.push_str(&format!(
                "| | ⚠️ | Jitter exceeds {}ms |\n",
                JITTER_TOLERANCE_MS
            ));
        }
        if !seg.dropped_ok {
            md.push_str(&format!(
                "| | ⚠️ | Dropped frames exceed {}% |\n",
                MAX_DROPPED_FRAME_PERCENT
            ));
        }
    }

    md.push_str(&format!(
        "| Audio Timing | {} | tolerance: ±{:.0}ms vs video |\n",
        if report.audio_timing.valid {
            "✅"
        } else {
            "❌"
        },
        AUDIO_VIDEO_DURATION_TOLERANCE_MS
    ));

    for seg in &report.audio_timing.segments {
        if let Some(ref mic) = seg.mic {
            let diff_str = seg
                .mic_video_duration_diff_ms
                .map(|d| format!("{d:.1}ms"))
                .unwrap_or_else(|| "N/A".to_string());

            md.push_str(&format!(
                "| ↳ Seg {} Mic | {} | {:.2}s diff={} {}Hz {}ch |\n",
                seg.index,
                if seg.mic_duration_ok { "✅" } else { "❌" },
                mic.duration_secs,
                diff_str,
                mic.sample_rate,
                mic.channels
            ));

            if mic.has_gaps {
                md.push_str(&format!(
                    "| | ⚠️ | {} audio gaps ({:.1}ms total) |\n",
                    mic.gap_count, mic.total_gap_duration_ms
                ));
            }
        }

        if let Some(ref sys) = seg.system_audio {
            let diff_str = seg
                .system_audio_video_duration_diff_ms
                .map(|d| format!("{d:.1}ms"))
                .unwrap_or_else(|| "N/A".to_string());

            md.push_str(&format!(
                "| ↳ Seg {} System | {} | {:.2}s diff={} {}Hz {}ch |\n",
                seg.index,
                if seg.system_audio_duration_ok {
                    "✅"
                } else {
                    "❌"
                },
                sys.duration_secs,
                diff_str,
                sys.sample_rate,
                sys.channels
            ));

            if sys.has_gaps {
                md.push_str(&format!(
                    "| | ⚠️ | {} audio gaps ({:.1}ms total) |\n",
                    sys.gap_count, sys.total_gap_duration_ms
                ));
            }
        }
    }

    if !report.errors.is_empty() {
        md.push_str("\n**Errors:**\n");
        for error in &report.errors {
            md.push_str(&format!("- {error}\n"));
        }
    }

    md.push_str(&format!(
        "\n**Elapsed:** {:.2}s\n\n",
        report.elapsed.as_secs_f64()
    ));

    md
}

fn generate_benchmark_markdown(
    reports: &[TestReport],
    devices: &AvailableDevices,
    notes: Option<&str>,
    command: &str,
) -> String {
    let mut md = String::new();

    let timestamp = Utc::now().format("%Y-%m-%d %H:%M:%S UTC").to_string();
    let local_timestamp = Local::now().format("%Y-%m-%d %H:%M:%S").to_string();

    md.push_str(&format!("### Benchmark Run: {}\n\n", timestamp));
    md.push_str(&format!("*Local time: {}*\n\n", local_timestamp));

    let passed = reports.iter().filter(|r| r.passed).count();
    let total = reports.len();
    let overall_status = if passed == total {
        "✅ ALL PASS"
    } else {
        "❌ FAILURES"
    };

    md.push_str(&format!(
        "**Overall Result:** {} ({}/{})\n\n",
        overall_status, passed, total
    ));

    if let Some(notes_text) = notes {
        md.push_str(&format!("**Notes:** {}\n\n", notes_text));
    }

    md.push_str(&format!("**Command:** `{}`\n\n", command));

    md.push_str("<details>\n<summary>System Information</summary>\n\n");
    let sys_info = SystemInfo::collect(devices);
    md.push_str(&sys_info.to_markdown());
    md.push_str("\n</details>\n\n");

    if passed < total {
        md.push_str("**Failed Tests:**\n");
        for report in reports.iter().filter(|r| !r.passed) {
            let format_type = if report.fragmented {
                "fragmented"
            } else {
                "mp4"
            };
            let camera_str = if report.include_camera { "+camera" } else { "" };
            let tags = get_failure_tags(report);
            md.push_str(&format!(
                "- {} ({}{}) — `{}`\n",
                report.scenario,
                format_type,
                camera_str,
                tags.join("`, `")
            ));
        }
        md.push_str("\n");
    }

    md.push_str("<details>\n<summary>Detailed Results</summary>\n\n");

    for report in reports {
        md.push_str(&report_to_markdown(report));
        md.push_str("---\n\n");
    }

    md.push_str("</details>\n\n");

    md
}

fn write_benchmark_to_file(benchmark_md: &str) -> anyhow::Result<()> {
    let benchmark_file = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("BENCHMARKS.md");

    if !benchmark_file.exists() {
        bail!(
            "BENCHMARKS.md not found at {:?}. Please ensure the file exists.",
            benchmark_file
        );
    }

    let content = fs::read_to_string(&benchmark_file)?;

    let marker_start = "<!-- BENCHMARK_RESULTS_START -->";
    let marker_end = "<!-- BENCHMARK_RESULTS_END -->";

    let Some(start_idx) = content.find(marker_start) else {
        bail!("Could not find BENCHMARK_RESULTS_START marker in BENCHMARKS.md");
    };

    let Some(end_idx) = content.find(marker_end) else {
        bail!("Could not find BENCHMARK_RESULTS_END marker in BENCHMARKS.md");
    };

    let insert_pos = start_idx + marker_start.len();

    let mut new_content = String::new();
    new_content.push_str(&content[..insert_pos]);
    new_content.push_str("\n\n");
    new_content.push_str(benchmark_md);
    new_content.push_str(&content[end_idx..]);

    let mut file = fs::File::create(&benchmark_file)?;
    file.write_all(new_content.as_bytes())?;

    println!(
        "\n✅ Benchmark results written to: {}",
        benchmark_file.display()
    );

    Ok(())
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    #[cfg(windows)]
    {
        use windows::Win32::UI::HiDpi::{PROCESS_PER_MONITOR_DPI_AWARE, SetProcessDpiAwareness};
        unsafe { SetProcessDpiAwareness(PROCESS_PER_MONITOR_DPI_AWARE).ok() };
    }

    tracing_subscriber::registry()
        .with(fmt::layer())
        .with(EnvFilter::from_default_env().add_directive(tracing::Level::INFO.into()))
        .init();

    let cli = Cli::parse();

    match cli.command {
        Some(Commands::ListDevices) => {
            let devices = AvailableDevices::discover()?;
            devices.print();
            return Ok(());
        }
        Some(Commands::CheckPermissions) => {
            return check_permissions().await;
        }
        _ => {}
    }

    let devices = AvailableDevices::discover()?;

    #[cfg(target_os = "macos")]
    if cidre::sc::ShareableContent::current().await.is_err() {
        bail!(
            "Screen Recording permission not granted. Run with 'check-permissions' to see details."
        );
    }

    let scenarios: Vec<TestScenario> = match cli.command {
        Some(Commands::Baseline) => vec![TestScenario::baseline()],
        Some(Commands::SinglePause) => vec![TestScenario::single_pause()],
        Some(Commands::MultiplePauses) => vec![TestScenario::multiple_pauses()],
        Some(Commands::Full) | None => vec![
            TestScenario::baseline(),
            TestScenario::single_pause(),
            TestScenario::multiple_pauses(),
        ],
        _ => unreachable!(),
    };

    let test_fragmented = !cli.mp4_only;
    let test_mp4 = !cli.fragmented_only;

    let include_camera = !cli.no_camera && !devices.cameras.is_empty();

    if cli.output_dir.exists()
        && let Err(e) = std::fs::remove_dir_all(&cli.output_dir)
    {
        tracing::warn!("Failed to clean output directory: {}", e);
    }
    std::fs::create_dir_all(&cli.output_dir)?;

    println!("\nCap Real-Device Recording Test Runner");
    println!("{}", "=".repeat(40));
    devices.print();
    println!("\nRunning {} scenario(s)...", scenarios.len());
    if test_mp4 && test_fragmented {
        println!("Testing both MP4 and fragmented M4S output formats");
    } else if test_mp4 {
        println!("Testing MP4 output format only");
    } else {
        println!("Testing fragmented M4S output format only");
    }
    println!("Screen FPS: {} (use --fps to change)", cli.fps);
    if include_camera {
        println!("Camera: ENABLED (use --no-camera to disable)");
        if devices.default_microphone.is_some() {
            println!("  Testing A/V sync between camera and microphone");
            println!("  Sync tolerance: {SYNC_TOLERANCE_MS}ms");
        } else {
            println!("  WARNING: No microphone available - A/V sync validation limited");
        }
    } else if cli.no_camera {
        println!("Camera: DISABLED (--no-camera flag)");
    } else {
        println!("Camera: SKIPPED (no camera available)");
    }
    println!();

    let mut reports = vec![];

    for scenario in &scenarios {
        if test_mp4 {
            let camera_str = if include_camera { "+camera" } else { "" };
            println!("Running: {} (mp4{})...", scenario.name, camera_str);
            let report = run_test(
                scenario,
                &cli.output_dir,
                &devices,
                false,
                include_camera,
                cli.fps,
            )
            .await;
            reports.push(report);
        }

        if test_fragmented {
            let camera_str = if include_camera { "+camera" } else { "" };
            println!("Running: {} (fragmented{})...", scenario.name, camera_str);
            let report = run_test(
                scenario,
                &cli.output_dir,
                &devices,
                true,
                include_camera,
                cli.fps,
            )
            .await;
            reports.push(report);
        }
    }

    print_summary(&reports);

    if cli.benchmark_output {
        let command = format!(
            "cargo run -p cap-recording --example real-device-test-runner -- {} {}{}{}{}--fps {}",
            match cli.command {
                Some(Commands::Baseline) => "baseline",
                Some(Commands::SinglePause) => "single-pause",
                Some(Commands::MultiplePauses) => "multiple-pauses",
                Some(Commands::Full) | None => "full",
                _ => "unknown",
            },
            if cli.keep_outputs {
                "--keep-outputs "
            } else {
                ""
            },
            if cli.no_camera { "--no-camera " } else { "" },
            if cli.fragmented_only {
                "--fragmented-only "
            } else {
                ""
            },
            if cli.mp4_only { "--mp4-only " } else { "" },
            cli.fps,
        );

        let benchmark_md =
            generate_benchmark_markdown(&reports, &devices, cli.notes.as_deref(), command.trim());

        if let Err(e) = write_benchmark_to_file(&benchmark_md) {
            tracing::error!("Failed to write benchmark results: {}", e);
        }
    }

    if !cli.keep_outputs {
        if let Err(e) = std::fs::remove_dir_all(&cli.output_dir) {
            tracing::warn!("Failed to clean up output directory: {}", e);
        }
    } else {
        println!("\nRecordings kept at: {}", cli.output_dir.display());
    }

    let failed = reports.iter().filter(|r| !r.passed).count();
    std::process::exit(if failed > 0 { 1 } else { 0 });
}
