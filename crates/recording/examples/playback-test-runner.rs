use anyhow::bail;
use cap_audio::{AudioData, SyncAnalyzer};
use cap_project::{RecordingMeta, RecordingMetaInner, StudioRecordingMeta};
use cap_rendering::decoder::spawn_decoder;
use chrono::{Local, Utc};
use clap::{Parser, Subcommand};
use std::{
    fs,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};
use sysinfo::System;
use tracing_subscriber::{EnvFilter, fmt, prelude::*};

#[cfg(windows)]
fn default_input_dir() -> PathBuf {
    std::env::temp_dir().join("cap-real-device-tests")
}

#[cfg(not(windows))]
fn default_input_dir() -> PathBuf {
    PathBuf::from("/tmp/cap-real-device-tests")
}

#[derive(Parser)]
#[command(name = "playback-test-runner")]
#[command(about = "Run playback validation tests on existing Cap recordings")]
struct Cli {
    #[command(subcommand)]
    command: Option<Commands>,

    #[arg(long, global = true, default_value_os_t = default_input_dir())]
    input_dir: PathBuf,

    #[arg(long, global = true)]
    recording_path: Option<PathBuf>,

    #[arg(long, global = true, default_value = "30")]
    fps: u32,

    #[arg(long, global = true)]
    verbose: bool,

    #[arg(long, global = true)]
    benchmark_output: bool,

    #[arg(long, global = true)]
    notes: Option<String>,
}

#[derive(Subcommand)]
enum Commands {
    Full,
    Decoder,
    Playback,
    Scrub,
    AudioSync,
    CameraSync,
    List,
}

const FPS_TOLERANCE: f64 = 2.0;
const DECODE_LATENCY_WARNING_MS: f64 = 50.0;
const SCRUB_SEEK_WARNING_MS: f64 = 40.0;
const AUDIO_VIDEO_SYNC_TOLERANCE_MS: f64 = 100.0;
const CAMERA_SYNC_TOLERANCE_MS: f64 = 100.0;

#[derive(Debug, Clone, Default)]
struct DecoderTestResult {
    passed: bool,
    decoder_type: String,
    init_time_ms: f64,
    video_width: u32,
    video_height: u32,
    is_hardware_accelerated: bool,
    fallback_reason: Option<String>,
    errors: Vec<String>,
}

#[derive(Debug, Clone, Default)]
struct PlaybackTestResult {
    passed: bool,
    segment_index: usize,
    total_frames: usize,
    decoded_frames: usize,
    failed_frames: usize,
    first_frame_decode_time_ms: f64,
    startup_to_first_frame_ms: f64,
    avg_decode_time_ms: f64,
    min_decode_time_ms: f64,
    max_decode_time_ms: f64,
    p50_decode_time_ms: f64,
    p95_decode_time_ms: f64,
    p99_decode_time_ms: f64,
    effective_fps: f64,
    expected_fps: f64,
    fps_ok: bool,
    jitter_ms: f64,
    decode_latency_ok: bool,
    errors: Vec<String>,
}

#[derive(Debug, Clone, Default)]
struct ScrubTestResult {
    passed: bool,
    segment_index: usize,
    seek_operations: usize,
    successful_seeks: usize,
    failed_seeks: usize,
    avg_seek_time_ms: f64,
    p50_seek_time_ms: f64,
    p95_seek_time_ms: f64,
    p99_seek_time_ms: f64,
    max_seek_time_ms: f64,
    seek_latency_ok: bool,
    errors: Vec<String>,
}

#[derive(Debug, Clone, Default)]
struct AudioSyncTestResult {
    passed: bool,
    segment_index: usize,
    has_mic_audio: bool,
    has_system_audio: bool,
    mic_duration_secs: f64,
    system_audio_duration_secs: f64,
    video_duration_secs: f64,
    mic_video_diff_ms: f64,
    system_audio_video_diff_ms: f64,
    mic_sync_ok: bool,
    system_audio_sync_ok: bool,
    detected_sync_offset_ms: Option<f64>,
    sync_confidence: f64,
    errors: Vec<String>,
}

#[derive(Debug, Clone, Default)]
struct CameraSyncTestResult {
    passed: bool,
    segment_index: usize,
    has_camera: bool,
    camera_start_time: Option<f64>,
    display_start_time: Option<f64>,
    camera_display_drift_ms: Option<f64>,
    drift_ok: bool,
    camera_decoder_ok: bool,
    camera_frame_count: usize,
    display_frame_count: usize,
    frame_count_diff: i32,
    errors: Vec<String>,
}

#[derive(Debug, Clone, Default)]
struct RecordingTestReport {
    recording_path: PathBuf,
    recording_name: String,
    segment_count: usize,
    is_fragmented: bool,
    has_camera: bool,
    has_mic: bool,
    has_system_audio: bool,
    decoder_results: Vec<DecoderTestResult>,
    playback_results: Vec<PlaybackTestResult>,
    scrub_results: Vec<ScrubTestResult>,
    audio_sync_results: Vec<AudioSyncTestResult>,
    camera_sync_results: Vec<CameraSyncTestResult>,
    overall_passed: bool,
    elapsed: Duration,
}

