use crate::{CLIP_ALIGNMENT_VERSION, ProjectConfiguration, StudioRecordingMeta};

/// Moves a project saved before late audio stopped setting a segment's start
/// (`LATE_AUDIO_START_SECS`) onto the current segment clock. Only segments
/// whose start moved are touched. On each, everything the project timed
/// against the old, late start shifts by the same amount, so it keeps pointing
/// at the same moment of the recording:
///
/// - mic and system audio clip offsets, automatic or set by hand (any
///   calibration they carry is kept);
/// - markers on that clip;
/// - caption words in that clip's stretch of the source clock.
///
/// Screen and camera then play from their own start. `recording_durations`
/// (each clip's display duration, the source clock captions use) is only
/// read when such a segment has markers or captions. Returns whether anything
/// other than the version changed, i.e. whether the project should be saved.
pub fn migrate_late_audio_alignment(
    project: &mut ProjectConfiguration,
    meta: &StudioRecordingMeta,
    recording_durations: impl FnOnce() -> Vec<f64>,
) -> bool {
    if project.clip_alignment_version >= CLIP_ALIGNMENT_VERSION {
        return false;
    }
    project.clip_alignment_version = CLIP_ALIGNMENT_VERSION;

    let StudioRecordingMeta::MultipleSegments { inner } = meta else {
        return false;
    };
    let shifts: Vec<(usize, f64)> = inner
        .segments
        .iter()
        .enumerate()
        .filter_map(|(index, segment)| {
            let shift = segment.legacy_latest_start_time()? - segment.latest_start_time()?;
            (shift.is_finite() && shift > 0.0).then_some((index, shift))
        })
        .collect();
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
    if has_markers || has_captions {
        let durations = recording_durations();
        shift_markers(project, &shifts, &durations);
        if has_captions {
            shift_captions(project, &shifts, &durations);
        }
    }

    true
}

fn shift_markers(project: &mut ProjectConfiguration, shifts: &[(usize, f64)], durations: &[f64]) {
    for &(index, shift) in shifts {
        let end = durations
            .get(index)
            .copied()
            .filter(|d| d.is_finite() && *d > 0.0);
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
    let mut moved = false;
    for &(index, shift) in shifts {
        let (Some(&start), Some(&duration)) = (clip_start.get(index), durations.get(index)) else {
            continue;
        };
        let end = start + duration;
        let shift = shift as f32;
        let clamp = |time: f32| time.min(end as f32);
        for segment in captions
            .segments
            .iter_mut()
            .filter(|segment| (start..end).contains(&f64::from(segment.start)))
        {
            segment.start = clamp(segment.start + shift);
            segment.end = clamp(segment.end + shift);
            for word in &mut segment.words {
                word.start = clamp(word.start + shift);
                word.end = clamp(word.end + shift);
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
            Vec::new
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
        migrate_late_audio_alignment(&mut project, &meta(4.05), Vec::new);
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
            Vec::new
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
        let mut project = legacy_project();
        let clips = serde_json::to_string(&project.clips).unwrap();
        assert!(!migrate_late_audio_alignment(
            &mut project,
            &meta(0.06),
            || unreachable!()
        ));
        assert_eq!(serde_json::to_string(&project.clips).unwrap(), clips);
        assert_eq!(project.clip_alignment_version, CLIP_ALIGNMENT_VERSION);
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

    #[test]
    fn a_mic_that_never_started_needs_no_durations_without_markers_or_captions() {
        let mut project = legacy_project();
        project.clips[1] = clip(1, 0.0, 10.0, true);
        assert!(migrate_late_audio_alignment(
            &mut project,
            &meta(10.0),
            || unreachable!()
        ));
        assert!(close(project.clips[1].offsets.mic, -9.95));
        assert!(close(project.clips[1].offsets.system_audio, 0.05));
    }
}
