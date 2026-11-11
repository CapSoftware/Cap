use cap_project::{ProjectConfiguration, SceneMode, SceneSegment, TimelineConfiguration};

use crate::scene::MIN_GAP_FOR_TRANSITION;

const SHOW_LEAD_SECS: f64 = 0.3;
const MIN_SPEECH_SECS: f64 = 0.2;
const TRANSITION_SECS: f64 = 0.3;
const MIN_HIDDEN_SECS: f64 = 1.0;

/// What was said in one recording clip, in source seconds. `timing_offset` is
/// the mic repair the audio pipeline applies on top of the clip's mic offset.
#[derive(Clone, Debug, PartialEq)]
pub struct ClipSpeech {
    pub spans: Vec<(f64, f64)>,
    pub timing_offset: f64,
}

/// Replaces the generated scene segments with ones for `delay` seconds of
/// silence, leaving hand-made segments alone. A clip without speech data
/// counts as speech: a mic that could not be read keeps the camera on screen.
/// Returns how many segments were generated.
pub fn regenerate_silence_scenes(
    project: &mut ProjectConfiguration,
    speech: &[Option<ClipSpeech>],
    delay: f64,
) -> usize {
    let Some(timeline) = project.timeline.as_ref() else {
        return 0;
    };
    let duration = timeline.duration();
    let spoken = timeline_speech(project, timeline, speech);
    let windows = silence_windows(&spoken, duration, delay);
    let Some(timeline) = project.timeline.as_mut() else {
        return 0;
    };
    timeline.scene_segments.retain(|scene| !scene.from_silence);
    let generated = silence_scene_segments(&windows, &timeline.scene_segments);
    let count = generated.len();
    timeline.scene_segments.extend(generated);
    timeline
        .scene_segments
        .sort_by(|a, b| a.start.total_cmp(&b.start));
    count
}

fn silence_windows(speech: &[(f64, f64)], duration: f64, delay: f64) -> Vec<(f64, f64)> {
    let mut windows = Vec::new();
    if !(duration.is_finite() && duration > 0.0) {
        return windows;
    }
    let mut push = |silence_start: f64, silence_end: f64, lead: f64| {
        let start = silence_start + delay;
        let end = silence_end - lead;
        if end - start >= MIN_HIDDEN_SECS.max(TRANSITION_SECS * 2.0) {
            windows.push((start, end));
        }
    };
    let mut silence_start = 0.0;
    for &(start, end) in speech
        .iter()
        .filter(|(start, end)| end - start >= MIN_SPEECH_SECS)
    {
        if start > silence_start {
            push(silence_start, start.min(duration), SHOW_LEAD_SECS);
        }
        silence_start = silence_start.max(end);
    }
    if silence_start < duration {
        push(silence_start, duration, 0.0);
    }
    windows
}

fn timeline_speech(
    project: &ProjectConfiguration,
    timeline: &TimelineConfiguration,
    speech: &[Option<ClipSpeech>],
) -> Vec<(f64, f64)> {
    let mut runs: Vec<(f64, f64)> = Vec::new();
    for window in timeline.clip_source_windows() {
        if !(window.timescale.is_finite() && window.timescale > 0.0) {
            continue;
        }
        let clip = speech
            .get(window.recording_clip as usize)
            .and_then(Option::as_ref);
        let Some(clip) = clip else {
            runs.push((window.output_start, window.output_end));
            continue;
        };
        let offset = project
            .clips
            .iter()
            .find(|config| config.index == window.recording_clip)
            .map_or(0.0, |config| f64::from(config.offsets.mic))
            + clip.timing_offset;
        let source_end =
            window.source_start + (window.output_end - window.output_start) * window.timescale;
        let first = clip
            .spans
            .partition_point(|(_, end)| end - offset <= window.source_start);
        for &(start, end) in &clip.spans[first..] {
            let (start, end) = (start - offset, end - offset);
            if start >= source_end {
                break;
            }
            let start = start.max(window.source_start);
            let end = end.min(source_end);
            if end > start {
                runs.push((
                    window.output_start + (start - window.source_start) / window.timescale,
                    window.output_start + (end - window.source_start) / window.timescale,
                ));
            }
        }
    }
    runs.sort_by(|a, b| a.0.total_cmp(&b.0));
    let mut merged: Vec<(f64, f64)> = Vec::with_capacity(runs.len());
    for (start, end) in runs {
        match merged.last_mut() {
            Some(last) if start <= last.1 + 1e-6 => last.1 = last.1.max(end),
            _ => merged.push((start, end)),
        }
    }
    merged
}

