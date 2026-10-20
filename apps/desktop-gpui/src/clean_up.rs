use std::{collections::HashSet, sync::Arc};

use cap_gpui_kernels::silence::FLOOR_DB;
use cap_project::{ProjectConfiguration, TimelineConfiguration};

use crate::{
    editor_edits::{cut_clip_source_range, effective_to_output_end},
    editor_timeline::clip_timeline_offsets,
    ui::CollapsibleState,
};

pub const ENVELOPE_STEP_SECS: f64 = cap_gpui_kernels::silence::WINDOW_FRAMES as f64 / 48_000.0;
const BLIP_WINDOWS: usize = 2;
const MIN_CUT_SECS: f64 = 0.05;
const EDGE_SNAP_SECS: f64 = 0.03;
const MUTED_TRACK_DB: f32 = -30.0;
const VOICE_REFERENCE_DB: f32 = -20.0;
const VOICE_PERCENTILE: f64 = 0.95;
const MAX_LEVEL_BOOST_DB: f32 = 30.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SilencePreset {
    Conservative,
    Balanced,
    Aggressive,
}

impl SilencePreset {
    pub const ALL: [Self; 3] = [Self::Conservative, Self::Balanced, Self::Aggressive];

    pub fn label(self) -> &'static str {
        match self {
            Self::Conservative => "Conservative",
            Self::Balanced => "Balanced",
            Self::Aggressive => "Aggressive",
        }
    }

    pub fn settings(self) -> SilenceSettings {
        match self {
            Self::Conservative => SilenceSettings {
                threshold_db: -45.,
                min_silence_ms: 1000.,
                min_keep_ms: 200.,
                pad_start_ms: 100.,
                pad_end_ms: 150.,
                normalize: true,
            },
            Self::Balanced => SilenceSettings {
                threshold_db: -40.,
                min_silence_ms: 500.,
                min_keep_ms: 300.,
                pad_start_ms: 10.,
                pad_end_ms: 10.,
                normalize: true,
            },
            Self::Aggressive => SilenceSettings {
                threshold_db: -35.,
                min_silence_ms: 250.,
                min_keep_ms: 400.,
                pad_start_ms: 0.,
                pad_end_ms: 0.,
                normalize: true,
            },
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SilenceSettings {
    pub threshold_db: f32,
    pub min_silence_ms: f32,
    pub min_keep_ms: f32,
    pub pad_start_ms: f32,
    pub pad_end_ms: f32,
    pub normalize: bool,
}

impl Default for SilenceSettings {
    fn default() -> Self {
        SilencePreset::Balanced.settings()
    }
}

impl SilenceSettings {
    pub fn preset(&self) -> Option<SilencePreset> {
        SilencePreset::ALL
            .into_iter()
            .find(|preset| preset.settings().with_normalize(self.normalize) == *self)
    }

    pub fn with_normalize(mut self, normalize: bool) -> Self {
        self.normalize = normalize;
        self
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SilenceParameter {
    Threshold,
    MinSilence,
    MinKeep,
    PadStart,
    PadEnd,
}

impl SilenceParameter {
    pub const ALL: [Self; 5] = [
        Self::Threshold,
        Self::MinSilence,
        Self::MinKeep,
        Self::PadStart,
        Self::PadEnd,
    ];

    pub fn label(self) -> &'static str {
        match self {
            Self::Threshold => "Silence Threshold",
            Self::MinSilence => "Min Duration",
            Self::MinKeep => "Min Keep",
            Self::PadStart => "Pad start",
            Self::PadEnd => "Pad end",
        }
    }

    pub fn description(self) -> &'static str {
        match self {
            Self::Threshold => {
                "Audio quieter than this counts as silence, measured after quiet recordings are boosted"
            }
            Self::MinSilence => "Only cut silences at least this long",
            Self::MinKeep => {
                "Sounds shorter than this between two silences (clicks, breaths) are cut with them"
            }
            Self::PadStart => "Silence left in after speech stops, so words don't end abruptly",
            Self::PadEnd => "Silence left in before speech resumes, so words don't start abruptly",
        }
    }

    pub fn limits(self) -> (f32, f32, f32) {
        match self {
            Self::Threshold => (-70., -10., 1.),
            Self::MinSilence => (100., 3000., 50.),
            Self::MinKeep => (0., 1000., 10.),
            Self::PadStart | Self::PadEnd => (0., 500., 10.),
        }
    }

    pub fn read(self, settings: &SilenceSettings) -> f32 {
        match self {
            Self::Threshold => settings.threshold_db,
            Self::MinSilence => settings.min_silence_ms,
            Self::MinKeep => settings.min_keep_ms,
            Self::PadStart => settings.pad_start_ms,
            Self::PadEnd => settings.pad_end_ms,
        }
    }

    pub fn write(self, settings: &mut SilenceSettings, value: f32) {
        let (min, max, step) = self.limits();
        let value = ((value / step).round() * step).clamp(min, max);
        match self {
            Self::Threshold => settings.threshold_db = value,
            Self::MinSilence => settings.min_silence_ms = value,
            Self::MinKeep => settings.min_keep_ms = value,
            Self::PadStart => settings.pad_start_ms = value,
            Self::PadEnd => settings.pad_end_ms = value,
        }
    }

    pub fn value_label(self, value: f32) -> String {
        match self {
            Self::Threshold => format!("{}", value.round() as i32),
            _ => format!("{}ms", value.round() as i32),
        }
    }

    pub fn unit(self) -> Option<&'static str> {
        match self {
            Self::Threshold => Some("DB"),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct ClipEnvelope {
    pub mic: Option<Arc<Vec<f32>>>,
    pub system: Option<Arc<Vec<f32>>>,
    pub mic_repair_secs: f64,
    pub system_repair_secs: f64,
}

impl ClipEnvelope {
    fn has_audio(&self) -> bool {
        self.mic.as_ref().is_some_and(|levels| !levels.is_empty())
            || self
                .system
                .as_ref()
                .is_some_and(|levels| !levels.is_empty())
    }
}

pub fn loudness_db(blocks: &[&[f32]], channels: u16) -> Vec<f32> {
    cap_gpui_kernels::silence::loudness_db(blocks.iter().copied(), channels)
}

pub struct TrackLevels<'a> {
    pub levels: &'a [f32],
    pub offset_secs: f64,
    pub gain_db: f32,
}

/// Merges tracks into one envelope, never longer than the longest track.
/// Offsets come from the project file, so they are clamped: an out-of-range
/// offset only moves a track out of view, it can't grow the allocation.
pub fn combined_levels(tracks: &[TrackLevels]) -> Vec<f32> {
    let max_len = tracks
        .iter()
        .map(|track| track.levels.len())
        .max()
        .unwrap_or(0);
    let bound = isize::try_from(max_len).unwrap_or(isize::MAX);
    let shifts: Vec<isize> = tracks
        .iter()
        .map(|track| {
            let shift = track.offset_secs / ENVELOPE_STEP_SECS;
            if shift.is_finite() {
                shift.round().clamp(-(bound as f64), bound as f64) as isize
            } else {
                0
            }
        })
        .collect();
    let len = tracks
        .iter()
        .zip(&shifts)
        .map(|(track, shift)| (track.levels.len() as isize - shift).clamp(0, bound))
        .max()
        .unwrap_or(0) as usize;
    (0..len)
        .map(|index| {
            tracks
                .iter()
                .zip(&shifts)
                .filter_map(|(track, shift)| {
                    let at = index as isize + shift;
                    usize::try_from(at)
                        .ok()
                        .and_then(|at| track.levels.get(at))
                        .map(|level| level + track.gain_db)
                })
                .fold(FLOOR_DB, f32::max)
        })
        .collect()
}

fn bridge_gaps(runs: Vec<(usize, usize)>, max_gap: usize) -> Vec<(usize, usize)> {
    let mut merged: Vec<(usize, usize)> = Vec::with_capacity(runs.len());
    for run in runs {
        match merged.last_mut() {
            Some(last) if run.0.saturating_sub(last.1) <= max_gap => last.1 = run.1,
            _ => merged.push(run),
        }
    }
    merged
}

pub fn detect_silences(levels: &[f32], settings: &SilenceSettings) -> Vec<(f64, f64)> {
    let windows = |ms: f32| (f64::from(ms) / 1000. / ENVELOPE_STEP_SECS).round() as usize;
    let min_silence = windows(settings.min_silence_ms).max(1);
    let min_keep = windows(settings.min_keep_ms);
    let len = levels.len();

    let mut runs = Vec::new();
    let mut open = None;
    for (index, level) in levels.iter().enumerate() {
        let silent = level.is_nan() || *level < settings.threshold_db;
        match (silent, open) {
            (true, None) => open = Some(index),
            (false, Some(start)) => {
                runs.push((start, index));
                open = None;
            }
            _ => {}
        }
    }
    if let Some(start) = open {
        runs.push((start, len));
    }

    let mut runs = bridge_gaps(runs, BLIP_WINDOWS);
    runs.retain(|(start, end)| end - start >= min_silence);
    let mut runs = if min_keep > 0 {
        bridge_gaps(runs, min_keep - 1)
    } else {
        runs
    };
    if let Some(first) = runs.first_mut()
        && first.0 < min_keep
    {
        first.0 = 0;
    }
    if let Some(last) = runs.last_mut()
        && len - last.1 < min_keep
    {
        last.1 = len;
    }

    let pad_start = f64::from(settings.pad_start_ms) / 1000.;
    let pad_end = f64::from(settings.pad_end_ms) / 1000.;
    runs.into_iter()
        .filter_map(|(start, end)| {
            let mut from = start as f64 * ENVELOPE_STEP_SECS;
            let mut to = end as f64 * ENVELOPE_STEP_SECS;
            if start > 0 {
                from += pad_start;
            }
            if end < len {
                to -= pad_end;
            }
            (to - from >= MIN_CUT_SECS).then_some((from, to))
        })
        .collect()
}

#[derive(Debug, Clone, PartialEq)]
struct DetectionInputs {
    settings: SilenceSettings,
    mic_volume_db: f32,
    system_volume_db: f32,
    offsets: Vec<(f32, f32)>,
}

impl DetectionInputs {
    fn new(project: &ProjectConfiguration, settings: SilenceSettings, clips: usize) -> Self {
        Self {
            settings,
            mic_volume_db: project.audio.mic_volume_db,
            system_volume_db: project.audio.system_volume_db,
            offsets: (0..clips)
                .map(|index| {
                    project
                        .clips
                        .iter()
                        .find(|clip| clip.index as usize == index)
                        .map_or((0., 0.), |clip| {
                            (clip.offsets.mic, clip.offsets.system_audio)
                        })
                })
                .collect(),
        }
    }
}

pub fn level_boost_db<'a>(clips: impl IntoIterator<Item = &'a [f32]>) -> f32 {
    let mut audible: Vec<f32> = clips
        .into_iter()
        .flatten()
        .copied()
        .filter(|level| level.is_finite() && *level > FLOOR_DB)
        .collect();
    if audible.is_empty() {
        return 0.;
    }
    let index = ((audible.len() - 1) as f64 * VOICE_PERCENTILE).round() as usize;
    let (_, reference, _) = audible.select_nth_unstable_by(index, f32::total_cmp);
    (VOICE_REFERENCE_DB - *reference).clamp(0., MAX_LEVEL_BOOST_DB)
}

struct Detection {
    ranges: Vec<Vec<(f64, f64)>>,
    boost_db: f32,
}

fn detect_clips(envelopes: &[ClipEnvelope], inputs: &DetectionInputs) -> Detection {
    let combined: Vec<Option<Vec<f32>>> = envelopes
        .iter()
        .zip(&inputs.offsets)
        .map(|(envelope, (mic_offset, system_offset))| {
            let mut tracks = Vec::with_capacity(2);
            if let Some(levels) = &envelope.mic
                && inputs.mic_volume_db > MUTED_TRACK_DB
            {
                tracks.push(TrackLevels {
                    levels: levels.as_slice(),
                    offset_secs: f64::from(*mic_offset) + envelope.mic_repair_secs,
                    gain_db: inputs.mic_volume_db,
                });
            }
            if let Some(levels) = &envelope.system
                && inputs.system_volume_db > MUTED_TRACK_DB
            {
                tracks.push(TrackLevels {
                    levels: levels.as_slice(),
                    offset_secs: f64::from(*system_offset) + envelope.system_repair_secs,
                    gain_db: inputs.system_volume_db,
                });
            }
            (!tracks.is_empty()).then(|| combined_levels(&tracks))
        })
        .collect();
    let boost_db = if inputs.settings.normalize {
        level_boost_db(combined.iter().flatten().map(Vec::as_slice))
    } else {
        0.
    };
    let ranges = combined
        .into_iter()
        .map(|levels| match levels {
            Some(mut levels) => {
                if boost_db > 0. {
                    for level in &mut levels {
                        *level += boost_db;
                    }
                }
                detect_silences(&levels, &inputs.settings)
            }
            None => Vec::new(),
        })
        .collect();
    Detection { ranges, boost_db }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct SilenceKey {
    pub recording_clip: u32,
    pub index: usize,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TimelineSilence {
    pub key: SilenceKey,
    pub segment_index: usize,
    pub source_start: f64,
    pub source_end: f64,
    pub start: f64,
    pub end: f64,
}

impl TimelineSilence {
    pub fn duration(&self) -> f64 {
        (self.end - self.start).max(0.)
    }
}

pub fn timeline_silences(
    timeline: &TimelineConfiguration,
    detected: &[Vec<(f64, f64)>],
) -> Vec<TimelineSilence> {
    let offsets = clip_timeline_offsets(timeline);
    let holds = timeline.hold_windows();
    let mut silences = Vec::new();
    for (index, segment) in timeline.segments.iter().enumerate() {
        let Some(ranges) = detected.get(segment.recording_clip as usize) else {
            continue;
        };
        let timescale = segment.timescale;
        if !timescale.is_finite() || timescale <= 0. {
            continue;
        }
        let incoming = timeline
            .effective_transition(index)
            .map_or(0., |transition| transition.duration);
        let outgoing = timeline
            .effective_transition(index + 1)
            .map_or(0., |transition| transition.duration);
        let lower = segment.start + incoming * timescale;
        let upper = segment.end - outgoing * timescale;
        let clip_start = offsets.get(index).copied().unwrap_or(0.);
        for (range_index, (range_start, range_end)) in ranges.iter().enumerate() {
            if *range_start >= upper {
                break;
            }
            if *range_end <= lower {
                continue;
            }
            let mut start = range_start.max(lower);
            let mut end = range_end.min(upper);
            if incoming <= 0. && (start - segment.start) / timescale < EDGE_SNAP_SECS {
                start = segment.start;
            }
            if outgoing <= 0. && (segment.end - end) / timescale < EDGE_SNAP_SECS {
                end = segment.end;
            }
            if (end - start) / timescale < MIN_CUT_SECS {
                continue;
            }
            let effective_start = clip_start + (start - segment.start) / timescale;
            let effective_end = clip_start + (end - segment.start) / timescale;
            silences.push(TimelineSilence {
                key: SilenceKey {
                    recording_clip: segment.recording_clip,
                    index: range_index,
                },
                segment_index: index,
                source_start: start,
                source_end: end,
                start: effective_to_output_end(&holds, effective_start),
                end: effective_to_output_end(&holds, effective_end),
            });
        }
    }
    silences.sort_by(|a, b| a.start.total_cmp(&b.start));
    silences
}

pub fn cut_silences<'a>(
    timeline: &mut TimelineConfiguration,
    silences: impl IntoIterator<Item = &'a TimelineSilence>,
) -> usize {
    let mut ordered: Vec<&TimelineSilence> = silences.into_iter().collect();
    ordered.sort_by(|a, b| {
        b.segment_index
            .cmp(&a.segment_index)
            .then(b.source_start.total_cmp(&a.source_start))
    });
    ordered
        .into_iter()
        .filter(|silence| {
            cut_clip_source_range(
                timeline,
                silence.segment_index,
                silence.source_start,
                silence.source_end,
            )
        })
        .count()
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CleanUpSummary {
    pub count: usize,
    pub kept: usize,
    pub saved: f64,
    pub before: f64,
}

impl CleanUpSummary {
    pub fn after(&self) -> f64 {
        (self.before - self.saved).max(0.)
    }

    pub fn fraction(&self) -> f64 {
        if self.before > 0. {
            (self.saved / self.before).clamp(0., 1.)
        } else {
            0.
        }
    }
}

pub fn format_duration(seconds: f64) -> String {
    let tenths = (seconds.max(0.) * 10.).round() as u64;
    let hours = tenths / 36_000;
    let minutes = tenths / 600 % 60;
    let secs = (tenths % 600) as f64 / 10.;
    if hours > 0 {
        format!("{hours}h {minutes}m {secs:.1}s")
    } else if minutes > 0 {
        format!("{minutes}m {secs:.1}s")
    } else {
        format!("{secs:.1}s")
    }
}

pub struct CleanUpState {
    pub settings: SilenceSettings,
    pub advanced_open: CollapsibleState,
    pub envelopes: Option<Arc<Vec<ClipEnvelope>>>,
    detected_for: Option<DetectionInputs>,
    detected: Vec<Vec<(f64, f64)>>,
    pub level_boost_db: f32,
    pub silences: Vec<TimelineSilence>,
    pub kept: HashSet<SilenceKey>,
    pub focused: Option<SilenceKey>,
    pub reviewing: bool,
    pub message: Option<String>,
}

impl Default for CleanUpState {
    fn default() -> Self {
        Self {
            settings: SilenceSettings::default(),
            advanced_open: CollapsibleState::new(true),
            envelopes: None,
            detected_for: None,
            detected: Vec::new(),
            level_boost_db: 0.,
            silences: Vec::new(),
            kept: HashSet::new(),
            focused: None,
            reviewing: false,
            message: None,
        }
    }
}

impl CleanUpState {
    pub fn loaded(&self) -> bool {
        self.envelopes.is_some()
    }

    pub fn has_audio(&self) -> bool {
        self.envelopes
            .as_ref()
            .is_some_and(|envelopes| envelopes.iter().any(ClipEnvelope::has_audio))
    }

    pub fn set_envelopes(&mut self, envelopes: Vec<ClipEnvelope>) {
        self.envelopes = Some(Arc::new(envelopes));
        self.detected_for = None;
    }

    pub fn set_settings(&mut self, settings: SilenceSettings) -> bool {
        if self.settings == settings {
            return false;
        }
        self.settings = settings;
        self.message = None;
        true
    }

    pub fn refresh(&mut self, project: &ProjectConfiguration) {
        let Some(envelopes) = self.envelopes.clone() else {
            self.silences.clear();
            return;
        };
        let inputs = DetectionInputs::new(project, self.settings, envelopes.len());
        if self.detected_for.as_ref() != Some(&inputs) {
            let detection = detect_clips(&envelopes, &inputs);
            self.detected = detection.ranges;
            self.level_boost_db = detection.boost_db;
            self.detected_for = Some(inputs);
            self.kept.clear();
            self.focused = None;
        }
        self.silences = project
            .timeline
            .as_ref()
            .map(|timeline| timeline_silences(timeline, &self.detected))
            .unwrap_or_default();
        let live: HashSet<SilenceKey> = self.silences.iter().map(|silence| silence.key).collect();
        self.kept.retain(|key| live.contains(key));
        if self.focused.is_some_and(|key| !live.contains(&key)) {
            self.focused = None;
        }
        if self.silences.is_empty() {
            self.reviewing = false;
        }
    }

    pub fn is_kept(&self, silence: &TimelineSilence) -> bool {
        self.kept.contains(&silence.key)
    }

    pub fn pending(&self) -> impl Iterator<Item = &TimelineSilence> {
        self.silences
            .iter()
            .filter(|silence| !self.kept.contains(&silence.key))
    }

    pub fn summary(&self, before: f64) -> CleanUpSummary {
        CleanUpSummary {
            count: self.pending().count(),
            kept: self.silences.len() - self.pending().count(),
            saved: self.pending().map(TimelineSilence::duration).sum(),
            before,
        }
    }

    pub fn focused_position(&self) -> Option<usize> {
        let key = self.focused?;
        self.silences.iter().position(|silence| silence.key == key)
    }

    pub fn focused_silence(&self) -> Option<&TimelineSilence> {
        self.silences.get(self.focused_position()?)
    }

    pub fn focus_at_or_after(&mut self, time: f64) -> Option<TimelineSilence> {
        let silence = self
            .silences
            .iter()
            .find(|silence| silence.end > time + 1e-6)
            .or_else(|| self.silences.last())
            .copied()?;
        self.focused = Some(silence.key);
        Some(silence)
    }

    pub fn step_focus(&mut self, forward: bool) -> Option<TimelineSilence> {
        if self.silences.is_empty() {
            return None;
        }
        let last = self.silences.len() - 1;
        let next = match self.focused_position() {
            Some(position) if forward => (position + 1).min(last),
            Some(position) => position.saturating_sub(1),
            None if forward => 0,
            None => last,
        };
        let silence = self.silences[next];
        self.focused = Some(silence.key);
        Some(silence)
    }

    pub fn silence_at(&self, time: f64) -> Option<TimelineSilence> {
        self.silences
            .iter()
            .find(|silence| time >= silence.start && time < silence.end)
            .copied()
    }

    pub fn skip_target(&self, time: f64, lead: f64) -> Option<f64> {
        let pending: Vec<&TimelineSilence> = self.pending().collect();
        let mut end = pending
            .iter()
            .find(|silence| time >= silence.start - lead && time < silence.end - lead)?
            .end;
        while let Some(next) = pending
            .iter()
            .find(|silence| silence.start <= end + lead && silence.end > end)
        {
            end = next.end;
        }
        Some(end)
    }

    pub fn toggle_kept(&mut self, key: SilenceKey) {
        if !self.kept.remove(&key) {
            self.kept.insert(key);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn timeline(json: serde_json::Value) -> TimelineConfiguration {
        let project: ProjectConfiguration =
            serde_json::from_value(serde_json::json!({ "timeline": json })).expect("fixture");
        project.timeline.expect("timeline")
    }

    fn levels(spec: &[(f64, f32)]) -> Vec<f32> {
        spec.iter()
            .flat_map(|(seconds, level)| {
                std::iter::repeat_n(*level, (seconds / ENVELOPE_STEP_SECS).round() as usize)
            })
            .collect()
    }

    fn settings(min_silence_ms: f32, min_keep_ms: f32, pad: f32) -> SilenceSettings {
        SilenceSettings {
            threshold_db: -40.,
            min_silence_ms,
            min_keep_ms,
            pad_start_ms: pad,
            pad_end_ms: pad,
            normalize: false,
        }
    }

    fn approx(actual: &[(f64, f64)], expected: &[(f64, f64)]) {
        assert_eq!(actual.len(), expected.len(), "{actual:?}");
        for ((a0, a1), (e0, e1)) in actual.iter().zip(expected) {
            assert!(
                (a0 - e0).abs() < 1e-6 && (a1 - e1).abs() < 1e-6,
                "{actual:?} != {expected:?}"
            );
        }
    }

    #[test]
    fn the_balanced_preset_matches_its_settings() {
        assert_eq!(
            SilenceSettings::default().preset(),
            Some(SilencePreset::Balanced)
        );
        let mut custom = SilenceSettings::default();
        SilenceParameter::PadEnd.write(&mut custom, 20.);
        assert_eq!(custom.preset(), None);
    }

    #[test]
    fn parameter_writes_snap_and_clamp() {
        let mut settings = SilenceSettings::default();
        SilenceParameter::MinSilence.write(&mut settings, 512.);
        assert_eq!(settings.min_silence_ms, 500.);
        SilenceParameter::Threshold.write(&mut settings, -200.);
        assert_eq!(settings.threshold_db, -70.);
    }

    #[test]
    fn a_long_pause_is_detected_with_padding() {
        let levels = levels(&[(1.0, -20.), (2.0, -60.), (1.0, -20.)]);
        approx(
            &detect_silences(&levels, &settings(500., 0., 100.)),
            &[(1.1, 2.9)],
        );
    }

    #[test]
    fn pauses_shorter_than_the_minimum_are_left_alone() {
        let levels = levels(&[(1.0, -20.), (0.4, -60.), (1.0, -20.)]);
        assert!(detect_silences(&levels, &settings(500., 0., 0.)).is_empty());
    }

    #[test]
    fn edges_are_not_padded() {
        let levels = levels(&[(1.0, -60.), (1.0, -20.), (1.0, -60.)]);
        approx(
            &detect_silences(&levels, &settings(500., 0., 100.)),
            &[(0.0, 0.9), (2.1, 3.0)],
        );
    }

    #[test]
    fn a_short_click_inside_a_pause_does_not_split_it() {
        let levels = levels(&[
            (1.0, -20.),
            (1.0, -60.),
            (0.02, -10.),
            (1.0, -60.),
            (1.0, -20.),
        ]);
        approx(
            &detect_silences(&levels, &settings(500., 0., 0.)),
            &[(1.0, 3.02)],
        );
    }

    #[test]
    fn a_short_sound_between_two_pauses_is_cut_with_them() {
        let levels = levels(&[
            (1.0, -20.),
            (1.0, -60.),
            (0.2, -20.),
            (1.0, -60.),
            (1.0, -20.),
        ]);
        approx(
            &detect_silences(&levels, &settings(500., 300., 0.)),
            &[(1.0, 3.2)],
        );
        approx(
            &detect_silences(&levels, &settings(500., 100., 0.)),
            &[(1.0, 2.0), (2.2, 3.2)],
        );
    }

    #[test]
    fn syllable_gaps_never_add_up_to_a_cut() {
        let mut spec = Vec::new();
        for _ in 0..20 {
            spec.push((0.15, -20.));
            spec.push((0.03, -60.));
        }
        let levels = levels(&spec);
        assert!(detect_silences(&levels, &SilenceSettings::default()).is_empty());
    }

    #[test]
    fn tracks_combine_by_their_loudest_level_after_offset_and_gain() {
        let mic = levels(&[(1.0, -60.), (1.0, -20.)]);
        let system = levels(&[(2.0, -90.)]);
        let combined = combined_levels(&[
            TrackLevels {
                levels: &mic,
                offset_secs: 0.5,
                gain_db: -6.,
            },
            TrackLevels {
                levels: &system,
                offset_secs: 0.,
                gain_db: 0.,
            },
        ]);
        assert_eq!(combined.len(), 200);
        assert_eq!(combined[0], -66.);
        assert_eq!(combined[49], -66.);
        assert_eq!(combined[50], -26.);
        assert_eq!(combined[150], -90.);
    }

    #[test]
    fn extreme_offsets_never_grow_the_envelope_past_the_longest_track() {
        let mic = levels(&[(1.0, -20.)]);
        for offset_secs in [-1.0e12, 1.0e12, f64::MIN, f64::MAX, f64::NAN, f64::INFINITY] {
            let combined = combined_levels(&[TrackLevels {
                levels: &mic,
                offset_secs,
                gain_db: 0.,
            }]);
            assert!(combined.len() <= mic.len(), "offset {offset_secs}");
        }
    }

    #[test]
    fn silences_map_through_trims_and_speed_changes() {
        let timeline = timeline(serde_json::json!({
            "segments": [
                { "recordingSegment": 0, "timescale": 1.0, "start": 1.0, "end": 10.0 },
                { "recordingSegment": 0, "timescale": 2.0, "start": 12.0, "end": 20.0 }
            ],
            "zoomSegments": []
        }));
        let detected = vec![vec![(0.0, 2.0), (4.0, 5.0), (9.5, 13.0), (16.0, 18.0)]];
        let silences = timeline_silences(&timeline, &detected);
        let spans: Vec<(usize, f64, f64, f64, f64)> = silences
            .iter()
            .map(|s| {
                (
                    s.segment_index,
                    s.source_start,
                    s.source_end,
                    s.start,
                    s.end,
                )
            })
            .collect();
        assert_eq!(
            spans,
            vec![
                (0, 1.0, 2.0, 0.0, 1.0),
                (0, 4.0, 5.0, 3.0, 4.0),
                (0, 9.5, 10.0, 8.5, 9.0),
                (1, 12.0, 13.0, 9.0, 9.5),
                (1, 16.0, 18.0, 11.0, 12.0),
            ]
        );
        assert_eq!(silences[2].key, silences[3].key);
    }

    #[test]
    fn silences_stay_out_of_transitions() {
        let mut timeline = timeline(serde_json::json!({
            "segments": [
                { "recordingSegment": 0, "timescale": 1.0, "start": 0.0, "end": 10.0 },
                { "recordingSegment": 1, "timescale": 1.0, "start": 0.0, "end": 10.0 }
            ],
            "zoomSegments": []
        }));
        timeline.transitions = vec![cap_project::ClipTransition {
            segment_index: 1,
            kind: cap_project::ClipTransitionType::CrossFade,
            duration: 1.0,
        }];
        let detected = vec![vec![(8.0, 10.0)], vec![(0.0, 2.0)]];
        let silences = timeline_silences(&timeline, &detected);
        let spans: Vec<(f64, f64)> = silences
            .iter()
            .map(|s| (s.source_start, s.source_end))
            .collect();
        assert_eq!(spans, vec![(8.0, 9.0), (1.0, 2.0)]);
    }

    #[test]
    fn cutting_splits_clips_and_ripples_the_other_tracks() {
        let mut timeline = timeline(serde_json::json!({
            "segments": [
                { "recordingSegment": 0, "timescale": 1.0, "start": 0.0, "end": 10.0 }
            ],
            "zoomSegments": [
                { "start": 1.0, "end": 3.5, "amount": 1.5, "mode": "auto" },
                { "start": 6.0, "end": 8.0, "amount": 2.0, "mode": "auto" }
            ]
        }));
        let detected = vec![vec![(0.0, 1.0), (3.0, 4.0), (6.5, 7.0), (9.0, 10.0)]];
        let silences = timeline_silences(&timeline, &detected);
        assert_eq!(cut_silences(&mut timeline, &silences), 4);

        let clips: Vec<(f64, f64)> = timeline
            .segments
            .iter()
            .map(|segment| (segment.start, segment.end))
            .collect();
        assert_eq!(clips, vec![(1.0, 3.0), (4.0, 6.5), (7.0, 9.0)]);
        assert!((timeline.duration() - 6.5).abs() < 1e-9);

        let zooms: Vec<(f64, f64)> = timeline
            .zoom_segments
            .iter()
            .map(|zoom| (zoom.start, zoom.end))
            .collect();
        assert_eq!(zooms, vec![(0.0, 2.0), (4.0, 5.5)]);
    }

    #[test]
    fn a_fully_silent_clip_is_removed_but_never_the_last_one() {
        let mut timeline = timeline(serde_json::json!({
            "segments": [
                { "recordingSegment": 0, "timescale": 1.0, "start": 0.0, "end": 4.0 },
                { "recordingSegment": 1, "timescale": 1.0, "start": 0.0, "end": 4.0 }
            ],
            "zoomSegments": []
        }));
        let detected = vec![vec![(0.0, 4.0)], vec![(0.0, 4.0)]];
        let silences = timeline_silences(&timeline, &detected);
        assert_eq!(silences.len(), 2);
        assert_eq!(cut_silences(&mut timeline, &silences), 1);
        assert_eq!(timeline.segments.len(), 1);
    }

    #[test]
    fn the_summary_counts_only_pending_silences() {
        let mut state = CleanUpState {
            silences: vec![
                TimelineSilence {
                    key: SilenceKey {
                        recording_clip: 0,
                        index: 0,
                    },
                    segment_index: 0,
                    source_start: 1.,
                    source_end: 3.,
                    start: 1.,
                    end: 3.,
                },
                TimelineSilence {
                    key: SilenceKey {
                        recording_clip: 0,
                        index: 1,
                    },
                    segment_index: 0,
                    source_start: 5.,
                    source_end: 6.,
                    start: 5.,
                    end: 6.,
                },
            ],
            ..CleanUpState::default()
        };
        state.toggle_kept(state.silences[0].key);
        let summary = state.summary(10.);
        assert_eq!((summary.count, summary.kept), (1, 1));
        assert!((summary.saved - 1.).abs() < 1e-9);
        assert!((summary.after() - 9.).abs() < 1e-9);
        assert!((summary.fraction() - 0.1).abs() < 1e-9);

        assert_eq!(state.step_focus(true).map(|s| s.start), Some(1.));
        assert_eq!(state.step_focus(true).map(|s| s.start), Some(5.));
        assert_eq!(state.step_focus(true).map(|s| s.start), Some(5.));
        assert_eq!(state.step_focus(false).map(|s| s.start), Some(1.));
    }

    fn silence(index: usize, start: f64, end: f64) -> TimelineSilence {
        TimelineSilence {
            key: SilenceKey {
                recording_clip: 0,
                index,
            },
            segment_index: 0,
            source_start: start,
            source_end: end,
            start,
            end,
        }
    }

    #[test]
    fn playback_skips_pending_silences_and_their_neighbours() {
        let mut state = CleanUpState {
            silences: vec![silence(0, 1., 2.), silence(1, 2.01, 3.), silence(2, 5., 6.)],
            ..CleanUpState::default()
        };
        let lead = 1. / 60.;
        assert_eq!(state.skip_target(0.5, lead), None);
        assert_eq!(state.skip_target(0.99, lead), Some(3.));
        assert_eq!(state.skip_target(1.5, lead), Some(3.));
        assert_eq!(state.skip_target(3., lead), None);
        state.toggle_kept(state.silences[2].key);
        assert_eq!(state.skip_target(5.5, lead), None);
        state.toggle_kept(state.silences[1].key);
        assert_eq!(state.skip_target(1.5, lead), Some(2.));
        assert_eq!(state.silence_at(2.5).map(|s| s.key.index), Some(1));
        assert_eq!(state.silence_at(4.), None);
    }

    #[test]
    fn quiet_recordings_are_boosted_towards_a_voice_reference() {
        let quiet = levels(&[(3.0, -45.), (1.0, -70.)]);
        assert!((level_boost_db([quiet.as_slice()]) - 25.).abs() < 1e-4);
        let loud = levels(&[(3.0, -12.), (1.0, -60.)]);
        assert_eq!(level_boost_db([loud.as_slice()]), 0.);
        let silent = vec![FLOOR_DB; 100];
        assert_eq!(level_boost_db([silent.as_slice()]), 0.);
        let whisper = levels(&[(3.0, -80.)]);
        assert_eq!(level_boost_db([whisper.as_slice()]), MAX_LEVEL_BOOST_DB);
    }

    #[test]
    fn boosting_finds_speech_the_default_threshold_misses() {
        let envelope = ClipEnvelope {
            mic: Some(Arc::new(levels(&[(1.0, -45.), (1.0, -70.), (1.0, -45.)]))),
            ..ClipEnvelope::default()
        };
        let inputs = |normalize: bool| DetectionInputs {
            settings: SilenceSettings::default().with_normalize(normalize),
            mic_volume_db: 0.,
            system_volume_db: 0.,
            offsets: vec![(0., 0.)],
        };
        let flat = detect_clips(std::slice::from_ref(&envelope), &inputs(false));
        assert_eq!(flat.ranges[0].len(), 1);
        assert!(flat.ranges[0][0].1 - flat.ranges[0][0].0 > 2.5);
        let boosted = detect_clips(std::slice::from_ref(&envelope), &inputs(true));
        assert!((boosted.boost_db - 25.).abs() < 1e-4);
        approx(&boosted.ranges[0], &[(1.01, 1.99)]);
    }

    #[test]
    fn durations_format_like_the_summary_card() {
        assert_eq!(format_duration(150.8), "2m 30.8s");
        assert_eq!(format_duration(937.6), "15m 37.6s");
        assert_eq!(format_duration(4.25), "4.3s");
        assert_eq!(format_duration(3_725.), "1h 2m 5.0s");
    }
}
