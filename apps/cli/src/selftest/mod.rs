//! `cap selftest` — diagnostics that verify Cap works correctly on this
//! machine, starting with an end-to-end A/V sync test: record a known
//! flash+beep pattern through the real capture pipeline, then measure the
//! flash-to-beep offset in both the raw recording and an export of it.

pub mod measure;
pub mod pattern;
pub mod playback;

use std::{
    path::{Path, PathBuf},
    time::Duration,
};

use cap_project::{RecordingMeta, RecordingMetaInner, StudioRecordingMeta};
use clap::{Args, Subcommand};
use serde::Serialize;

use measure::SyncMeasurement;
use pattern::PatternSpec;

const DEFAULT_PATTERN_SECS: u64 = 20;
const EVENT_PERIOD: Duration = Duration::from_secs(2);
const FLASH_LEN: Duration = Duration::from_millis(120);
const SETTLE: Duration = Duration::from_secs(2);
const MIN_EVENTS: usize = 6;

const PASS_OFFSET_MS: f64 = 80.0;
const PASS_TOTAL_DRIFT_MS: f64 = 20.0;
const PASS_MAD_MS: f64 = 20.0;
const WARN_OFFSET_MS: f64 = 120.0;
const WARN_TOTAL_DRIFT_MS: f64 = 40.0;
const WARN_MAD_MS: f64 = 40.0;
const MAX_RAW_EXPORT_DELTA_MS: f64 = 25.0;
const MIN_BEEP_SNR: f64 = 8.0;
/// Extra offset budget for the acoustic microphone path: sound flight time
/// plus input device latency.
const MIC_EXTRA_OFFSET_MS: f64 = 60.0;
/// Acoustic pickup competes with room noise; a lower SNR still yields sharp
/// onsets for a 1 kHz tone.
const MIN_MIC_SNR: f64 = 4.0;

#[derive(Args)]
pub struct SelftestArgs {
    #[command(subcommand)]
    pub command: SelftestCommands,
}

#[derive(Subcommand)]
pub enum SelftestCommands {
    /// Record a test pattern and verify audio/video sync end-to-end
    #[command(name = "av-sync")]
    AvSync(AvSyncArgs),
    /// Verify the editor playback path preserves audio/video sync
    #[command(name = "playback")]
    Playback(playback::PlaybackArgs),
    /// Internal: measure flash/beep onsets in an existing recording or export
    #[command(name = "analyze", hide = true)]
    Analyze(AnalyzeArgs),
}

#[derive(Args)]
pub struct AnalyzeArgs {
    /// Video file (or file containing both tracks)
    video: PathBuf,
    /// Separate audio file (defaults to the video file's audio track)
    #[arg(long)]
    audio: Option<PathBuf>,
    /// Added to flash times (track start offset)
    #[arg(long, default_value_t = 0.0)]
    voffset: f64,
    /// Added to beep times (track start offset)
    #[arg(long, default_value_t = 0.0)]
    aoffset: f64,
}

#[derive(Args)]
pub struct AvSyncArgs {
    /// Seconds of test pattern to record (longer = more sensitive to drift)
    #[arg(long, default_value_t = DEFAULT_PATTERN_SECS)]
    duration: u64,
    /// Maximum fps to record at (defaults to the standard recording fps)
    #[arg(long)]
    fps: Option<u32>,
    /// Also record a microphone and verify its sync acoustically (the mic
    /// must be able to hear the test beeps through your speakers)
    #[arg(long)]
    mic: bool,
    /// Microphone device name to use with --mic (defaults to the default mic)
    #[arg(long)]
    mic_name: Option<String>,
    /// Skip exporting the recording (tests only the recording stage)
    #[arg(long)]
    skip_export: bool,
    /// Keep the recorded project on disk for inspection
    #[arg(long)]
    keep: bool,
}

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
enum Verdict {
    Pass,
    Warn,
    Fail,
    Inconclusive,
}

#[derive(Serialize)]
struct Thresholds {
    pass_offset_ms: f64,
    pass_total_drift_ms: f64,
    warn_offset_ms: f64,
    warn_total_drift_ms: f64,
    max_raw_export_delta_ms: f64,
}

