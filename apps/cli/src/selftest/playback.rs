//! `cap selftest playback` — verifies A/V sync of the editor's playback
//! path: what the renderer presents vs what the audio output plays.
//!
//! The harness opens a flash+beep recording with the real editor machinery
//! (`EditorInstance`: real decoders, real frame scheduling, real audio
//! pipeline) and taps both presentation boundaries — the renderer's frame
//! callback and a headless audio sink that pulls blocks on a device-like
//! real-time schedule. Flash/beep onsets measured in those taps are compared
//! against the same onsets measured in the recording's raw tracks; playback
//! must reproduce the recording's sync within one frame and without drift.
//!
//! Without `--project` the fixture is generated through the real recording
//! pipeline (the same channel-source path the sync matrix uses), so the test
//! runs headless on CI where no capture hardware exists.

use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use cap_editor::{EditorFrameOutput, EditorInstance, HEADLESS_CHANNELS, HEADLESS_SAMPLE_RATE};
use cap_project::XY;
use clap::Args;
use serde::Serialize;

use super::measure::{self, SyncMeasurement};

/// Flash/beep schedule of the generated fixture. Mirrors the av-sync pattern:
/// events every two seconds after a settle period, 120 ms flash+beep each.
const FIXTURE_SETTLE_SECS: f64 = 2.0;
const FIXTURE_PERIOD_SECS: f64 = 2.0;
/// Longer than the live pattern's 120 ms so CI runners with slow virtualized
/// GPUs still present at least one frame inside every flash window; onset
/// detection is edge-triggered, so the extra length does not blur the onset.
const FIXTURE_FLASH_SECS: f64 = 0.36;
const FIXTURE_TAIL_SECS: f64 = 1.0;
const FIXTURE_FPS: u32 = 30;
const FIXTURE_WIDTH: u32 = 320;
const FIXTURE_HEIGHT: u32 = 240;
/// A video emission gap after the second event: the screen is static, no
/// frames are captured, and playback/export must hold the last frame (the
/// VFR hold path) without disturbing audio sync. Longer than the decoders'
/// FRAME_CACHE_SIZE (90 frames = 3s at 30fps) so the pre-gap hold frame is
/// guaranteed to face cache eviction while requests march through the hole —
/// the regression class where post-gap content got served mid-hold. Events
/// whose flashes fall inside the gap are still beeped; their unpaired beeps
/// are rejected by the measurement's pairing window.
const FIXTURE_GAP_START_SECS: f64 = FIXTURE_SETTLE_SECS + FIXTURE_PERIOD_SECS + 0.4;
const FIXTURE_GAP_LEN_SECS: f64 = 4.2;
/// A second, narrow gap (~30 frames) between the fifth and sixth events.
/// Narrower than the decoders' cache read-ahead window, so it exercises the
/// in-loop narrow-hole answer paths that the long gap's cache-bounds exit
/// never reaches.
const FIXTURE_GAP2_START_SECS: f64 = FIXTURE_SETTLE_SECS + 4.0 * FIXTURE_PERIOD_SECS + 0.4;
const FIXTURE_GAP2_LEN_SECS: f64 = 1.0;

/// The playback-vs-raw delta window is asymmetric because every presentation
/// boundary in the harness shifts it the same way: video content appears at
/// the first playback frame tick at-or-after its pts (0..1 frame late), the
/// renderer adds its render latency, and the zero-latency headless sink
/// consumes audio up to one block before the video clock starts. Audio can
/// therefore legitimately read EARLY by up to a frame plus a block plus a
/// render margin, but reading LATE (or early beyond that window) means the
/// editor's playback mapping itself is off.
const RENDER_MARGIN_MS: f64 = 35.0;
const DELTA_LATE_TOLERANCE_MS: f64 = 15.0;
/// Gated on the DIFFERENCE from the raw recording's drift: the fixture's own
/// emission jitter shows up identically in both legs and must not count
/// against playback.
const PASS_TOTAL_DRIFT_MS: f64 = 40.0;
const PASS_MAD_MS: f64 = 25.0;
/// The export decodes the same tracks offline, so its sync must match the
/// raw recording almost exactly (same budget as the av-sync selftest).
const EXPORT_DELTA_TOLERANCE_MS: f64 = 25.0;
/// Ceiling for waiting on playback to finish beyond the timeline duration.
const PLAYBACK_EXTRA_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Args)]
pub struct PlaybackArgs {
    /// Existing flash+beep .cap project to measure (defaults to generating a
    /// synthetic fixture through the real recording pipeline)
    #[arg(long)]
    project: Option<PathBuf>,
    /// Seconds of synthetic fixture pattern to generate
    #[arg(long, default_value_t = 20)]
    duration: u64,
    /// Frame rate to drive editor playback at
    #[arg(long, default_value_t = 30)]
    fps: u32,
    /// Skip exporting the project (tests only the playback stage)
    #[arg(long)]
    skip_export: bool,
    /// Keep the generated fixture project on disk for inspection
    #[arg(long)]
    keep: bool,
}

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
enum Verdict {
    Pass,
    Fail,
    Inconclusive,
}

