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
///   every later edit onto different footage.
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
        shift_captions(project, &shifts, &durations);
    }
    let mut trims_moved = false;
    if let Some(timeline) = project.timeline.as_mut() {
        for (&(index, shift), _) in shifts.iter().zip(&edited).filter(|(_, edited)| **edited) {
            for segment in timeline
                .segments
                .iter_mut()
                .filter(|segment| segment.recording_clip as usize == index)
            {
                segment.start += shift;
                segment.end += shift;
                trims_moved = true;
            }
        }
    }
    if trims_moved && has_captions {
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

fn shift_captions(project: &mut ProjectConfiguration, shifts: &[(usize, f64)], durations: &[f64]) {
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
    // a caption spanning a pause moves each word with its own clip and a time
    // clamped to one clip's end never re-enters the next.
    let clip_of = |time: f32| {
        let time = f64::from(time);
        (0..durations.len())
            .find(|&i| (clip_start[i]..clip_start[i] + durations[i]).contains(&time))
    };
    let move_in = |time: f32, clip: Option<usize>| -> Option<f32> {
        let clip = clip?;
        let &(_, shift) = shifts.iter().find(|(index, _)| *index == clip)?;
        Some(((f64::from(time) + shift).min(clip_start[clip] + durations[clip])) as f32)
    };
    let mut moved = false;
    for segment in &mut captions.segments {
        let start_clip = clip_of(segment.start);
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
            moved = true;
        }
    }
    if moved {
        captions
            .segments
            .sort_by(|a, b| a.start.total_cmp(&b.start));
        crate::synchronize_captions(project, durations);
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

        // Every other edited-time track counts the same way.
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
}