#[derive(Serialize)]
struct Diagnostics {
    beep_snr: Option<f64>,
    audio_output_latency_ms: Option<f64>,
    /// Median (beep DAC time − flash present time) at emission; the part of
    /// the measured offset contributed by the test rig itself.
    emission_skew_ms: Option<f64>,
    project_path: Option<String>,
}

#[derive(Serialize)]
struct AvSyncReport {
    verdict: Verdict,
    summary: String,
    recording: Option<SyncMeasurement>,
    microphone: Option<SyncMeasurement>,
    export: Option<SyncMeasurement>,
    thresholds: Thresholds,
    diagnostics: Diagnostics,
}

impl SelftestArgs {
    pub async fn run(self, json: bool) -> Result<(), String> {
        match self.command {
            SelftestCommands::AvSync(args) => run_av_sync(args, json).await,
            SelftestCommands::Playback(args) => playback::run_playback(args, json).await,
            SelftestCommands::Analyze(args) => run_analyze(args),
        }
    }
}

fn run_analyze(args: AnalyzeArgs) -> Result<(), String> {
    let flashes: Vec<f64> = measure::video_flash_onsets(&args.video)?
        .into_iter()
        .map(|t| t + args.voffset)
        .collect();
    let audio_path = args.audio.as_ref().unwrap_or(&args.video);
    let audio = measure::audio_beep_onsets(audio_path)?;
    let beeps: Vec<f64> = audio.onsets.iter().map(|t| t + args.aoffset).collect();
    eprintln!(
        "flashes: {} beeps: {} (snr {:.1})",
        flashes.len(),
        beeps.len(),
        audio.snr
    );
    let measurement = measure::measure_sync(&flashes, &beeps, MIN_EVENTS)?;
    println!(
        "{}",
        serde_json::to_string_pretty(&measurement)
            .map_err(|e| format!("failed to serialize: {e}"))?
    );
    Ok(())
}

fn progress(json: bool, msg: &str) {
    if !json {
        eprintln!("{msg}");
    }
}