#[derive(Serialize)]
struct PlaybackReport {
    verdict: Verdict,
    summary: String,
    /// Sync measured in the recording's raw tracks (ground truth).
    raw: Option<SyncMeasurement>,
    /// Sync measured at the editor playback presentation boundaries.
    playback: Option<SyncMeasurement>,
    /// Sync measured in an export of the same project.
    export: Option<SyncMeasurement>,
    /// playback median offset − raw median offset. Negative = audio early.
    delta_ms: Option<f64>,
    delta_early_tolerance_ms: f64,
    delta_late_tolerance_ms: f64,
    pass_total_drift_ms: f64,
    frames_presented: usize,
    project_path: Option<String>,
}

/// How early audio may legitimately read at the presentation taps: one video
/// frame (content quantization) + one audio block (sink start quantization)
/// + the render margin.
fn delta_early_tolerance_ms(fps: u32) -> f64 {
    1000.0 / f64::from(fps)
        + 1000.0 * cap_editor::HEADLESS_BLOCK_FRAMES as f64 / f64::from(HEADLESS_SAMPLE_RATE)
        + RENDER_MARGIN_MS
}

pub async fn run_playback(args: PlaybackArgs, json: bool) -> Result<(), String> {
    ffmpeg::util::log::set_level(ffmpeg::util::log::Level::Quiet);

    if !(1..=240).contains(&args.fps) {
        return Err(format!("invalid playback fps: {}", args.fps));
    }

    let progress = |msg: &str| {
        if !json {
            eprintln!("{msg}");
        }
    };

    let (project_path, generated) = match &args.project {
        Some(path) => (path.clone(), false),
        None => {
            let path = std::env::temp_dir().join(format!(
                "cap-selftest-playback-{}.cap",
                uuid::Uuid::new_v4()
            ));
            // The floor guarantees enough events for measure_sync's minimum
            // after the first event is dropped AND the two events whose
            // flashes fall inside the video gap: 18s -> 9 events -> 7 visible
            // -> 6 pairs.
            let pattern_secs = args.duration.clamp(18, 120) as f64;
            progress(&format!(
                "[1/3] Generating synthetic flash+beep recording ({pattern_secs:.0}s, real-time)..."
            ));
            fixture::generate(&path, pattern_secs).await?;
            (path, true)
        }
    };

    progress("[2/3] Measuring the raw recording...");
    let raw = super::analyze_raw(&project_path);

    progress("[3/3] Playing back through the editor and measuring what it presents...");
    let playback = measure_playback(&project_path, args.fps).await;

    // The export drives the same decoders and timeline mapping as playback
    // through the offline path; on CI this is the only place the export-side
    // VFR gap handling is exercised at all.
    let export = if args.skip_export {
        Ok(None)
    } else {
        progress("Exporting and verifying the export...");
        match crate::export::export_project_default(project_path.clone()).await {
            Ok(output) => super::analyze_export(&output).map(Some),
            Err(e) => Err(format!("export failed: {e}")),
        }
    };

    let (verdict, summary, raw_m, playback_m, export_m, delta_ms, frames_presented) =
        evaluate(&args, raw, playback, export);

    let keep = args.keep || (generated && verdict != Verdict::Pass);
    if generated {
        if keep {
            progress(&format!(
                "Fixture project kept at {}",
                project_path.display()
            ));
        } else {
            let _ = std::fs::remove_dir_all(&project_path);
        }
    }

    let report = PlaybackReport {
        verdict,
        summary: summary.clone(),
        raw: raw_m,
        playback: playback_m,
        export: export_m,
        delta_ms,
        delta_early_tolerance_ms: delta_early_tolerance_ms(args.fps),
        delta_late_tolerance_ms: DELTA_LATE_TOLERANCE_MS,
        pass_total_drift_ms: PASS_TOTAL_DRIFT_MS,
        frames_presented,
        project_path: (keep || !generated).then(|| project_path.display().to_string()),
    };

    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&report)
                .map_err(|e| format!("failed to serialize report: {e}"))?
        );
    } else {
        if let Some(m) = &report.raw {
            println!(
                "\nRecording: offset {:+.0} ms (median), drift {:+.0} ms over {:.0}s, {} events",
                m.median_offset_ms, m.total_drift_ms, m.span_secs, m.inlier_events
            );
        }
        if let Some(m) = &report.playback {
            println!(
                "Playback:  offset {:+.0} ms (median), drift {:+.0} ms over {:.0}s, {} events",
                m.median_offset_ms, m.total_drift_ms, m.span_secs, m.inlier_events
            );
        }
        if let Some(m) = &report.export {
            println!(
                "Export:    offset {:+.0} ms (median), drift {:+.0} ms over {:.0}s, {} events",
                m.median_offset_ms, m.total_drift_ms, m.span_secs, m.inlier_events
            );
        }
        let label = match verdict {
            Verdict::Pass => "PASS",
            Verdict::Fail => "FAIL",
            Verdict::Inconclusive => "INCONCLUSIVE",
        };
        println!("\nResult: {label} — {summary}");
    }

    match verdict {
        Verdict::Pass => Ok(()),
        Verdict::Fail => Err(format!("editor playback sync check failed: {summary}")),
        Verdict::Inconclusive => Err(format!(
            "editor playback sync check inconclusive: {summary}"
        )),
    }
}

