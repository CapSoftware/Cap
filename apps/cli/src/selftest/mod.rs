//! `cap selftest` — diagnostics that verify Cap works correctly on this
//! machine, starting with an end-to-end A/V sync test: record a known
//! flash+beep pattern through the real capture pipeline, then measure the
//! flash-to-beep offset in both the raw recording and an export of it.

pub mod instant;
pub mod measure;
pub mod pattern;
pub mod playback;

use std::{
    io::Write,
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};

use cap_project::{RecordingMeta, RecordingMetaInner, StudioRecordingMeta};
use clap::{Args, Subcommand, ValueEnum};
use serde::Serialize;

use measure::SyncMeasurement;
use pattern::{PatternReport, PatternSpec};

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
    /// Which recording pipeline to test: studio, instant, or both
    #[arg(long, value_enum, default_value_t = SyncMode::Studio)]
    mode: SyncMode,
    /// Maximum fps to record at (defaults to the standard recording fps)
    #[arg(long)]
    fps: Option<u32>,
    /// Also record a microphone and verify its sync acoustically (the mic
    /// must be able to hear the test beeps through your speakers). Applies to
    /// the studio leg only; the instant leg records system audio alone.
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
    /// Always delete the recorded project, even when the check fails. The
    /// desktop apps pass this: they surface the report, not the recording.
    #[arg(long)]
    discard_recordings: bool,
    /// Emit newline-delimited JSON progress on stdout: one message per stage
    /// transition, then the final report. Human logs stay on stderr.
    #[arg(long)]
    progress_json: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, ValueEnum)]
pub enum SyncMode {
    Studio,
    Instant,
    Both,
}

impl std::fmt::Display for SyncMode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.name())
    }
}

impl SyncMode {
    fn name(self) -> &'static str {
        match self {
            Self::Studio => "studio",
            Self::Instant => "instant",
            Self::Both => "both",
        }
    }

    fn runs_studio(self) -> bool {
        matches!(self, Self::Studio | Self::Both)
    }

    fn runs_instant(self) -> bool {
        matches!(self, Self::Instant | Self::Both)
    }
}

/// Machine-readable progress for callers driving the self-test (the desktop
/// Feedback page). Stage names are stable API: `collecting`, `recording`,
/// `pattern-run`, `remuxing`, `analyzing`, `exporting`, `done`.
#[derive(Serialize)]
#[serde(tag = "type")]
enum ProgressMessage<'a> {
    Stage {
        stage: &'static str,
        mode: Option<&'static str>,
    },
    Report {
        report: &'a AvSyncReport,
    },
    Error {
        error: &'a str,
    },
}

struct Reporter {
    /// The global `--json` flag: suppresses human logs, as it always has.
    json: bool,
    /// The `--progress-json` flag: turns stdout into an NDJSON stream.
    ndjson: bool,
    emitted_report: AtomicBool,
}

impl Reporter {
    fn log(&self, msg: &str) {
        if !self.json {
            eprintln!("{msg}");
        }
    }

    fn stage(&self, stage: &'static str, mode: Option<&'static str>) {
        self.emit(&ProgressMessage::Stage { stage, mode });
    }

    fn report(&self, report: &AvSyncReport) {
        self.emit(&ProgressMessage::Report { report });
        self.emitted_report.store(true, Ordering::Release);
    }

    fn error(&self, error: &str) {
        self.emit(&ProgressMessage::Error { error });
    }

    fn emitted_report(&self) -> bool {
        self.emitted_report.load(Ordering::Acquire)
    }

    fn emit(&self, message: &ProgressMessage<'_>) {
        if !self.ndjson {
            return;
        }
        let Ok(line) = serde_json::to_string(message) else {
            return;
        };
        println!("{line}");
        // The process can exit via exit_after_success without unwinding, so
        // every line is flushed as it is written.
        let _ = std::io::stdout().flush();
    }
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
    instant_project_path: Option<String>,
}