async fn run_av_sync(args: AvSyncArgs, json: bool) -> Result<(), String> {
    // ffmpeg's own stderr chatter (muxer segment writes, codec notes) drowns
    // the progress output; measurement errors are surfaced through Results.
    ffmpeg::util::log::set_level(ffmpeg::util::log::Level::Quiet);

    // The floor guarantees enough events for measure_sync's minimum after the
    // first event is dropped: 14s -> 7 events -> 6 usable pairs.
    let pattern_secs = args.duration.clamp(14, 120);
    let events = (pattern_secs / EVENT_PERIOD.as_secs()).max(3) as u32;
    let spec = PatternSpec {
        settle: SETTLE,
        events,
        period: EVENT_PERIOD,
        flash_len: FLASH_LEN,
    };

    // Rough wall-clock estimate: settle + pattern + finalize + analysis (+ export).
    let estimate_secs = spec.total_runtime().as_secs() + 4 + if args.skip_export { 0 } else { 6 };

    progress(json, "Cap A/V sync self-test");
    progress(
        json,
        &format!(
            "This will take about {} seconds.",
            (estimate_secs as f64 / 10.0).round() as u64 * 10
        ),
    );
    progress(
        json,
        "A black window will appear with brief white flashes and short beeps.\n\
         Leave the window visible and make sure output volume is not muted.\n",
    );

    let project_path =
        std::env::temp_dir().join(format!("cap-selftest-{}.cap", uuid::Uuid::new_v4()));

    progress(
        json,
        &format!("[1/4] Recording test pattern ({pattern_secs}s)..."),
    );
    let mic_name =
        if args.mic || args.mic_name.is_some() {
            match args.mic_name.clone().or_else(|| {
                cap_recording::MicrophoneFeed::default_device().map(|(label, _, _)| label)
            }) {
                Some(label) => {
                    progress(json, &format!("Including microphone: {label}"));
                    Some(label)
                }
                None => return Err("no microphone available for --mic".to_string()),
            }
        } else {
            None
        };

    let handle = start_recording(&project_path, args.fps, mic_name.clone()).await?;

    // Give capture a moment to deliver first frames before the pattern starts.
    tokio::time::sleep(Duration::from_millis(500)).await;

    let pattern_result = pattern::request_pattern(spec).await;

    let report = match pattern_result {
        Ok(report) => report,
        Err(e) => {
            let _ = handle.stop().await;
            let _ = std::fs::remove_dir_all(&project_path);
            if e == "cancelled" {
                return Err("self-test cancelled".to_string());
            }
            return Err(format!("test pattern failed: {e}"));
        }
    };

    // Let the tail of the last beep land in the recording.
    tokio::time::sleep(Duration::from_secs(1)).await;

    progress(json, "[2/4] Finalizing recording...");
    let completed = handle
        .stop()
        .await
        .map_err(|e| format!("failed to stop recording: {e}"))?;
    let project_path = completed.project_path.clone();

    // Fragmented recordings need the shared remux step before their segment
    // files are directly readable (the same step the desktop app runs).
    {
        let project_path = project_path.clone();
        tokio::task::spawn_blocking(move || {
            cap_recording::recovery::RecoveryManager::remux_if_needed(&project_path)
        })
        .await
        .map_err(|e| format!("remux task join error: {e}"))?
        .map_err(|e| format!("failed to finalize recording segments: {e}"))?;
    }

    let emission_skew_ms = median_emission_skew_ms(&report);

    progress(json, "[3/4] Analyzing recording...");
    let raw = analyze_raw(&project_path);
    let mic = mic_name.is_some().then(|| analyze_mic(&project_path));

    let export = if args.skip_export {
        Ok(None)
    } else {
        progress(json, "[4/4] Exporting and verifying the export...");
        match crate::export::export_project_default(project_path.clone()).await {
            Ok(output) => analyze_export(&output).map(Some),
            Err(e) => Err(format!("export failed: {e}")),
        }
    };

    let (verdict, summary, raw_m, mic_m, export_m, snr) = evaluate(raw, mic, export);

    let keep = args.keep || verdict != Verdict::Pass;
    if keep {
        progress(
            json,
            &format!("Recorded project kept at {}", project_path.display()),
        );
    } else {
        let _ = std::fs::remove_dir_all(&project_path);
    }

    let report = AvSyncReport {
        verdict,
        summary: summary.clone(),
        recording: raw_m,
        microphone: mic_m,
        export: export_m,
        thresholds: Thresholds {
            pass_offset_ms: PASS_OFFSET_MS,
            pass_total_drift_ms: PASS_TOTAL_DRIFT_MS,
            warn_offset_ms: WARN_OFFSET_MS,
            warn_total_drift_ms: WARN_TOTAL_DRIFT_MS,
            max_raw_export_delta_ms: MAX_RAW_EXPORT_DELTA_MS,
        },
        diagnostics: Diagnostics {
            beep_snr: snr,
            audio_output_latency_ms: report.audio_latency_ms,
            emission_skew_ms,
            project_path: keep.then(|| project_path.display().to_string()),
        },
    };

    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&report)
                .map_err(|e| format!("failed to serialize report: {e}"))?
        );
    } else {
        print_human(&report);
    }

    match verdict {
        Verdict::Pass | Verdict::Warn => Ok(()),
        Verdict::Fail => Err(format!("A/V sync check failed: {summary}")),
        Verdict::Inconclusive => Err(format!("A/V sync check inconclusive: {summary}")),
    }
}

fn print_human(report: &AvSyncReport) {
    println!();
    if let Some(m) = &report.recording {
        println!(
            "Recording: offset {:+.0} ms (median), drift {:+.0} ms over {:.0}s, {} events (spread ±{:.0} ms)",
            m.median_offset_ms, m.total_drift_ms, m.span_secs, m.inlier_events, m.mad_ms
        );
    }
    if let Some(m) = &report.microphone {
        println!(
            "Microphone: offset {:+.0} ms (median), drift {:+.0} ms over {:.0}s, {} events (spread ±{:.0} ms)",
            m.median_offset_ms, m.total_drift_ms, m.span_secs, m.inlier_events, m.mad_ms
        );
    }
    if let Some(m) = &report.export {
        println!(
            "Export:    offset {:+.0} ms (median), drift {:+.0} ms over {:.0}s, {} events (spread ±{:.0} ms)",
            m.median_offset_ms, m.total_drift_ms, m.span_secs, m.inlier_events, m.mad_ms
        );
    }
    let label = match report.verdict {
        Verdict::Pass => "PASS",
        Verdict::Warn => "WARN",
        Verdict::Fail => "FAIL",
        Verdict::Inconclusive => "INCONCLUSIVE",
    };
    println!("\nResult: {label} — {}", report.summary);
}

