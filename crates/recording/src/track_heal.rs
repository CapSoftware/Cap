//! Load-time repair for recordings whose video tracks were stamped at the
//! wrong rate.
//!
//! A source that delivered frames faster than the pipeline's nominal rate
//! produced a track whose duration is a multiple of the real recording span —
//! the video plays in slow motion, desyncs from audio, and stretches the
//! editor timeline. Two variants shipped:
//!
//! - cameras free-running past their nominal rate (e.g. an AVFoundation
//!   device at 60fps recorded as 30fps) → stretched camera.mp4;
//! - Windows screen capture on high-refresh monitors (WGC delivering at up
//!   to the monitor rate with no MinUpdateInterval support) → stretched
//!   display.mp4, with a content-dependent non-integer ratio
//!   (delivered fps / nominal fps, e.g. ~2.24x for a 165Hz monitor).
//!
//! The recorder-side defects are fixed, but affected recordings on disk stay
//! broken; this module detects the signatures on editor open and losslessly
//! rewrites the tracks' timestamps.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use cap_enc_ffmpeg::remux::{
    get_media_duration, get_video_fps, probe_video_pts_ladder, rescale_video_timestamps,
};
use cap_project::{ProjectConfiguration, RecordingMeta, RecordingMetaInner, StudioRecordingMeta};
use tracing::{info, warn};

/// Runs every track repair for a studio recording, display first so the
/// camera heal can trust the display track as a reference. Returns `true`
/// if anything was healed.
pub fn heal_stretched_tracks(project_path: &Path) -> anyhow::Result<bool> {
    // Concurrent editor opens of the same project would race the
    // backup/install renames and could bury the original under an
    // already-healed file; only one heal per project may be in flight.
    // The app is single-instance and only the editor-open path heals, so
    // an in-process guard suffices.
    let Some(_guard) = HealInFlightGuard::try_claim(project_path) else {
        return Ok(false);
    };

    let display_healed = heal_stretched_display(project_path)?;
    let camera_healed = heal_stretched_camera(project_path)?;
    Ok(display_healed || camera_healed)
}

struct HealInFlightGuard(PathBuf);

impl HealInFlightGuard {
    fn in_flight() -> &'static std::sync::Mutex<std::collections::HashSet<PathBuf>> {
        static IN_FLIGHT: std::sync::OnceLock<
            std::sync::Mutex<std::collections::HashSet<PathBuf>>,
        > = std::sync::OnceLock::new();
        IN_FLIGHT.get_or_init(Default::default)
    }

    fn try_claim(project_path: &Path) -> Option<Self> {
        let path = project_path.to_path_buf();
        let mut set = Self::in_flight().lock().ok()?;
        set.insert(path.clone()).then(|| Self(path))
    }
}

impl Drop for HealInFlightGuard {
    fn drop(&mut self) {
        if let Ok(mut set) = Self::in_flight().lock() {
            set.remove(&self.0);
        }
    }
}

/// Minimum reference span for a heal to be considered; very short recordings
/// have too much probe noise to trust a ratio.
const MIN_REFERENCE_SECS: f64 = 2.0;
/// Camera must exceed the reference span by at least this factor…
const MIN_STRETCH_RATIO: f64 = 1.5;
/// …and by at least this many seconds, so long recordings with slightly
/// off-by-probe durations never trigger.
const MIN_STRETCH_SECS: f64 = 1.0;
/// When only the display track is available as a reference (no audio), the
/// ratio must sit in the rate-doubling family (60/30, 50/25, 60/24) to rule
/// out a display track that legitimately stopped early.
const DISPLAY_ONLY_RATIO_RANGE: (f64, f64) = (1.6, 2.6);
/// References must agree with each other within this fraction of the larger
/// one before the camera is judged against them.
const REFERENCE_AGREEMENT_RATIO: f64 = 0.15;
/// The healed file must land within this fraction of the expected span or the
/// original is kept untouched.
const HEAL_VERIFY_TOLERANCE_RATIO: f64 = 0.05;

const BACKUP_FILE_NAME: &str = "camera.original.mp4";