#[derive(Serialize)]
struct AvSyncReport {
    verdict: Verdict,
    summary: String,
    /// Which legs ran: "studio", "instant" or "both".
    mode: String,
    /// The studio leg's raw recording measurement.
    recording: Option<SyncMeasurement>,
    microphone: Option<SyncMeasurement>,
    export: Option<SyncMeasurement>,
    /// The instant leg's measurement of content/output.mp4.
    instant: Option<SyncMeasurement>,
    /// Set when a leg could not run at all; the other leg still reports.
    studio_error: Option<String>,
    instant_error: Option<String>,
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

/// A leg that could not produce any measurement. Cancellation is separate:
/// the user closed the pattern window, so no further leg should open one.
enum LegFailure {
    Cancelled,
    Failed(String),
}

/// Removes a temp `.cap` directory when a leg leaves without handing it over.
///
/// Only the pattern-failure path used to clean up after itself, so a failed
/// `stop()`, remux or instant finalize left a full screen recording behind in
/// the temp directory with nothing tracking it.
struct TempProject {
    /// Every directory this leg is responsible for: the one it created, plus
    /// whatever the recording actor reports back from `stop()` (the same
    /// directory in practice, tracked explicitly so the guard covers the one
    /// that actually exists either way).
    paths: Vec<PathBuf>,
}

impl TempProject {
    fn new(path: PathBuf) -> Self {
        Self { paths: vec![path] }
    }

    fn path(&self) -> &Path {
        self.paths
            .first()
            .expect("a temp project always keeps the path it was created with")
    }

    fn track(&mut self, path: PathBuf) {
        if !self.paths.contains(&path) {
            self.paths.push(path);
        }
    }