async fn start_recording(
    path: &Path,
    fps: Option<u32>,
    mic_name: Option<String>,
) -> Result<cap_recording::studio_recording::ActorHandle, String> {
    use cap_recording::{
        MicrophoneFeed, feeds::microphone, screen_capture::ScreenCaptureTarget, studio_recording,
    };
    use kameo::Actor as _;

    let display = scap_targets::Display::primary();
    let target = ScreenCaptureTarget::Display { id: display.id() };

    let mut builder =
        studio_recording::Actor::builder(path.to_path_buf(), target).with_system_audio(true);

    if let Some(label) = mic_name {
        let (error_tx, _error_rx) = flume::bounded(16);
        let mic_feed = MicrophoneFeed::spawn(MicrophoneFeed::new(error_tx));
        mic_feed
            .ask(microphone::SetInput {
                label: label.clone(),
                settings: None,
            })
            .await
            .map_err(|e| format!("failed to set microphone input '{label}': {e}"))?
            .await
            .map_err(|e| format!("microphone '{label}' failed to connect: {e}"))?;
        // The stream needs a moment to warm up before locking on slower devices.
        tokio::time::sleep(Duration::from_millis(100)).await;
        let lock = mic_feed
            .ask(microphone::Lock)
            .await
            .map_err(|e| format!("failed to lock microphone feed: {e}"))?;
        builder = builder.with_mic_feed(std::sync::Arc::new(lock));
    }

    let builder =
        cap_recording::RecordingDefaults::default().apply_to_studio_builder(builder, false, fps);

    #[cfg(target_os = "macos")]
    let shareable_content = cidre::sc::ShareableContent::current()
        .await
        .map_err(|e| {
            format!(
                "screen recording permission unavailable: {e}. \
                 Grant Cap screen recording access in System Settings and retry."
            )
        })
        .map(cap_recording::SendableShareableContent::from)?;

    builder
        .build(
            #[cfg(target_os = "macos")]
            Some(shareable_content),
        )
        .await
        .map_err(|e| format!("failed to start recording: {e}"))
}

struct RawTracks {
    display: PathBuf,
    system_audio: PathBuf,
    display_start: f64,
    audio_start: f64,
    mic: Option<(PathBuf, f64)>,
}

fn locate_raw_tracks(project_path: &Path) -> Result<RawTracks, String> {
    let meta = RecordingMeta::load_for_project(project_path)
        .map_err(|e| format!("failed to load recording meta: {e}"))?;
    let RecordingMetaInner::Studio(studio) = &meta.inner else {
        return Err("self-test recording is not a studio recording".to_string());
    };
    let StudioRecordingMeta::MultipleSegments { inner, .. } = &**studio else {
        return Err("unexpected single-segment recording".to_string());
    };
    let segment = inner.segments.first().ok_or("recording has no segments")?;
    let audio = segment
        .system_audio
        .as_ref()
        .ok_or("recording has no system audio track")?;

    // Fragmented recordings write meta before remux, so the display path may
    // still reference the fragments directory; the remuxed file sits next to it.
    let mut display = meta.path(&segment.display.path);
    if display.is_dir() {
        display = display.with_extension("mp4");
    }
    if !display.is_file() {
        return Err(format!("display track not found at {}", display.display()));
    }

    let mic = segment
        .mic
        .as_ref()
        .map(|mic| (meta.path(&mic.path), mic.start_time.unwrap_or(0.0)));

    Ok(RawTracks {
        display,
        system_audio: meta.path(&audio.path),
        display_start: segment.display.start_time.unwrap_or(0.0),
        audio_start: audio.start_time.unwrap_or(0.0),
        mic,
    })
}

type MeasureOutcome = Result<(SyncMeasurement, f64), String>;