impl RecordingTestReport {
    fn print(&self) {
        let status = if self.overall_passed { "PASS" } else { "FAIL" };
        let format_type = if self.is_fragmented {
            "fragmented"
        } else {
            "mp4"
        };

        println!("\n{}", "=".repeat(70));
        println!("[{}] {} ({})", status, self.recording_name, format_type);
        println!("{}", "=".repeat(70));
        println!("  Path: {}", self.recording_path.display());
        println!("  Segments: {}", self.segment_count);
        println!(
            "  Features: camera={} mic={} system_audio={}",
            self.has_camera, self.has_mic, self.has_system_audio
        );

        println!("\n  DECODER TESTS:");
        for (i, result) in self.decoder_results.iter().enumerate() {
            let status = if result.passed { "OK" } else { "FAIL" };
            println!(
                "    Segment {}: [{}] {} ({}x{}) init={:.1}ms hw={}",
                i,
                status,
                result.decoder_type,
                result.video_width,
                result.video_height,
                result.init_time_ms,
                result.is_hardware_accelerated
            );
            if let Some(reason) = &result.fallback_reason {
                println!("      Fallback: {reason}");
            }
            for err in &result.errors {
                println!("      ERROR: {err}");
            }
        }

        println!("\n  PLAYBACK TESTS:");
        for result in &self.playback_results {
            let status = if result.passed { "OK" } else { "FAIL" };
            println!(
                "    Segment {}: [{}] frames={}/{} fps={:.1}/{:.1} avg={:.1}ms",
                result.segment_index,
                status,
                result.decoded_frames,
                result.total_frames,
                result.effective_fps,
                result.expected_fps,
                result.avg_decode_time_ms
            );
            println!(
                "      Latency: min={:.1}ms avg={:.1}ms max={:.1}ms p95={:.1}ms p99={:.1}ms",
                result.min_decode_time_ms,
                result.avg_decode_time_ms,
                result.max_decode_time_ms,
                result.p95_decode_time_ms,
                result.p99_decode_time_ms
            );
            println!(
                "      Startup: first_decode={:.1}ms startup_to_first={:.1}ms",
                result.first_frame_decode_time_ms, result.startup_to_first_frame_ms
            );
            if !result.fps_ok {
                println!("      WARN: FPS outside tolerance!");
            }
            if !result.decode_latency_ok {
                println!("      WARN: Decode latency exceeds {DECODE_LATENCY_WARNING_MS}ms!");
            }
            for err in &result.errors {
                println!("      ERROR: {err}");
            }
        }

        if !self.scrub_results.is_empty() {
            println!("\n  SCRUB TESTS:");
            for result in &self.scrub_results {
                let status = if result.passed { "OK" } else { "FAIL" };
                println!(
                    "    Segment {}: [{}] seeks={}/{} avg={:.1}ms p95={:.1}ms",
                    result.segment_index,
                    status,
                    result.successful_seeks,
                    result.seek_operations,
                    result.avg_seek_time_ms,
                    result.p95_seek_time_ms
                );
                if !result.seek_latency_ok {
                    println!("      WARN: Scrub seek latency exceeds {SCRUB_SEEK_WARNING_MS}ms!");
                }
                for err in &result.errors {
                    println!("      ERROR: {err}");
                }
            }
        }

        if !self.audio_sync_results.is_empty() {
            println!("\n  AUDIO SYNC TESTS:");
            for result in &self.audio_sync_results {
                let status = if result.passed { "OK" } else { "FAIL" };
                println!(
                    "    Segment {}: [{}] mic={} sys_audio={}",
                    result.segment_index, status, result.has_mic_audio, result.has_system_audio
                );
                if result.has_mic_audio {
                    println!(
                        "      Mic: {:.2}s diff={:.1}ms ({})",
                        result.mic_duration_secs,
                        result.mic_video_diff_ms,
                        if result.mic_sync_ok { "OK" } else { "FAIL" }
                    );
                }
                if result.has_system_audio {
                    println!(
                        "      System: {:.2}s diff={:.1}ms ({})",
                        result.system_audio_duration_secs,
                        result.system_audio_video_diff_ms,
                        if result.system_audio_sync_ok {
                            "OK"
                        } else {
                            "FAIL"
                        }
                    );
                }
                if let Some(offset) = result.detected_sync_offset_ms {
                    println!(
                        "      Detected sync offset: {:.1}ms (confidence: {:.0}%)",
                        offset,
                        result.sync_confidence * 100.0
                    );
                }
                for err in &result.errors {
                    println!("      ERROR: {err}");
                }
            }
        }

        if !self.camera_sync_results.is_empty() {
            println!("\n  CAMERA SYNC TESTS:");
            for result in &self.camera_sync_results {
                let status = if result.passed { "OK" } else { "FAIL" };
                if result.has_camera {
                    let drift_str = result
                        .camera_display_drift_ms
                        .map(|d| format!("{d:.1}ms"))
                        .unwrap_or_else(|| "N/A".to_string());
                    println!(
                        "    Segment {}: [{}] drift={} frames={}(cam)/{}(disp)",
                        result.segment_index,
                        status,
                        drift_str,
                        result.camera_frame_count,
                        result.display_frame_count
                    );
                    if !result.drift_ok {
                        println!(
                            "      WARN: Camera-display drift exceeds {CAMERA_SYNC_TOLERANCE_MS}ms!"
                        );
                    }
                } else {
                    println!("    Segment {}: No camera", result.segment_index);
                }
                for err in &result.errors {
                    println!("      ERROR: {err}");
                }
            }
        }

        println!("\n  Elapsed: {:.2}s", self.elapsed.as_secs_f64());
    }
}

fn percentile(data: &[f64], p: f64) -> f64 {
    if data.is_empty() {
        return 0.0;
    }
    let mut sorted: Vec<f64> = data.iter().copied().filter(|x| !x.is_nan()).collect();
    if sorted.is_empty() {
        return 0.0;
    }
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let idx = ((p / 100.0) * (sorted.len() - 1) as f64).round() as usize;
    sorted[idx.min(sorted.len() - 1)]
}

async fn test_decoder(video_path: &Path, fps: u32, is_camera: bool) -> DecoderTestResult {
    let mut result = DecoderTestResult::default();
    let name = if is_camera { "camera" } else { "display" };

    let start = Instant::now();
    match spawn_decoder(name, video_path.to_path_buf(), fps, 0.0, false).await {
        Ok(decoder) => {
            result.init_time_ms = start.elapsed().as_secs_f64() * 1000.0;
            result.decoder_type = format!("{}", decoder.decoder_type());
            result.is_hardware_accelerated = decoder.is_hardware_accelerated();
            let (width, height) = decoder.video_dimensions();
            result.video_width = width;
            result.video_height = height;
            result.fallback_reason = decoder.fallback_reason().map(String::from);
            result.passed = true;
        }
        Err(e) => {
            result.init_time_ms = start.elapsed().as_secs_f64() * 1000.0;
            result.errors.push(format!("Decoder init failed: {e}"));
            result.passed = false;
        }
    }

    result
}