fn silence_scene_segments(windows: &[(f64, f64)], manual: &[SceneSegment]) -> Vec<SceneSegment> {
    let margin = TRANSITION_SECS + MIN_GAP_FOR_TRANSITION;
    let blocked: Vec<(f64, f64)> = manual
        .iter()
        .map(|segment| {
            (
                segment.start - segment.transition_in.max(0.0) - margin,
                segment.end + segment.transition_out.max(0.0) + margin,
            )
        })
        .collect();

    let mut segments = Vec::new();
    for &window in windows {
        let mut pieces = vec![window];
        for &(block_start, block_end) in &blocked {
            pieces = pieces
                .into_iter()
                .flat_map(|(start, end)| {
                    if block_end <= start || block_start >= end {
                        vec![(start, end)]
                    } else {
                        [(start, block_start), (block_end, end)]
                            .into_iter()
                            .filter(|(start, end)| end > start)
                            .collect()
                    }
                })
                .collect();
        }
        segments.extend(
            pieces
                .into_iter()
                .filter(|(start, end)| end - start >= MIN_HIDDEN_SECS.max(TRANSITION_SECS * 2.0))
                .map(|(start, end)| SceneSegment {
                    start: start + TRANSITION_SECS,
                    end,
                    mode: SceneMode::HideCamera,
                    split_layout: None,
                    transition_in: TRANSITION_SECS,
                    transition_out: TRANSITION_SECS,
                    from_silence: true,
                }),
        );
    }
    segments
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scene::{InterpolatedScene, SceneSegmentsCursor};
    use cap_project::TimelineSegment;

    const DELAY: f64 = 2.0;

    fn approx(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-6
    }

    #[test]
    fn long_silences_hide_after_the_delay_and_return_before_speech() {
        let speech = [(1.0, 5.0), (12.0, 15.0)];
        let windows = silence_windows(&speech, 20.0, DELAY);
        assert_eq!(windows.len(), 2);
        assert!(approx(windows[0].0, 7.0) && approx(windows[0].1, 11.7));
        assert!(approx(windows[1].0, 17.0) && approx(windows[1].1, 20.0));
    }

    #[test]
    fn short_pauses_never_hide() {
        let speech = [(0.0, 3.0), (4.5, 8.0), (10.5, 12.0)];
        assert!(silence_windows(&speech, 12.0, DELAY).is_empty());
    }

    #[test]
    fn a_silence_just_over_the_delay_needs_room_for_both_fades() {
        let speech = [(0.0, 1.0), (4.0, 6.0)];
        assert!(silence_windows(&speech, 6.0, DELAY).is_empty());
        let speech = [(0.0, 1.0), (4.4, 6.0)];
        let windows = silence_windows(&speech, 6.0, DELAY);
        assert_eq!(windows.len(), 1);
        assert!(approx(windows[0].0, 3.0) && approx(windows[0].1, 4.1));
    }

    #[test]
    fn blips_shorter_than_the_minimum_do_not_bring_the_camera_back() {
        let speech = [(0.0, 2.0), (6.0, 6.15), (12.0, 14.0)];
        let windows = silence_windows(&speech, 14.0, DELAY);
        assert_eq!(windows.len(), 1);
        assert!(approx(windows[0].0, 4.0) && approx(windows[0].1, 11.7));

        let speech = [(0.0, 2.0), (6.0, 6.3), (12.0, 14.0)];
        let windows = silence_windows(&speech, 14.0, DELAY);
        assert_eq!(windows.len(), 2);
        assert!(approx(windows[0].1, 5.7) && approx(windows[1].0, 8.3));
    }

    #[test]
    fn leading_silence_and_empty_or_invalid_input() {
        let windows = silence_windows(&[(6.0, 8.0)], 8.0, DELAY);
        assert_eq!(windows.len(), 1);
        assert!(approx(windows[0].0, 2.0) && approx(windows[0].1, 5.7));
        assert_eq!(silence_windows(&[], 10.0, DELAY), vec![(2.0, 10.0)]);
        assert!(silence_windows(&[], f64::NAN, DELAY).is_empty());
        assert!(silence_windows(&[], 0.0, DELAY).is_empty());
    }

    fn project_with(segments: Vec<TimelineSegment>) -> ProjectConfiguration {
        let mut timeline: TimelineConfiguration =
            serde_json::from_value(serde_json::json!({ "segments": [], "zoomSegments": [] }))
                .unwrap();
        timeline.segments = segments;
        ProjectConfiguration {
            timeline: Some(timeline),
            ..Default::default()
        }
    }

    fn clip(recording_clip: u32, start: f64, end: f64, timescale: f64) -> TimelineSegment {
        TimelineSegment {
            recording_clip,
            timescale,
            start,
            end,
            name: None,
            speed_audio_mode: None,
            volume: None,
            hide_cursor: None,
            voice_eq: None,
        }
    }

    fn speech(spans: &[(f64, f64)]) -> Option<ClipSpeech> {
        Some(ClipSpeech {
            spans: spans.to_vec(),
            timing_offset: 0.0,
        })
    }

    fn runs(project: &ProjectConfiguration, clips: &[Option<ClipSpeech>]) -> Vec<(f64, f64)> {
        timeline_speech(project, project.timeline.as_ref().unwrap(), clips)
    }

    #[test]
    fn speech_maps_through_cuts_speed_and_mic_offsets() {
        let mut project = project_with(vec![clip(0, 10.0, 20.0, 1.0), clip(0, 30.0, 40.0, 2.0)]);
        let clips = [speech(&[(12.0, 14.0), (32.0, 36.0)])];
        let spoken = runs(&project, &clips);
        assert_eq!(spoken.len(), 2);
        assert!(approx(spoken[0].0, 2.0) && approx(spoken[0].1, 4.0));
        assert!(approx(spoken[1].0, 11.0) && approx(spoken[1].1, 13.0));

        project.clips.push(cap_project::ClipConfiguration {
            index: 0,
            offsets: cap_project::ClipOffsets {
                mic: 1.0,
                ..Default::default()
            },
            ..Default::default()
        });
        let spoken = runs(&project, &clips);
        assert!(approx(spoken[0].0, 1.0) && approx(spoken[0].1, 3.0));

        let repaired = [Some(ClipSpeech {
            timing_offset: -0.5,
            ..clips[0].clone().unwrap()
        })];
        let spoken = runs(&project, &repaired);
        assert!(approx(spoken[0].0, 1.5) && approx(spoken[0].1, 3.5));
    }

    #[test]
    fn speech_in_a_cross_fades_outgoing_tail_counts() {
        let mut project = project_with(vec![clip(0, 0.0, 10.0, 1.0), clip(1, 0.0, 10.0, 1.0)]);
        project.timeline.as_mut().unwrap().transitions =
            serde_json::from_value(serde_json::json!([
                { "segmentIndex": 1, "type": "cross-fade", "duration": 1.0 }
            ]))
            .unwrap();
        let spoken = runs(&project, &[speech(&[(9.2, 9.8)]), speech(&[])]);
        assert_eq!(spoken.len(), 1);
        assert!(approx(spoken[0].0, 9.2) && approx(spoken[0].1, 9.8));
    }

    #[test]
    fn clips_without_speech_data_keep_the_camera() {
        let project = project_with(vec![clip(0, 0.0, 10.0, 1.0), clip(1, 0.0, 10.0, 1.0)]);
        let spoken = runs(&project, &[speech(&[]), None]);
        assert_eq!(spoken.len(), 1);
        assert!(approx(spoken[0].0, 10.0) && approx(spoken[0].1, 20.0));
    }

    fn scene(start: f64, end: f64, mode: SceneMode) -> SceneSegment {
        SceneSegment {
            start,
            end,
            mode,
            split_layout: None,
            transition_in: 0.3,
            transition_out: 0.3,
            from_silence: false,
        }
    }

    #[test]
    fn silence_segments_fade_out_at_the_window_start_and_are_back_by_its_end() {
        let segments = silence_scene_segments(&[(7.0, 11.7)], &[]);
        assert_eq!(segments.len(), 1);
        let opacity = |time: f64| {
            InterpolatedScene::new(SceneSegmentsCursor::new(time, &segments))
                .regular_camera_transition_opacity()
        };
        assert!(approx(opacity(6.99), 1.0));
        assert!(opacity(7.15) > 0.1 && opacity(7.15) < 0.9);
        assert!(opacity(7.31) < 0.01);
        assert!(opacity(11.0) < 0.01);
        assert!(opacity(11.55) > 0.1 && opacity(11.55) < 0.9);
        assert!(approx(opacity(11.71), 1.0));
    }

    #[test]
    fn manual_scene_segments_win_over_silence() {
        let manual = [scene(10.0, 14.0, SceneMode::Default)];
        let segments = silence_scene_segments(&[(4.0, 20.0)], &manual);
        assert_eq!(segments.len(), 2);
        assert!(segments[0].end <= 10.0 - 0.3 - 0.3 - MIN_GAP_FOR_TRANSITION + 1e-9);
        assert!(segments[1].start - 0.3 >= 14.0 + 0.3 + 0.3 + MIN_GAP_FOR_TRANSITION - 1e-9);
        assert!(silence_scene_segments(&[(9.0, 15.0)], &manual).is_empty());
    }

    #[test]
    fn regenerating_replaces_generated_segments_and_keeps_manual_ones() {
        let mut project = project_with(vec![clip(0, 0.0, 60.0, 1.0)]);
        project.timeline.as_mut().unwrap().scene_segments =
            vec![scene(20.0, 24.0, SceneMode::SplitScreen)];
        let clips = [speech(&[(0.0, 2.0), (55.0, 58.0)])];

        assert_eq!(regenerate_silence_scenes(&mut project, &clips, 2.0), 2);
        let scenes = |project: &ProjectConfiguration| {
            project.timeline.as_ref().unwrap().scene_segments.clone()
        };
        assert_eq!(scenes(&project).len(), 3);
        assert!(scenes(&project).is_sorted_by(|a, b| a.start <= b.start));

        assert_eq!(regenerate_silence_scenes(&mut project, &clips, 30.0), 1);
        let after = scenes(&project);
        assert_eq!(after.len(), 2);
        assert!(after.iter().any(|segment| !segment.from_silence));
        assert!(approx(after[1].start, 2.0 + 30.0 + 0.3));
    }

    #[test]
    fn a_long_cut_up_timeline_stays_fast() {
        let segments: Vec<_> = (0..200)
            .map(|index| clip(0, index as f64 * 40.0, index as f64 * 40.0 + 36.0, 1.0))
            .collect();
        let mut project = project_with(segments);
        let spans: Vec<(f64, f64)> = (0..4000)
            .map(|index| (index as f64 * 2.0, index as f64 * 2.0 + 1.2))
            .collect();
        let started = std::time::Instant::now();
        let generated = regenerate_silence_scenes(&mut project, &[speech(&spans)], 2.0);
        assert_eq!(generated, 0);
        assert!(started.elapsed() < std::time::Duration::from_millis(50));
    }
}