fn analyze_raw(project_path: &Path) -> MeasureOutcome {
    let tracks = locate_raw_tracks(project_path)?;

    let flashes: Vec<f64> = measure::video_flash_onsets(&tracks.display)?
        .into_iter()
        .map(|t| t + tracks.display_start)
        .collect();
    let audio = measure::audio_beep_onsets(&tracks.system_audio)?;
    let beeps: Vec<f64> = audio
        .onsets
        .iter()
        .map(|t| t + tracks.audio_start)
        .collect();

    if audio.snr < MIN_BEEP_SNR {
        return Err(format!(
            "test tone barely audible in the recording (SNR {:.1}); \
             check that output volume is not muted",
            audio.snr
        ));
    }

    measure::measure_sync(&flashes, &beeps, MIN_EVENTS).map(|m| (m, audio.snr))
}

/// Measures the microphone track against the display flashes. The beeps
/// reach the mic acoustically, so this validates the real input-device path
/// end to end (device rate, resampling, timestamping).
fn analyze_mic(project_path: &Path) -> MeasureOutcome {
    let tracks = locate_raw_tracks(project_path)?;
    let (mic_path, mic_start) = tracks
        .mic
        .ok_or("recording has no microphone track despite --mic")?;

    let flashes: Vec<f64> = measure::video_flash_onsets(&tracks.display)?
        .into_iter()
        .map(|t| t + tracks.display_start)
        .collect();
    let audio = measure::audio_beep_onsets(&mic_path)?;
    let beeps: Vec<f64> = audio.onsets.iter().map(|t| t + mic_start).collect();

    if audio.snr < MIN_MIC_SNR {
        return Err(format!(
            "test tone barely audible through the microphone (SNR {:.1}); \
             raise the output volume or move the mic closer to the speakers",
            audio.snr
        ));
    }

    measure::measure_sync(&flashes, &beeps, MIN_EVENTS).map(|m| (m, audio.snr))
}

fn analyze_export(output: &Path) -> MeasureOutcome {
    let flashes = measure::video_flash_onsets(output)?;
    let audio = measure::audio_beep_onsets(output)?;
    measure::measure_sync(&flashes, &audio.onsets, MIN_EVENTS).map(|m| (m, audio.snr))
}

fn median_emission_skew_ms(report: &pattern::PatternReport) -> Option<f64> {
    let mut skews: Vec<f64> = report
        .flash_presents
        .iter()
        .filter_map(|(event, flash)| {
            let (_, beep) = report.beep_outputs.iter().find(|(e, _)| e == event)?;
            Some(if beep >= flash {
                (*beep - *flash).as_secs_f64() * 1000.0
            } else {
                -((*flash - *beep).as_secs_f64() * 1000.0)
            })
        })
        .collect();
    if skews.is_empty() {
        return None;
    }
    skews.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    Some(skews[skews.len() / 2])
}

fn classify(m: &SyncMeasurement) -> Verdict {
    let offset = m.median_offset_ms.abs();
    let drift = m.total_drift_ms.abs();
    if offset <= PASS_OFFSET_MS && drift <= PASS_TOTAL_DRIFT_MS && m.mad_ms <= PASS_MAD_MS {
        Verdict::Pass
    } else if offset <= WARN_OFFSET_MS && drift <= WARN_TOTAL_DRIFT_MS && m.mad_ms <= WARN_MAD_MS {
        Verdict::Warn
    } else {
        Verdict::Fail
    }
}

#[allow(clippy::type_complexity)]
/// Classifies the acoustic microphone measurement: same drift/spread rules
/// as the digital path, with extra offset budget for sound flight time and
/// input device latency.
fn classify_mic(m: &SyncMeasurement) -> Verdict {
    let offset = m.median_offset_ms.abs();
    let drift = m.total_drift_ms.abs();
    if offset <= PASS_OFFSET_MS + MIC_EXTRA_OFFSET_MS
        && drift <= PASS_TOTAL_DRIFT_MS
        && m.mad_ms <= PASS_MAD_MS
    {
        Verdict::Pass
    } else if offset <= WARN_OFFSET_MS + MIC_EXTRA_OFFSET_MS
        && drift <= WARN_TOTAL_DRIFT_MS
        && m.mad_ms <= WARN_MAD_MS
    {
        Verdict::Warn
    } else {
        Verdict::Fail
    }
}