#[allow(clippy::type_complexity)]
fn evaluate(
    args: &PlaybackArgs,
    raw: Result<(SyncMeasurement, f64), String>,
    playback: Result<(SyncMeasurement, usize), String>,
    export: Result<Option<(SyncMeasurement, f64)>, String>,
) -> (
    Verdict,
    String,
    Option<SyncMeasurement>,
    Option<SyncMeasurement>,
    Option<SyncMeasurement>,
    Option<f64>,
    usize,
) {
    let (raw_m, _snr) = match raw {
        Ok(v) => v,
        Err(reason) => {
            return (
                Verdict::Inconclusive,
                format!("could not measure the raw recording: {reason}"),
                None,
                None,
                None,
                None,
                0,
            );
        }
    };

    let (playback_m, frames_presented) = match playback {
        Ok(v) => v,
        Err(reason) => {
            return (
                Verdict::Fail,
                format!("editor playback could not be measured: {reason}"),
                Some(raw_m),
                None,
                None,
                None,
                0,
            );
        }
    };

    let export_m = match export {
        Ok(v) => v.map(|(m, _)| m),
        Err(reason) => {
            // A project that plays back but cannot be exported is a hard
            // failure: the export path is part of the product.
            return (
                Verdict::Fail,
                reason,
                Some(raw_m),
                Some(playback_m),
                None,
                None,
                frames_presented,
            );
        }
    };

    let delta = playback_m.median_offset_ms - raw_m.median_offset_ms;
    let early_tolerance = delta_early_tolerance_ms(args.fps);

    let mut reasons = Vec::new();
    if delta < -early_tolerance || delta > DELTA_LATE_TOLERANCE_MS {
        reasons.push(format!(
            "playback shifts sync by {delta:+.0} ms vs the recording \
             (allowed -{early_tolerance:.0}..+{DELTA_LATE_TOLERANCE_MS:.0} ms)"
        ));
    }
    let drift_delta = playback_m.total_drift_ms - raw_m.total_drift_ms;
    if drift_delta.abs() > PASS_TOTAL_DRIFT_MS {
        reasons.push(format!(
            "playback adds {drift_delta:+.0} ms of drift over {:.0}s vs the recording",
            playback_m.span_secs
        ));
    }
    if playback_m.mad_ms > PASS_MAD_MS {
        reasons.push(format!(
            "playback offsets are unstable (spread ±{:.0} ms)",
            playback_m.mad_ms
        ));
    }
    if let Some(export_m) = &export_m {
        let export_delta = (export_m.median_offset_ms - raw_m.median_offset_ms).abs();
        if export_delta > EXPORT_DELTA_TOLERANCE_MS {
            reasons.push(format!(
                "export changes sync by {export_delta:.0} ms vs the recording"
            ));
        }
        let export_drift_delta = export_m.total_drift_ms - raw_m.total_drift_ms;
        if export_drift_delta.abs() > PASS_TOTAL_DRIFT_MS {
            reasons.push(format!(
                "export adds {export_drift_delta:+.0} ms of drift over {:.0}s vs the recording",
                export_m.span_secs
            ));
        }
    }

    let verdict = if reasons.is_empty() {
        Verdict::Pass
    } else {
        Verdict::Fail
    };
    let summary = if reasons.is_empty() {
        format!(
            "editor playback preserves sync (playback {:+.0} ms vs recording {:+.0} ms, drift {:+.0} ms)",
            playback_m.median_offset_ms, raw_m.median_offset_ms, playback_m.total_drift_ms
        )
    } else {
        reasons.join("; ")
    };

    (
        verdict,
        summary,
        Some(raw_m),
        Some(playback_m),
        export_m,
        Some(delta),
        frames_presented,
    )
}