async fn test_playback(
    recording_meta: &RecordingMeta,
    meta: &StudioRecordingMeta,
    segment_index: usize,
    fps: u32,
    verbose: bool,
) -> PlaybackTestResult {
    let playback_start = Instant::now();
    let mut result = PlaybackTestResult {
        segment_index,
        expected_fps: fps as f64,
        ..Default::default()
    };

    let display_path = match meta {
        StudioRecordingMeta::SingleSegment { segment } => {
            recording_meta.path(&segment.display.path)
        }
        StudioRecordingMeta::MultipleSegments { inner } => {
            recording_meta.path(&inner.segments[segment_index].display.path)
        }
    };

    let decoder = match spawn_decoder("display", display_path.clone(), fps, 0.0, false).await {
        Ok(d) => d,
        Err(e) => {
            result.errors.push(format!("Failed to create decoder: {e}"));
            return result;
        }
    };

    let duration_secs = get_video_duration(&display_path);
    let total_frames = (duration_secs * fps as f64).ceil() as usize;
    result.total_frames = total_frames;

    let test_frame_count = total_frames.min(300);
    let mut decode_times: Vec<f64> = Vec::with_capacity(test_frame_count);
    let mut decoded_count = 0;
    let mut failed_count = 0;

    let overall_start = Instant::now();

    for frame_num in 0..test_frame_count {
        let time = frame_num as f32 / fps as f32;
        let start = Instant::now();

        match decoder.get_frame(time).await {
            Some(frame) => {
                let decode_time_ms = start.elapsed().as_secs_f64() * 1000.0;
                decode_times.push(decode_time_ms);
                decoded_count += 1;
                if decoded_count == 1 {
                    result.first_frame_decode_time_ms = decode_time_ms;
                    result.startup_to_first_frame_ms =
                        playback_start.elapsed().as_secs_f64() * 1000.0;
                }

                if frame.width() == 0 || frame.height() == 0 {
                    result
                        .errors
                        .push(format!("Frame {frame_num} has zero dimensions"));
                }

                if verbose && frame_num % 30 == 0 {
                    println!(
                        "    Frame {}/{}: {:.1}ms ({}x{})",
                        frame_num,
                        test_frame_count,
                        decode_time_ms,
                        frame.width(),
                        frame.height()
                    );
                }
            }
            None => {
                failed_count += 1;
                if verbose {
                    println!("    Frame {frame_num}: FAILED");
                }
            }
        }
    }

    let overall_elapsed = overall_start.elapsed();
    result.decoded_frames = decoded_count;
    result.failed_frames = failed_count;

    if !decode_times.is_empty() {
        result.avg_decode_time_ms = decode_times.iter().sum::<f64>() / decode_times.len() as f64;
        result.min_decode_time_ms = decode_times.iter().copied().fold(f64::INFINITY, f64::min);
        result.max_decode_time_ms = decode_times
            .iter()
            .copied()
            .fold(f64::NEG_INFINITY, f64::max);
        result.p50_decode_time_ms = percentile(&decode_times, 50.0);
        result.p95_decode_time_ms = percentile(&decode_times, 95.0);
        result.p99_decode_time_ms = percentile(&decode_times, 99.0);

        let mean = result.avg_decode_time_ms;
        let variance: f64 = decode_times.iter().map(|t| (t - mean).powi(2)).sum::<f64>()
            / decode_times.len() as f64;
        result.jitter_ms = variance.sqrt();
    }

    if overall_elapsed.as_secs_f64() > 0.0 {
        result.effective_fps = decoded_count as f64 / overall_elapsed.as_secs_f64();
    }

    result.fps_ok = (result.effective_fps - result.expected_fps).abs() <= FPS_TOLERANCE
        || result.effective_fps >= result.expected_fps;
    result.decode_latency_ok = result.p95_decode_time_ms <= DECODE_LATENCY_WARNING_MS;

    result.passed = result.fps_ok
        && result.decode_latency_ok
        && result.failed_frames == 0
        && result.decoded_frames > 0;

    result
}

async fn test_scrub(
    recording_meta: &RecordingMeta,
    meta: &StudioRecordingMeta,
    segment_index: usize,
    fps: u32,
    verbose: bool,
) -> ScrubTestResult {
    let mut result = ScrubTestResult {
        segment_index,
        seek_operations: 120,
        ..Default::default()
    };

    let display_path = match meta {
        StudioRecordingMeta::SingleSegment { segment } => {
            recording_meta.path(&segment.display.path)
        }
        StudioRecordingMeta::MultipleSegments { inner } => {
            recording_meta.path(&inner.segments[segment_index].display.path)
        }
    };

    let decoder = match spawn_decoder("display", display_path.clone(), fps, 0.0, false).await {
        Ok(d) => d,
        Err(e) => {
            result.errors.push(format!("Failed to create decoder: {e}"));
            return result;
        }
    };

    let duration_secs = get_video_duration(&display_path);
    let total_frames = (duration_secs * fps as f64).ceil() as usize;
    if total_frames < 2 {
        result
            .errors
            .push("Video duration too short for scrub benchmark".to_string());
        return result;
    }

    let mut seek_times = Vec::with_capacity(result.seek_operations);

    for operation in 0..result.seek_operations {
        let target_frame = ((operation * 7919) % total_frames).max(1);
        let target_time = target_frame as f32 / fps as f32;
        let seek_start = Instant::now();
        match decoder.get_frame(target_time).await {
            Some(_) => {
                let seek_time_ms = seek_start.elapsed().as_secs_f64() * 1000.0;
                seek_times.push(seek_time_ms);
                result.successful_seeks += 1;
                if verbose && operation % 20 == 0 {
                    println!(
                        "    Scrub {} / {}: frame={} time={:.3}s seek={:.1}ms",
                        operation + 1,
                        result.seek_operations,
                        target_frame,
                        target_time,
                        seek_time_ms
                    );
                }
            }
            None => {
                result.failed_seeks += 1;
                if verbose {
                    println!(
                        "    Scrub {} / {}: frame={} FAILED",
                        operation + 1,
                        result.seek_operations,
                        target_frame
                    );
                }
            }
        }
    }

    if !seek_times.is_empty() {
        result.avg_seek_time_ms = seek_times.iter().sum::<f64>() / seek_times.len() as f64;
        result.p50_seek_time_ms = percentile(&seek_times, 50.0);
        result.p95_seek_time_ms = percentile(&seek_times, 95.0);
        result.p99_seek_time_ms = percentile(&seek_times, 99.0);
        result.max_seek_time_ms = seek_times.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    }

    result.seek_latency_ok = result.p95_seek_time_ms <= SCRUB_SEEK_WARNING_MS;
    result.passed =
        result.seek_latency_ok && result.failed_seeks == 0 && result.successful_seeks > 0;

    result
}