/// Merges verdicts: Fail dominates everything, otherwise the worse one wins.
fn merge_verdicts(a: Verdict, b: Verdict) -> Verdict {
    if a == Verdict::Fail || b == Verdict::Fail {
        Verdict::Fail
    } else {
        a.max(b)
    }
}

#[allow(clippy::type_complexity)]
fn evaluate(
    raw: MeasureOutcome,
    mic: Option<MeasureOutcome>,
    export: Result<Option<(SyncMeasurement, f64)>, String>,
) -> (
    Verdict,
    String,
    Option<SyncMeasurement>,
    Option<SyncMeasurement>,
    Option<SyncMeasurement>,
    Option<f64>,
) {
    let (raw_m, snr) = match raw {
        Ok((m, snr)) => (m, snr),
        Err(reason) => {
            return (Verdict::Inconclusive, reason, None, None, None, None);
        }
    };

    let export_m = match export {
        Ok(Some((m, _))) => Some(m),
        Ok(None) => None,
        Err(reason) => {
            // A recording that measures fine but cannot be exported is a hard
            // failure: the export path is part of the product.
            return (Verdict::Fail, reason, Some(raw_m), None, None, Some(snr));
        }
    };

    let mut verdict = classify(&raw_m);
    let mut reasons: Vec<String> = Vec::new();

    if verdict != Verdict::Pass {
        reasons.push(format!(
            "recording offset {:+.0} ms / drift {:+.0} ms over {:.0}s",
            raw_m.median_offset_ms, raw_m.total_drift_ms, raw_m.span_secs
        ));
    }

    let mic_m = match mic {
        None => None,
        Some(Ok((m, _))) => {
            let mic_verdict = classify_mic(&m);
            if mic_verdict != Verdict::Pass {
                reasons.push(format!(
                    "microphone offset {:+.0} ms / drift {:+.0} ms over {:.0}s",
                    m.median_offset_ms, m.total_drift_ms, m.span_secs
                ));
            }
            verdict = merge_verdicts(verdict, mic_verdict);
            Some(m)
        }
        Some(Err(reason)) => {
            // The mic leg was explicitly requested; not being able to measure
            // it makes the run inconclusive (unless something already failed).
            verdict = merge_verdicts(verdict, Verdict::Inconclusive);
            reasons.push(reason);
            None
        }
    };

    if let Some(export_m) = &export_m {
        let export_verdict = classify(export_m);
        if export_verdict != Verdict::Pass {
            reasons.push(format!(
                "export offset {:+.0} ms / drift {:+.0} ms over {:.0}s",
                export_m.median_offset_ms, export_m.total_drift_ms, export_m.span_secs
            ));
        }
        verdict = merge_verdicts(verdict, export_verdict);
        let delta = (export_m.median_offset_ms - raw_m.median_offset_ms).abs();
        if delta > MAX_RAW_EXPORT_DELTA_MS {
            verdict = Verdict::Fail;
            reasons.push(format!(
                "export changes sync by {delta:.0} ms vs the recording"
            ));
        }
    }

    let summary = match verdict {
        Verdict::Pass => format!(
            "audio/video sync is healthy (offset {:+.0} ms, drift {:+.0} ms over {:.0}s)",
            raw_m.median_offset_ms, raw_m.total_drift_ms, raw_m.span_secs
        ),
        Verdict::Warn => format!(
            "sync is within tolerance but not ideal: {}",
            reasons.join("; ")
        ),
        Verdict::Fail => format!("sync problem detected: {}", reasons.join("; ")),
        Verdict::Inconclusive => reasons.join("; "),
    };

    (verdict, summary, Some(raw_m), mic_m, export_m, Some(snr))
}

impl PartialOrd for Verdict {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for Verdict {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        fn rank(v: &Verdict) -> u8 {
            match v {
                Verdict::Pass => 0,
                Verdict::Warn => 1,
                Verdict::Fail => 2,
                Verdict::Inconclusive => 3,
            }
        }
        rank(self).cmp(&rank(other))
    }
}