/// Drives the editor's real playback over the project and measures
/// flash-vs-beep alignment in what it presents. Returns the measurement and
/// the number of frames the renderer actually presented.
async fn measure_playback(
    project_path: &Path,
    fps: u32,
) -> Result<(SyncMeasurement, usize), String> {
    // Wall-clock epoch shared by both presentation taps.
    let epoch = Instant::now();

    let video_events: Arc<Mutex<Vec<(f64, f64)>>> = Arc::new(Mutex::new(Vec::new()));
    let frame_cb: cap_editor::EditorFrameCallback = Box::new({
        let video_events = video_events.clone();
        move |output, _layout| {
            let now = Instant::now();
            if let EditorFrameOutput::Rgba(frame) = output {
                if let Some(luma) = mean_center_luma_rgba(
                    &frame.data,
                    frame.width,
                    frame.height,
                    frame.padded_bytes_per_row,
                ) && let Ok(mut events) = video_events.lock()
                {
                    events.push((now.duration_since(epoch).as_secs_f64(), luma));
                }
            }
        }
    });

    struct AudioTapState {
        base_secs: Option<f64>,
        mono: Vec<f32>,
    }
    let audio_tap_state = Arc::new(Mutex::new(AudioTapState {
        base_secs: None,
        mono: Vec::new(),
    }));
    let audio_tap: cap_editor::HeadlessAudioTap = Box::new({
        let state = audio_tap_state.clone();
        move |block: &[f32], deadline: Instant| {
            let Ok(mut state) = state.lock() else {
                return;
            };
            if state.base_secs.is_none() {
                // The pump's schedule is absolute, so the first block deadline
                // anchors an exact sample-index -> wall-time mapping.
                state.base_secs = Some(
                    deadline
                        .checked_duration_since(epoch)
                        .map(|d| d.as_secs_f64())
                        .unwrap_or_else(|| -epoch.duration_since(deadline).as_secs_f64()),
                );
            }
            for frame in block.chunks_exact(usize::from(HEADLESS_CHANNELS)) {
                state
                    .mono
                    .push(frame.iter().sum::<f32>() / frame.len() as f32);
            }
        }
    });

    let audio_output = Arc::new(cap_editor::AudioOutput::new_headless(audio_tap));

    let instance = EditorInstance::new_with_audio_output(
        project_path.to_path_buf(),
        |_| {},
        frame_cb,
        None,
        audio_output,
    )
    .await
    .map_err(|e| format!("failed to open the project in the editor: {e}"))?;

    let resolution_base = {
        let display = &instance.recordings.segments[0].display;
        XY::new(display.width, display.height)
    };

    let total_frames = instance.get_total_frames(fps);
    let expected_duration = Duration::from_secs_f64(f64::from(total_frames) / f64::from(fps));

    instance.start_playback(fps, resolution_base).await;

    let mut handle = instance
        .state
        .lock()
        .await
        .playback_task
        .clone()
        .ok_or("editor playback did not start")?;

    let wait = tokio::time::timeout(expected_duration + PLAYBACK_EXTRA_TIMEOUT, async {
        loop {
            let event = *handle.receive_event().await;
            if matches!(event, cap_editor::PlaybackEvent::Stop) {
                break;
            }
        }
    })
    .await;

    instance.dispose().await;

    if wait.is_err() {
        return Err(format!(
            "playback did not finish within {:?}",
            expected_duration + PLAYBACK_EXTRA_TIMEOUT
        ));
    }

    let video_samples = video_events
        .lock()
        .map_err(|_| "video tap poisoned".to_string())?
        .clone();
    let frames_presented = video_samples.len();
    let (audio_base_secs, mono) = {
        let mut state = audio_tap_state
            .lock()
            .map_err(|_| "audio tap poisoned".to_string())?;
        (
            state.base_secs.unwrap_or(0.0),
            std::mem::take(&mut state.mono),
        )
    };

    let flashes = measure::flash_onsets_from_luma(&video_samples)
        .map_err(|e| format!("playback video ({frames_presented} frames presented): {e}"))?;
    let audio = measure::beep_onsets_from_mono(mono, HEADLESS_SAMPLE_RATE)
        .map_err(|e| format!("playback audio: {e}"))?;
    let beeps: Vec<f64> = audio.onsets.iter().map(|t| t + audio_base_secs).collect();

    measure::measure_sync(&flashes, &beeps, super::MIN_EVENTS)
        .map(|m| (m, frames_presented))
        .map_err(|e| format!("playback pairing ({frames_presented} frames presented): {e}"))
}