async fn test_audio_sync(
    recording_meta: &RecordingMeta,
    meta: &StudioRecordingMeta,
    segment_index: usize,
    fps: u32,
) -> AudioSyncTestResult {
    let mut result = AudioSyncTestResult {
        segment_index,
        ..Default::default()
    };

    let (display_path, mic_path, system_audio_path) = match meta {
        StudioRecordingMeta::SingleSegment { segment } => (
            recording_meta.path(&segment.display.path),
            segment.audio.as_ref().map(|a| recording_meta.path(&a.path)),
            None,
        ),
        StudioRecordingMeta::MultipleSegments { inner } => {
            let seg = &inner.segments[segment_index];
            (
                recording_meta.path(&seg.display.path),
                seg.mic.as_ref().map(|m| recording_meta.path(&m.path)),
                seg.system_audio
                    .as_ref()
                    .map(|s| recording_meta.path(&s.path)),
            )
        }
    };

    result.video_duration_secs = get_video_duration(&display_path);

    if let Some(mic_path) = mic_path {
        result.has_mic_audio = true;
        match AudioData::from_file(&mic_path) {
            Ok(audio_data) => {
                let duration = audio_data.sample_count() as f64 / AudioData::SAMPLE_RATE as f64;
                result.mic_duration_secs = duration;
                let diff = (result.mic_duration_secs - result.video_duration_secs).abs() * 1000.0;
                result.mic_video_diff_ms = diff;
                result.mic_sync_ok = diff <= AUDIO_VIDEO_SYNC_TOLERANCE_MS;

                let mut analyzer = SyncAnalyzer::new(AudioData::SAMPLE_RATE, fps as f64);
                let mono_samples: Vec<f32> = audio_data
                    .samples()
                    .chunks(audio_data.channels() as usize)
                    .map(|c| c.iter().sum::<f32>() / c.len() as f32)
                    .collect();
                analyzer.add_audio_samples(&mono_samples, 0.0);

                if let Some(sync_result) = analyzer.calculate_sync_offset() {
                    result.detected_sync_offset_ms = Some(sync_result.offset_secs * 1000.0);
                    result.sync_confidence = sync_result.confidence;
                }
            }
            Err(e) => {
                result.errors.push(format!("Failed to load mic audio: {e}"));
            }
        }
    }

    if let Some(sys_path) = system_audio_path {
        result.has_system_audio = true;
        match AudioData::from_file(&sys_path) {
            Ok(audio_data) => {
                let duration = audio_data.sample_count() as f64 / AudioData::SAMPLE_RATE as f64;
                result.system_audio_duration_secs = duration;
                let diff =
                    (result.system_audio_duration_secs - result.video_duration_secs).abs() * 1000.0;
                result.system_audio_video_diff_ms = diff;
                result.system_audio_sync_ok = diff <= AUDIO_VIDEO_SYNC_TOLERANCE_MS;
            }
            Err(e) => {
                result
                    .errors
                    .push(format!("Failed to load system audio: {e}"));
            }
        }
    }

    let mic_ok = !result.has_mic_audio || result.mic_sync_ok;
    let sys_ok = !result.has_system_audio || result.system_audio_sync_ok;
    result.passed = mic_ok && sys_ok && result.errors.is_empty();

    result
}

async fn test_camera_sync(
    recording_meta: &RecordingMeta,
    meta: &StudioRecordingMeta,
    segment_index: usize,
    fps: u32,
) -> CameraSyncTestResult {
    let mut result = CameraSyncTestResult {
        segment_index,
        ..Default::default()
    };

    let (display_path, camera_path, display_start_time, camera_start_time) = match meta {
        StudioRecordingMeta::SingleSegment { segment } => (
            recording_meta.path(&segment.display.path),
            segment
                .camera
                .as_ref()
                .map(|c| recording_meta.path(&c.path)),
            segment.display.start_time,
            segment.camera.as_ref().and_then(|c| c.start_time),
        ),
        StudioRecordingMeta::MultipleSegments { inner } => {
            let seg = &inner.segments[segment_index];
            (
                recording_meta.path(&seg.display.path),
                seg.camera.as_ref().map(|c| recording_meta.path(&c.path)),
                seg.display.start_time,
                seg.camera.as_ref().and_then(|c| c.start_time),
            )
        }
    };

    result.display_start_time = display_start_time;
    result.camera_start_time = camera_start_time;

    let camera_path = match camera_path {
        Some(p) => {
            result.has_camera = true;
            p
        }
        None => {
            result.passed = true;
            return result;
        }
    };

    if let (Some(disp_start), Some(cam_start)) = (display_start_time, camera_start_time) {
        let drift_secs = (disp_start - cam_start).abs();
        result.camera_display_drift_ms = Some(drift_secs * 1000.0);
        result.drift_ok = drift_secs * 1000.0 <= CAMERA_SYNC_TOLERANCE_MS;
    } else {
        result.drift_ok = true;
    }

    let display_decoder =
        match spawn_decoder("display", display_path.clone(), fps, 0.0, false).await {
            Ok(d) => d,
            Err(e) => {
                result
                    .errors
                    .push(format!("Failed to create display decoder: {e}"));
                return result;
            }
        };

    let camera_decoder = match spawn_decoder("camera", camera_path.clone(), fps, 0.0, false).await {
        Ok(d) => {
            result.camera_decoder_ok = true;
            d
        }
        Err(e) => {
            result
                .errors
                .push(format!("Failed to create camera decoder: {e}"));
            result.camera_decoder_ok = false;
            return result;
        }
    };

    let test_duration_secs = 5.0f32;
    let test_frame_count = (test_duration_secs * fps as f32) as usize;

    let mut display_frames = 0;
    let mut camera_frames = 0;

    for frame_num in 0..test_frame_count {
        let time = frame_num as f32 / fps as f32;

        if display_decoder.get_frame(time).await.is_some() {
            display_frames += 1;
        }

        if camera_decoder.get_frame(time).await.is_some() {
            camera_frames += 1;
        }
    }

    result.display_frame_count = display_frames;
    result.camera_frame_count = camera_frames;
    result.frame_count_diff = (display_frames as i32 - camera_frames as i32).abs();

    result.passed = result.drift_ok && result.camera_decoder_ok && result.errors.is_empty();

    result
}