/// Detects and repairs stretched camera tracks in a studio recording.
/// Returns `true` if any segment was healed. Never modifies media unless the
/// stretch signature is unambiguous, and keeps the original file alongside
/// the healed one.
pub fn heal_stretched_camera(project_path: &Path) -> anyhow::Result<bool> {
    let mut meta = RecordingMeta::load_for_project(project_path)
        .map_err(|e| anyhow::anyhow!("failed to load recording meta: {e}"))?;

    let RecordingMetaInner::Studio(studio_meta) = &mut meta.inner else {
        return Ok(false);
    };

    let StudioRecordingMeta::MultipleSegments { inner } = studio_meta.as_mut() else {
        return Ok(false);
    };

    let project_path = project_path.to_path_buf();
    let mut healed_any = false;

    for (segment_index, segment) in inner.segments.iter_mut().enumerate() {
        let Some(camera) = segment.camera.as_mut() else {
            continue;
        };

        let camera_path = camera.path.to_path(&project_path);
        let display_path = segment.display.path.to_path(&project_path);

        let backup_path = backup_path_for(&camera_path);
        if backup_path.exists() {
            // Healed before — never rescale the same track twice.
            continue;
        }

        let Some(camera_duration) = get_media_duration(&camera_path) else {
            continue;
        };

        // Each reference predicts the camera's span from its own duration
        // plus the difference in track start times (a track that started
        // later ran for less wall time).
        let camera_start = camera.start_time.unwrap_or(0.0);
        let mut references: Vec<(&'static str, f64)> = Vec::new();

        if let Some(display_duration) = get_media_duration(&display_path) {
            let display_start = segment.display.start_time.unwrap_or(0.0);
            references.push((
                "display",
                display_duration.as_secs_f64() + (display_start - camera_start),
            ));
        }

        for (name, audio) in [
            ("mic", segment.mic.as_ref()),
            ("system-audio", segment.system_audio.as_ref()),
        ] {
            let Some(audio) = audio else { continue };
            let audio_path = audio.path.to_path(&project_path);
            if let Some(audio_duration) = get_media_duration(&audio_path) {
                let audio_start = audio.start_time.unwrap_or(0.0);
                references.push((
                    name,
                    audio_duration.as_secs_f64() + (audio_start - camera_start),
                ));
            }
        }

        let Some(decision) = evaluate_stretch(camera_duration.as_secs_f64(), &references) else {
            continue;
        };

        info!(
            segment_index,
            camera_secs = camera_duration.as_secs_f64(),
            expected_secs = decision.expected_span_secs,
            ratio = decision.ratio,
            references = ?references,
            "Detected stretched camera track, rewriting timestamps"
        );

        let healed_path = camera_path.with_extension("healed.mp4");
        let _ = std::fs::remove_file(&healed_path);

        if let Err(e) = rescale_video_timestamps(&camera_path, &healed_path, decision.scale) {
            warn!(
                segment_index,
                "Camera heal remux failed, keeping original: {e}"
            );
            let _ = std::fs::remove_file(&healed_path);
            continue;
        }

        let healed_ok = get_media_duration(&healed_path).is_some_and(|healed| {
            let error = (healed.as_secs_f64() - decision.expected_span_secs).abs();
            error <= decision.expected_span_secs * HEAL_VERIFY_TOLERANCE_RATIO
        });

        if !healed_ok {
            warn!(
                segment_index,
                "Healed camera track failed duration verification, keeping original"
            );
            let _ = std::fs::remove_file(&healed_path);
            continue;
        }

        if let Err(e) = std::fs::rename(&camera_path, &backup_path) {
            warn!(
                segment_index,
                "Failed to back up original camera track: {e}"
            );
            let _ = std::fs::remove_file(&healed_path);
            continue;
        }

        if let Err(e) = std::fs::rename(&healed_path, &camera_path) {
            warn!(segment_index, "Failed to install healed camera track: {e}");
            // Put the original back so the recording stays playable.
            let _ = std::fs::rename(&backup_path, &camera_path);
            let _ = std::fs::remove_file(&healed_path);
            continue;
        }

        if let Some(fps) = get_video_fps(&camera_path).filter(|fps| *fps > 0) {
            camera.fps = fps;
        }

        info!(
            segment_index,
            healed_secs = get_media_duration(&camera_path).map(|d| d.as_secs_f64()),
            fps = camera.fps,
            "Camera track healed (original kept as {BACKUP_FILE_NAME})"
        );
        healed_any = true;
    }

    if healed_any {
        meta.save_for_project()
            .map_err(|e| anyhow::anyhow!("failed to save healed recording meta: {e:?}"))?;
    }

    Ok(healed_any)
}

fn backup_path_for(camera_path: &Path) -> PathBuf {
    camera_path.with_file_name(BACKUP_FILE_NAME)
}

const DISPLAY_BACKUP_FILE_NAME: &str = "display.original.mp4";
/// The display ratio is content-dependent (delivered fps / nominal), so no
/// ratio-family gate applies; instead the floor is low enough to catch a
/// 75Hz monitor (1.25x) while staying above audio-tail noise.
const DISPLAY_MIN_STRETCH_RATIO: f64 = 1.15;
/// Absolute stretch floor, so long recordings with slightly off-by-probe
/// durations never trigger.
const DISPLAY_MIN_STRETCH_SECS: f64 = 2.0;
/// No real refresh/nominal mismatch exceeds this; anything above means a
/// different defect we should not touch.
const DISPLAY_MAX_STRETCH_RATIO: f64 = 6.0;
/// Video cannot run longer than the wall clock; requiring it to exceed the
/// log-derived wall span (which over-counts by a few seconds of pre/post
/// roll) by this factor is the physical proof of a stretch. It also rejects
/// the nastiest false positive: a healthy recording whose audio track died
/// early, which an audio-only ratio would mis-read as a stretched video.
const WALL_GATE_RATIO: f64 = 1.1;
/// An audio reference predicting a content span below this fraction of the
/// wall span is treated as a track that died early, not as a sync target.
const AUDIO_REF_PLAUSIBLE_WALL_FRACTION: f64 = 0.4;

/// Detects and repairs stretched display tracks in a studio recording.
/// Returns `true` if any segment was healed. The display is the timeline's
/// backbone, so this is deliberately more conservative than the camera heal:
/// it requires the synthetic CFR-ladder signature that the defective
/// pipeline always produced, plus either wall-clock proof from the recording
/// log or two independently-agreeing audio references.
pub fn heal_stretched_display(project_path: &Path) -> anyhow::Result<bool> {
    let meta = RecordingMeta::load_for_project(project_path)
        .map_err(|e| anyhow::anyhow!("failed to load recording meta: {e}"))?;

    let RecordingMetaInner::Studio(studio_meta) = &meta.inner else {
        return Ok(false);
    };

    let StudioRecordingMeta::MultipleSegments { inner } = studio_meta.as_ref() else {
        return Ok(false);
    };

    let wall_span_secs = recording_log_wall_span_secs(project_path);
    let project_path = project_path.to_path_buf();
    let mut healed_scales: HashMap<u32, f64> = HashMap::new();

    for (segment_index, segment) in inner.segments.iter().enumerate() {
        let display_path = segment.display.path.to_path(&project_path);

        let backup_path = display_path.with_file_name(DISPLAY_BACKUP_FILE_NAME);
        if backup_path.exists() {
            // Healed before — never rescale the same track twice.
            continue;
        }

        let Some(display_duration) = get_media_duration(&display_path) else {
            continue;
        };
        let display_secs = display_duration.as_secs_f64();
        let display_start = segment.display.start_time.unwrap_or(0.0);

        let mut audio_refs: Vec<(&'static str, f64)> = Vec::new();
        let mut audio_track_count = 0usize;
        for (name, audio) in [
            ("mic", segment.mic.as_ref()),
            ("system-audio", segment.system_audio.as_ref()),
        ] {
            let Some(audio) = audio else { continue };
            audio_track_count += 1;
            let audio_path = audio.path.to_path(&project_path);
            if let Some(audio_duration) = get_media_duration(&audio_path) {
                let audio_start = audio.start_time.unwrap_or(0.0);
                audio_refs.push((
                    name,
                    audio_duration.as_secs_f64() + (audio_start - display_start),
                ));
            }
        }

        // The ladder probe reads packets, so run the cheap gates through
        // `evaluate_display_stretch` first with a claimed ladder, then
        // confirm against the file before touching anything.
        let inputs = DisplayStretchInputs {
            display_secs,
            display_start,
            audio_refs: audio_refs.clone(),
            audio_track_count,
            wall_span_secs,
            ladder_is_synthetic: true,
        };
        let Some(decision) = evaluate_display_stretch(&inputs) else {
            continue;
        };

        let ladder_confirmed = probe_video_pts_ladder(&display_path, segment.display.fps)
            .is_some_and(|probe| probe.is_ladder());
        if !ladder_confirmed {
            info!(
                segment_index,
                display_secs,
                "Display track is long relative to references but not ladder-stamped; leaving it alone"
            );
            continue;
        }

        info!(
            segment_index,
            display_secs,
            expected_secs = decision.expected_span_secs,
            ratio = decision.ratio,
            wall_span_secs,
            references = ?audio_refs,
            "Detected stretched display track, rewriting timestamps"
        );

        let healed_path = display_path.with_extension("healed.mp4");
        let _ = std::fs::remove_file(&healed_path);

        if let Err(e) = rescale_video_timestamps(&display_path, &healed_path, decision.scale) {
            warn!(
                segment_index,
                "Display heal remux failed, keeping original: {e}"
            );
            let _ = std::fs::remove_file(&healed_path);
            continue;
        }

        let healed_ok = get_media_duration(&healed_path).is_some_and(|healed| {
            let error = (healed.as_secs_f64() - decision.expected_span_secs).abs();
            error <= decision.expected_span_secs * HEAL_VERIFY_TOLERANCE_RATIO
        });

        if !healed_ok {
            warn!(
                segment_index,
                "Healed display track failed duration verification, keeping original"
            );
            let _ = std::fs::remove_file(&healed_path);
            continue;
        }

        if let Err(e) = std::fs::rename(&display_path, &backup_path) {
            warn!(
                segment_index,
                "Failed to back up original display track: {e}"
            );
            let _ = std::fs::remove_file(&healed_path);
            continue;
        }

        if let Err(e) = std::fs::rename(&healed_path, &display_path) {
            warn!(segment_index, "Failed to install healed display track: {e}");
            // Put the original back so the recording stays playable.
            let _ = std::fs::rename(&backup_path, &display_path);
            let _ = std::fs::remove_file(&healed_path);
            continue;
        }

        info!(
            segment_index,
            healed_secs = get_media_duration(&display_path).map(|d| d.as_secs_f64()),
            "Display track healed (original kept as {DISPLAY_BACKUP_FILE_NAME})"
        );
        healed_scales.insert(segment_index as u32, decision.scale);
    }

    if !healed_scales.is_empty() {
        rescale_project_config(&project_path, &healed_scales);
    }

    Ok(!healed_scales.is_empty())
}

/// Wall-clock span of the recording session, from the first and last
/// timestamped lines of `recording-logs.log`. Over-counts the capture span
/// by a few seconds (setup before the pipeline plays, finalization after
/// stop), which is the safe direction for a "video exceeds wall time" gate.
///
/// Log timestamps are system wall-clock, not monotonic: if the clock
/// stepped backward mid-recording (NTP correction), the net span
/// under-counts and could authorize — and mis-target — a heal of a healthy
/// no-audio recording. A backward step is visible as a backwards jump
/// between adjacent log lines, so any such jump discredits the whole log.
/// Small inversions are normal (threads capture timestamps before the
/// appender serializes them) and are tolerated.
fn recording_log_wall_span_secs(project_path: &Path) -> Option<f64> {
    // Logs are tens of KB; cap the read defensively rather than streaming.
    const MAX_LOG_READ_BYTES: u64 = 8 * 1024 * 1024;
    /// Well above async-logging interleave, well below any real clock step.
    const MAX_BACKWARD_INTERLEAVE_MS: i64 = 2_000;

    let log_path = project_path.join("recording-logs.log");
    let len = std::fs::metadata(&log_path).ok()?.len();
    if len == 0 || len > MAX_LOG_READ_BYTES {
        return None;
    }
    let contents = std::fs::read_to_string(&log_path).ok()?;

    let mut first: Option<chrono::DateTime<chrono::FixedOffset>> = None;
    let mut prev: Option<chrono::DateTime<chrono::FixedOffset>> = None;
    for line in contents.lines() {
        let Some(ts_str) = line.split_whitespace().next() else {
            continue;
        };
        let Ok(ts) = chrono::DateTime::parse_from_rfc3339(ts_str) else {
            continue;
        };
        if let Some(prev) = prev
            && prev.signed_duration_since(ts).num_milliseconds() > MAX_BACKWARD_INTERLEAVE_MS
        {
            return None;
        }
        if first.is_none() {
            first = Some(ts);
        }
        prev = Some(ts);
    }

    let span = prev?.signed_duration_since(first?);
    let secs = span.num_milliseconds() as f64 / 1000.0;
    (secs > 0.0).then_some(secs)
}

#[derive(Debug, Clone)]
struct DisplayStretchInputs {
    display_secs: f64,
    display_start: f64,
    /// Expected display spans predicted by each audio track.
    audio_refs: Vec<(&'static str, f64)>,
    /// How many audio tracks the recording has, probed successfully or not.
    audio_track_count: usize,
    wall_span_secs: Option<f64>,
    /// Whether the track's packet timestamps form the synthetic
    /// one-nominal-tick-per-frame ladder the defective pipeline produced.
    ladder_is_synthetic: bool,
}

/// Decides whether a display track is stretched. Returns `None` unless the
/// signature is unambiguous.
fn evaluate_display_stretch(inputs: &DisplayStretchInputs) -> Option<StretchDecision> {
    if !inputs.ladder_is_synthetic {
        return None;
    }

    // Physical gate: a video track cannot outrun the wall clock. When the
    // log span is available it must prove the stretch, whatever the audio
    // says.
    if let Some(wall) = inputs.wall_span_secs
        && inputs.display_secs < wall * WALL_GATE_RATIO
    {
        return None;
    }

    // Audio references that died early (pre-keepalive system audio) predict
    // a span far below the wall clock; they are not sync targets.
    let plausible_refs: Vec<(&'static str, f64)> = inputs
        .audio_refs
        .iter()
        .filter(|(_, span)| match inputs.wall_span_secs {
            Some(wall) => *span >= wall * AUDIO_REF_PLAUSIBLE_WALL_FRACTION,
            None => true,
        })
        .copied()
        .collect();

    let expected_span_secs = if !plausible_refs.is_empty() {
        let spans: Vec<f64> = plausible_refs.iter().map(|(_, span)| *span).collect();
        let max_span = spans.iter().cloned().fold(f64::MIN, f64::max);
        let min_span = spans.iter().cloned().fold(f64::MAX, f64::min);

        // All remaining references must tell the same story.
        if max_span - min_span > (max_span * REFERENCE_AGREEMENT_RATIO).max(MIN_STRETCH_SECS) {
            return None;
        }

        // Without wall-clock proof, one audio track alone cannot rule out
        // "the audio died early"; require two independent tracks agreeing.
        if inputs.wall_span_secs.is_none() && plausible_refs.len() < 2 {
            return None;
        }

        max_span
    } else if inputs.audio_track_count > 0 {
        // The recording had audio but no track produced a plausible
        // reference — too ambiguous to touch.
        return None;
    } else {
        // No audio at all: the wall span is the only reference. Without a
        // log there is nothing to measure against.
        inputs.wall_span_secs? - inputs.display_start
    };

    if expected_span_secs < MIN_REFERENCE_SECS {
        return None;
    }

    let ratio = inputs.display_secs / expected_span_secs;
    if !(DISPLAY_MIN_STRETCH_RATIO..=DISPLAY_MAX_STRETCH_RATIO).contains(&ratio)
        || inputs.display_secs - expected_span_secs < DISPLAY_MIN_STRETCH_SECS
    {
        return None;
    }

    Some(StretchDecision {
        expected_span_secs,
        ratio,
        scale: expected_span_secs / inputs.display_secs,
    })
}

/// Rewrites an existing project config so edits made against a stretched
/// recording keep pointing at the same content after the heal. For the pure
/// ladder stretch the source-time mapping is exactly linear, so scaling
/// segment bounds is exact, not approximate. Overlay tracks live on the
/// output timeline, which only scales by the same factor when every timeline
/// segment does; keyboard and caption segments are regenerable from their
/// source-of-truth files, so they are left untouched.
fn rescale_project_config(project_path: &Path, scales: &HashMap<u32, f64>) {
    let Ok(mut config) = ProjectConfiguration::load(project_path) else {
        // No config yet: the editor will build a default timeline from the
        // healed media.
        return;
    };
    let Some(timeline) = config.timeline.as_mut() else {
        return;
    };

    let mut changed = false;
    let mut all_clips_healed = true;

    for segment in &mut timeline.segments {
        if let Some(scale) = scales.get(&segment.recording_clip) {
            // `timescale` (the user-facing Speed control) is deliberately
            // untouched: scaling start/end alone keeps content selection and
            // overlay alignment exact and makes a "2x" label mean 2x of real
            // time again. A speed edit made against the stretched media was
            // compensating for the defect; preserving its on-screen rate
            // would carry the defect forward.
            segment.start *= scale;
            segment.end *= scale;
            changed = true;
        } else {
            all_clips_healed = false;
        }
    }

    let uniform_scale = if scales.len() == 1 && all_clips_healed {
        scales.values().next().copied()
    } else {
        None
    };

    if let Some(scale) = uniform_scale {
        for s in &mut timeline.zoom_segments {
            s.start *= scale;
            s.end *= scale;
        }
        for s in &mut timeline.scene_segments {
            s.start *= scale;
            s.end *= scale;
        }
        for s in &mut timeline.mask_segments {
            s.start *= scale;
            s.end *= scale;
        }
        for s in &mut timeline.text_segments {
            s.start *= scale;
            s.end *= scale;
        }
        for s in &mut timeline.audio_segments {
            s.start *= scale;
            s.end *= scale;
        }
        changed = true;
    }

    if changed {
        if let Err(e) = config.write(project_path) {
            warn!("Failed to write rescaled project config after display heal: {e}");
        }
    }
}

#[derive(Debug, PartialEq)]
struct StretchDecision {
    expected_span_secs: f64,
    ratio: f64,
    scale: f64,
}

/// Decides whether `camera_secs` is a stretched track given the expected
/// spans predicted by the other tracks. Returns `None` unless the signature
/// is unambiguous.
fn evaluate_stretch(camera_secs: f64, references: &[(&str, f64)]) -> Option<StretchDecision> {
    let spans: Vec<f64> = references.iter().map(|(_, span)| *span).collect();
    if spans.is_empty() {
        return None;
    }

    let max_span = spans.iter().cloned().fold(f64::MIN, f64::max);
    let min_span = spans.iter().cloned().fold(f64::MAX, f64::min);

    if max_span < MIN_REFERENCE_SECS {
        return None;
    }

    // All references must tell the same story; a mic that ran much longer
    // than the display means the display died early, not that the camera is
    // stretched.
    if max_span - min_span > (max_span * REFERENCE_AGREEMENT_RATIO).max(MIN_STRETCH_SECS) {
        return None;
    }

    let expected_span_secs = max_span;
    let ratio = camera_secs / expected_span_secs;

    if ratio < MIN_STRETCH_RATIO || camera_secs - expected_span_secs < MIN_STRETCH_SECS {
        return None;
    }

    let has_audio_reference = references.iter().any(|(name, _)| *name != "display");
    if !has_audio_reference
        && !(DISPLAY_ONLY_RATIO_RANGE.0..=DISPLAY_ONLY_RATIO_RANGE.1).contains(&ratio)
    {
        return None;
    }

    Some(StretchDecision {
        expected_span_secs,
        ratio,
        scale: expected_span_secs / camera_secs,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const USER_REPORT_CAMERA_SECS: f64 = 13.666;

    fn user_report_references() -> Vec<(&'static str, f64)> {
        // From the original report: display 6.75s starting at 0.302s, mic
        // 6.91s starting at 0.102s, camera starting at 0.149s.
        vec![
            ("display", 6.75 + (0.302 - 0.149)),
            ("mic", 6.91 + (0.102 - 0.149)),
        ]
    }

    #[test]
    fn detects_the_reported_double_length_camera() {
        let decision = evaluate_stretch(USER_REPORT_CAMERA_SECS, &user_report_references())
            .expect("the reported recording must be detected");
        assert!(
            (decision.ratio - 2.0).abs() < 0.05,
            "ratio {}",
            decision.ratio
        );
        assert!(
            (decision.scale - 0.5).abs() < 0.02,
            "scale {}",
            decision.scale
        );
    }

    #[test]
    fn healthy_recording_is_left_alone() {
        assert_eq!(
            evaluate_stretch(6.9, &[("display", 6.75), ("mic", 6.91)]),
            None
        );
    }

    #[test]
    fn camera_slightly_longer_than_references_is_left_alone() {
        // Cameras legitimately run a little past the other tracks.
        assert_eq!(
            evaluate_stretch(7.4, &[("display", 6.75), ("mic", 6.91)]),
            None
        );
    }

    #[test]
    fn display_dying_early_does_not_trigger_heal() {
        // Display stopped at half-time but the mic kept going: references
        // disagree, so the long camera is trusted.
        assert_eq!(
            evaluate_stretch(60.0, &[("display", 30.0), ("mic", 59.5)]),
            None
        );
    }

    #[test]
    fn display_only_requires_doubling_ratio() {
        // Without audio, a 2x camera is healed…
        assert!(evaluate_stretch(13.6, &[("display", 6.8)]).is_some());
        // …but a 3x mismatch (not a rate-doubling signature) is not.
        assert_eq!(evaluate_stretch(20.4, &[("display", 6.8)]), None);
        // …nor is a display that died at two-thirds.
        assert_eq!(evaluate_stretch(90.0, &[("display", 60.0)]), None);
    }

    #[test]
    fn short_recordings_are_not_healed() {
        assert_eq!(
            evaluate_stretch(3.0, &[("display", 1.5), ("mic", 1.5)]),
            None
        );
    }

    #[test]
    fn below_ratio_threshold_is_left_alone() {
        assert_eq!(
            evaluate_stretch(3.1, &[("display", 2.1), ("mic", 2.1)]),
            None
        );
    }

    /// Manual harness for healing a real .cap bundle:
    /// `CAP_HEAL_PROJECT_PATH=/path/to/recording.cap cargo test -p cap-recording \
    ///   --lib track_heal::tests::heal_project_from_env -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn heal_project_from_env() {
        let path =
            std::env::var("CAP_HEAL_PROJECT_PATH").expect("CAP_HEAL_PROJECT_PATH must be set");
        let healed = heal_stretched_tracks(Path::new(&path)).unwrap();
        println!("healed: {healed}");
    }

    // -- Display heal --
    //
    // Numbers below are from the 2026-07-06 user report: a 90.3s window
    // recording on a 165Hz monitor produced a 202.22s display.mp4 (12,133
    // frames stamped at exactly 1/60s) against 90.82s of real-time system
    // audio and a 92.8s log wall span.

    fn report_inputs() -> DisplayStretchInputs {
        DisplayStretchInputs {
            display_secs: 202.22,
            display_start: 0.4728,
            audio_refs: vec![("system-audio", 90.8225 - 0.4728)],
            audio_track_count: 1,
            wall_span_secs: Some(92.8),
            ladder_is_synthetic: true,
        }
    }

    #[test]
    fn detects_the_reported_high_refresh_display_stretch() {
        let decision = evaluate_display_stretch(&report_inputs())
            .expect("the reported recording must be detected");
        assert!(
            (decision.ratio - 2.24).abs() < 0.02,
            "ratio {}",
            decision.ratio
        );
        // The scale targets the audio span, which is what playback syncs to.
        assert!(
            (decision.scale - 0.4468).abs() < 0.002,
            "scale {}",
            decision.scale
        );
    }

    #[test]
    fn non_ladder_track_is_never_healed() {
        // Long relative to audio but with real, jittered timestamps: the
        // audio died early, the video is fine.
        let inputs = DisplayStretchInputs {
            ladder_is_synthetic: false,
            ..report_inputs()
        };
        assert_eq!(evaluate_display_stretch(&inputs), None);
    }

    #[test]
    fn wall_clock_gate_blocks_healthy_video_with_dead_audio() {
        // Pre-fix 60Hz recording (ladder-stamped but correctly paced) whose
        // system audio died at 30s: the audio ratio alone screams "stretch"
        // but the video does not exceed the wall clock.
        let inputs = DisplayStretchInputs {
            display_secs: 90.3,
            display_start: 0.4,
            audio_refs: vec![("system-audio", 30.0)],
            audio_track_count: 1,
            wall_span_secs: Some(92.8),
            ladder_is_synthetic: true,
        };
        assert_eq!(evaluate_display_stretch(&inputs), None);
    }

    #[test]
    fn implausible_audio_reference_is_not_a_sync_target() {
        // Genuinely stretched video, but the only audio track died at a
        // quarter of the wall span; squeezing the video to it would over-
        // correct, so nothing is healed.
        let inputs = DisplayStretchInputs {
            display_secs: 202.22,
            display_start: 0.4728,
            audio_refs: vec![("system-audio", 22.0)],
            audio_track_count: 1,
            wall_span_secs: Some(92.8),
            ladder_is_synthetic: true,
        };
        assert_eq!(evaluate_display_stretch(&inputs), None);
    }

    #[test]
    fn without_wall_clock_a_single_audio_reference_is_not_enough() {
        let inputs = DisplayStretchInputs {
            wall_span_secs: None,
            ..report_inputs()
        };
        assert_eq!(evaluate_display_stretch(&inputs), None);
    }

    #[test]
    fn without_wall_clock_two_agreeing_audio_references_heal() {
        let inputs = DisplayStretchInputs {
            display_secs: 202.22,
            display_start: 0.4728,
            audio_refs: vec![("mic", 90.1), ("system-audio", 90.35)],
            audio_track_count: 2,
            wall_span_secs: None,
            ladder_is_synthetic: true,
        };
        let decision = evaluate_display_stretch(&inputs).expect("two refs must be enough");
        assert!((decision.expected_span_secs - 90.35).abs() < 0.01);
    }

    #[test]
    fn without_wall_clock_disagreeing_references_do_not_heal() {
        let inputs = DisplayStretchInputs {
            display_secs: 202.22,
            display_start: 0.4728,
            audio_refs: vec![("mic", 45.0), ("system-audio", 90.35)],
            audio_track_count: 2,
            wall_span_secs: None,
            ladder_is_synthetic: true,
        };
        assert_eq!(evaluate_display_stretch(&inputs), None);
    }

    #[test]
    fn no_audio_heals_against_the_wall_span() {
        let inputs = DisplayStretchInputs {
            display_secs: 202.22,
            display_start: 0.4728,
            audio_refs: vec![],
            audio_track_count: 0,
            wall_span_secs: Some(92.8),
            ladder_is_synthetic: true,
        };
        let decision = evaluate_display_stretch(&inputs).expect("wall span must be enough");
        assert!((decision.expected_span_secs - (92.8 - 0.4728)).abs() < 0.01);
    }

    #[test]
    fn no_audio_and_no_log_does_not_heal() {
        let inputs = DisplayStretchInputs {
            display_secs: 202.22,
            display_start: 0.4728,
            audio_refs: vec![],
            audio_track_count: 0,
            wall_span_secs: None,
            ladder_is_synthetic: true,
        };
        assert_eq!(evaluate_display_stretch(&inputs), None);
    }

    #[test]
    fn healthy_sixty_hertz_prefix_recording_is_left_alone() {
        // Pre-fix on a 60Hz monitor: ladder-stamped but correctly paced,
        // so the ratio sits at ~1.
        let inputs = DisplayStretchInputs {
            display_secs: 90.3,
            display_start: 0.4728,
            audio_refs: vec![("system-audio", 90.35)],
            audio_track_count: 1,
            wall_span_secs: Some(92.8),
            ladder_is_synthetic: true,
        };
        assert_eq!(evaluate_display_stretch(&inputs), None);
    }

    #[test]
    fn paused_stretched_recording_heals_to_the_audio_span() {
        // 90s wall with a long pause: 45s of content stretched 2.24x. The
        // wall gate still passes (100.8 > 99) and audio remains the target.
        let inputs = DisplayStretchInputs {
            display_secs: 100.8,
            display_start: 0.4,
            audio_refs: vec![("mic", 45.0), ("system-audio", 45.2)],
            audio_track_count: 2,
            wall_span_secs: Some(90.0),
            ladder_is_synthetic: true,
        };
        let decision = evaluate_display_stretch(&inputs).expect("paused stretch must heal");
        assert!((decision.expected_span_secs - 45.2).abs() < 0.01);
    }

    #[test]
    fn absurd_ratio_is_not_touched() {
        let inputs = DisplayStretchInputs {
            display_secs: 800.0,
            display_start: 0.0,
            audio_refs: vec![("mic", 90.0), ("system-audio", 90.0)],
            audio_track_count: 2,
            wall_span_secs: Some(92.8),
            ladder_is_synthetic: true,
        };
        assert_eq!(evaluate_display_stretch(&inputs), None);
    }

    #[test]
    fn wall_span_parses_first_and_last_log_timestamps() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("recording-logs.log"),
            "2026-07-06T18:19:14.754110Z  INFO recording: start\n\
             not a timestamped line\n\
             2026-07-06T18:19:58.715980Z  INFO snapshot\n\
             2026-07-06T18:20:47.563260Z  INFO cap_desktop_lib::recording: done\n",
        )
        .unwrap();
        let span = recording_log_wall_span_secs(dir.path()).unwrap();
        assert!((span - 92.809).abs() < 0.01, "span {span}");
    }

    #[test]
    fn wall_span_is_none_for_missing_or_unparseable_logs() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(recording_log_wall_span_secs(dir.path()), None);
        std::fs::write(
            dir.path().join("recording-logs.log"),
            "no timestamps here\n",
        )
        .unwrap();
        assert_eq!(recording_log_wall_span_secs(dir.path()), None);
    }

    #[test]
    fn wall_span_rejects_logs_with_backward_clock_steps() {
        // A backward system-clock step mid-recording under-counts the span,
        // which could both authorize and mis-target a no-audio heal; such a
        // log must be discredited entirely.
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("recording-logs.log"),
            "2026-07-06T18:19:14.754110Z  INFO start\n\
             2026-07-06T18:19:58.715980Z  INFO snapshot\n\
             2026-07-06T18:19:20.000000Z  INFO after ntp step\n\
             2026-07-06T18:20:47.563260Z  INFO done\n",
        )
        .unwrap();
        assert_eq!(recording_log_wall_span_secs(dir.path()), None);
    }

    #[test]
    fn wall_span_tolerates_async_log_interleaving() {
        // Millisecond-scale inversions are normal: threads capture their
        // timestamps before the appender serializes the lines.
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("recording-logs.log"),
            "2026-07-06T18:19:14.754110Z  INFO start\n\
             2026-07-06T18:19:58.715980Z  INFO a\n\
             2026-07-06T18:19:58.703215Z  INFO b (interleaved)\n\
             2026-07-06T18:20:47.563260Z  INFO done\n",
        )
        .unwrap();
        let span = recording_log_wall_span_secs(dir.path()).unwrap();
        assert!((span - 92.809).abs() < 0.01, "span {span}");
    }

    #[test]
    fn concurrent_heals_of_the_same_project_are_exclusive() {
        let dir = tempfile::tempdir().unwrap();
        let first = HealInFlightGuard::try_claim(dir.path());
        assert!(first.is_some());
        assert!(
            HealInFlightGuard::try_claim(dir.path()).is_none(),
            "second claim must be refused while the first is held"
        );
        drop(first);
        assert!(
            HealInFlightGuard::try_claim(dir.path()).is_some(),
            "claim must be reusable after release"
        );
    }

    #[test]
    fn config_rescale_scales_timeline_and_overlays_exactly() {
        use cap_project::{
            ProjectConfiguration, TimelineConfiguration, TimelineSegment, ZoomMode, ZoomSegment,
        };

        let dir = tempfile::tempdir().unwrap();
        let timeline = TimelineConfiguration {
            segments: vec![TimelineSegment {
                recording_clip: 0,
                timescale: 1.0,
                start: 0.0,
                end: 202.220711,
                name: None,
                speed_audio_mode: None,
            }],
            transitions: Vec::new(),
            zoom_segments: vec![ZoomSegment {
                start: 100.0,
                end: 150.0,
                amount: 2.0,
                mode: ZoomMode::Auto,
                glide_direction: Default::default(),
                glide_speed: 0.5,
                instant_animation: false,
                edge_snap_ratio: 0.25,
            }],
            scene_segments: vec![],
            mask_segments: vec![],
            text_segments: vec![],
            caption_segments: vec![],
            keyboard_segments: vec![],
            audio_segments: vec![],
        };
        let config = ProjectConfiguration {
            timeline: Some(timeline),
            ..Default::default()
        };
        config.write(dir.path()).unwrap();

        let scale = 0.4468;
        let mut scales = HashMap::new();
        scales.insert(0u32, scale);
        rescale_project_config(dir.path(), &scales);

        let reloaded = ProjectConfiguration::load(dir.path()).unwrap();
        let timeline = reloaded.timeline.unwrap();
        assert!((timeline.segments[0].end - 202.220711 * scale).abs() < 1e-6);
        assert!((timeline.zoom_segments[0].start - 100.0 * scale).abs() < 1e-6);
        assert!((timeline.zoom_segments[0].end - 150.0 * scale).abs() < 1e-6);
    }

    #[test]
    fn config_rescale_leaves_overlays_alone_with_unhealed_clips() {
        use cap_project::{
            ProjectConfiguration, TimelineConfiguration, TimelineSegment, ZoomMode, ZoomSegment,
        };

        let dir = tempfile::tempdir().unwrap();
        let timeline = TimelineConfiguration {
            segments: vec![
                TimelineSegment {
                    recording_clip: 0,
                    timescale: 1.0,
                    start: 0.0,
                    end: 100.0,
                    name: None,
                    speed_audio_mode: None,
                },
                TimelineSegment {
                    recording_clip: 1,
                    timescale: 1.0,
                    start: 0.0,
                    end: 50.0,
                    name: None,
                    speed_audio_mode: None,
                },
            ],
            transitions: Vec::new(),
            zoom_segments: vec![ZoomSegment {
                start: 10.0,
                end: 20.0,
                amount: 2.0,
                mode: ZoomMode::Auto,
                glide_direction: Default::default(),
                glide_speed: 0.5,
                instant_animation: false,
                edge_snap_ratio: 0.25,
            }],
            scene_segments: vec![],
            mask_segments: vec![],
            text_segments: vec![],
            caption_segments: vec![],
            keyboard_segments: vec![],
            audio_segments: vec![],
        };
        let config = ProjectConfiguration {
            timeline: Some(timeline),
            ..Default::default()
        };
        config.write(dir.path()).unwrap();

        let mut scales = HashMap::new();
        scales.insert(0u32, 0.5);
        rescale_project_config(dir.path(), &scales);

        let reloaded = ProjectConfiguration::load(dir.path()).unwrap();
        let timeline = reloaded.timeline.unwrap();
        // Healed clip's timeline segment scales…
        assert!((timeline.segments[0].end - 50.0).abs() < 1e-6);
        // …the unhealed clip's does not…
        assert!((timeline.segments[1].end - 50.0).abs() < 1e-6);
        // …and output-time overlays are left untouched because the output
        // timeline no longer scales uniformly.
        assert!((timeline.zoom_segments[0].start - 10.0).abs() < 1e-6);
    }
}