/// Mean luma over the center crop of an RGBA/BGRA presentation frame.
/// Channel order doesn't matter for the black/white test pattern.
fn mean_center_luma_rgba(
    data: &[u8],
    width: u32,
    height: u32,
    padded_bytes_per_row: u32,
) -> Option<f64> {
    let width = width as usize;
    let height = height as usize;
    let stride = padded_bytes_per_row as usize;
    if width == 0 || height == 0 || stride < width * 4 || data.len() < stride * height {
        return None;
    }

    let x0 = width / 4;
    let x1 = width * 3 / 4;
    let y0 = height / 4;
    let y1 = height * 3 / 4;

    let mut sum = 0u64;
    let mut count = 0u64;
    let mut y = y0;
    while y < y1 {
        let row = &data[y * stride..y * stride + width * 4];
        let mut x = x0;
        while x < x1 {
            let px = &row[x * 4..x * 4 + 3];
            sum += u64::from(px[0]) + u64::from(px[1]) + u64::from(px[2]);
            count += 3;
            x += 4;
        }
        y += 4;
    }
    (count > 0).then(|| sum as f64 / count as f64)
}

/// Generates a real `.cap` studio project containing a flash+beep pattern by
/// driving the production recording pipeline with synthetic sources — the
/// same real-time channel-source path the sync matrix uses. Only the media
/// origin is synthetic; encoding, muxing and metadata are the real product
/// code paths.
mod fixture {
    use std::{path::Path, time::Duration};

    use cap_media_info::{AudioInfo, RawVideoFormat, Sample, Type, VideoInfo};
    use cap_project::{
        AudioMeta, ClipConfiguration, MultipleSegment, MultipleSegments, Platform,
        ProjectConfiguration, RecordingMeta, RecordingMetaInner, StudioRecordingMeta,
        StudioRecordingStatus, TimelineConfiguration, TimelineSegment, VideoMeta,
    };
    use cap_recording::{
        AudioFrame, ChannelAudioSource, ChannelAudioSourceConfig, ChannelVideoSource,
        ChannelVideoSourceConfig, OutputPipeline,
        ffmpeg::{FFmpegVideoFrame, Mp4Muxer, OggMuxer},
    };
    use cap_timestamp::{Timestamp, Timestamps};
    use relative_path::RelativePathBuf;

    use super::{
        FIXTURE_FLASH_SECS, FIXTURE_FPS, FIXTURE_GAP_LEN_SECS, FIXTURE_GAP_START_SECS,
        FIXTURE_GAP2_LEN_SECS, FIXTURE_GAP2_START_SECS, FIXTURE_HEIGHT, FIXTURE_PERIOD_SECS,
        FIXTURE_SETTLE_SECS, FIXTURE_TAIL_SECS, FIXTURE_WIDTH,
    };

    const AUDIO_RATE: u32 = 48_000;
    const AUDIO_CHUNK_SECS: f64 = 0.02;
    const BEEP_FREQ: f32 = 1_000.0;
    /// Two tracks beep in unison (mic + system audio); keep their sum
    /// comfortably below full scale.
    const BEEP_AMPLITUDE: f32 = 0.35;
    /// The mic device becomes ready shortly after the recording starts, like
    /// real capture hardware. Its start_time (the latest across tracks, since
    /// system audio anchors at the epoch) becomes the playback anchor, so the
    /// fixture exercises the cross-track start_time offset math.
    const FIXTURE_MIC_START_SECS: f64 = 0.3;

    struct Pattern {
        events: Vec<f64>,
        total_secs: f64,
    }

