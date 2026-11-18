use crate::{CLIP_ALIGNMENT_VERSION, ProjectConfiguration, StudioRecordingMeta};

/// How far from the clip's start and end a timeline clip may sit and still be
/// the untouched clip the recorder or editor created. The end allows for the
/// recorder's and the decoder's media durations differing by a frame.
const PRISTINE_START_TOLERANCE_SECS: f64 = 1e-6;
const PRISTINE_END_TOLERANCE_SECS: f64 = 0.05;
/// How far past its own span an edit may still change a clip's frames: a
/// zoom springs back after it ends, keyboard keys fade out after theirs, an
/// instant zoom snaps just around its edges. A scene's fade-in, which starts
/// `transition_in` before it, is added on top. Erring wide only keeps a clip
/// on its old footage, which is always safe.
const EDIT_REACH_SECS: f64 = 3.0;

/// Moves a project saved before late audio stopped setting a segment's start
/// (`LATE_AUDIO_START_SECS`) onto the current segment clock. Only segments
/// whose start moved are touched, by `shift = old start - new start`. On each,
/// everything timed against the segment's own clock moves by `shift`, so it
/// keeps pointing at the same moment of the recording:
///
/// - mic and system audio clip offsets, automatic or set by hand (any
///   calibration they carry is kept);
/// - markers on that clip;
/// - caption words in that clip's stretch of the source clock.
///
/// What else changes depends on whether the user edited the clip:
///
/// - Untouched (one timeline clip from its start to its end at normal speed,
///   no transition, and nothing on any other track over it): the timeline is
///   left as it is, so the clip now plays the screen and camera from their own
///   start instead of skipping forward and holding the last frame.
/// - Edited: the clip's timeline trims move by `shift` too, so every edited
///   moment keeps showing exactly the frame, audio, cursor and keys it showed
///   before, and every zoom, text, mask or other track item stays on the same
///   footage. The footage the old clock skipped sits before the trim start,
///   where the user can drag the clip open to reveal it. A trim end that ran
///   into the held last frame keeps running past the media end and still
///   holds it; it is not clamped, because shortening the clip would pull
///   every later edit onto different footage. Captions and markers there are
///   not clamped either; a caption in the held tail, which the shared source
///   clock would put in the next clip, is tied to its own clip
///   (`CaptionSegment::recording_clip`), and one running into another clip
///   is split where the clips meet. So is a caption without words running
///   between a late clip, edited or not, and another clip.
///
/// `recording_durations` (each clip's display duration, the source clock
/// captions use) is only read when such a segment has a timeline, markers or
/// captions. Returns whether anything other than the version changed, i.e.
/// whether the project should be saved.
pub fn migrate_late_audio_alignment(
    project: &mut ProjectConfiguration,
    meta: &StudioRecordingMeta,
    recording_durations: impl FnOnce() -> Vec<f64>,
) -> bool {
    if project.clip_alignment_version >= CLIP_ALIGNMENT_VERSION {
        return false;
    }
    project.clip_alignment_version = CLIP_ALIGNMENT_VERSION;

    let shifts = late_audio_shifts(meta);
    if shifts.is_empty() {
        return false;
    }

    for &(index, shift) in &shifts {
        if let Some(clip) = project
            .clips
            .iter_mut()
            .find(|clip| clip.index as usize == index)
        {
            clip.offsets.mic -= shift as f32;
            clip.offsets.system_audio -= shift as f32;
        }
    }

    let has_markers = shifts.iter().any(|&(index, _)| {
        project
            .markers
            .iter()
            .any(|marker| marker.recording_clip as usize == index)
    });
    let has_captions = project
        .captions
        .as_ref()
        .is_some_and(|captions| !captions.segments.is_empty());
    if !(has_markers || has_captions || project.timeline.is_some()) {
        return true;
    }
    let durations = recording_durations();
    // Decided on the timeline as saved, before anything below changes it.
    let edited: Vec<bool> = shifts
        .iter()
        .map(|&(index, _)| match &project.timeline {
            Some(timeline) => {
                !is_untouched_clip(project, timeline, index, durations.get(index).copied())
            }
            None => false,
        })
        .collect();

    shift_markers(project, &shifts, &edited, &durations);
    if has_captions {
        // Converts legacy edited-time captions through the timeline as saved.
        shift_captions(project, &shifts, &edited, &durations);
    }
    if let Some(timeline) = project.timeline.as_mut() {
        for (&(index, shift), _) in shifts.iter().zip(&edited).filter(|(_, edited)| **edited) {
            for segment in timeline
                .segments
                .iter_mut()
                .filter(|segment| segment.recording_clip as usize == index)
            {
                segment.start += shift;
                segment.end += shift;
            }
        }
    }
    if has_captions {
        // Derived once everything has moved: a caption derived against the
        // old trims could fall outside them and lose its style overrides.
        crate::synchronize_captions(project, &durations);
    }

    true
}

/// Each segment whose start moved when late audio stopped counting, with
/// how far (`legacy_latest_start_time - latest_start_time`, always > 0).
fn late_audio_shifts(meta: &StudioRecordingMeta) -> Vec<(usize, f64)> {
    let StudioRecordingMeta::MultipleSegments { inner } = meta else {
        return Vec::new();
    };
    inner
        .segments
        .iter()
        .enumerate()
        .filter_map(|(index, segment)| {
            let shift = segment.legacy_latest_start_time()? - segment.latest_start_time()?;
            (shift.is_finite() && shift > 0.0).then_some((index, shift))
        })
        .collect()
}

/// The source durations [`crate::clamp_timeline_to_sources`] measures clip
/// overrun against. A migrated edited clip of a late-audio segment may end up
/// to that segment's shift past its media (see
/// [`migrate_late_audio_alignment`]), so its limit grows by the shift; every
/// other clip keeps its media duration.
pub fn late_audio_trim_limits(meta: &StudioRecordingMeta, durations: &[f64]) -> Vec<f64> {
    let mut limits = durations.to_vec();
    for (index, shift) in late_audio_shifts(meta) {
        if let Some(limit) = limits.get_mut(index) {
            *limit += shift;
        }
    }
    limits
}

/// Whether recording clip `index` is on the timeline exactly as recorded:
/// one timeline clip from its start to its end at normal speed, no transition
/// into or out of it, no fullscreen text hold anywhere (it moves output time),
/// and no item on any edited-time track over it or within
/// [`EDIT_REACH_SECS`] of it. Only then can its footage
/// move under the timeline without moving anything the user placed.
fn is_untouched_clip(
    project: &ProjectConfiguration,
    timeline: &crate::TimelineConfiguration,
    index: usize,
    duration: Option<f64>,
) -> bool {
    let Some(duration) = duration.filter(|d| d.is_finite() && *d > 0.0) else {
        return false;
    };
    let mut clips = timeline
        .segments
        .iter()
        .enumerate()
        .filter(|(_, segment)| segment.recording_clip as usize == index);
    let (Some((position, segment)), None) = (clips.next(), clips.next()) else {
        return false;
    };
    if segment.start.abs() > PRISTINE_START_TOLERANCE_SECS
        || (segment.end - duration).abs() > PRISTINE_END_TOLERANCE_SECS
        || segment.timescale != 1.0
        || timeline.effective_transition(position).is_some()
        || timeline.effective_transition(position + 1).is_some()
        || !timeline.hold_windows().is_empty()
    {
        return false;
    }
    let Some(&clip_start) = crate::caption_timing::clip_timeline_offsets(timeline).get(position)
    else {
        return false;
    };
    let clip_end = clip_start + segment.duration();
    let over = |start: f64, end: f64| {
        start < clip_end + EDIT_REACH_SECS && end > clip_start - EDIT_REACH_SECS
    };
    let mut spans = timeline
        .zoom_segments
        .iter()
        .map(|s| (s.start, s.end))
        .chain(
            timeline
                .scene_segments
                .iter()
                .map(|s| (s.start - s.transition_in.max(0.0), s.end)),
        )
        .chain(timeline.mask_segments.iter().map(|s| (s.start, s.end)))
        .chain(timeline.text_segments.iter().map(|s| (s.start, s.end)))
        .chain(timeline.keyboard_segments.iter().map(|s| (s.start, s.end)))
        .chain(timeline.audio_segments.iter().map(|s| (s.start, s.end)))
        .chain(timeline.style_segments.iter().map(|s| (s.start, s.end)))
        .chain(timeline.image_segments.iter().map(|s| (s.start, s.end)))
        .chain(timeline.shape_segments.iter().map(|s| (s.start, s.end)))
        .chain(timeline.camera3d_segments.iter().map(|s| (s.start, s.end)))
        // The caption track is derived from source-timed captions, which move
        // with the audio; only a track without captions behind it is an edit.
        .chain(
            timeline
                .caption_segments
                .iter()
                .filter(|_| project.captions.is_none())
                .map(|s| (s.start, s.end)),
        );
    !spans.any(|(start, end)| !(start.is_finite() && end.is_finite()) || over(start, end))
}

fn shift_markers(
    project: &mut ProjectConfiguration,
    shifts: &[(usize, f64)],
    edited: &[bool],
    durations: &[f64],
) {
    for (&(index, shift), &edited) in shifts.iter().zip(edited) {
        // An edited clip's trims move with its markers and may run past the
        // media end, so a marker there stays where it was on the timeline.
        let end = durations
            .get(index)
            .copied()
            .filter(|d| !edited && d.is_finite() && *d > 0.0);
        for marker in project
            .markers
            .iter_mut()
            .filter(|marker| marker.recording_clip as usize == index)
        {
            let time = marker.time + shift;
            marker.time = end.map_or(time, |end| time.min(end));
        }
    }
}