fn get_video_duration(path: &Path) -> f64 {
    if path.is_dir() {
        let init_segment = path.join("init.mp4");
        if !init_segment.exists() {
            return 0.0;
        }

        let mut fragments: Vec<PathBuf> = std::fs::read_dir(path)
            .ok()
            .map(|entries| {
                entries
                    .filter_map(|e| e.ok())
                    .map(|e| e.path())
                    .filter(|p| p.extension().is_some_and(|ext| ext == "m4s"))
                    .collect()
            })
            .unwrap_or_default();
        fragments.sort();

        if fragments.is_empty() {
            return 0.0;
        }

        let combined_path = path.join("_combined_for_duration.mp4");
        let mut combined_data = match std::fs::read(&init_segment) {
            Ok(d) => d,
            Err(_) => return 0.0,
        };
        for fragment in &fragments {
            if let Ok(data) = std::fs::read(fragment) {
                combined_data.extend(data);
            }
        }
        if std::fs::write(&combined_path, &combined_data).is_err() {
            return 0.0;
        }

        let duration = get_single_file_duration(&combined_path);
        let _ = std::fs::remove_file(&combined_path);
        duration
    } else {
        get_single_file_duration(path)
    }
}

fn get_single_file_duration(path: &Path) -> f64 {
    match ffmpeg::format::input(path) {
        Ok(input) => {
            let raw_duration = input.duration();
            if raw_duration > 0 {
                raw_duration as f64 / ffmpeg::ffi::AV_TIME_BASE as f64
            } else {
                for stream in input.streams() {
                    if stream.parameters().medium() == ffmpeg::media::Type::Video {
                        let time_base = stream.time_base();
                        if let Some(duration) = stream.duration().checked_mul(time_base.0 as i64) {
                            return (duration as f64 / time_base.1 as f64).max(0.0);
                        }
                    }
                }
                0.0
            }
        }
        Err(_) => 0.0,
    }
}

fn discover_recordings(input_dir: &Path) -> Vec<PathBuf> {
    let mut recordings = Vec::new();

    if !input_dir.exists() {
        return recordings;
    }

    if let Ok(entries) = std::fs::read_dir(input_dir) {
        for entry in entries.filter_map(|e| e.ok()) {
            let path = entry.path();
            if path.is_dir() {
                let meta_path = path.join("recording-meta.json");
                if meta_path.exists() {
                    recordings.push(path);
                }
            }
        }
    }

    recordings.sort();
    recordings
}