    /// Hands the directories to the caller, which becomes responsible for them.
    fn keep(mut self) {
        self.paths.clear();
    }
}

impl Drop for TempProject {
    fn drop(&mut self) {
        for path in &self.paths {
            let _ = std::fs::remove_dir_all(path);
        }
    }
}

/// A leg that produced no measurement: it reports as inconclusive and its
/// reason is carried in the report's matching `*_error` field.
fn failed_leg(error: String) -> (LegSummary, String) {
    (
        LegSummary {
            verdict: Verdict::Inconclusive,
            summary: error.clone(),
        },
        error,
    )
}

/// Everything one studio leg produced, still unevaluated.
struct StudioLeg {
    project_path: PathBuf,
    pattern: PatternReport,
    raw: MeasureOutcome,
    mic: Option<MeasureOutcome>,
    export: Result<Option<(SyncMeasurement, f64)>, String>,
}

struct InstantLeg {
    project_path: PathBuf,
    pattern: PatternReport,
    measurement: MeasureOutcome,
}

/// One leg's contribution to the overall verdict.
#[derive(Debug, Clone, PartialEq)]
struct LegSummary {
    verdict: Verdict,
    summary: String,
}

async fn run_av_sync(args: AvSyncArgs, json: bool) -> Result<(), String> {
    let reporter = Reporter {
        json,
        ndjson: args.progress_json,
        emitted_report: AtomicBool::new(false),
    };

    let result = run_av_sync_inner(args, json, &reporter).await;

    // A verdict of Fail/Inconclusive already shipped a report; only a run that
    // never got that far reports as an error.
    if let Err(error) = &result
        && !reporter.emitted_report()
    {
        reporter.error(error);
    }

    result
}

async fn run_av_sync_inner(
    args: AvSyncArgs,
    json: bool,
    reporter: &Reporter,
) -> Result<(), String> {
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
    let studio_estimate = spec.total_runtime().as_secs() + 4 + if args.skip_export { 0 } else { 6 };
    let instant_estimate = spec.total_runtime().as_secs() + 6;
    let estimate_secs = if args.mode.runs_studio() {
        studio_estimate
    } else {
        0
    } + if args.mode.runs_instant() {
        instant_estimate
    } else {
        0
    };

    reporter.log("Cap A/V sync self-test");
    reporter.log(&format!(
        "This will take about {} seconds.",
        (estimate_secs as f64 / 10.0).round() as u64 * 10
    ));
    reporter.log(
        "A black window will appear with brief white flashes and short beeps.\n\
         Leave the window visible and make sure output volume is not muted.\n",
    );

    let studio = if args.mode.runs_studio() {
        match run_studio_leg(&args, spec, pattern_secs, reporter).await {
            Ok(leg) => Some(Ok(leg)),
            Err(LegFailure::Cancelled) => return Err("self-test cancelled".to_string()),
            // A single-leg run keeps today's behaviour exactly: the failure is
            // the command's error, with no report.
            Err(LegFailure::Failed(e)) if args.mode == SyncMode::Studio => return Err(e),
            Err(LegFailure::Failed(e)) => Some(Err(e)),
        }
    } else {
        None
    };

    // Cancelling the instant leg of a two-leg run must not discard the studio
    // leg that already completed: the run falls through to the cleanup and the
    // report, and only returns the cancellation once both have happened.
    let mut cancelled = false;

    let instant = if args.mode.runs_instant() {
        match run_instant_leg(&args, spec, pattern_secs, reporter).await {
            Ok(leg) => Some(Ok(leg)),
            // A single-leg run keeps today's behaviour exactly: no report.
            Err(LegFailure::Cancelled) if args.mode == SyncMode::Instant => {
                return Err("self-test cancelled".to_string());
            }
            Err(LegFailure::Cancelled) => {
                cancelled = true;
                Some(Err("cancelled".to_string()))
            }
            Err(LegFailure::Failed(e)) if args.mode == SyncMode::Instant => return Err(e),
            Err(LegFailure::Failed(e)) => Some(Err(e)),
        }
    } else {
        None
    };

    let mut studio_error = None;
    let mut instant_error = None;
    let mut raw_m = None;
    let mut mic_m = None;
    let mut export_m = None;
    let mut instant_m = None;
    let mut snr = None;
    let mut audio_latency_ms = None;
    let mut emission_skew_ms = None;
    let mut studio_summary = None;
    let mut instant_summary = None;
    let mut studio_path = None;
    let mut instant_path = None;

    if let Some(studio) = studio {
        match studio {
            Ok(leg) => {
                studio_path = Some(leg.project_path);
                audio_latency_ms = leg.pattern.audio_latency_ms;
                emission_skew_ms = median_emission_skew_ms(&leg.pattern);
                let (verdict, summary, raw, mic, export, leg_snr) =
                    evaluate(leg.raw, leg.mic, leg.export);
                raw_m = raw;
                mic_m = mic;
                export_m = export;
                snr = leg_snr;
                studio_summary = Some(LegSummary { verdict, summary });
            }
            Err(e) => {
                let (summary, error) = failed_leg(e);
                studio_summary = Some(summary);
                studio_error = Some(error);
            }
        }
    }

    if let Some(instant) = instant {
        match instant {
            Ok(leg) => {
                instant_path = Some(leg.project_path);
                audio_latency_ms = audio_latency_ms.or(leg.pattern.audio_latency_ms);
                emission_skew_ms =
                    emission_skew_ms.or_else(|| median_emission_skew_ms(&leg.pattern));
                let (summary, measurement, leg_snr) = evaluate_instant(leg.measurement);
                instant_m = measurement;
                snr = snr.or(leg_snr);
                instant_summary = Some(summary);
            }
            Err(e) => {
                let (summary, error) = failed_leg(e);
                instant_summary = Some(summary);
                instant_error = Some(error);
            }
        }
    }

    let merged = merge_legs(studio_summary, instant_summary);
    let verdict = merged.verdict;
    let summary = merged.summary;

    // `--discard-recordings` wins over both: the desktop apps surface the
    // report and never the recording, so a failed run there must not leave a
    // full screen capture in temp for nobody to collect.
    let keep = !args.discard_recordings && (args.keep || verdict != Verdict::Pass);
    for path in [studio_path.as_ref(), instant_path.as_ref()]
        .into_iter()
        .flatten()
    {
        if keep {
            reporter.log(&format!("Recorded project kept at {}", path.display()));
        } else {
            let _ = std::fs::remove_dir_all(path);
        }
    }

    let report = AvSyncReport {
        verdict,
        summary: summary.clone(),
        mode: args.mode.name().to_string(),
        recording: raw_m,
        microphone: mic_m,
        export: export_m,
        instant: instant_m,
        studio_error,
        instant_error,
        thresholds: Thresholds {
            pass_offset_ms: PASS_OFFSET_MS,
            pass_total_drift_ms: PASS_TOTAL_DRIFT_MS,
            warn_offset_ms: WARN_OFFSET_MS,
            warn_total_drift_ms: WARN_TOTAL_DRIFT_MS,
            max_raw_export_delta_ms: MAX_RAW_EXPORT_DELTA_MS,
        },
        diagnostics: Diagnostics {
            beep_snr: snr,
            audio_output_latency_ms: audio_latency_ms,
            emission_skew_ms,
            project_path: keep
                .then(|| studio_path.map(|p| p.display().to_string()))
                .flatten(),
            instant_project_path: keep
                .then(|| instant_path.map(|p| p.display().to_string()))
                .flatten(),
        },
    };

    reporter.stage("done", None);
    reporter.report(&report);

    if !args.progress_json {
        if json {
            println!(
                "{}",
                serde_json::to_string_pretty(&report)
                    .map_err(|e| format!("failed to serialize report: {e}"))?
            );
        } else {
            print_human(&report);
        }
    }

    // The report has shipped, so the leg that did run is not lost; the exit
    // code stays the one a cancelled run has always had.
    if cancelled {
        return Err("self-test cancelled".to_string());
    }

    match verdict {
        Verdict::Pass | Verdict::Warn => Ok(()),
        Verdict::Fail => Err(format!("A/V sync check failed: {summary}")),
        Verdict::Inconclusive => Err(format!("A/V sync check inconclusive: {summary}")),
    }
}

async fn run_studio_leg(
    args: &AvSyncArgs,
    spec: PatternSpec,
    pattern_secs: u64,
    reporter: &Reporter,
) -> Result<StudioLeg, LegFailure> {
    // Every early return below leaves the directory to the guard.
    let mut temp = TempProject::new(
        std::env::temp_dir().join(format!("cap-selftest-{}.cap", uuid::Uuid::new_v4())),
    );
    let project_path = temp.path().to_path_buf();

    reporter.stage("collecting", Some("studio"));
    reporter.log(&format!(
        "[1/4] Recording test pattern ({pattern_secs}s)..."
    ));
    let mic_name =
        if args.mic || args.mic_name.is_some() {
            match args.mic_name.clone().or_else(|| {
                cap_recording::MicrophoneFeed::default_device().map(|(label, _, _)| label)
            }) {
                Some(label) => {
                    reporter.log(&format!("Including microphone: {label}"));
                    Some(label)
                }
                None => {
                    return Err(LegFailure::Failed(
                        "no microphone available for --mic".to_string(),
                    ));
                }
            }
        } else {
            None
        };

    let handle = start_recording(&project_path, args.fps, mic_name.clone())
        .await
        .map_err(LegFailure::Failed)?;
    reporter.stage("recording", Some("studio"));

    // Give capture a moment to deliver first frames before the pattern starts.
    tokio::time::sleep(Duration::from_millis(500)).await;

    reporter.stage("pattern-run", Some("studio"));
    let pattern_result = pattern::request_pattern(spec).await;

    let pattern = match pattern_result {
        Ok(report) => report,
        Err(e) => {
            let _ = handle.stop().await;
            if e == "cancelled" {
                return Err(LegFailure::Cancelled);
            }
            return Err(LegFailure::Failed(format!("test pattern failed: {e}")));
        }
    };

    // Let the tail of the last beep land in the recording.
    tokio::time::sleep(Duration::from_secs(1)).await;

    reporter.stage("remuxing", Some("studio"));
    reporter.log("[2/4] Finalizing recording...");
    let completed = handle
        .stop()
        .await
        .map_err(|e| LegFailure::Failed(format!("failed to stop recording: {e}")))?;
    // The actor reports the directory it wrote into; it is the one the guard
    // was built with, tracked explicitly so the guard follows the directory
    // that actually exists.
    let project_path = completed.project_path.clone();
    temp.track(project_path.clone());

    // Fragmented recordings need the shared remux step before their segment
    // files are directly readable (the same step the desktop app runs).
    {
        let project_path = project_path.clone();
        tokio::task::spawn_blocking(move || {
            cap_recording::recovery::RecoveryManager::remux_if_needed(&project_path)
        })
        .await
        .map_err(|e| LegFailure::Failed(format!("remux task join error: {e}")))?
        .map_err(|e| LegFailure::Failed(format!("failed to finalize recording segments: {e}")))?;
    }

    reporter.stage("analyzing", Some("studio"));
    reporter.log("[3/4] Analyzing recording...");
    let raw = analyze_raw(&project_path);
    let mic = mic_name.is_some().then(|| analyze_mic(&project_path));

    let export = if args.skip_export {
        Ok(None)
    } else {
        reporter.stage("exporting", Some("studio"));
        reporter.log("[4/4] Exporting and verifying the export...");
        match crate::export::export_project_default(project_path.clone()).await {
            Ok(output) => analyze_export(&output).map(Some),
            Err(e) => Err(format!("export failed: {e}")),
        }
    };

    temp.keep();
    Ok(StudioLeg {
        project_path,
        pattern,
        raw,
        mic,
        export,
    })
}

async fn run_instant_leg(
    args: &AvSyncArgs,
    spec: PatternSpec,
    pattern_secs: u64,
    reporter: &Reporter,
) -> Result<InstantLeg, LegFailure> {
    // `instant::finalize` is the fragment mux and the most failure-prone step
    // in this leg; the guard is what keeps its directory from leaking.
    let mut temp = TempProject::new(
        std::env::temp_dir().join(format!("cap-selftest-instant-{}.cap", uuid::Uuid::new_v4())),
    );
    let project_path = temp.path().to_path_buf();

    reporter.stage("collecting", Some("instant"));
    reporter.log(&format!(
        "[instant 1/3] Recording test pattern ({pattern_secs}s)..."
    ));

    let handle = instant::start_recording(&project_path, args.fps)
        .await
        .map_err(LegFailure::Failed)?;
    reporter.stage("recording", Some("instant"));

    tokio::time::sleep(Duration::from_millis(500)).await;

    reporter.stage("pattern-run", Some("instant"));
    let pattern = match pattern::request_pattern(spec).await {
        Ok(report) => report,
        Err(e) => {
            let _ = handle.stop().await;
            if e == "cancelled" {
                return Err(LegFailure::Cancelled);
            }
            return Err(LegFailure::Failed(format!("test pattern failed: {e}")));
        }
    };

    tokio::time::sleep(Duration::from_secs(1)).await;

    reporter.stage("remuxing", Some("instant"));
    reporter.log("[instant 2/3] Finalizing recording...");
    let mut completed = handle
        .stop()
        .await
        .map_err(|e| LegFailure::Failed(format!("failed to stop instant recording: {e}")))?;
    let project_path = completed.project_path.clone();
    temp.track(project_path.clone());

    let output = instant::finalize(&mut completed)
        .await
        .map_err(LegFailure::Failed)?;

    reporter.stage("analyzing", Some("instant"));
    reporter.log("[instant 3/3] Analyzing recording...");
    let measurement = analyze_instant(&output);

    temp.keep();
    Ok(InstantLeg {
        project_path,
        pattern,
        measurement,
    })
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
    if let Some(m) = &report.instant {
        println!(
            "Instant:   offset {:+.0} ms (median), drift {:+.0} ms over {:.0}s, {} events (spread ±{:.0} ms)",
            m.median_offset_ms, m.total_drift_ms, m.span_secs, m.inlier_events, m.mad_ms
        );
    }
    if let Some(error) = &report.studio_error {
        println!("Studio leg did not run: {error}");
    }
    if let Some(error) = &report.instant_error {
        println!("Instant leg did not run: {error}");
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

/// Instant recordings mux display and system audio into one container, so both
/// tracks share a timeline and read like an export. The audio is the digital
/// system-audio path, so it gets the full beep SNR floor.
fn analyze_instant(output: &Path) -> MeasureOutcome {
    let flashes = measure::video_flash_onsets(output)?;
    let audio = measure::audio_beep_onsets(output)?;

    if audio.snr < MIN_BEEP_SNR {
        return Err(format!(
            "test tone barely audible in the instant recording (SNR {:.1}); \
             check that output volume is not muted",
            audio.snr
        ));
    }

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

/// Classifies the instant leg. Same thresholds as the digital studio path:
/// one container, one clock, no acoustic budget to allow for.
fn evaluate_instant(outcome: MeasureOutcome) -> (LegSummary, Option<SyncMeasurement>, Option<f64>) {
    match outcome {
        Ok((m, snr)) => {
            let verdict = classify(&m);
            let summary = match verdict {
                Verdict::Pass => format!(
                    "instant recording sync is healthy (offset {:+.0} ms, drift {:+.0} ms over {:.0}s)",
                    m.median_offset_ms, m.total_drift_ms, m.span_secs
                ),
                _ => format!(
                    "instant recording offset {:+.0} ms / drift {:+.0} ms over {:.0}s",
                    m.median_offset_ms, m.total_drift_ms, m.span_secs
                ),
            };
            (LegSummary { verdict, summary }, Some(m), Some(snr))
        }
        Err(reason) => (
            LegSummary {
                verdict: Verdict::Inconclusive,
                summary: reason,
            },
            None,
            None,
        ),
    }
}

/// Merges the legs into the run's verdict. A single-leg run reports that leg
/// verbatim, so `--mode studio` reads exactly as it always has; a two-leg run
/// labels each side so the summary names both outcomes.
fn merge_legs(studio: Option<LegSummary>, instant: Option<LegSummary>) -> LegSummary {
    match (studio, instant) {
        (Some(studio), None) => studio,
        (None, Some(instant)) => instant,
        (Some(studio), Some(instant)) => LegSummary {
            verdict: merge_verdicts(studio.verdict, instant.verdict),
            summary: format!("studio: {}; instant: {}", studio.summary, instant.summary),
        },
        (None, None) => LegSummary {
            verdict: Verdict::Inconclusive,
            summary: "no recording legs ran".to_string(),
        },
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    fn measurement(offset_ms: f64, drift_ms: f64, mad_ms: f64) -> SyncMeasurement {
        SyncMeasurement {
            paired_events: 9,
            inlier_events: 9,
            median_offset_ms: offset_ms,
            mad_ms,
            drift_ms_per_min: drift_ms * 3.0,
            total_drift_ms: drift_ms,
            span_secs: 20.0,
            min_offset_ms: offset_ms - mad_ms,
            max_offset_ms: offset_ms + mad_ms,
            events: vec![(0.0, offset_ms)],
        }
    }

    fn leg(verdict: Verdict, summary: &str) -> LegSummary {
        LegSummary {
            verdict,
            summary: summary.to_string(),
        }
    }

    fn empty_report(mode: &str) -> AvSyncReport {
        AvSyncReport {
            verdict: Verdict::Pass,
            summary: "ok".to_string(),
            mode: mode.to_string(),
            recording: None,
            microphone: None,
            export: None,
            instant: None,
            studio_error: None,
            instant_error: None,
            thresholds: Thresholds {
                pass_offset_ms: PASS_OFFSET_MS,
                pass_total_drift_ms: PASS_TOTAL_DRIFT_MS,
                warn_offset_ms: WARN_OFFSET_MS,
                warn_total_drift_ms: WARN_TOTAL_DRIFT_MS,
                max_raw_export_delta_ms: MAX_RAW_EXPORT_DELTA_MS,
            },
            diagnostics: Diagnostics {
                beep_snr: None,
                audio_output_latency_ms: None,
                emission_skew_ms: None,
                project_path: None,
                instant_project_path: None,
            },
        }
    }

    #[test]
    fn single_leg_run_reports_that_leg_verbatim() {
        let studio = merge_legs(Some(leg(Verdict::Warn, "studio wobble")), None);
        assert_eq!(studio.verdict, Verdict::Warn);
        assert_eq!(studio.summary, "studio wobble");

        let instant = merge_legs(None, Some(leg(Verdict::Pass, "instant fine")));
        assert_eq!(instant.verdict, Verdict::Pass);
        assert_eq!(instant.summary, "instant fine");
    }

    #[test]
    fn both_legs_merge_verdicts_and_name_each_outcome() {
        let merged = merge_legs(
            Some(leg(Verdict::Pass, "healthy")),
            Some(leg(Verdict::Warn, "wobble")),
        );
        assert_eq!(merged.verdict, Verdict::Warn);
        assert_eq!(merged.summary, "studio: healthy; instant: wobble");

        // Fail dominates everything, including Inconclusive.
        assert_eq!(
            merge_legs(
                Some(leg(Verdict::Inconclusive, "no beeps")),
                Some(leg(Verdict::Fail, "drifting")),
            )
            .verdict,
            Verdict::Fail
        );
        assert_eq!(
            merge_legs(
                Some(leg(Verdict::Fail, "drifting")),
                Some(leg(Verdict::Pass, "healthy")),
            )
            .verdict,
            Verdict::Fail
        );
        // An unmeasurable leg makes the run inconclusive, as the mic leg does.
        assert_eq!(
            merge_legs(
                Some(leg(Verdict::Pass, "healthy")),
                Some(leg(Verdict::Inconclusive, "instant leg failed")),
            )
            .verdict,
            Verdict::Inconclusive
        );
        assert_eq!(
            merge_legs(
                Some(leg(Verdict::Warn, "wobble")),
                Some(leg(Verdict::Pass, "healthy")),
            )
            .verdict,
            Verdict::Warn
        );

        assert_eq!(merge_legs(None, None).verdict, Verdict::Inconclusive);
    }

    /// Cancelling the instant leg after the studio leg completed still reports
    /// the studio half: the instant leg reads as an inconclusive "cancelled"
    /// and the report carries it in `instant_error`.
    #[test]
    fn instant_cancellation_still_reports_the_studio_leg() {
        let studio = leg(
            Verdict::Pass,
            "audio/video sync is healthy (offset +2 ms, drift +1 ms over 20s)",
        );
        let (instant, instant_error) = failed_leg("cancelled".to_string());

        assert_eq!(instant.verdict, Verdict::Inconclusive);
        assert_eq!(instant_error, "cancelled");

        let merged = merge_legs(Some(studio.clone()), Some(instant));
        assert_eq!(merged.verdict, Verdict::Inconclusive);
        assert_eq!(
            merged.summary,
            format!("studio: {}; instant: cancelled", studio.summary)
        );

        let mut report = empty_report("both");
        report.verdict = merged.verdict;
        report.summary = merged.summary;
        report.instant_error = Some(instant_error);
        let json = serde_json::to_value(&report).unwrap();
        assert_eq!(json["verdict"], "inconclusive");
        assert_eq!(json["instant_error"], "cancelled");
        assert!(json["studio_error"].is_null());
        assert!(
            json["summary"]
                .as_str()
                .unwrap()
                .starts_with("studio: audio/video sync is healthy")
        );
    }

    /// The guard removes the temp `.cap` unless the leg hands it over, which is
    /// what keeps a failed `stop()`/remux/finalize from leaking a recording.
    #[test]
    fn the_temp_project_guard_cleans_up_unless_kept() {
        let dropped =
            std::env::temp_dir().join(format!("cap-selftest-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dropped).unwrap();
        drop(TempProject::new(dropped.clone()));
        assert!(!dropped.exists());

        let kept = std::env::temp_dir().join(format!("cap-selftest-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&kept).unwrap();
        TempProject::new(kept.clone()).keep();
        assert!(kept.exists());
        std::fs::remove_dir_all(&kept).ok();

        // A directory the recording actor reported after `stop()` is covered
        // too, and tracking the one already held does not double up.
        let created =
            std::env::temp_dir().join(format!("cap-selftest-test-{}", uuid::Uuid::new_v4()));
        let reported =
            std::env::temp_dir().join(format!("cap-selftest-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&created).unwrap();
        std::fs::create_dir_all(&reported).unwrap();
        let mut guard = TempProject::new(created.clone());
        guard.track(created.clone());
        guard.track(reported.clone());
        assert_eq!(guard.paths.len(), 2);
        assert_eq!(guard.path(), created.as_path());
        drop(guard);
        assert!(!created.exists());
        assert!(!reported.exists());
    }

    #[test]
    fn instant_leg_uses_the_digital_thresholds() {
        let (summary, measured, snr) = evaluate_instant(Ok((measurement(12.0, 4.0, 3.0), 21.0)));
        assert_eq!(summary.verdict, Verdict::Pass);
        assert!(
            summary
                .summary
                .contains("instant recording sync is healthy")
        );
        assert!(measured.is_some());
        assert_eq!(snr, Some(21.0));

        // Past the acoustic-free offset budget: no MIC_EXTRA_OFFSET_MS here.
        let (summary, _, _) = evaluate_instant(Ok((measurement(100.0, 4.0, 3.0), 21.0)));
        assert_eq!(summary.verdict, Verdict::Warn);

        let (summary, _, _) = evaluate_instant(Ok((measurement(400.0, 4.0, 3.0), 21.0)));
        assert_eq!(summary.verdict, Verdict::Fail);

        let (summary, measured, snr) =
            evaluate_instant(Err("no beeps detected in the recording".to_string()));
        assert_eq!(summary.verdict, Verdict::Inconclusive);
        assert_eq!(summary.summary, "no beeps detected in the recording");
        assert!(measured.is_none());
        assert!(snr.is_none());
    }

    #[test]
    fn progress_messages_serialize_to_the_documented_ndjson_shapes() {
        assert_eq!(
            serde_json::to_string(&ProgressMessage::Stage {
                stage: "recording",
                mode: Some("instant"),
            })
            .unwrap(),
            r#"{"type":"Stage","stage":"recording","mode":"instant"}"#
        );
        assert_eq!(
            serde_json::to_string(&ProgressMessage::Stage {
                stage: "done",
                mode: None,
            })
            .unwrap(),
            r#"{"type":"Stage","stage":"done","mode":null}"#
        );
        assert_eq!(
            serde_json::to_string(&ProgressMessage::Error {
                error: "screen recording permission unavailable",
            })
            .unwrap(),
            r#"{"type":"Error","error":"screen recording permission unavailable"}"#
        );

        let report = empty_report("both");
        let line = serde_json::to_string(&ProgressMessage::Report { report: &report }).unwrap();
        assert!(line.starts_with(r#"{"type":"Report","report":{"#));
        assert!(line.contains(r#""mode":"both""#));
        assert!(line.contains(r#""verdict":"pass""#));
        assert!(line.contains(r#""instant":null"#));
        assert!(line.contains(r#""studio_error":null"#));
        assert!(line.contains(r#""instant_error":null"#));
        // One line per message: NDJSON breaks if a message wraps.
        assert!(!line.contains('\n'));
    }

    #[test]
    fn report_keeps_the_existing_field_names() {
        let mut report = empty_report("studio");
        report.recording = Some(measurement(10.0, 2.0, 3.0));
        let json = serde_json::to_value(&report).unwrap();
        for key in [
            "verdict",
            "summary",
            "recording",
            "microphone",
            "export",
            "thresholds",
            "diagnostics",
        ] {
            assert!(json.get(key).is_some(), "missing existing field {key}");
        }
        for key in ["mode", "instant", "studio_error", "instant_error"] {
            assert!(json.get(key).is_some(), "missing new field {key}");
        }
        assert!(
            json["diagnostics"].get("project_path").is_some(),
            "diagnostics keeps project_path"
        );
    }

    #[test]
    fn sync_mode_names_match_the_cli_values() {
        assert_eq!(SyncMode::Studio.name(), "studio");
        assert_eq!(SyncMode::Instant.name(), "instant");
        assert_eq!(SyncMode::Both.name(), "both");
        assert!(SyncMode::Both.runs_studio() && SyncMode::Both.runs_instant());
        assert!(SyncMode::Studio.runs_studio() && !SyncMode::Studio.runs_instant());
        assert!(!SyncMode::Instant.runs_studio() && SyncMode::Instant.runs_instant());
    }
}