fn shift_captions(
    project: &mut ProjectConfiguration,
    shifts: &[(usize, f64)],
    edited: &[bool],
    durations: &[f64],
) {
    if durations.is_empty() || project.timeline.is_none() {
        return;
    }
    // Legacy captions are stored in edited time; put them on the source clock
    // first so they can be moved with their clip.
    crate::synchronize_captions(project, durations);
    let Some(captions) = project.captions.as_mut().filter(|c| c.source_timed) else {
        return;
    };
    let mut clip_start = Vec::with_capacity(durations.len());
    let mut cumulative = 0.0;
    for duration in durations {
        clip_start.push(cumulative);
        cumulative += duration;
    }
    // Every time is moved with the clip its original start falls in, once, so
    // a caption spanning a pause moves each word with its own clip and a
    // moved time never re-enters the next clip's moves.
    let clip_of = |time: f32| {
        let time = f64::from(time);
        (0..durations.len())
            .find(|&i| (clip_start[i]..clip_start[i] + durations[i]).contains(&time))
    };
    let late = |clip: usize| {
        shifts
            .iter()
            .zip(edited)
            .find(|((index, _), _)| *index == clip)
            .map(|(&(_, shift), &edited)| (shift, edited))
    };
    let media_end = |clip: usize| clip_start[clip] + durations[clip];
    // An untouched clip plays its media from the start and ends at its media
    // end, so a time moved past it is held there. An edited clip's trims move
    // by the same shift and may run past its media end (its held tail), so
    // its times move unclamped to stay on the same edited moment.
    let move_in = |time: f32, clip: Option<usize>| -> Option<f32> {
        let clip = clip?;
        let (shift, edited) = late(clip)?;
        let time = f64::from(time) + shift;
        Some(
            (if edited {
                time
            } else {
                time.min(media_end(clip))
            }) as f32,
        )
    };
    let edited_late = |clip: Option<usize>| clip.and_then(late).is_some_and(|(_, edited)| edited);

    // A caption running from an edited late clip into another clip is split
    // where the clips meet, so each part moves with, and is tied to, its own
    // clip (its times near the boundary cannot say which). So is a caption
    // without words running from or into any late clip: its two ends alone
    // cannot move with two clips. Each part already showed separately, one
    // per timeline segment, so nothing on screen changes; extra parts keep
    // the caption's style. Words move with their own clip, so a transcribed
    // caption across an untouched late clip needs no cut.
    let mut ids: std::collections::HashSet<String> =
        captions.segments.iter().map(|c| c.id.clone()).collect();
    let mut split_ids = Vec::new();
    // Each caption with the clip it was cut for, when it was cut: a part's
    // start on a clip boundary need not read back as that clip.
    let mut segments = Vec::with_capacity(captions.segments.len());
    for segment in std::mem::take(&mut captions.segments) {
        let words = segment.words.len();
        let segment = split_words_at_clips(segment, &clip_start, |clip| late(clip).is_some());
        // A word cut in two is cut with its caption, so no caption holds two
        // pieces of one word (an edit to its text would merge them).
        let word_cut = segment.words.len() > words;
        let cut_for = |clip: Option<usize>| {
            edited_late(clip) || (segment.words.is_empty() && clip.and_then(late).is_some())
        };
        let parts = split_at_clips(&segment, &clip_of, &clip_start);
        if parts.len() < 2 || !(word_cut || parts.iter().any(|(clip, _)| cut_for(*clip))) {
            segments.push((None, segment));
            continue;
        }
        // Each part is tied to its clip, so a word running out of it into a
        // clip that is not late is cut at that clip's start too.
        let segment = split_words_at_clips(segment, &clip_start, |_| true);
        let parts = split_at_clips(&segment, &clip_of, &clip_start);
        for (index, (clip, mut part)) in parts.into_iter().enumerate() {
            if index > 0 {
                let mut suffix = index;
                while ids.contains(&format!("{}-{suffix}", segment.id)) {
                    suffix += 1;
                }
                part.id = format!("{}-{suffix}", segment.id);
                ids.insert(part.id.clone());
                split_ids.push((segment.id.clone(), part.id.clone()));
            }
            part.recording_clip = clip.map(|clip| clip as u32);
            segments.push((clip, part));
        }
    }

    let mut moved = !split_ids.is_empty();
    captions.segments = Vec::with_capacity(segments.len());
    for (clip, mut segment) in segments {
        let start_clip = clip.or_else(|| clip_of(segment.start));
        let mut end_clip = start_clip;
        let mut segment_moved = false;
        for word in &mut segment.words {
            let clip = clip_of(word.start);
            end_clip = clip;
            if let (Some(start), Some(end)) = (move_in(word.start, clip), move_in(word.end, clip)) {
                word.start = start;
                word.end = end;
                segment_moved = true;
            }
        }
        if let Some(start) = move_in(segment.start, start_clip) {
            segment.start = start;
            segment_moved = true;
        }
        if let Some(end) = move_in(segment.end, end_clip) {
            segment.end = end;
            segment_moved = true;
        }
        if segment_moved {
            if let Some(first) = segment.words.iter().map(|w| w.start).reduce(f32::min) {
                segment.start = segment.start.min(first);
            }
            if let Some(last) = segment.words.iter().map(|w| w.end).reduce(f32::max) {
                segment.end = segment.end.max(last);
            }
            // Past its clip's media end the shared clock is the next clip's,
            // so a caption in an edited clip's held tail is tied to its clip.
            if let Some(clip) = start_clip.filter(|&clip| edited_late(Some(clip)))
                && f64::from(segment.end) > media_end(clip)
            {
                segment.recording_clip = Some(clip as u32);
            }
            moved = true;
        }
        captions.segments.push(segment);
    }
    if moved {
        captions
            .segments
            .sort_by(|a, b| a.start.total_cmp(&b.start));
    }
    if let Some(timeline) = project.timeline.as_mut() {
        for (source, part) in split_ids {
            if let Some(style) = timeline
                .caption_segments
                .iter()
                .find(|item| crate::source_caption_id(&item.id) == source)
            {
                let mut style = style.clone();
                style.id = part;
                timeline.caption_segments.push(style);
            }
        }
    }
}

/// `segment` with each word drawn across the start of a clip, where `cut`
/// holds for either clip, cut there into one word per clip with the same
/// text. The word showed through both clips before; cut, each piece moves
/// with, and is tied to, its own clip and keeps showing there. Cut ends round
/// toward the boundary so each piece's start reads back as its own clip.
fn split_words_at_clips(
    mut segment: crate::CaptionSegment,
    clip_start: &[f64],
    cut: impl Fn(usize) -> bool,
) -> crate::CaptionSegment {
    let drawn_end = |word: &crate::CaptionWord| {
        word.end
            .min(word.start + crate::caption_words::MAX_CAPTION_WORD_DURATION)
    };
    let cuts = |word: &crate::CaptionWord| {
        (1..clip_start.len())
            .filter(|&clip| cut(clip - 1) || cut(clip))
            .map(|clip| clip_start[clip])
            .filter(|&cut| f64::from(word.start) < cut && cut < f64::from(drawn_end(word)))
            .collect::<Vec<_>>()
    };
    if segment.words.iter().all(|word| cuts(word).is_empty()) {
        return segment;
    }
    let first_start = segment.words.first().map(|word| word.start);
    let mut words = Vec::with_capacity(segment.words.len() + 1);
    for word in std::mem::take(&mut segment.words) {
        let cuts = cuts(&word);
        if cuts.is_empty() {
            words.push(word);
            continue;
        }
        let mut start = word.start;
        for cut in cuts {
            words.push(crate::CaptionWord {
                text: word.text.clone(),
                start,
                end: f32_at_or_before(cut),
            });
            start = f32_at_or_after(cut);
        }
        words.push(crate::CaptionWord {
            end: drawn_end(&word),
            start,
            text: word.text,
        });
    }
    words.retain(|word| word.end > word.start);
    // A caption starting with a word at a clip start that f32 rounds just
    // short of it starts in that clip too, with its word.
    if let (Some(old), Some(new)) = (first_start, words.first())
        && segment.start == old
        && new.start > old
    {
        segment.start = new.start;
    }
    segment.words = words;
    segment
}

/// `segment` cut where its content changes recording clip, each part with
/// the clip it belongs to. Words go with the clip their start is in (a run
/// of words keeps its clip across a time outside every clip); a caption
/// without words is cut at the clip boundaries it crosses.
fn split_at_clips(
    segment: &crate::CaptionSegment,
    clip_of: &impl Fn(f32) -> Option<usize>,
    clip_start: &[f64],
) -> Vec<(Option<usize>, crate::CaptionSegment)> {
    let part = |start: f32, end: f32, words: Vec<crate::CaptionWord>| crate::CaptionSegment {
        id: segment.id.clone(),
        start,
        end,
        text: if words.is_empty() {
            segment.text.clone()
        } else {
            crate::caption_words::caption_text_from_words(&words)
        },
        words,
        recording_clip: segment.recording_clip,
    };
    if segment.words.is_empty() {
        let first = clip_of(segment.start);
        let last = clip_of(segment.end).or(first);
        let (Some(first), Some(last)) = (first, last) else {
            return vec![(first, segment.clone())];
        };
        if last <= first {
            return vec![(Some(first), segment.clone())];
        }
        // Each part is tied to its clip, which bounds it exactly, so its
        // ends round outward past the boundary rather than short of it. A
        // caption ending exactly where a clip starts has nothing in it.
        return (first..=last)
            .map(|clip| {
                let start = if clip == first {
                    segment.start
                } else {
                    f32_at_or_before(clip_start[clip])
                };
                let end = match clip_start.get(clip + 1) {
                    Some(&next) if clip < last => f32_at_or_after(next),
                    _ => segment.end,
                };
                (Some(clip), part(start, end, Vec::new()))
            })
            .filter(|(clip, part)| *clip == Some(first) || part.end > part.start)
            .collect();
    }
    let mut runs: Vec<(Option<usize>, Vec<crate::CaptionWord>)> = Vec::new();
    for word in &segment.words {
        let clip = clip_of(word.start);
        match runs.last_mut() {
            Some((run_clip, words)) if clip.is_none() || *run_clip == clip => {
                words.push(word.clone())
            }
            _ => runs.push((clip, vec![word.clone()])),
        }
    }
    if runs.len() < 2 {
        return vec![(runs.first().and_then(|run| run.0), segment.clone())];
    }
    let count = runs.len();
    runs.into_iter()
        .enumerate()
        .map(|(index, (clip, words))| {
            let first = words.iter().map(|w| w.start).fold(f32::INFINITY, f32::min);
            let last = words
                .iter()
                .map(|w| w.end)
                .fold(f32::NEG_INFINITY, f32::max);
            let start = if index == 0 {
                segment.start.min(first)
            } else {
                first
            };
            let end = if index + 1 == count {
                segment.end.max(last)
            } else {
                last
            };
            (clip, part(start, end, words))
        })
        .collect()
}