async fn run_tests_on_recording(
    recording_path: &Path,
    fps: u32,
    run_decoder: bool,
    run_playback: bool,
    run_scrub: bool,
    run_audio_sync: bool,
    run_camera_sync: bool,
    verbose: bool,
) -> anyhow::Result<RecordingTestReport> {
    let start = Instant::now();

    let meta = RecordingMeta::load_for_project(recording_path)
        .map_err(|e| anyhow::anyhow!("Failed to load recording metadata: {}", e))?;

    let RecordingMetaInner::Studio(studio_meta) = &meta.inner else {
        bail!("Not a studio recording");
    };

    let segment_count = match studio_meta.as_ref() {
        StudioRecordingMeta::SingleSegment { .. } => 1,
        StudioRecordingMeta::MultipleSegments { inner } => inner.segments.len(),
    };

    let is_fragmented = match studio_meta.as_ref() {
        StudioRecordingMeta::SingleSegment { segment } => meta.path(&segment.display.path).is_dir(),
        StudioRecordingMeta::MultipleSegments { inner } => {
            !inner.segments.is_empty() && meta.path(&inner.segments[0].display.path).is_dir()
        }
    };

    let (has_camera, has_mic, has_system_audio) = match studio_meta.as_ref() {
        StudioRecordingMeta::SingleSegment { segment } => {
            (segment.camera.is_some(), segment.audio.is_some(), false)
        }
        StudioRecordingMeta::MultipleSegments { inner } => {
            let has_cam = inner.segments.iter().any(|s| s.camera.is_some());
            let has_mic = inner.segments.iter().any(|s| s.mic.is_some());
            let has_sys = inner.segments.iter().any(|s| s.system_audio.is_some());
            (has_cam, has_mic, has_sys)
        }
    };

    let mut report = RecordingTestReport {
        recording_path: recording_path.to_path_buf(),
        recording_name: meta.pretty_name.clone(),
        segment_count,
        is_fragmented,
        has_camera,
        has_mic,
        has_system_audio,
        ..Default::default()
    };

    for segment_idx in 0..segment_count {
        if run_decoder {
            let display_path = match studio_meta.as_ref() {
                StudioRecordingMeta::SingleSegment { segment } => meta.path(&segment.display.path),
                StudioRecordingMeta::MultipleSegments { inner } => {
                    meta.path(&inner.segments[segment_idx].display.path)
                }
            };

            if verbose {
                println!("  Testing decoder for segment {segment_idx} display...");
            }
            let decoder_result = test_decoder(&display_path, fps, false).await;
            report.decoder_results.push(decoder_result);

            let camera_path = match studio_meta.as_ref() {
                StudioRecordingMeta::SingleSegment { segment } => {
                    segment.camera.as_ref().map(|c| meta.path(&c.path))
                }
                StudioRecordingMeta::MultipleSegments { inner } => inner.segments[segment_idx]
                    .camera
                    .as_ref()
                    .map(|c| meta.path(&c.path)),
            };

            if let Some(cam_path) = camera_path {
                if verbose {
                    println!("  Testing decoder for segment {segment_idx} camera...");
                }
                let cam_decoder_result = test_decoder(&cam_path, fps, true).await;
                report.decoder_results.push(cam_decoder_result);
            }
        }

        if run_playback {
            if verbose {
                println!("  Testing playback for segment {segment_idx}...");
            }
            let playback_result =
                test_playback(&meta, studio_meta.as_ref(), segment_idx, fps, verbose).await;
            report.playback_results.push(playback_result);
        }

        if run_scrub {
            if verbose {
                println!("  Testing scrub performance for segment {segment_idx}...");
            }
            let scrub_result =
                test_scrub(&meta, studio_meta.as_ref(), segment_idx, fps, verbose).await;
            report.scrub_results.push(scrub_result);
        }

        if run_audio_sync {
            if verbose {
                println!("  Testing audio sync for segment {segment_idx}...");
            }
            let audio_result = test_audio_sync(&meta, studio_meta.as_ref(), segment_idx, fps).await;
            report.audio_sync_results.push(audio_result);
        }

        if run_camera_sync && has_camera {
            if verbose {
                println!("  Testing camera sync for segment {segment_idx}...");
            }
            let camera_result =
                test_camera_sync(&meta, studio_meta.as_ref(), segment_idx, fps).await;
            report.camera_sync_results.push(camera_result);
        }
    }

    report.elapsed = start.elapsed();

    let decoder_ok = report.decoder_results.iter().all(|r| r.passed);
    let playback_ok = report.playback_results.iter().all(|r| r.passed);
    let scrub_ok = report.scrub_results.iter().all(|r| r.passed);
    let audio_ok = report.audio_sync_results.iter().all(|r| r.passed);
    let camera_ok = report.camera_sync_results.iter().all(|r| r.passed);

    report.overall_passed = decoder_ok && playback_ok && scrub_ok && audio_ok && camera_ok;

    Ok(report)
}

#[derive(Debug)]
struct SystemInfo {
    os: String,
    arch: String,
    cpu: String,
}

impl SystemInfo {
    fn collect() -> Self {
        let mut sys = System::new_all();
        sys.refresh_all();

        let os = format!(
            "{} {}",
            System::name().unwrap_or_default(),
            System::os_version().unwrap_or_default()
        );
        let arch = std::env::consts::ARCH.to_string();
        let cpu = sys
            .cpus()
            .first()
            .map(|c| c.brand().to_string())
            .unwrap_or_default();

        Self { os, arch, cpu }
    }

    fn to_markdown(&self) -> String {
        let mut md = String::new();
        md.push_str("| Property | Value |\n");
        md.push_str("|----------|-------|\n");
        md.push_str(&format!("| OS | {} |\n", self.os));
        md.push_str(&format!("| Architecture | {} |\n", self.arch));
        md.push_str(&format!("| CPU | {} |\n", self.cpu));
        md
    }
}

fn get_failure_tags(report: &RecordingTestReport) -> Vec<String> {
    let mut tags = Vec::new();

    if report.decoder_results.iter().any(|r| !r.passed) {
        tags.push("DECODER".to_string());
    }
    if report.playback_results.iter().any(|r| !r.fps_ok) {
        tags.push("FPS".to_string());
    }
    if report.playback_results.iter().any(|r| !r.decode_latency_ok) {
        tags.push("LATENCY".to_string());
    }
    if report.scrub_results.iter().any(|r| !r.seek_latency_ok) {
        tags.push("SCRUB_LATENCY".to_string());
    }
    if report.scrub_results.iter().any(|r| r.failed_seeks > 0) {
        tags.push("SCRUB_ERRORS".to_string());
    }
    if report.playback_results.iter().any(|r| r.failed_frames > 0) {
        tags.push("DECODE_ERRORS".to_string());
    }
    if report.audio_sync_results.iter().any(|r| !r.mic_sync_ok) {
        tags.push("MIC_SYNC".to_string());
    }
    if report
        .audio_sync_results
        .iter()
        .any(|r| !r.system_audio_sync_ok)
    {
        tags.push("SYS_AUDIO_SYNC".to_string());
    }
    if report.camera_sync_results.iter().any(|r| !r.drift_ok) {
        tags.push("CAMERA_DRIFT".to_string());
    }

    tags
}