    fn pattern(pattern_secs: f64) -> Pattern {
        let events = ((pattern_secs / FIXTURE_PERIOD_SECS) as u32).max(4);
        // Same deterministic anti-aliasing jitter as the live pattern window
        // (PatternSpec::event_offsets_secs): a perfectly periodic schedule
        // would let a one-period A/V shift alias to a zero measured offset.
        let events: Vec<f64> = (0..events)
            .map(|k| {
                let jitter = (u64::from(k).wrapping_mul(2_654_435_761) % 601) as f64 / 1000.0 - 0.3;
                FIXTURE_SETTLE_SECS + (f64::from(k) * FIXTURE_PERIOD_SECS + jitter).max(0.0)
            })
            .collect();
        let total_secs =
            events.last().copied().unwrap_or(0.0) + FIXTURE_FLASH_SECS + FIXTURE_TAIL_SECS;
        Pattern { events, total_secs }
    }

    fn in_flash(events: &[f64], t: f64) -> bool {
        events.iter().any(|&e| t >= e && t < e + FIXTURE_FLASH_SECS)
    }

    fn in_video_gap(t: f64) -> bool {
        (FIXTURE_GAP_START_SECS..FIXTURE_GAP_START_SECS + FIXTURE_GAP_LEN_SECS).contains(&t)
            || (FIXTURE_GAP2_START_SECS..FIXTURE_GAP2_START_SECS + FIXTURE_GAP2_LEN_SECS)
                .contains(&t)
    }

