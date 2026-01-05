use anyhow::{Context, bail};
use cap_project::{Platform, RecordingMeta, RecordingMetaInner, StudioRecordingMeta};
use cap_recording::{
    CameraFeed, MicrophoneFeed,
    feeds::{camera, microphone},
    screen_capture::ScreenCaptureTarget,
    studio_recording,
};
use chrono::Local;
use clap::{Parser, Subcommand};
use kameo::Actor as _;
use scap_targets::Display;
use std::{
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant},
};
use tracing_subscriber::{EnvFilter, fmt, prelude::*};

#[derive(Parser)]
#[command(name = "real-device-test-runner")]
#[command(about = "Run end-to-end recording tests with real hardware devices on macOS")]
struct Cli {
    #[command(subcommand)]
    command: Option<Commands>,

    #[arg(long, global = true, default_value = "/tmp/cap-real-device-tests")]
    output_dir: PathBuf,

    #[arg(long, global = true)]
    keep_outputs: bool,

    #[arg(long, global = true)]
    no_camera: bool,

    #[arg(long, global = true)]
    fragmented_only: bool,

    #[arg(long, global = true)]
    mp4_only: bool,
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
            println!("  Default Microphone: {}", mic);
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
                    println!("    ISSUE: {}", issue);
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

        if !self.errors.is_empty() {
            println!("  Errors:");
            for error in &self.errors {
                println!("    - {}", error);
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
            let mut metrics = StreamSyncMetrics::default();

            metrics.display_start = segment.display.start_time;
            metrics.camera_start = segment.camera.as_ref().and_then(|c| c.start_time);
            metrics.mic_start = segment.mic.as_ref().and_then(|m| m.start_time);
            metrics.system_audio_start = segment.system_audio.as_ref().and_then(|s| s.start_time);

            if let (Some(disp), Some(cam)) = (metrics.display_start, metrics.camera_start) {
                metrics.display_camera_drift = Some((disp - cam).abs());
            }

            if let (Some(disp), Some(mic)) = (metrics.display_start, metrics.mic_start) {
                metrics.display_mic_drift = Some((disp - mic).abs());
            }

            if let (Some(cam), Some(mic)) = (metrics.camera_start, metrics.mic_start) {
                metrics.camera_mic_drift = Some((cam - mic).abs());
            }

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

            if !camera_mic_sync_ok {
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
                            "Segment {}: Missing init.mp4 in camera fragmented output",
                            idx
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
                        result.issues.push(format!(
                            "Segment {}: No .m4s fragments in camera output",
                            idx
                        ));
                    }
                } else if camera_path.is_file() {
                    result.valid = false;
                    result.issues.push(format!(
                        "Segment {}: Camera output is a single file, expected fragmented directory",
                        idx
                    ));
                } else {
                    result.valid = false;
                    result.issues.push(format!(
                        "Segment {}: Camera output path does not exist: {:?}",
                        idx, camera_path
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
            if let Some(start_time) = segment.display.start_time {
                if start_time.abs() > START_TIME_THRESHOLD {
                    result.all_valid = false;
                    result.issues.push(SegmentTimingIssue {
                        segment_index: idx,
                        stream_type: "display".to_string(),
                        start_time,
                    });
                }
            }

            if let Some(ref mic) = segment.mic {
                if let Some(start_time) = mic.start_time {
                    if start_time.abs() > START_TIME_THRESHOLD {
                        result.all_valid = false;
                        result.issues.push(SegmentTimingIssue {
                            segment_index: idx,
                            stream_type: "mic".to_string(),
                            start_time,
                        });
                    }
                }
            }

            if let Some(ref camera) = segment.camera {
                if let Some(start_time) = camera.start_time {
                    if start_time.abs() > START_TIME_THRESHOLD {
                        result.all_valid = false;
                        result.issues.push(SegmentTimingIssue {
                            segment_index: idx,
                            stream_type: "camera".to_string(),
                            start_time,
                        });
                    }
                }
            }

            if let Some(ref system_audio) = segment.system_audio {
                if let Some(start_time) = system_audio.start_time {
                    if start_time.abs() > START_TIME_THRESHOLD {
                        result.all_valid = false;
                        result.issues.push(SegmentTimingIssue {
                            segment_index: idx,
                            stream_type: "system_audio".to_string(),
                            start_time,
                        });
                    }
                }
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

    let shareable_content = cidre::sc::ShareableContent::current().await?;

    let mut builder = studio_recording::Actor::builder(
        recording_dir.clone(),
        ScreenCaptureTarget::Display {
            id: devices.primary_display.id(),
        },
    )
    .with_system_audio(true)
    .with_fragmented(fragmented)
    .with_max_fps(30);

    if let Some(mic) = mic_lock {
        builder = builder.with_mic_feed(mic);
    }

    if let Some(camera) = camera_lock {
        builder = builder.with_camera_feed(camera);
    }

    let handle = builder.build(shareable_content).await?;

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
) -> TestReport {
    let start = Instant::now();

    let mut report = TestReport {
        scenario: scenario.name.clone(),
        fragmented,
        include_camera,
        expected_segments: scenario.expected_segments,
        ..Default::default()
    };

    let recording_result =
        execute_recording(scenario, output_dir, devices, fragmented, include_camera).await;

    let recording_dir = match recording_result {
        Ok(dir) => dir,
        Err(e) => {
            report.errors.push(format!("Recording failed: {}", e));
            report.elapsed = start.elapsed();
            return report;
        }
    };

    let meta = match RecordingMeta::load_for_project(&recording_dir) {
        Ok(m) => m,
        Err(e) => {
            report
                .errors
                .push(format!("Failed to load recording metadata: {}", e));
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
                .push(format!("Duration validation failed: {}", e));
        }
    }

    let av_sync_ok = !include_camera || report.av_sync.all_synced;
    let camera_output_ok = !include_camera || !fragmented || report.camera_output.valid;

    report.passed = report.segment_count_ok
        && report.segment_timing.all_valid
        && report.duration_validation.total_ok
        && av_sync_ok
        && camera_output_ok
        && report.errors.is_empty();

    report.elapsed = start.elapsed();
    report
}

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

    if !cap_camera::list_cameras().next().is_none() {
        println!("  Camera: AVAILABLE (permission will be requested on first use)");
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
    println!("SUMMARY: {}/{} tests passed", passed, total);

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

#[tokio::main]
async fn main() -> anyhow::Result<()> {
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

    if cli.output_dir.exists() {
        if let Err(e) = std::fs::remove_dir_all(&cli.output_dir) {
            tracing::warn!("Failed to clean output directory: {}", e);
        }
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
    if include_camera {
        println!("Camera: ENABLED (use --no-camera to disable)");
        if devices.default_microphone.is_some() {
            println!("  Testing A/V sync between camera and microphone");
            println!("  Sync tolerance: {}ms", SYNC_TOLERANCE_MS);
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
            let report = run_test(scenario, &cli.output_dir, &devices, false, include_camera).await;
            reports.push(report);
        }

        if test_fragmented {
            let camera_str = if include_camera { "+camera" } else { "" };
            println!("Running: {} (fragmented{})...", scenario.name, camera_str);
            let report = run_test(scenario, &cli.output_dir, &devices, true, include_camera).await;
            reports.push(report);
        }
    }

    print_summary(&reports);

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