fn report_to_markdown(report: &RecordingTestReport) -> String {
    let mut md = String::new();

    let status = if report.overall_passed {
        "✅ PASS"
    } else {
        "❌ FAIL"
    };
    let format_type = if report.is_fragmented {
        "fragmented"
    } else {
        "mp4"
    };

    md.push_str(&format!(
        "#### {} {} ({})\n\n",
        status, report.recording_name, format_type
    ));

    if !report.overall_passed {
        let tags = get_failure_tags(report);
        if !tags.is_empty() {
            md.push_str(&format!("**Failure Tags:** `{}`\n\n", tags.join("`, `")));
        }
    }

    md.push_str("| Metric | Result | Details |\n");
    md.push_str("|--------|--------|--------|\n");

    md.push_str(&format!(
        "| Features | ℹ️ | camera={} mic={} sys_audio={} |\n",
        report.has_camera, report.has_mic, report.has_system_audio
    ));
    md.push_str(&format!("| Segments | ℹ️ | {} |\n", report.segment_count));

    for (i, result) in report.decoder_results.iter().enumerate() {
        let status = if result.passed { "✅" } else { "❌" };
        let hw_str = if result.is_hardware_accelerated {
            "HW"
        } else {
            "SW"
        };
        md.push_str(&format!(
            "| Decoder {} | {} | {} {}x{} init={:.1}ms {} |\n",
            i,
            status,
            result.decoder_type,
            result.video_width,
            result.video_height,
            result.init_time_ms,
            hw_str
        ));
        if let Some(reason) = &result.fallback_reason {
            md.push_str(&format!("| ↳ Fallback | ⚠️ | {} |\n", reason));
        }
    }

    for result in &report.playback_results {
        let status = if result.passed { "✅" } else { "❌" };
        md.push_str(&format!(
            "| Playback Seg {} | {} | frames={}/{} fps={:.1}/{:.1} |\n",
            result.segment_index,
            status,
            result.decoded_frames,
            result.total_frames,
            result.effective_fps,
            result.expected_fps
        ));
        md.push_str(&format!(
            "| ↳ Latency | {} | min={:.1}ms avg={:.1}ms p95={:.1}ms p99={:.1}ms max={:.1}ms |\n",
            if result.decode_latency_ok {
                "✅"
            } else {
                "❌"
            },
            result.min_decode_time_ms,
            result.avg_decode_time_ms,
            result.p95_decode_time_ms,
            result.p99_decode_time_ms,
            result.max_decode_time_ms
        ));
        md.push_str(&format!(
            "| ↳ Startup | {} | first_decode={:.1}ms startup_to_first={:.1}ms |\n",
            if result.startup_to_first_frame_ms > 0.0 {
                "✅"
            } else {
                "❌"
            },
            result.first_frame_decode_time_ms,
            result.startup_to_first_frame_ms
        ));
        if result.failed_frames > 0 {
            md.push_str(&format!(
                "| ↳ Failed Frames | ⚠️ | {} |\n",
                result.failed_frames
            ));
        }
    }

    for result in &report.scrub_results {
        md.push_str(&format!(
            "| Scrub Seg {} | {} | seeks={}/{} avg={:.1}ms p95={:.1}ms p99={:.1}ms |\n",
            result.segment_index,
            if result.passed { "✅" } else { "❌" },
            result.successful_seeks,
            result.seek_operations,
            result.avg_seek_time_ms,
            result.p95_seek_time_ms,
            result.p99_seek_time_ms
        ));
        md.push_str(&format!(
            "| ↳ Scrub Latency | {} | max={:.1}ms threshold={:.1}ms |\n",
            if result.seek_latency_ok { "✅" } else { "❌" },
            result.max_seek_time_ms,
            SCRUB_SEEK_WARNING_MS
        ));
        if result.failed_seeks > 0 {
            md.push_str(&format!(
                "| ↳ Scrub Failures | ⚠️ | {} |\n",
                result.failed_seeks
            ));
        }
    }

    for result in &report.audio_sync_results {
        if result.has_mic_audio {
            let status = if result.mic_sync_ok { "✅" } else { "❌" };
            md.push_str(&format!(
                "| Mic Sync Seg {} | {} | {:.2}s diff={:.1}ms |\n",
                result.segment_index, status, result.mic_duration_secs, result.mic_video_diff_ms
            ));
        }
        if result.has_system_audio {
            let status = if result.system_audio_sync_ok {
                "✅"
            } else {
                "❌"
            };
            md.push_str(&format!(
                "| Sys Audio Sync Seg {} | {} | {:.2}s diff={:.1}ms |\n",
                result.segment_index,
                status,
                result.system_audio_duration_secs,
                result.system_audio_video_diff_ms
            ));
        }
        if let Some(offset) = result.detected_sync_offset_ms {
            md.push_str(&format!(
                "| ↳ Detected Offset | ℹ️ | {:.1}ms (confidence: {:.0}%) |\n",
                offset,
                result.sync_confidence * 100.0
            ));
        }
    }

    for result in &report.camera_sync_results {
        if result.has_camera {
            let status = if result.drift_ok { "✅" } else { "❌" };
            let drift_str = result
                .camera_display_drift_ms
                .map(|d| format!("{d:.1}ms"))
                .unwrap_or_else(|| "N/A".to_string());
            md.push_str(&format!(
                "| Camera Sync Seg {} | {} | drift={} cam_frames={} disp_frames={} |\n",
                result.segment_index,
                status,
                drift_str,
                result.camera_frame_count,
                result.display_frame_count
            ));
        }
    }

    md.push_str(&format!(
        "\n**Elapsed:** {:.2}s\n\n",
        report.elapsed.as_secs_f64()
    ));

    md
}