    pub async fn generate(project_dir: &Path, pattern_secs: f64) -> Result<(), String> {
        let pattern = pattern(pattern_secs);

        let segment_dir = project_dir.join("content/segments/segment-0");
        std::fs::create_dir_all(&segment_dir)
            .map_err(|e| format!("failed to create fixture directories: {e}"))?;
        let display_path = segment_dir.join("display.mp4");
        let mic_path = segment_dir.join("audio-input.ogg");
        let audio_path = segment_dir.join("system_audio.ogg");

        let timestamps = Timestamps::now();

        // Video leg: black frames with white flashes; nothing is emitted
        // inside the gap window, like a static screen under VFR capture.
        let video_info = VideoInfo::from_raw(
            RawVideoFormat::Bgra,
            FIXTURE_WIDTH,
            FIXTURE_HEIGHT,
            FIXTURE_FPS,
        );
        let (video_tx, video_rx) = flume::bounded::<FFmpegVideoFrame>(32);
        let video_emit = {
            let events = pattern.events.clone();
            let total_secs = pattern.total_secs;
            let base = timestamps.instant();
            tokio::spawn(async move {
                let period = 1.0 / f64::from(FIXTURE_FPS);
                let frame_count = (total_secs * f64::from(FIXTURE_FPS)) as u64;
                for k in 0..frame_count {
                    let t = k as f64 * period;
                    if in_video_gap(t) {
                        continue;
                    }
                    tokio::time::sleep_until((base + Duration::from_secs_f64(t)).into()).await;
                    let mut frame = ffmpeg::frame::Video::new(
                        ffmpeg::format::Pixel::BGRA,
                        FIXTURE_WIDTH,
                        FIXTURE_HEIGHT,
                    );
                    let shade = if in_flash(&events, t) { 0xFF } else { 0x00 };
                    frame.data_mut(0).fill(shade);
                    let frame = FFmpegVideoFrame {
                        inner: frame,
                        timestamp: Timestamp::Instant(base + Duration::from_secs_f64(t)),
                    };
                    if video_tx.send_async(frame).await.is_err() {
                        break;
                    }
                }
            })
        };

        // Audio legs: 1 kHz beep bursts aligned to the flashes on BOTH audio
        // tracks so any relative shift between them (or against video) splits
        // the beep clusters and fails the sync gates.
        //
        // The mic delivers continuously from device-ready to stop, like real
        // capture hardware. System audio delivers loopback-style: chunks
        // exist ONLY while a beep plays (WASAPI loopback produces no packets
        // while the system is silent), so the recorder must synthesize the
        // head/gap/tail silence to keep the track on the recording timeline.
        let audio_info = AudioInfo::new(Sample::F32(Type::Packed), AUDIO_RATE, 2)
            .map_err(|e| format!("audio info: {e:?}"))?;

        let beep_chunk = move |chunk_t: f64, events: &[f64]| {
            let chunk_frames = (f64::from(AUDIO_RATE) * AUDIO_CHUNK_SECS) as usize;
            let mut frame = ffmpeg::frame::Audio::new(
                ffmpeg::format::Sample::F32(ffmpeg::format::sample::Type::Packed),
                chunk_frames,
                audio_info.channel_layout(),
            );
            frame.set_rate(AUDIO_RATE);
            let data = frame.data_mut(0);
            let samples = unsafe {
                std::slice::from_raw_parts_mut(data.as_mut_ptr().cast::<f32>(), data.len() / 4)
            };
            for (i, sample) in samples.iter_mut().enumerate() {
                let t = chunk_t + (i / 2) as f64 / f64::from(AUDIO_RATE);
                *sample = if in_flash(events, t) {
                    (t as f32 * BEEP_FREQ * 2.0 * std::f32::consts::PI).sin() * BEEP_AMPLITUDE
                } else {
                    0.0
                };
            }
            frame
        };

        // Both emitters return their sender when done: real capture sources
        // keep the channel open until the recording stops, and the muxer's
        // stop-time tail fill only runs on stop-cancellation, not on
        // channel-closure.
        let (mic_tx, mic_rx) = futures::channel::mpsc::channel::<AudioFrame>(32);
        let mic_emit = {
            let events = pattern.events.clone();
            let total_secs = pattern.total_secs;
            let base = timestamps.instant();
            let mut tx = mic_tx;
            tokio::spawn(async move {
                use futures::SinkExt;
                let first_chunk = (FIXTURE_MIC_START_SECS / AUDIO_CHUNK_SECS).ceil() as usize;
                let total_chunks = (total_secs / AUDIO_CHUNK_SECS).ceil() as usize;
                for k in first_chunk..total_chunks {
                    let chunk_t = k as f64 * AUDIO_CHUNK_SECS;
                    tokio::time::sleep_until((base + Duration::from_secs_f64(chunk_t)).into())
                        .await;
                    let frame = AudioFrame::new(
                        beep_chunk(chunk_t, &events),
                        Timestamp::Instant(base + Duration::from_secs_f64(chunk_t)),
                    );
                    if tx.send(frame).await.is_err() {
                        break;
                    }
                }
                tx
            })
        };

        let (sys_tx, sys_rx) = futures::channel::mpsc::channel::<AudioFrame>(32);
        let sys_emit = {
            let events = pattern.events.clone();
            let base = timestamps.instant();
            let mut tx = sys_tx;
            tokio::spawn(async move {
                use futures::SinkExt;
                for &event in &events {
                    let first_chunk = (event / AUDIO_CHUNK_SECS).floor() as usize;
                    let last_chunk =
                        ((event + FIXTURE_FLASH_SECS) / AUDIO_CHUNK_SECS).ceil() as usize;
                    for k in first_chunk..last_chunk {
                        let chunk_t = k as f64 * AUDIO_CHUNK_SECS;
                        tokio::time::sleep_until((base + Duration::from_secs_f64(chunk_t)).into())
                            .await;
                        let frame = AudioFrame::new(
                            beep_chunk(chunk_t, &events),
                            Timestamp::Instant(base + Duration::from_secs_f64(chunk_t)),
                        );
                        if tx.send(frame).await.is_err() {
                            return tx;
                        }
                    }
                }
                tx
            })
        };

        let video_pipeline = OutputPipeline::builder(display_path.clone())
            .with_video::<ChannelVideoSource<FFmpegVideoFrame>>(ChannelVideoSourceConfig::new(
                video_info, video_rx,
            ))
            .with_timestamps(timestamps)
            .build::<Mp4Muxer>(())
            .await
            .map_err(|e| format!("video pipeline: {e}"))?;
        let mic_pipeline = OutputPipeline::builder(mic_path.clone())
            .with_audio_source::<ChannelAudioSource>(ChannelAudioSourceConfig::new(
                audio_info, mic_rx,
            ))
            .with_timestamps(timestamps)
            .build::<OggMuxer>(())
            .await
            .map_err(|e| format!("mic pipeline: {e}"))?;
        let sys_pipeline = OutputPipeline::builder(audio_path.clone())
            .with_audio_source::<ChannelAudioSource>(ChannelAudioSourceConfig::new(
                audio_info, sys_rx,
            ))
            .with_timestamps(timestamps)
            // System audio anchors at the recording epoch, exactly like the
            // studio recorder configures it.
            .with_audio_anchor(cap_recording::AudioAnchor::PipelineEpoch)
            .build::<OggMuxer>(())
            .await
            .map_err(|e| format!("system audio pipeline: {e}"))?;

        video_emit
            .await
            .map_err(|e| format!("video emit join: {e}"))?;
        let mic_held_tx = mic_emit.await.map_err(|e| format!("mic emit join: {e}"))?;
        let sys_held_tx = sys_emit
            .await
            .map_err(|e| format!("system audio emit join: {e}"))?;
        // Let the stream tails flush through the encoders.
        tokio::time::sleep(Duration::from_millis(500)).await;

        let finished_video = video_pipeline
            .stop()
            .await
            .map_err(|e| format!("video pipeline stop: {e}"))?;
        let finished_mic = mic_pipeline
            .stop()
            .await
            .map_err(|e| format!("mic pipeline stop: {e}"))?;
        let finished_sys = sys_pipeline
            .stop()
            .await
            .map_err(|e| format!("system audio pipeline stop: {e}"))?;
        drop((mic_held_tx, sys_held_tx));

        // Persist metadata the way the studio recorder does: start times are
        // each track's first timestamp on the shared clock, and the timeline
        // covers the real muxed video span.
        let display_start = finished_video
            .first_timestamp
            .signed_duration_since_secs(timestamps);
        let mic_start = finished_mic
            .first_timestamp
            .signed_duration_since_secs(timestamps);
        let sys_start = finished_sys
            .first_timestamp
            .signed_duration_since_secs(timestamps);
        let display_duration = finished_video
            .video_timestamp_span
            .map(|(first, last)| (last - first).as_secs_f64() + 1.0 / f64::from(FIXTURE_FPS))
            .ok_or("fixture video reported no timestamp span")?;

        let to_project_gap_summary =
            |s: cap_recording::AudioGapSummary| cap_project::AudioGapSummary {
                total_overlap_trimmed_ms: s.total_overlap_trimmed_ms,
                startup_overlap_trimmed_ms: s.startup_overlap_trimmed_ms,
                overlap_dropped_frames: s.overlap_dropped_frames,
                startup_overlap_drops: s.startup_overlap_drops,
            };

        let segment = MultipleSegment {
            display: VideoMeta {
                path: RelativePathBuf::from("content/segments/segment-0/display.mp4"),
                fps: FIXTURE_FPS,
                start_time: Some(display_start),
                device_id: None,
            },
            camera: None,
            mic: Some(AudioMeta {
                path: RelativePathBuf::from("content/segments/segment-0/audio-input.ogg"),
                start_time: Some(mic_start),
                device_id: None,
                gap_summary: finished_mic.audio_gap_summary.map(to_project_gap_summary),
            }),
            system_audio: Some(AudioMeta {
                path: RelativePathBuf::from("content/segments/segment-0/system_audio.ogg"),
                start_time: Some(sys_start),
                device_id: None,
                gap_summary: finished_sys.audio_gap_summary.map(to_project_gap_summary),
            }),
            cursor: None,
            keyboard: None,
        };
        // Clip offsets exactly as the studio recorder persists them.
        let offsets = segment.calculate_audio_offsets();

        let meta = StudioRecordingMeta::MultipleSegments {
            inner: MultipleSegments {
                segments: vec![segment],
                cursors: Default::default(),
                status: Some(StudioRecordingStatus::Complete),
            },
        };

        let recording_meta = RecordingMeta {
            platform: Some(Platform::default()),
            project_path: project_dir.to_path_buf(),
            pretty_name: "Cap Playback Selftest Fixture".to_string(),
            sharing: None,
            inner: RecordingMetaInner::Studio(Box::new(meta)),
            upload: None,
        };
        recording_meta
            .save_for_project()
            .map_err(|e| format!("failed to write recording meta: {e:?}"))?;

        let project_config = ProjectConfiguration {
            timeline: Some(TimelineConfiguration {
                segments: vec![TimelineSegment {
                    recording_clip: 0,
                    start: 0.0,
                    end: display_duration,
                    timescale: 1.0,
                    name: None,
                }],
                zoom_segments: Vec::new(),
                scene_segments: Vec::new(),
                mask_segments: Vec::new(),
                text_segments: Vec::new(),
                caption_segments: Vec::new(),
                keyboard_segments: Vec::new(),
                audio_segments: Vec::new(),
            }),
            clips: vec![ClipConfiguration {
                index: 0,
                offsets,
                offsets_auto_calculated: true,
            }],
            ..Default::default()
        };
        project_config
            .write(project_dir)
            .map_err(|e| format!("failed to write project config: {e}"))?;

        Ok(())
    }
}