fn f32_at_or_before(time: f64) -> f32 {
    let rounded = time as f32;
    if f64::from(rounded) > time {
        rounded.next_down()
    } else {
        rounded
    }
}

fn f32_at_or_after(time: f64) -> f32 {
    let rounded = time as f32;
    if f64::from(rounded) < time {
        rounded.next_up()
    } else {
        rounded
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        CaptionSegment, CaptionWord, CaptionsData, ClipConfiguration, ClipOffsets, TimelineMarker,
    };

    // Two clips of 10 s. Clip 1: screen and camera start at 0.05, the mic at
    // 4.05 (it came back 4 s in), system audio at 0.
    fn meta(mic_start: f64) -> StudioRecordingMeta {
        serde_json::from_value(serde_json::json!({
            "segments": [
                {
                    "display": { "path": "a/display.mp4", "fps": 30, "start_time": 0.05 },
                    "mic": { "path": "a/mic.ogg", "start_time": 0.03 }
                },
                {
                    "display": { "path": "b/display.mp4", "fps": 30, "start_time": 0.05 },
                    "camera": { "path": "b/camera.mp4", "fps": 30, "start_time": 0.05 },
                    "mic": { "path": "b/mic.ogg", "start_time": mic_start },
                    "system_audio": { "path": "b/system.ogg", "start_time": 0.0 }
                }
            ]
        }))
        .unwrap()
    }

    fn clip(index: u32, mic: f32, system_audio: f32, auto: bool) -> ClipConfiguration {
        ClipConfiguration {
            index,
            offsets: ClipOffsets {
                camera: 0.0,
                mic,
                system_audio,
            },
            offsets_auto_calculated: auto,
        }
    }

    fn legacy_project() -> ProjectConfiguration {
        let mut project: ProjectConfiguration = serde_json::from_value(serde_json::json!({
            "timeline": {
                "segments": [
                    { "recordingSegment": 0, "start": 0.0, "end": 10.0, "timescale": 1.0 },
                    { "recordingSegment": 1, "start": 0.0, "end": 10.0, "timescale": 1.0 }
                ],
                "zoomSegments": []
            }
        }))
        .unwrap();
        assert_eq!(project.clip_alignment_version, 0);
        // Saved while the mic set clip 1's start: mic 0 + calibration 0.02,
        // system audio 4.05 + 0.02.
        project.clips = vec![clip(0, 0.04, 0.0, true), clip(1, 0.02, 4.07, true)];
        project
    }

    fn durations() -> Vec<f64> {
        vec![10.0, 10.0]
    }

    fn close(a: f32, b: f32) -> bool {
        (a - b).abs() < 1e-4
    }

    #[test]
    fn default_projects_are_current_and_never_migrate() {
        let mut project = ProjectConfiguration::default();
        assert_eq!(project.clip_alignment_version, CLIP_ALIGNMENT_VERSION);
        project.clips = vec![clip(1, -4.0, 0.05, true)];
        let before = serde_json::to_string(&project).unwrap();
        assert!(!migrate_late_audio_alignment(
            &mut project,
            &meta(4.05),
            || unreachable!()
        ));
        assert_eq!(serde_json::to_string(&project).unwrap(), before);
    }

    #[test]
    fn auto_offsets_move_to_the_screen_start_and_keep_calibration() {
        let mut project = legacy_project();
        assert!(migrate_late_audio_alignment(
            &mut project,
            &meta(4.05),
            durations
        ));
        assert_eq!(project.clip_alignment_version, CLIP_ALIGNMENT_VERSION);
        let clip1 = project.clips[1].offsets;
        assert!(close(clip1.mic, -3.98), "mic {}", clip1.mic);
        assert!(
            close(clip1.system_audio, 0.07),
            "system {}",
            clip1.system_audio
        );
        assert_eq!(clip1.camera, 0.0);
        assert!(project.clips[1].offsets_auto_calculated);
        // The untouched clip keeps its exact bits.
        assert_eq!(project.clips[0].offsets.mic.to_bits(), 0.04f32.to_bits());
    }

    #[test]
    fn user_offsets_keep_their_sync_against_the_video() {
        let mut project = legacy_project();
        project.clips[1] = clip(1, 0.25, 4.3, false);
        migrate_late_audio_alignment(&mut project, &meta(4.05), durations);
        let clip1 = &project.clips[1];
        assert!(!clip1.offsets_auto_calculated);
        assert!(close(clip1.offsets.mic, -3.75));
        assert!(close(clip1.offsets.system_audio, 0.3));
    }

    #[test]
    fn runs_once() {
        let mut project = legacy_project();
        assert!(migrate_late_audio_alignment(
            &mut project,
            &meta(4.05),
            durations
        ));
        let once = serde_json::to_string(&project).unwrap();
        assert!(!migrate_late_audio_alignment(
            &mut project,
            &meta(4.05),
            || unreachable!()
        ));
        assert_eq!(serde_json::to_string(&project).unwrap(), once);
        let reloaded: ProjectConfiguration = serde_json::from_str(&once).unwrap();
        assert_eq!(reloaded.clip_alignment_version, CLIP_ALIGNMENT_VERSION);
    }

    #[test]
    fn normal_recordings_only_get_the_version() {
        // An edited normal project: nothing but the version may change.
        let mut project = edited_project();
        let before = serde_json::to_value(&project).unwrap();
        assert!(!migrate_late_audio_alignment(
            &mut project,
            &meta(0.06),
            || unreachable!()
        ));
        assert_eq!(project.clip_alignment_version, CLIP_ALIGNMENT_VERSION);
        project.clip_alignment_version = 0;
        assert_eq!(serde_json::to_value(&project).unwrap(), before);
    }

    #[test]
    fn markers_on_the_late_clip_follow_their_moment() {
        let mut project = legacy_project();
        project.markers = vec![
            TimelineMarker::new(0, 2.0),
            TimelineMarker::new(1, 1.5),
            TimelineMarker::new(1, 9.0),
        ];
        migrate_late_audio_alignment(&mut project, &meta(4.05), || vec![10.0, 10.0]);
        let times: Vec<_> = project.markers.iter().map(|m| m.time).collect();
        assert_eq!(times[0], 2.0);
        assert!((times[1] - 5.5).abs() < 1e-9);
        assert_eq!(times[2], 10.0);
    }

    #[test]
    fn caption_words_on_the_late_clip_follow_the_audio() {
        let mut project = legacy_project();
        let caption = |id: &str, start: f32| CaptionSegment {
            id: id.into(),
            start,
            end: start + 1.0,
            text: "hi".into(),
            words: vec![CaptionWord {
                text: "hi".into(),
                start,
                end: start + 1.0,
            }],
            recording_clip: None,
        };
        project.captions = Some(CaptionsData {
            segments: vec![caption("first", 2.0), caption("second", 11.0)],
            source_timed: true,
            ..Default::default()
        });
        migrate_late_audio_alignment(&mut project, &meta(4.05), || vec![10.0, 10.0]);
        let captions = project.captions.as_ref().unwrap();
        assert_eq!(captions.segments[0].start, 2.0);
        assert!(close(captions.segments[1].start, 15.0));
        assert!(close(captions.segments[1].words[0].start, 15.0));
        assert!(close(captions.segments[1].words[0].end, 16.0));
        let track = &project.timeline.as_ref().unwrap().caption_segments;
        assert!(track.iter().any(|c| (c.start - 15.0).abs() < 1e-4));
    }

    // Two consecutive late clips: a caption clamped to the first clip's end
    // must not be moved again by the second.
    #[test]
    fn captions_move_once_across_consecutive_late_clips() {
        let mut project = legacy_project();
        let StudioRecordingMeta::MultipleSegments { mut inner } = meta(4.05) else {
            unreachable!()
        };
        inner.segments[0].mic.as_mut().unwrap().start_time = Some(4.05);
        let meta = StudioRecordingMeta::MultipleSegments { inner };
        let caption = |start: f32| CaptionSegment {
            id: format!("c{start}"),
            start,
            end: start + 1.0,
            text: "hi".into(),
            words: vec![CaptionWord {
                text: "hi".into(),
                start,
                end: start + 1.0,
            }],
            recording_clip: None,
        };
        project.captions = Some(CaptionsData {
            segments: vec![caption(7.0), caption(12.0)],
            source_timed: true,
            ..Default::default()
        });
        migrate_late_audio_alignment(&mut project, &meta, || vec![10.0, 10.0]);
        let starts: Vec<_> = project
            .captions
            .as_ref()
            .unwrap()
            .segments
            .iter()
            .map(|s| s.start)
            .collect();
        assert_eq!(starts, vec![10.0, 16.0]);
    }

    fn spanning_caption() -> CaptionSegment {
        let word = |start: f32, end: f32| CaptionWord {
            text: "w".into(),
            start,
            end,
        };
        CaptionSegment {
            id: "span".into(),
            start: 5.0,
            end: 10.8,
            text: "w w".into(),
            words: vec![word(5.0, 5.5), word(10.2, 10.8)],
            recording_clip: None,
        }
    }

    fn word_times(project: &ProjectConfiguration) -> (f32, f32, Vec<(f32, f32)>) {
        let segment = &project.captions.as_ref().unwrap().segments[0];
        (
            segment.start,
            segment.end,
            segment.words.iter().map(|w| (w.start, w.end)).collect(),
        )
    }

    // A caption that runs from a normal clip into a late one: only the words
    // in the late clip move.
    #[test]
    fn caption_spanning_into_a_late_clip_moves_only_its_late_words() {
        let mut project = legacy_project();
        project.captions = Some(CaptionsData {
            segments: vec![spanning_caption()],
            source_timed: true,
            ..Default::default()
        });
        migrate_late_audio_alignment(&mut project, &meta(4.05), || vec![10.0, 10.0]);
        let (start, end, words) = word_times(&project);
        assert_eq!(start, 5.0);
        assert!(close(end, 14.8));
        assert_eq!(words[0], (5.0, 5.5));
        assert!(close(words[1].0, 14.2) && close(words[1].1, 14.8));
    }

    // The reverse: a caption from a late clip into a normal one keeps the
    // normal clip's words where they are instead of clamping them.
    #[test]
    fn caption_spanning_out_of_a_late_clip_keeps_its_normal_words() {
        let mut project = legacy_project();
        let StudioRecordingMeta::MultipleSegments { mut inner } = meta(0.06) else {
            unreachable!()
        };
        inner.segments[0].mic.as_mut().unwrap().start_time = Some(4.05);
        let meta = StudioRecordingMeta::MultipleSegments { inner };
        project.captions = Some(CaptionsData {
            segments: vec![spanning_caption()],
            source_timed: true,
            ..Default::default()
        });
        migrate_late_audio_alignment(&mut project, &meta, || vec![10.0, 10.0]);
        let (start, end, words) = word_times(&project);
        assert!(close(start, 9.0));
        assert_eq!(end, 10.8);
        assert!(close(words[0].0, 9.0) && close(words[0].1, 9.5));
        assert_eq!(words[1], (10.2, 10.8));
    }

    #[test]
    fn a_mic_that_never_started_needs_no_durations_without_timeline_markers_or_captions() {
        let mut project = legacy_project();
        project.timeline = None;
        project.clips[1] = clip(1, 0.0, 10.0, true);
        assert!(migrate_late_audio_alignment(
            &mut project,
            &meta(10.0),
            || unreachable!()
        ));
        assert!(close(project.clips[1].offsets.mic, -9.95));
        assert!(close(project.clips[1].offsets.system_audio, 0.05));
    }

    // Where an edited moment of the timeline reads every track from, on the
    // clock `clock` (seconds after the recording epoch of segment time zero).
    // Mirrors the renderer: the screen decoder adds `clock - display start`
    // (`rendering::segment_timing`), the camera also takes the camera offset,
    // audio reads `segment time + clip offset` (`editor::audio`), and cursor
    // and keyboard events are looked up at `segment time + clock`.
    #[derive(Debug, PartialEq)]
    struct Sources {
        clip: u32,
        screen: f64,
        camera: Option<f64>,
        mic: f64,
        system: f64,
        cursor: f64,
    }

    fn sources(
        project: &ProjectConfiguration,
        meta: &StudioRecordingMeta,
        legacy_clock: bool,
        edited_time: f64,
    ) -> Option<Sources> {
        let StudioRecordingMeta::MultipleSegments { inner } = meta else {
            unreachable!()
        };
        let (segment_time, segment) = project.timeline.as_ref()?.get_segment_time(edited_time)?;
        let recording = &inner.segments[segment.recording_clip as usize];
        let clock = if legacy_clock {
            recording.legacy_latest_start_time()
        } else {
            recording.latest_start_time()
        }?;
        let offsets = project
            .clips
            .iter()
            .find(|clip| clip.index == segment.recording_clip)
            .map(|clip| clip.offsets)
            .unwrap_or_default();
        Some(Sources {
            clip: segment.recording_clip,
            screen: segment_time + clock - recording.display.start_time?,
            camera: recording.camera.as_ref().map(|camera| {
                segment_time + f64::from(offsets.camera) + clock - camera.start_time.unwrap()
            }),
            mic: segment_time + f64::from(offsets.mic),
            system: segment_time + f64::from(offsets.system_audio),
            cursor: segment_time + clock,
        })
    }

    fn same_sources(a: &Sources, b: &Sources) -> bool {
        let near = |x: f64, y: f64| (x - y).abs() < 1e-5;
        a.clip == b.clip
            && near(a.screen, b.screen)
            && match (a.camera, b.camera) {
                (Some(x), Some(y)) => near(x, y),
                (None, None) => true,
                _ => false,
            }
            && near(a.mic, b.mic)
            && near(a.system, b.system)
            && near(a.cursor, b.cursor)
    }

    // Clip 1 of `meta(4.05)` (shift 4 s) trimmed to 1-6 s and 7-9.5 s at 2x,
    // with a zoom and a text overlay over it, a marker and a caption on it.
    fn edited_project() -> ProjectConfiguration {
        let mut project: ProjectConfiguration = serde_json::from_value(serde_json::json!({
            "timeline": {
                "segments": [
                    { "recordingSegment": 0, "start": 0.0, "end": 10.0, "timescale": 1.0 },
                    { "recordingSegment": 1, "start": 1.0, "end": 6.0, "timescale": 1.0 },
                    { "recordingSegment": 1, "start": 7.0, "end": 9.5, "timescale": 2.0 }
                ],
                "zoomSegments": [
                    { "start": 11.0, "end": 13.0, "amount": 2.0, "mode": "auto" }
                ],
                "textSegments": [ { "start": 12.0, "end": 15.5 } ]
            }
        }))
        .unwrap();
        project.clips = vec![clip(0, 0.04, 0.0, true), clip(1, 0.02, 4.07, true)];
        project.markers = vec![TimelineMarker::new(1, 2.5)];
        project.captions = Some(CaptionsData {
            segments: vec![CaptionSegment {
                id: "c".into(),
                start: 11.5,
                end: 12.5,
                text: "hi there".into(),
                words: vec![
                    CaptionWord {
                        text: "hi".into(),
                        start: 11.5,
                        end: 11.9,
                    },
                    CaptionWord {
                        text: "there".into(),
                        start: 12.0,
                        end: 12.5,
                    },
                ],
                recording_clip: None,
            }],
            source_timed: true,
            ..Default::default()
        });
        crate::synchronize_captions(&mut project, &durations());
        project
    }

    fn edited_times(project: &ProjectConfiguration) -> impl Iterator<Item = f64> {
        let duration = project.timeline.as_ref().unwrap().duration();
        (0..(duration * 100.0) as usize).map(|step| step as f64 / 100.0)
    }

    // The coordinator's regression: an edited late-audio clip must show
    // exactly the frame, audio, cursor and keys at every edited moment that it
    // showed before the migration, with every overlay on the same footage.
    #[test]
    fn edited_clip_keeps_every_edited_moment_on_the_same_source() {
        let meta = meta(4.05);
        let before = edited_project();
        let mut after = before.clone();
        assert!(migrate_late_audio_alignment(&mut after, &meta, durations));

        let mut checked = 0;
        for time in edited_times(&before) {
            let old = sources(&before, &meta, true, time).unwrap();
            let new = sources(&after, &meta, false, time).unwrap();
            assert!(same_sources(&old, &new), "at {time}: {old:?} -> {new:?}");
            checked += 1;
        }
        assert!(checked > 1500);

        let (old, new) = (before.timeline.unwrap(), after.timeline.as_ref().unwrap());
        assert_eq!(
            serde_json::to_value(&old.zoom_segments).unwrap(),
            serde_json::to_value(&new.zoom_segments).unwrap()
        );
        assert_eq!(
            serde_json::to_value(&old.text_segments).unwrap(),
            serde_json::to_value(&new.text_segments).unwrap()
        );
        assert!((old.duration() - new.duration()).abs() < 1e-9);
        // The caption track the renderer draws is where it was, and its words
        // now read the same moment of the mic as before.
        let track = |t: &crate::TimelineConfiguration| {
            t.caption_segments
                .iter()
                .map(|c| (c.start, c.end))
                .collect::<Vec<_>>()
        };
        assert_eq!(track(&old).len(), 1);
        for ((old_start, old_end), (new_start, new_end)) in track(&old).into_iter().zip(track(new))
        {
            assert!((old_start - new_start).abs() < 1e-4 && (old_end - new_end).abs() < 1e-4);
        }
        // The marker points at the same recorded moment and sits at the same
        // edited time.
        let (old_marker, new_marker) = (2.5, after.markers[0].time);
        assert!((new_marker - (old_marker + 4.0)).abs() < 1e-9);
        assert!((new.segments[1].start - 5.0).abs() < 1e-9);
    }

    fn late_clip_start(project: &ProjectConfiguration) -> f64 {
        project
            .timeline
            .as_ref()
            .unwrap()
            .segments
            .iter()
            .find(|segment| segment.recording_clip == 1)
            .unwrap()
            .start
    }

    fn migrated_late_clip_start(edit: impl FnOnce(&mut ProjectConfiguration)) -> f64 {
        let mut project = legacy_project();
        edit(&mut project);
        migrate_late_audio_alignment(&mut project, &meta(4.05), durations);
        late_clip_start(&project)
    }

    // Untouched clips are restored (their timeline stays put); any edit that
    // a footage move would carry onto different content keeps the clip on
    // its old footage (its trims move by the 4 s shift).
    #[test]
    fn only_untouched_clips_are_restored() {
        assert_eq!(migrated_late_clip_start(|_| {}), 0.0);
        // Overlays on the other clip only, and a caption track backed by
        // captions, leave it untouched.
        assert_eq!(
            migrated_late_clip_start(|p| {
                p.timeline.as_mut().unwrap().zoom_segments =
                    serde_json::from_value(serde_json::json!([
                        { "start": 1.0, "end": 6.9, "amount": 2.0, "mode": "auto" },
                        { "start": 23.1, "end": 25.0, "amount": 2.0, "mode": "auto" }
                    ]))
                    .unwrap();
            }),
            0.0
        );
        assert_eq!(
            migrated_late_clip_start(|p| {
                p.timeline.as_mut().unwrap().segments[1].end = 9.99;
            }),
            0.0,
            "within the media-duration tolerance"
        );

        type Edit = fn(&mut ProjectConfiguration);
        let edits: Vec<(&str, Edit)> = vec![
            ("start trim", |p| {
                p.timeline.as_mut().unwrap().segments[1].start = 0.5
            }),
            ("end trim", |p| {
                p.timeline.as_mut().unwrap().segments[1].end = 8.0
            }),
            ("speed", |p| {
                p.timeline.as_mut().unwrap().segments[1].timescale = 2.0
            }),
            ("split", |p| {
                let timeline = p.timeline.as_mut().unwrap();
                let mut tail = timeline.segments[1].clone();
                timeline.segments[1].end = 5.0;
                tail.start = 5.0;
                timeline.segments.push(tail);
            }),
            ("transition", |p| {
                p.timeline.as_mut().unwrap().transitions =
                    serde_json::from_value(serde_json::json!([
                        { "segmentIndex": 1, "kind": "crossfade", "duration": 0.5 }
                    ]))
                    .unwrap();
            }),
            ("zoom", |p| {
                p.timeline.as_mut().unwrap().zoom_segments =
                    serde_json::from_value(serde_json::json!([
                        { "start": 15.0, "end": 16.0, "amount": 2.0, "mode": "auto" }
                    ]))
                    .unwrap();
            }),
            ("text", |p| {
                p.timeline.as_mut().unwrap().text_segments =
                    serde_json::from_value(serde_json::json!([{ "start": 12.0, "end": 13.0 }]))
                        .unwrap();
            }),
            ("zoom springing back into it", |p| {
                p.timeline.as_mut().unwrap().zoom_segments =
                    serde_json::from_value(serde_json::json!([
                        { "start": 5.0, "end": 9.0, "amount": 2.0, "mode": "auto" }
                    ]))
                    .unwrap();
            }),
            ("scene fading in over its end", |p| {
                p.timeline.as_mut().unwrap().scene_segments =
                    serde_json::from_value(serde_json::json!([
                        { "start": 24.0, "end": 26.0, "mode": "cameraOnly", "transitionIn": 1.5 }
                    ]))
                    .unwrap();
            }),
            ("fullscreen text elsewhere", |p| {
                p.timeline.as_mut().unwrap().text_segments =
                    serde_json::from_value(serde_json::json!([
                        { "start": 2.0, "end": 3.0, "layout": "fullscreen" }
                    ]))
                    .unwrap();
            }),
        ];
        for (name, edit) in edits {
            let mut original = legacy_project();
            edit(&mut original);
            let expected = late_clip_start(&original) + 4.0;
            assert!(
                (migrated_late_clip_start(edit) - expected).abs() < 1e-9,
                "{name}"
            );
        }

        for track in [
            "sceneSegments",
            "maskSegments",
            "keyboardSegments",
            "audioSegments",
            "styleSegments",
            "imageSegments",
            "shapeSegments",
            "camera3dSegments",
            "captionSegments",
        ] {
            let mut value = serde_json::to_value(legacy_project().timeline.unwrap()).unwrap();
            value[track] = serde_json::json!([sample_item(track)]);
            let parsed: Result<crate::TimelineConfiguration, _> = serde_json::from_value(value);
            let Ok(parsed) = parsed else {
                panic!("{track}: {}", parsed.unwrap_err());
            };
            let start = migrated_late_clip_start(|p| p.timeline = Some(parsed));
            assert!((start - 4.0).abs() < 1e-9, "{track}");
        }
    }

    // The smallest item of each edited-time track, over clip 1 (12-13 s).
    fn sample_item(track: &str) -> serde_json::Value {
        let base = |extra: serde_json::Value| {
            let mut value = serde_json::json!({ "start": 12.0, "end": 13.0 });
            value
                .as_object_mut()
                .unwrap()
                .extend(extra.as_object().unwrap().clone());
            value
        };
        match track {
            "sceneSegments" => base(serde_json::json!({ "mode": "cameraOnly" })),
            "maskSegments" => base(serde_json::json!({
                "maskType": "sensitive",
                "center": { "x": 0.5, "y": 0.5 },
                "size": { "x": 0.2, "y": 0.2 }
            })),
            "keyboardSegments" => {
                base(serde_json::json!({ "id": "kb-edit-1-0", "displayText": "a" }))
            }
            "audioSegments" => base(serde_json::json!({ "id": "m", "path": "music.mp3" })),
            "styleSegments" => base(serde_json::json!({ "id": "s" })),
            "imageSegments" => base(serde_json::json!({ "id": "i", "path": "image.png" })),
            "shapeSegments" => base(serde_json::json!({ "id": "sh" })),
            "camera3dSegments" => base(serde_json::json!({ "id": "c3" })),
            "captionSegments" => base(serde_json::json!({ "id": "c", "text": "hi" })),
            _ => unreachable!(),
        }
    }

    // An edited clip whose trim end ran into the held last frame keeps it:
    // the end runs past the media end instead of being clamped, so nothing
    // after it moves. The overrun guard measures against the shifted limit,
    // even when the shift is longer than its one-minute allowance.
    #[test]
    fn edited_clip_keeps_its_held_tail_and_later_edits() {
        let mut project = legacy_project();
        project.timeline.as_mut().unwrap().zoom_segments = serde_json::from_value(
            serde_json::json!([{ "start": 15.0, "end": 16.0, "amount": 2.0, "mode": "auto" }]),
        )
        .unwrap();
        // An edit on the clip after it, which a shorter late clip would pull
        // onto earlier footage.
        project.timeline.as_mut().unwrap().text_segments =
            serde_json::from_value(serde_json::json!([{ "start": 25.0, "end": 26.0 }])).unwrap();
        let later =
            serde_json::to_value(&project.timeline.as_ref().unwrap().text_segments).unwrap();
        project.timeline.as_mut().unwrap().segments.push(
            serde_json::from_value(serde_json::json!({
                "recordingSegment": 0, "start": 0.0, "end": 10.0, "timescale": 1.0
            }))
            .unwrap(),
        );
        project.markers = vec![TimelineMarker::new(1, 9.5)];
        let before = project.timeline.as_ref().unwrap().duration();
        migrate_late_audio_alignment(&mut project, &meta(4.05), durations);
        let timeline = project.timeline.as_ref().unwrap();
        assert_eq!(
            (timeline.segments[1].start, timeline.segments[1].end),
            (4.0, 14.0)
        );
        assert_eq!(timeline.duration(), before);
        assert_eq!(
            serde_json::to_value(&timeline.text_segments).unwrap(),
            later
        );
        assert_eq!(timeline.get_segment_time(25.5).unwrap().0, 5.5);
        assert_eq!(
            project.markers[0].time, 13.5,
            "not clamped to the media end"
        );
        let limits = crate::late_audio_trim_limits(&meta(4.05), &durations());
        assert_eq!(limits, vec![10.0, 14.0]);
        crate::clamp_timeline_to_sources(&mut project, &limits);
        assert_eq!(project.timeline.as_ref().unwrap().segments[1].end, 14.0);

        // A mic that never delivered in a 120 s clip: shift ~120 s.
        let mut project = legacy_project();
        project.timeline.as_mut().unwrap().segments[1].end = 120.0;
        project.timeline.as_mut().unwrap().zoom_segments = serde_json::from_value(
            serde_json::json!([{ "start": 20.0, "end": 21.0, "amount": 2.0, "mode": "auto" }]),
        )
        .unwrap();
        let meta = meta(120.05);
        migrate_late_audio_alignment(&mut project, &meta, || vec![10.0, 120.0]);
        assert_eq!(project.timeline.as_ref().unwrap().segments[1].end, 240.0);
        let limits = crate::late_audio_trim_limits(&meta, &[10.0, 120.0]);
        crate::clamp_timeline_to_sources(&mut project, &limits);
        assert_eq!(project.timeline.as_ref().unwrap().segments[1].end, 240.0);
    }

    // A legacy edited-time caption over an edited clip is first placed on the
    // source clock through the timeline as saved, so it stays on its words.
    #[test]
    fn legacy_captions_over_an_edited_clip_keep_their_place() {
        let meta = meta(4.05);
        let mut before = edited_project();
        let words = |c: &CaptionsData| {
            c.segments[0]
                .words
                .iter()
                .map(|w| (w.start, w.end))
                .collect::<Vec<_>>()
        };
        // Store the derived track as legacy edited-time captions.
        let track = before.timeline.as_ref().unwrap().caption_segments.clone();
        before.captions = Some(CaptionsData {
            segments: track
                .iter()
                .map(|c| CaptionSegment {
                    id: "legacy".into(),
                    start: c.start as f32,
                    end: c.end as f32,
                    text: c.text.clone(),
                    words: c.words.clone(),
                    recording_clip: None,
                })
                .collect(),
            source_timed: false,
            ..Default::default()
        });
        let legacy_words = words(before.captions.as_ref().unwrap());
        let mut after = before.clone();
        migrate_late_audio_alignment(&mut after, &meta, durations);
        let derived = &after.timeline.as_ref().unwrap().caption_segments;
        assert_eq!(derived.len(), 1);
        for (old, new) in legacy_words.iter().zip(&derived[0].words) {
            assert!((old.0 - new.start).abs() < 1e-4 && (old.1 - new.end).abs() < 1e-4);
        }
    }

    // Three 10 s clips; the middle one's mic came back 4 s in (shift 4 s).
    fn meta_late_middle() -> StudioRecordingMeta {
        let StudioRecordingMeta::MultipleSegments { mut inner } = meta(4.05) else {
            unreachable!()
        };
        let last = inner.segments[0].clone();
        inner.segments.push(last);
        StudioRecordingMeta::MultipleSegments { inner }
    }

    fn words_caption(id: &str, words: &[(&str, f32, f32)]) -> CaptionSegment {
        CaptionSegment {
            id: id.into(),
            start: words.first().unwrap().1,
            end: words.last().unwrap().2,
            text: words.iter().map(|w| w.0).collect::<Vec<_>>().join(" "),
            words: words
                .iter()
                .map(|&(text, start, end)| CaptionWord {
                    text: text.into(),
                    start,
                    end,
                })
                .collect(),
            recording_clip: None,
        }
    }

    // What the caption layer draws: every caption track item with its text,
    // words and style overrides (ids aside, they do not render).
    type Rendered = (f64, f64, String, Vec<(String, f32, f32)>, Option<f32>);

    fn rendered_track(project: &ProjectConfiguration) -> Vec<Rendered> {
        project
            .timeline
            .as_ref()
            .unwrap()
            .caption_segments
            .iter()
            .map(|c| {
                (
                    c.start,
                    c.end,
                    c.text.clone(),
                    c.words
                        .iter()
                        .map(|w| (w.text.clone(), w.start, w.end))
                        .collect(),
                    c.fade_duration_override,
                )
            })
            .collect()
    }

    fn same_track(old: &[Rendered], new: &[Rendered]) -> Result<(), String> {
        let near = |a: f64, b: f64| (a - b).abs() < 1e-4;
        if old.len() != new.len() {
            return Err(format!("{} items -> {}", old.len(), new.len()));
        }
        for (o, n) in old.iter().zip(new) {
            let words_match = o.3.len() == n.3.len()
                && o.3.iter().zip(&n.3).all(|(a, b)| {
                    a.0 == b.0
                        && near(f64::from(a.1), f64::from(b.1))
                        && near(f64::from(a.2), f64::from(b.2))
                });
            if !(near(o.0, n.0) && near(o.1, n.1) && o.2 == n.2 && words_match && o.4 == n.4) {
                return Err(format!("{o:?} -> {n:?}"));
            }
        }
        Ok(())
    }

    fn on_screen(track: &[Rendered], time: f64) -> Vec<(String, Vec<String>)> {
        track
            .iter()
            .filter(|c| c.0 <= time && time < c.1)
            .map(|c| {
                (
                    c.2.clone(),
                    c.3.iter()
                        .filter(|w| f64::from(w.1) <= time && time < f64::from(w.2))
                        .map(|w| w.0.clone())
                        .collect(),
                )
            })
            .collect()
    }

    // Migrates `before`, then reloads it the way the editor and the exporter
    // do, and checks the captions on screen never change.
    fn assert_captions_render_the_same(
        before: &ProjectConfiguration,
        meta: &StudioRecordingMeta,
        durations: &[f64],
    ) -> ProjectConfiguration {
        let old = rendered_track(before);
        let mut after = before.clone();
        assert!(migrate_late_audio_alignment(&mut after, meta, || durations.to_vec()));
        let mut reloaded: ProjectConfiguration =
            serde_json::from_str(&serde_json::to_string(&after).unwrap()).unwrap();
        crate::synchronize_captions(&mut reloaded, durations);
        for (label, project) in [("migrated", &after), ("reloaded", &reloaded)] {
            let new = rendered_track(project);
            if let Err(error) = same_track(&old, &new) {
                panic!("{label}: {error}\nbefore {old:#?}\nafter {new:#?}");
            }
            let duration = project.timeline.as_ref().unwrap().duration();
            for step in 0..=(duration * 100.0) as usize {
                let time = step as f64 / 100.0;
                assert_eq!(
                    on_screen(&old, time),
                    on_screen(&new, time),
                    "{label} at {time}"
                );
            }
        }
        reloaded
    }

    // Greptile's case on an edited late clip that has a clip after it: a word
    // at 8-9 s of a 10 s clip with a 4 s shift belongs at 12-13 s, in the held
    // tail. It, a hand-typed caption there, and a caption spanning the pause
    // into the next clip all stay on screen exactly where they were, and the
    // next clip's own captions stay in the next clip.
    #[test]
    fn captions_in_an_edited_clips_held_tail_render_where_they_did() {
        let late_middle = meta_late_middle();
        // A late clip length f32 cannot hold exactly, as real ones are.
        let durations = [10.0, 9.937589, 10.0];
        let mut before: ProjectConfiguration = serde_json::from_value(serde_json::json!({
            "timeline": {
                "segments": [
                    { "recordingSegment": 0, "start": 0.0, "end": 10.0, "timescale": 1.0 },
                    { "recordingSegment": 1, "start": 1.0, "end": 9.8, "timescale": 1.0 },
                    { "recordingSegment": 2, "start": 0.0, "end": 10.0, "timescale": 1.0 }
                ],
                "zoomSegments": []
            }
        }))
        .unwrap();
        before.clips = vec![
            clip(0, 0.04, 0.0, true),
            clip(1, 0.02, 4.07, true),
            clip(2, 0.04, 0.0, true),
        ];
        let mut manual = words_caption("caption-typed", &[("typed", 19.1, 19.3)]);
        manual.words.clear();
        let mut across = words_caption("caption-across", &[("across", 19.75, 20.3)]);
        across.words.clear();
        before.captions = Some(CaptionsData {
            segments: vec![
                words_caption("zero", &[("zero", 5.0, 6.0)]),
                words_caption("a", &[("one", 13.0, 13.5), ("two", 18.0, 19.0)]),
                manual,
                words_caption("span", &[("three", 19.4, 19.7), ("four", 20.5, 21.0)]),
                across,
                words_caption("next", &[("five", 22.0, 22.5)]),
            ],
            source_timed: true,
            ..Default::default()
        });
        crate::synchronize_captions(&mut before, &durations);
        // A style override on the spanning caption, carried by its source id.
        for item in &mut before.timeline.as_mut().unwrap().caption_segments {
            if crate::source_caption_id(&item.id) == "span" {
                item.fade_duration_override = Some(0.1);
            }
        }
        crate::synchronize_captions(&mut before, &durations);
        assert_eq!(rendered_track(&before).len(), 8);
        // A marker in what becomes the held tail stays on its moment too.
        before.markers = vec![TimelineMarker::new(1, 9.5)];
        let place = |p: &ProjectConfiguration| {
            let timeline = p.timeline.as_ref().unwrap();
            timeline.place_markers(&p.markers)[0].time
        };
        let marker_before = place(&before);
        let after = assert_captions_render_the_same(&before, &late_middle, &durations);
        assert!((place(&after) - marker_before).abs() < 1e-9);
        // Held-tail captions are tied to the late clip, the parts of a
        // caption cut at the pause to their own clips, the rest to none.
        let mut ties: Vec<_> = after
            .captions
            .as_ref()
            .unwrap()
            .segments
            .iter()
            .map(|c| (c.id.as_str(), c.recording_clip))
            .collect();
        ties.sort();
        assert_eq!(
            ties,
            vec![
                ("a", Some(1)),
                ("caption-across", Some(1)),
                ("caption-across-1", Some(2)),
                ("caption-typed", Some(1)),
                ("next", None),
                ("span", Some(1)),
                ("span-1", Some(2)),
                ("zero", None),
            ]
        );

        // The same word when the late clip is the last one.
        let mut before = legacy_project();
        before.timeline.as_mut().unwrap().segments[1].start = 1.0;
        before.captions = Some(CaptionsData {
            segments: vec![words_caption("late", &[("late", 18.0, 19.0)])],
            source_timed: true,
            ..Default::default()
        });
        crate::synchronize_captions(&mut before, &[10.0, 10.0]);
        assert_eq!(rendered_track(&before).len(), 1);
        assert_captions_render_the_same(&before, &meta(4.05), &[10.0, 10.0]);
    }

    // Greptile's case: a transcribed word can run across the start of a clip
    // (adjacent clips share one transcription), and it showed through both
    // clips. With the late clip edited (a zoom over it), a word running into
    // it, one running out of it, and one ending a caption that otherwise stays
    // in the late clip all keep showing on both sides, exactly as before.
    #[test]
    fn words_across_an_edited_late_clips_edges_render_where_they_did() {
        let durations = [10.0, 10.0, 10.0];
        let mut before: ProjectConfiguration = serde_json::from_value(serde_json::json!({
            "timeline": {
                "segments": [
                    { "recordingSegment": 0, "start": 0.0, "end": 10.0, "timescale": 1.0 },
                    { "recordingSegment": 1, "start": 0.0, "end": 10.0, "timescale": 1.0 },
                    { "recordingSegment": 2, "start": 0.0, "end": 10.0, "timescale": 1.0 }
                ],
                "zoomSegments": [
                    { "start": 15.0, "end": 16.0, "amount": 2.0, "mode": "auto" }
                ]
            }
        }))
        .unwrap();
        before.captions = Some(CaptionsData {
            segments: vec![
                words_caption("into", &[("into", 9.5, 10.5)]),
                words_caption("tail", &[("a", 15.0, 15.4), ("b", 19.7, 20.3)]),
                words_caption("out", &[("over", 19.9, 20.4), ("out", 20.6, 20.9)]),
            ],
            source_timed: true,
            ..Default::default()
        });
        crate::synchronize_captions(&mut before, &durations);
        assert_eq!(rendered_track(&before).len(), 6);
        let after = assert_captions_render_the_same(&before, &meta_late_middle(), &durations);
        assert_eq!(late_clip_start(&after), 4.0, "edited, so its trims moved");
    }

    // The same words with the late clip untouched: the late side of a word
    // follows the late audio like every other late word, and the side over
    // the other clip stays where it was.
    #[test]
    fn words_across_an_untouched_late_clips_edges_keep_their_other_side() {
        let word = || vec![words_caption("w", &[("w", 9.5, 10.5)])];
        assert_eq!(
            migrate_untouched(0, word()),
            [("w".to_string(), 10.0, 10.5)]
        );
        assert_eq!(
            migrate_untouched(1, word()),
            [("w".to_string(), 9.5, 10.0), ("w".to_string(), 14.0, 14.5)]
        );
        // Each side is its own caption, so editing one's text keeps the other.
        let mut project = legacy_project();
        project.captions = Some(CaptionsData {
            segments: word(),
            source_timed: true,
            ..Default::default()
        });
        crate::synchronize_captions(&mut project, &durations());
        migrate_late_audio_alignment(&mut project, &meta(4.05), durations);
        let captions: Vec<_> = project
            .captions
            .as_ref()
            .unwrap()
            .segments
            .iter()
            .map(|c| (c.id.as_str(), c.words.len(), c.recording_clip))
            .collect();
        assert_eq!(captions, [("w", 1, Some(0)), ("w-1", 1, Some(1))]);
    }

    // Typed captions (no words) running across an untouched late clip's
    // edges are cut where the clips meet and each part moves with its clip,
    // as a worded caption's words do: one from the clip before into the late
    // clip keeps its first part and its late part follows the late audio
    // (without stretching over the late clip's first seconds, which it never
    // covered), and one from the late clip into the next keeps its part over
    // the next clip while its late part is held at the media end.
    #[test]
    fn typed_captions_across_an_untouched_late_clip_keep_each_side() {
        let durations = [10.0, 10.0, 10.0];
        let mut project: ProjectConfiguration = serde_json::from_value(serde_json::json!({
            "timeline": {
                "segments": [
                    { "recordingSegment": 0, "start": 0.0, "end": 10.0, "timescale": 1.0 },
                    { "recordingSegment": 1, "start": 0.0, "end": 10.0, "timescale": 1.0 },
                    { "recordingSegment": 2, "start": 0.0, "end": 10.0, "timescale": 1.0 }
                ],
                "zoomSegments": []
            }
        }))
        .unwrap();
        let typed = |id: &str, start: f32, end: f32| CaptionSegment {
            id: id.into(),
            start,
            end,
            text: id.into(),
            words: Vec::new(),
            recording_clip: None,
        };
        project.captions = Some(CaptionsData {
            segments: vec![
                typed("caption-into", 8.0, 12.0),
                typed("caption-out", 18.0, 22.0),
            ],
            source_timed: true,
            ..Default::default()
        });
        crate::synchronize_captions(&mut project, &durations);
        migrate_late_audio_alignment(&mut project, &meta_late_middle(), || durations.to_vec());
        assert_eq!(late_clip_start(&project), 0.0, "restored, not edited");
        let near = |time: f32| (f64::from(time) * 100.0).round() / 100.0;
        let captions: Vec<_> = project
            .captions
            .as_ref()
            .unwrap()
            .segments
            .iter()
            .map(|c| (c.id.as_str(), near(c.start), near(c.end), c.recording_clip))
            .collect();
        assert_eq!(
            captions,
            [
                ("caption-into", 8.0, 10.0, Some(0)),
                ("caption-into-1", 14.0, 16.0, Some(1)),
                ("caption-out", 20.0, 20.0, Some(1)),
                ("caption-out-1", 20.0, 22.0, Some(2))
            ]
        );
        let track: Vec<_> = rendered_track(&project)
            .into_iter()
            .map(|c| (c.2, near(c.0 as f32), near(c.1 as f32)))
            .collect();
        assert_eq!(
            track,
            [
                ("caption-into".to_string(), 8.0, 10.0),
                ("caption-into".to_string(), 14.0, 16.0),
                ("caption-out".to_string(), 20.0, 22.0)
            ]
        );
    }

    // An untouched late clip keeps its current behaviour: its captions follow
    // the audio to the screen's start and stop at its media end, and the next
    // clip's captions stay where they were.
    #[test]
    fn captions_of_an_untouched_late_clip_follow_the_audio() {
        let durations = [10.0, 10.0, 10.0];
        let mut project: ProjectConfiguration = serde_json::from_value(serde_json::json!({
            "timeline": {
                "segments": [
                    { "recordingSegment": 0, "start": 0.0, "end": 10.0, "timescale": 1.0 },
                    { "recordingSegment": 1, "start": 0.0, "end": 10.0, "timescale": 1.0 },
                    { "recordingSegment": 2, "start": 0.0, "end": 10.0, "timescale": 1.0 }
                ],
                "zoomSegments": []
            }
        }))
        .unwrap();
        project.captions = Some(CaptionsData {
            segments: vec![
                words_caption("early", &[("early", 12.0, 13.0)]),
                words_caption("late", &[("late", 18.0, 19.0)]),
                words_caption("next", &[("next", 20.5, 21.0)]),
            ],
            source_timed: true,
            ..Default::default()
        });
        crate::synchronize_captions(&mut project, &durations);
        migrate_late_audio_alignment(&mut project, &meta_late_middle(), || durations.to_vec());
        assert_eq!(late_clip_start(&project), 0.0, "restored, not edited");
        let track: Vec<_> = rendered_track(&project)
            .into_iter()
            .map(|c| {
                (
                    c.2,
                    (c.0 * 100.0).round() / 100.0,
                    (c.1 * 100.0).round() / 100.0,
                )
            })
            .collect();
        assert_eq!(
            track,
            vec![
                ("early".to_string(), 16.0, 17.0),
                ("next".to_string(), 20.5, 21.0)
            ]
        );
    }

    // Two 10 s clips, untouched on the timeline; `late` is the clip whose
    // mic came back 4 s in. Returns what the caption track draws after the
    // migration, as (text, start, end) to 0.01 s, the same after a reload.
    fn migrate_untouched(late: usize, captions: Vec<CaptionSegment>) -> Vec<(String, f64, f64)> {
        let StudioRecordingMeta::MultipleSegments { mut inner } = meta(0.06) else {
            unreachable!()
        };
        inner.segments[late].mic.as_mut().unwrap().start_time = Some(4.05);
        let meta = StudioRecordingMeta::MultipleSegments { inner };
        let mut project = legacy_project();
        project.captions = Some(CaptionsData {
            segments: captions,
            source_timed: true,
            ..Default::default()
        });
        crate::synchronize_captions(&mut project, &durations());
        let timeline = project.timeline.as_ref().unwrap().segments.clone();
        migrate_late_audio_alignment(&mut project, &meta, durations);
        let after = &project.timeline.as_ref().unwrap().segments;
        assert!(
            timeline
                .iter()
                .zip(after)
                .all(|(a, b)| a.start == b.start && a.end == b.end),
            "restored, not edited"
        );
        let shown = |project: &ProjectConfiguration| {
            let mut track: Vec<_> = rendered_track(project)
                .into_iter()
                .map(|c| {
                    (
                        c.2,
                        (c.0 * 100.0).round() / 100.0,
                        (c.1 * 100.0).round() / 100.0,
                    )
                })
                .collect();
            track.sort_by(|a, b| a.1.total_cmp(&b.1).then_with(|| a.0.cmp(&b.0)));
            track
        };
        let mut reloaded: ProjectConfiguration =
            serde_json::from_str(&serde_json::to_string(&project).unwrap()).unwrap();
        crate::synchronize_captions(&mut reloaded, &durations());
        assert_eq!(shown(&project), shown(&reloaded));
        for caption in &project.captions.as_ref().unwrap().segments {
            assert!(caption.start <= caption.end, "{caption:?}");
        }
        shown(&project)
    }

    fn typed(id: &str, start: f32, end: f32) -> CaptionSegment {
        let mut caption = words_caption(id, &[(id, start, end)]);
        caption.words.clear();
        caption
    }

    // Greptile's case: a typed caption (no words) from an untouched late clip
    // into the next one. Its part over the late clip follows the audio and,
    // like any caption there, is held at the media end; its part over the
    // next clip stays where it was instead of vanishing with the first.
    #[test]
    fn a_typed_caption_out_of_an_untouched_late_clip_keeps_its_next_clip_part() {
        let shown = migrate_untouched(0, vec![typed("typed", 8.0, 12.0), typed("wide", 4.0, 12.0)]);
        assert_eq!(
            shown,
            vec![
                ("wide".to_string(), 8.0, 10.0),
                ("typed".to_string(), 10.0, 12.0),
                ("wide".to_string(), 10.0, 12.0),
            ]
        );
    }

    // The reverse: only the second clip is late. The first clip's part stays,
    // the late clip's part follows that clip's audio.
    #[test]
    fn a_typed_caption_into_an_untouched_late_clip_moves_only_its_late_part() {
        let shown = migrate_untouched(1, vec![typed("typed", 8.0, 12.0)]);
        assert_eq!(
            shown,
            vec![
                ("typed".to_string(), 8.0, 10.0),
                ("typed".to_string(), 14.0, 16.0),
            ]
        );
    }

    // A typed caption ending exactly where the late clip starts holds nothing
    // of it, so it stays where it was rather than taking that clip's shift.
    #[test]
    fn a_typed_caption_ending_on_a_late_clips_start_stays_put() {
        assert_eq!(
            migrate_untouched(1, vec![typed("typed", 8.0, 10.0)]),
            vec![("typed".to_string(), 8.0, 10.0)]
        );
    }

    // A caption with words whose end lies in another clip than its last
    // word: only its words draw, each with its own clip, in either order.
    #[test]
    fn a_caption_ending_past_its_last_words_clip_keeps_its_words() {
        let mut caption = words_caption("words", &[("a", 5.0, 6.0), ("b", 7.0, 7.5)]);
        caption.end = 10.5;
        // "b" lands past the late clip's media end, held there like any
        // word of that clip.
        assert_eq!(
            migrate_untouched(0, vec![caption.clone()]),
            vec![("a".to_string(), 9.0, 10.0)]
        );
        assert_eq!(
            migrate_untouched(1, vec![caption]),
            vec![("a b".to_string(), 5.0, 7.5)]
        );
    }

    // A held tail runs past its clip's media end into source time that
    // belongs to the next recording clip; that clip's captions show once, in
    // their own clip.
    #[test]
    fn captions_of_the_next_clip_do_not_show_in_a_held_tail() {
        let mut project: ProjectConfiguration = serde_json::from_value(serde_json::json!({
            "timeline": {
                "segments": [
                    { "recordingSegment": 0, "start": 4.0, "end": 14.0, "timescale": 1.0 },
                    { "recordingSegment": 1, "start": 0.0, "end": 10.0, "timescale": 1.0 }
                ],
                "zoomSegments": []
            }
        }))
        .unwrap();
        project.captions = Some(CaptionsData {
            segments: vec![CaptionSegment {
                id: "next".into(),
                start: 11.0,
                end: 11.5,
                text: "hi".into(),
                words: vec![CaptionWord {
                    text: "hi".into(),
                    start: 11.0,
                    end: 11.5,
                }],
                recording_clip: None,
            }],
            source_timed: true,
            ..Default::default()
        });
        crate::synchronize_captions(&mut project, &durations());
        let track: Vec<_> = project
            .timeline
            .as_ref()
            .unwrap()
            .caption_segments
            .iter()
            .map(|c| (c.start, c.end))
            .collect();
        assert_eq!(track, vec![(11.0, 11.5)]);
    }

    /// splitmix64, as `cap_verify::fixture::Rng`.
    struct Rng(u64);

    impl Rng {
        fn next_u64(&mut self) -> u64 {
            self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
            let mut z = self.0;
            z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
            z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
            z ^ (z >> 31)
        }

        fn between(&mut self, low: f64, high: f64) -> f64 {
            low + (high - low) * ((self.next_u64() >> 11) as f64 / (1u64 << 53) as f64)
        }

        fn below(&mut self, count: usize) -> usize {
            (self.next_u64() % count as u64) as usize
        }

        fn chance(&mut self, probability: f64) -> bool {
            self.between(0.0, 1.0) < probability
        }
    }

    struct MigrationCase {
        project: ProjectConfiguration,
        meta: StudioRecordingMeta,
        durations: Vec<f64>,
    }

    /// Two to four clips, some with late audio (edited by a zoom or trims,
    /// or untouched), and transcribed captions whose words often run across
    /// the start of a clip. Times on a 1/8 s grid, a 0.1 s grid or anywhere.
    fn random_migration_case(rng: &mut Rng) -> MigrationCase {
        let grid = rng.below(3);
        let snap = |time: f64| match grid {
            0 => (time * 8.0).round() / 8.0,
            1 => (time * 10.0).round() / 10.0,
            _ => time,
        };
        let count = 2 + rng.below(3);
        let durations: Vec<f64> = (0..count).map(|_| snap(rng.between(3.0, 12.0))).collect();
        let mut late = vec![false; count];
        let mut segments = Vec::new();
        let mut timeline = Vec::new();
        let mut zooms = Vec::new();
        let mut output = 0.0;
        for (index, &duration) in durations.iter().enumerate() {
            late[index] = rng.chance(0.5);
            let mic_start = if late[index] {
                0.05 + snap(rng.between(1.2, 4.0))
            } else {
                0.03
            };
            segments.push(serde_json::json!({
                "display": { "path": format!("{index}/display.mp4"), "fps": 30, "start_time": 0.05 },
                "mic": { "path": format!("{index}/mic.ogg"), "start_time": mic_start }
            }));
            let (start, end) = match rng.below(4) {
                0 => (
                    snap(rng.between(0.0, 1.0)),
                    snap(rng.between(duration - 1.0, duration)),
                ),
                1 => {
                    zooms.push(serde_json::json!({
                        "start": output + duration * 0.4,
                        "end": output + duration * 0.6,
                        "amount": 2.0,
                        "mode": "auto"
                    }));
                    (0.0, duration)
                }
                _ => (0.0, duration),
            };
            output += end - start;
            timeline.push(serde_json::json!({
                "recordingSegment": index, "start": start, "end": end, "timescale": 1.0
            }));
        }
        if !late.contains(&true) {
            late[0] = true;
            segments[0]["mic"]["start_time"] = serde_json::json!(2.55);
        }
        let mut project: ProjectConfiguration = serde_json::from_value(serde_json::json!({
            "timeline": { "segments": timeline, "zoomSegments": zooms }
        }))
        .unwrap();
        let meta: StudioRecordingMeta =
            serde_json::from_value(serde_json::json!({ "segments": segments })).unwrap();

        let starts: Vec<f64> = durations
            .iter()
            .scan(0.0, |sum, duration| {
                let start = *sum;
                *sum += duration;
                Some(start)
            })
            .collect();
        let total: f64 = durations.iter().sum();
        let mut captions = Vec::new();
        for caption in 0..1 + rng.below(4) {
            let mut words = Vec::new();
            let mut at = snap(rng.between(0.0, total - 3.0));
            for word in 0..1 + rng.below(4) {
                let (start, end) = if rng.chance(0.4) {
                    let boundary = starts[1 + rng.below(count - 1)];
                    (
                        snap(boundary - rng.between(0.1, 0.8)),
                        snap(boundary + rng.between(0.1, 0.8)),
                    )
                } else {
                    let start = snap(at + rng.between(0.05, 0.6));
                    (start, snap(start + rng.between(0.2, 0.9)))
                };
                if start < at || end <= start || end > total {
                    continue;
                }
                at = end;
                words.push((format!("w{caption}-{word}"), start as f32, end as f32));
            }
            if words.is_empty() {
                continue;
            }
            let words: Vec<_> = words
                .iter()
                .map(|(text, start, end)| (text.as_str(), *start, *end))
                .collect();
            captions.push(words_caption(&format!("c{caption}"), &words));
        }
        project.captions = Some(CaptionsData {
            segments: captions,
            source_timed: true,
            ..Default::default()
        });
        crate::synchronize_captions(&mut project, &durations);
        MigrationCase {
            project,
            meta,
            durations,
        }
    }

    /// Migrates the case and checks the highlighted words on screen against
    /// the timeline alone: unchanged everywhere except over an untouched late
    /// clip, where they follow the late audio by its shift (and none show in
    /// its first `shift` seconds), before and after a reload.
    fn check_migration(case: &MigrationCase) -> Result<(), String> {
        let durations = &case.durations[..];
        let before = &case.project;
        let old = rendered_track(before);
        let mut after = before.clone();
        migrate_late_audio_alignment(&mut after, &case.meta, || durations.to_vec());
        let mut reloaded: ProjectConfiguration =
            serde_json::from_str(&serde_json::to_string(&after).unwrap()).unwrap();
        crate::synchronize_captions(&mut reloaded, durations);
        for caption in &after.captions.as_ref().unwrap().segments {
            if caption.start > caption.end {
                return Err(format!("saved reversed {caption:?}"));
            }
            // Generated word texts are unique, so a repeat is one word's two
            // pieces in one caption, which an edit to its text would merge.
            let mut texts: Vec<&str> = caption.words.iter().map(|w| w.text.as_str()).collect();
            texts.sort_unstable();
            if texts.windows(2).any(|pair| pair[0] == pair[1]) {
                return Err(format!(
                    "one caption holds two pieces of a word {caption:?}"
                ));
            }
        }

        let timeline = before.timeline.as_ref().unwrap();
        let shifts = late_audio_shifts(&case.meta);
        let mut output = 0.0;
        let untouched: Vec<(f64, f64, f64)> = timeline
            .segments
            .iter()
            .map(|segment| {
                let start = output;
                output += segment.duration();
                (segment.recording_clip as usize, start, output)
            })
            .filter_map(|(clip, start, end)| {
                let shift = shifts.iter().find(|(index, _)| *index == clip)?.1;
                is_untouched_clip(before, timeline, clip, durations.get(clip).copied())
                    .then_some((start, end, shift))
            })
            .collect();
        let words_at = |track: &[Rendered], time: f64| {
            let mut words: Vec<String> = on_screen(track, time)
                .into_iter()
                .flat_map(|(_, words)| words)
                .collect();
            words.sort();
            words
        };
        let mut edges: Vec<f64> = timeline
            .segments
            .iter()
            .scan(0.0, |sum, segment| {
                *sum += segment.duration();
                Some(*sum)
            })
            .collect();
        for (label, project) in [("migrated", &after), ("reloaded", &reloaded)] {
            let new = rendered_track(project);
            edges.extend(
                old.iter()
                    .chain(&new)
                    .flat_map(|item| item.3.iter().flat_map(|w| [f64::from(w.1), f64::from(w.2)])),
            );
            let near_edge = |time: f64| edges.iter().any(|edge| (edge - time).abs() < 0.02);
            let duration = timeline.duration();
            for step in 0..=(duration * 100.0) as usize {
                let time = step as f64 / 100.0;
                let in_late = untouched
                    .iter()
                    .find(|(start, end, _)| *start <= time && time < *end);
                let (expected, at) = match in_late {
                    None => (words_at(&old, time), time),
                    Some(&(start, _, shift)) if time - shift >= start => {
                        (words_at(&old, time - shift), time - shift)
                    }
                    Some(_) => (Vec::new(), time),
                };
                if near_edge(time) || near_edge(at) {
                    continue;
                }
                let shown = words_at(&new, time);
                if shown != expected {
                    return Err(format!(
                        "{label} at {time:.2}: {shown:?}, expected {expected:?} (from {at:.2})"
                    ));
                }
            }
        }
        Ok(())
    }

    // Seeded random projects, every migration checked against the oracle
    // above. CAP_LATE_CAPTION_CASES and CAP_LATE_CAPTION_BASE (hex) run more;
    // CAP_LATE_CAPTION_SEED dumps one case.
    #[test]
    fn migrated_caption_words_stay_on_screen() {
        let hex = |name: &str| {
            std::env::var(name)
                .ok()
                .map(|value| u64::from_str_radix(value.trim_start_matches("0x"), 16).unwrap())
        };
        let cases = hex("CAP_LATE_CAPTION_CASES").map_or(3_000, |cases| cases as usize);
        let mut rng = Rng(hex("CAP_LATE_CAPTION_BASE").unwrap_or(0x4308));
        let mut failures = Vec::new();
        for _ in 0..cases {
            let seed = rng.next_u64();
            if let Err(failure) = check_migration(&random_migration_case(&mut Rng(seed))) {
                failures.push(format!("seed {seed:#x}: {failure}"));
            }
        }
        println!(
            "late caption property: {cases} cases, {} failures",
            failures.len()
        );
        if let Some(seed) = hex("CAP_LATE_CAPTION_SEED") {
            let case = random_migration_case(&mut Rng(seed));
            let mut after = case.project.clone();
            migrate_late_audio_alignment(&mut after, &case.meta, || case.durations.clone());
            println!(
                "durations {:?}\nmeta {}\ntimeline {}\ncaptions {}\nafter {}\ntrack before {:?}\ntrack after {:?}\n{:?}",
                case.durations,
                serde_json::to_string(&case.meta).unwrap(),
                serde_json::to_string(&case.project.timeline.as_ref().unwrap().segments).unwrap(),
                serde_json::to_string(&case.project.captions.as_ref().unwrap().segments).unwrap(),
                serde_json::to_string(&after.captions.as_ref().unwrap().segments).unwrap(),
                rendered_track(&case.project),
                rendered_track(&after),
                check_migration(&case)
            );
        }
        assert!(
            failures.is_empty(),
            "{} of {cases} cases fail:\n{}",
            failures.len(),
            failures
                .iter()
                .take(8)
                .cloned()
                .collect::<Vec<_>>()
                .join("\n")
        );
    }
}