fn generate_benchmark_markdown(
    reports: &[RecordingTestReport],
    notes: Option<&str>,
    command: &str,
) -> String {
    let mut md = String::new();

    let timestamp = Utc::now().format("%Y-%m-%d %H:%M:%S UTC").to_string();
    let local_timestamp = Local::now().format("%Y-%m-%d %H:%M:%S").to_string();

    md.push_str(&format!("### Benchmark Run: {}\n\n", timestamp));
    md.push_str(&format!("*Local time: {}*\n\n", local_timestamp));

    let passed = reports.iter().filter(|r| r.overall_passed).count();
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
    let sys_info = SystemInfo::collect();
    md.push_str(&sys_info.to_markdown());
    md.push_str("\n</details>\n\n");

    if passed < total {
        md.push_str("**Failed Tests:**\n");
        for report in reports.iter().filter(|r| !r.overall_passed) {
            let format_type = if report.is_fragmented {
                "fragmented"
            } else {
                "mp4"
            };
            let tags = get_failure_tags(report);
            md.push_str(&format!(
                "- {} ({}) — `{}`\n",
                report.recording_name,
                format_type,
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
    let benchmark_file = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("editor")
        .join("PLAYBACK-BENCHMARKS.md");

    if !benchmark_file.exists() {
        bail!(
            "PLAYBACK-BENCHMARKS.md not found at {:?}. Please ensure the file exists.",
            benchmark_file
        );
    }

    let content = fs::read_to_string(&benchmark_file)?;

    let marker_start = "<!-- PLAYBACK_BENCHMARK_RESULTS_START -->";
    let marker_end = "<!-- PLAYBACK_BENCHMARK_RESULTS_END -->";

    let Some(start_idx) = content.find(marker_start) else {
        bail!("Could not find PLAYBACK_BENCHMARK_RESULTS_START marker in PLAYBACK-BENCHMARKS.md");
    };

    let Some(end_idx) = content.find(marker_end) else {
        bail!("Could not find PLAYBACK_BENCHMARK_RESULTS_END marker in PLAYBACK-BENCHMARKS.md");
    };

    let insert_pos = start_idx + marker_start.len();

    let mut new_content = String::new();
    new_content.push_str(&content[..insert_pos]);
    new_content.push_str("\n\n");
    new_content.push_str(benchmark_md);
    new_content.push_str(&content[end_idx..]);

    fs::write(&benchmark_file, new_content)?;

    println!(
        "\n✅ Benchmark results written to {}",
        benchmark_file.display()
    );

    Ok(())
}

fn print_summary(reports: &[RecordingTestReport]) {
    println!("\n{}", "=".repeat(70));
    println!("PLAYBACK TEST SUMMARY");
    println!("{}", "=".repeat(70));

    let passed = reports.iter().filter(|r| r.overall_passed).count();
    let total = reports.len();

    println!("\nResults: {passed}/{total} recordings passed");

    if passed < total {
        println!("\nFailed recordings:");
        for report in reports.iter().filter(|r| !r.overall_passed) {
            print!("  - {}", report.recording_name);

            let decoder_failed = report.decoder_results.iter().any(|r| !r.passed);
            let playback_failed = report.playback_results.iter().any(|r| !r.passed);
            let scrub_failed = report.scrub_results.iter().any(|r| !r.passed);
            let audio_failed = report.audio_sync_results.iter().any(|r| !r.passed);
            let camera_failed = report.camera_sync_results.iter().any(|r| !r.passed);

            if decoder_failed {
                print!(" [DECODER]");
            }
            if playback_failed {
                print!(" [PLAYBACK]");
            }
            if scrub_failed {
                print!(" [SCRUB]");
            }
            if audio_failed {
                print!(" [AUDIO SYNC]");
            }
            if camera_failed {
                print!(" [CAMERA SYNC]");
            }
            println!();
        }
    }

    println!();
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::registry()
        .with(fmt::layer())
        .with(EnvFilter::from_default_env().add_directive(tracing::Level::INFO.into()))
        .init();

    ffmpeg::init().map_err(|e| anyhow::anyhow!("Failed to initialize FFmpeg: {}", e))?;

    let cli = Cli::parse();

    if let Some(Commands::List) = cli.command {
        let recordings = discover_recordings(&cli.input_dir);
        if recordings.is_empty() {
            println!("No recordings found in {}", cli.input_dir.display());
        } else {
            println!("Found {} recordings:", recordings.len());
            for recording in recordings {
                if let Ok(meta) = RecordingMeta::load_for_project(&recording) {
                    println!("  - {} ({})", meta.pretty_name, recording.display());
                } else {
                    println!("  - {}", recording.display());
                }
            }
        }
        return Ok(());
    }

    let recordings = if let Some(ref path) = cli.recording_path {
        vec![path.clone()]
    } else {
        discover_recordings(&cli.input_dir)
    };

    if recordings.is_empty() {
        println!("No recordings found to test.");
        println!(
            "Either specify --recording-path or ensure recordings exist in {}",
            cli.input_dir.display()
        );
        println!("\nTip: Run real-device-test-runner first to create test recordings:");
        println!("  cargo run --example real-device-test-runner -- --keep-outputs");
        return Ok(());
    }

    let (run_decoder, run_playback, run_scrub, run_audio_sync, run_camera_sync) = match cli.command
    {
        Some(Commands::Decoder) => (true, false, false, false, false),
        Some(Commands::Playback) => (false, true, false, false, false),
        Some(Commands::Scrub) => (false, false, true, false, false),
        Some(Commands::AudioSync) => (false, false, false, true, false),
        Some(Commands::CameraSync) => (false, false, false, false, true),
        Some(Commands::Full) | None => (true, true, true, true, true),
        Some(Commands::List) => unreachable!(),
    };

    println!("\nCap Playback Test Runner");
    println!("{}", "=".repeat(40));
    println!(
        "Testing {} recording(s) at {} FPS",
        recordings.len(),
        cli.fps
    );
    println!();

    let mut reports = Vec::new();

    for recording_path in &recordings {
        println!("Testing: {}", recording_path.display());

        match run_tests_on_recording(
            recording_path,
            cli.fps,
            run_decoder,
            run_playback,
            run_scrub,
            run_audio_sync,
            run_camera_sync,
            cli.verbose,
        )
        .await
        {
            Ok(report) => {
                report.print();
                reports.push(report);
            }
            Err(e) => {
                println!("  ERROR: {e}");
            }
        }
    }

    print_summary(&reports);

    if cli.benchmark_output {
        let command = format!(
            "cargo run -p cap-recording --example playback-test-runner -- {} --fps {}{}",
            match cli.command {
                Some(Commands::Decoder) => "decoder",
                Some(Commands::Playback) => "playback",
                Some(Commands::Scrub) => "scrub",
                Some(Commands::AudioSync) => "audio-sync",
                Some(Commands::CameraSync) => "camera-sync",
                Some(Commands::Full) | None => "full",
                Some(Commands::List) => "list",
            },
            cli.fps,
            cli.recording_path
                .as_ref()
                .map(|p| format!(" --recording-path {}", p.display()))
                .unwrap_or_default(),
        );

        let benchmark_md =
            generate_benchmark_markdown(&reports, cli.notes.as_deref(), command.trim());

        if let Err(e) = write_benchmark_to_file(&benchmark_md) {
            tracing::error!("Failed to write benchmark results: {}", e);
        }
    }

    let failed = reports.iter().filter(|r| !r.overall_passed).count();
    std::process::exit(if failed > 0 { 1 } else { 0 });
}
