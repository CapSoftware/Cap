use cap_project::{CaptionSegment, CaptionWord, ProjectConfiguration};

use crate::{editor_edits, editor_timeline};

mod speech_pauses;

const EDGE_TOLERANCE: f64 = 0.000_001;

#[derive(Debug, Default)]
pub struct RemovalSummary {
    pub removed_words: usize,
    pub skipped_words: usize,
    pub removed_seconds: f64,
}

struct Cut {
    clip_index: usize,
    start: f64,
    end: f64,
}

pub fn has_word_timings(project: &ProjectConfiguration) -> bool {
    project.captions.as_ref().is_some_and(|captions| {
        captions.source_timed
            && captions
                .segments
                .iter()
                .any(|segment| !segment.words.is_empty())
    })
}

fn is_filler(text: &str) -> bool {
    let token = text.trim().trim_matches(|c: char| {
        matches!(
            c,
            '.' | ','
                | '!'
                | '?'
                | ';'
                | ':'
                | '"'
                | '\''
                | '“'
                | '”'
                | '‘'
                | '’'
                | '('
                | ')'
                | '['
                | ']'
        )
    });
    if !token.chars().any(char::is_lowercase) {
        return false;
    }
    let token = token.to_ascii_lowercase();
    if token == "err" {
        return false;
    }
    let mut normalized = String::new();
    let mut previous = None;
    for letter in token.chars() {
        if previous != Some(letter) {
            normalized.push(letter);
        }
        previous = Some(letter);
    }
    matches!(normalized.as_str(), "um" | "uh" | "uhm" | "er" | "erm")
}

pub fn refine_word_ends(
    segments: &mut [CaptionSegment],
    samples: &[f32],
    sample_rate: u32,
) -> Result<(), String> {
    if sample_rate == 0 || samples.is_empty() {
        return Err("The recording has no valid audio for filler timing.".into());
    }
    let mut words: Vec<_> = segments.iter().flat_map(|segment| &segment.words).collect();
    validate_words(&mut words, samples.len() as f64 / f64::from(sample_rate))?;
    let Some(pauses) = speech_pauses::SpeechPauses::detect(samples, sample_rate) else {
        tracing::info!("Filler timing: speech is not clearly above the noise; keeping word ends");
        return Ok(());
    };
    // Parakeet can stretch a word to the next onset. Keep audible release and
    // the following pause instead of cutting away both (see Cap PR #1880).
    for segment in segments {
        for word in &mut segment.words {
            if is_filler(&word.text) {
                word.end = pauses.audible_end(word.start, word.end);
            }
        }
    }
    Ok(())
}

fn validate_words(words: &mut [&CaptionWord], recording_duration: f64) -> Result<(), String> {
    for word in words.iter() {
        if !word.start.is_finite()
            || !word.end.is_finite()
            || word.start < 0.0
            || word.end <= word.start
            || f64::from(word.end) > recording_duration + 0.005
        {
            return Err(
                "Caption word timings are invalid. Regenerate captions and try again.".into(),
            );
        }
    }
    words.sort_by(|left, right| left.start.total_cmp(&right.start));
    if words.windows(2).any(|pair| pair[0].end > pair[1].start) {
        return Err("Caption words overlap. Review their timings before removing fillers.".into());
    }
    Ok(())
}

pub fn remove_filler_words(
    project: &mut ProjectConfiguration,
    recording_durations: &[f64],
) -> Result<RemovalSummary, String> {
    if !has_word_timings(project) {
        return Err("Generate word-timed captions before removing filler words.".into());
    }
    let mut recording_offsets = Vec::with_capacity(recording_durations.len());
    let mut recording_duration = 0.0;
    for duration in recording_durations {
        if !duration.is_finite() || *duration <= 0.0 {
            return Err("The recording has invalid source durations.".into());
        }
        recording_offsets.push(recording_duration);
        recording_duration += duration;
    }
    if recording_offsets.is_empty() || !recording_duration.is_finite() {
        return Err("The recording has no valid source durations.".into());
    }
    let captions = project
        .captions
        .as_ref()
        .expect("word timings were checked");
    let mut words: Vec<&CaptionWord> = captions
        .segments
        .iter()
        .flat_map(|segment| &segment.words)
        .collect();
    validate_words(&mut words, recording_duration)?;
    let fillers: Vec<_> = words
        .into_iter()
        .filter(|word| is_filler(&word.text))
        .collect();
    let mut edited = project.clone();
    if !editor_edits::ensure_timeline(&mut edited, recording_durations) {
        return Err("The recording has no editable timeline.".into());
    }
    let timeline = edited.timeline.as_ref().expect("timeline was ensured");
    let offsets = editor_timeline::clip_timeline_offsets(timeline);
    let mut held = 0.0;
    let hold_points: Vec<_> = timeline
        .hold_windows()
        .into_iter()
        .map(|(start, end)| {
            let effective = start - held;
            held += end - start;
            effective
        })
        .collect();
    let mut cuts: Vec<Cut> = Vec::new();
    let mut summary = RemovalSummary::default();

    for (clip_index, clip) in timeline.segments.iter().enumerate() {
        let recording = clip.recording_clip as usize;
        let Some(source_offset) = recording_offsets.get(recording) else {
            return Err("A timeline clip refers to a missing recording.".into());
        };
        if !clip.start.is_finite()
            || !clip.end.is_finite()
            || !clip.timescale.is_finite()
            || clip.timescale <= 0.0
            || clip.start < 0.0
            || clip.end <= clip.start
            || clip.end > recording_durations[recording] + 0.005
        {
            return Err("The timeline has invalid clip bounds or speed.".into());
        }
        let incoming = timeline
            .effective_transition(clip_index)
            .map_or(0.0, |transition| transition.duration);
        let outgoing = timeline
            .effective_transition(clip_index + 1)
            .map_or(0.0, |transition| transition.duration);
        for word in &fillers {
            let start = (f64::from(word.start) - source_offset).max(clip.start);
            let end = (f64::from(word.end) - source_offset).min(clip.end);
            if end <= start {
                continue;
            }
            let local_start = (start - clip.start) / clip.timescale;
            let local_end = (end - clip.start) / clip.timescale;
            let effective_start = offsets[clip_index] + local_start;
            let effective_end = offsets[clip_index] + local_end;
            // Keep transition handles and frozen frames intact rather than shortening them implicitly.
            if (incoming > 0.0 && local_start < incoming * 2.0 + EDGE_TOLERANCE)
                || (outgoing > 0.0 && clip.duration() - local_end < outgoing * 2.0 + EDGE_TOLERANCE)
                || hold_points
                    .iter()
                    .any(|point| *point >= effective_start && *point < effective_end)
            {
                summary.skipped_words += 1;
                continue;
            }
            summary.removed_words += 1;
            summary.removed_seconds += (end - start) / clip.timescale;
            if let Some(previous) = cuts.last_mut()
                && previous.clip_index == clip_index
                && start <= previous.end
            {
                previous.end = previous.end.max(end);
            } else {
                cuts.push(Cut {
                    clip_index,
                    start,
                    end,
                });
            }
        }
    }
    if cuts.is_empty() {
        return Ok(summary);
    }
    if timeline.duration() - summary.removed_seconds < 0.02 {
        return Err("Removing these fillers would leave no playable recording.".into());
    }
    let timeline = edited.timeline.as_mut().expect("timeline was ensured");
    for cut in cuts.into_iter().rev() {
        let clip = timeline.segments[cut.clip_index].clone();
        let offset = editor_timeline::clip_timeline_offsets(timeline)[cut.clip_index];
        let holds = timeline.hold_windows();
        if cut.end < clip.end {
            let end = editor_edits::effective_to_output_end(
                &holds,
                offset + (cut.end - clip.start) / clip.timescale,
            );
            if !editor_edits::split_clip_segment(timeline, end, Some(cut.clip_index)) {
                return Err(
                    "A filler cut could not be split safely. The project was not changed.".into(),
                );
            }
            // Preserve exact source boundaries across the source/output round trip, including nonbinary speeds.
            timeline.segments[cut.clip_index].end = cut.end;
            timeline.segments[cut.clip_index + 1].start = cut.end;
        }
        let middle = if cut.start > clip.start {
            let start = editor_edits::effective_to_output(
                &holds,
                offset + (cut.start - clip.start) / clip.timescale,
            );
            if !editor_edits::split_clip_segment(timeline, start, Some(cut.clip_index)) {
                return Err(
                    "A filler cut could not be split safely. The project was not changed.".into(),
                );
            }
            timeline.segments[cut.clip_index].end = cut.start;
            timeline.segments[cut.clip_index + 1].start = cut.start;
            cut.clip_index + 1
        } else {
            cut.clip_index
        };
        if !editor_edits::delete_clip_segments(timeline, &[middle]) {
            return Err(
                "A filler cut could not be removed safely. The project was not changed.".into(),
            );
        }
    }
    *project = edited;
    Ok(summary)
}

#[cfg(test)]
mod tests {
    use super::*;
    use cap_project::{CaptionSegment, CaptionsData};

    fn project(clips: serde_json::Value, words: &[(&str, f32, f32)]) -> ProjectConfiguration {
        let mut project: ProjectConfiguration = serde_json::from_value(serde_json::json!({
            "timeline": { "segments": clips, "zoomSegments": [{ "start": 6.0, "end": 8.0, "amount": 1.5, "mode": "auto" }] }
        })).unwrap();
        project.captions = Some(CaptionsData {
            source_timed: true,
            segments: vec![CaptionSegment {
                words: words
                    .iter()
                    .map(|(text, start, end)| CaptionWord {
                        text: text.to_string(),
                        start: *start,
                        end: *end,
                    })
                    .collect(),
                ..Default::default()
            }],
            ..Default::default()
        });
        project
    }

    fn single(words: &[(&str, f32, f32)]) -> ProjectConfiguration {
        project(
            serde_json::json!([{ "recordingSegment": 0, "start": 0.0, "end": 10.0, "timescale": 1.0 }]),
            words,
        )
    }

    #[test]
    fn whole_english_tokens_keep_acronyms_and_lexical_words() {
        for text in [
            "um", "Um,", "ummm", "uh", "uhhh.", "(Uhh)", "uhm", "uhhmm", "er", "Erm,", "errrm",
        ] {
            assert!(is_filler(text), "{text}");
        }
        for text in [
            "UM", "UH", "ER", "UML", "umbrella", "human", "hmm", "mhm", "ah", "like", "uh-oh",
            "err", "error", "you know", "u", "ummh",
        ] {
            assert!(!is_filler(text), "{text}");
        }
    }

    #[test]
    fn cuts_ripple_overlays_keep_source_words_and_are_idempotent() {
        let mut project = single(&[
            ("Hello", 0.0, 1.0),
            ("um", 2.0, 3.0),
            ("uh", 3.0, 4.0),
            ("ending", 8.0, 9.5),
        ]);
        let transcript = serde_json::to_value(&project.captions).unwrap();
        let original = project.clone();
        let summary = remove_filler_words(&mut project, &[10.0]).unwrap();
        assert_eq!(summary.removed_words, 2);
        assert_eq!(summary.removed_seconds, 2.0);
        let timeline = project.timeline.as_ref().unwrap();
        assert_eq!(
            timeline
                .segments
                .iter()
                .map(|clip| (clip.start, clip.end))
                .collect::<Vec<_>>(),
            vec![(0.0, 2.0), (4.0, 10.0)]
        );
        assert_eq!(
            (
                timeline.zoom_segments[0].start,
                timeline.zoom_segments[0].end
            ),
            (4.0, 6.0)
        );
        assert_eq!(serde_json::to_value(&project.captions).unwrap(), transcript);
        let derived = cap_project::derive_caption_track_segments(
            &project.captions.as_ref().unwrap().segments,
            timeline,
            &[10.0],
        );
        assert!(
            derived
                .iter()
                .flat_map(|caption| &caption.words)
                .all(|word| !is_filler(&word.text))
        );
        let mut history = editor_edits::ProjectHistory::new(original.clone());
        history.record(&project);
        assert_eq!(
            serde_json::to_value(history.undo().unwrap()).unwrap(),
            serde_json::to_value(original).unwrap()
        );
        assert_eq!(
            serde_json::to_value(history.redo().unwrap()).unwrap(),
            serde_json::to_value(&project).unwrap()
        );
        assert_eq!(
            remove_filler_words(&mut project, &[10.0])
                .unwrap()
                .removed_words,
            0
        );
    }

    #[test]
    fn maps_repeated_reordered_sources_and_speed() {
        let mut project = project(
            serde_json::json!([
                { "recordingSegment": 1, "start": 0.0, "end": 10.0, "timescale": 2.0 },
                { "recordingSegment": 0, "start": 0.0, "end": 10.0, "timescale": 1.0 },
                { "recordingSegment": 1, "start": 0.0, "end": 10.0, "timescale": 1.0 }
            ]),
            &[("um", 2.0, 3.0), ("uh", 14.0, 16.0)],
        );
        let summary = remove_filler_words(&mut project, &[10.0, 10.0]).unwrap();
        assert_eq!(summary.removed_words, 3);
        assert_eq!(summary.removed_seconds, 4.0);
        let timeline = project.timeline.unwrap();
        assert_eq!(timeline.duration(), 21.0);
        assert_eq!(
            timeline
                .segments
                .iter()
                .map(|clip| (clip.recording_clip, clip.start, clip.end))
                .collect::<Vec<_>>(),
            vec![
                (1, 0.0, 4.0),
                (1, 6.0, 10.0),
                (0, 0.0, 2.0),
                (0, 3.0, 10.0),
                (1, 0.0, 4.0),
                (1, 6.0, 10.0)
            ]
        );
    }

    #[test]
    fn invalid_or_all_filler_transcripts_do_not_change_project() {
        for words in [
            vec![("um", 0.0, 10.0)],
            vec![("um", 1.0, 3.0), ("speech", 2.0, 4.0)],
            vec![("uh", f32::NAN, 4.0)],
        ] {
            let mut project = single(&words);
            let before = serde_json::to_value(&project).unwrap();
            assert!(remove_filler_words(&mut project, &[10.0]).is_err());
            assert_eq!(serde_json::to_value(project).unwrap(), before);
        }
    }

    #[test]
    fn filler_at_clip_edges_preserves_the_complete_ending() {
        let mut project = single(&[("um", 0.0, 1.0), ("ending", 8.0, 9.0), ("uh", 9.5, 10.0)]);
        assert_eq!(
            remove_filler_words(&mut project, &[10.0])
                .unwrap()
                .removed_words,
            2
        );
        let clips = &project.timeline.as_ref().unwrap().segments;
        assert_eq!(clips.len(), 1);
        assert_eq!((clips[0].start, clips[0].end), (1.0, 9.5));
    }

    #[test]
    fn transition_handles_are_skipped_but_middle_cuts_keep_the_transition() {
        let mut project = project(
            serde_json::json!([
                { "recordingSegment": 0, "start": 0.0, "end": 5.0, "timescale": 1.0 },
                { "recordingSegment": 0, "start": 5.0, "end": 10.0, "timescale": 1.0 }
            ]),
            &[("um", 2.0, 2.5), ("uh", 4.5, 5.5)],
        );
        project.timeline.as_mut().unwrap().transitions =
            serde_json::from_value(serde_json::json!([
                { "segmentIndex": 1, "duration": 0.5, "type": "cross-fade" }
            ]))
            .unwrap();
        let summary = remove_filler_words(&mut project, &[10.0]).unwrap();
        assert_eq!(summary.removed_words, 1);
        assert_eq!(summary.skipped_words, 2);
        let timeline = project.timeline.unwrap();
        assert_eq!(timeline.transitions.len(), 1);
        assert_eq!(timeline.transitions[0].duration, 0.5);
        assert_eq!(timeline.transitions[0].segment_index, 2);
        assert_eq!(timeline.duration(), 9.0);
    }

    #[test]
    fn held_frames_survive_and_following_overlays_shift_in_output_time() {
        let mut project = single(&[("um", 2.0, 3.0), ("uh", 5.0, 6.0)]);
        project.timeline.as_mut().unwrap().text_segments =
            serde_json::from_value(serde_json::json!([
                { "start": 2.5, "end": 4.5, "content": "Keep this hold", "layout": "fullscreen" }
            ]))
            .unwrap();
        let summary = remove_filler_words(&mut project, &[10.0]).unwrap();
        assert_eq!(summary.removed_words, 1);
        assert_eq!(summary.skipped_words, 1);
        let timeline = project.timeline.unwrap();
        assert_eq!(timeline.hold_windows(), vec![(2.5, 4.5)]);
        assert_eq!(timeline.duration(), 11.0);
        assert_eq!(
            (
                timeline.zoom_segments[0].start,
                timeline.zoom_segments[0].end
            ),
            (6.0, 7.0)
        );
    }

    #[test]
    fn absent_word_timings_and_no_candidates_leave_the_project_unchanged() {
        let mut project = single(&[("Hello", 1.0, 2.0)]);
        let before = serde_json::to_value(&project).unwrap();
        assert_eq!(
            remove_filler_words(&mut project, &[10.0])
                .unwrap()
                .removed_words,
            0
        );
        assert_eq!(serde_json::to_value(&project).unwrap(), before);
        project.captions.as_mut().unwrap().source_timed = false;
        let before = serde_json::to_value(&project).unwrap();
        assert!(remove_filler_words(&mut project, &[10.0]).is_err());
        assert_eq!(serde_json::to_value(project).unwrap(), before);
    }

    #[test]
    fn fractional_speeds_do_not_leave_filler_slivers_on_repeat() {
        for (speed, source_start, filler_end) in [
            (0.7, 1.31, 2.89),
            (1.1, 1.31, 2.89),
            (1.7, 1.31, 2.89),
            (2.3, 1.31, 2.89),
            (3.1, 1.31, 2.89),
            (3.0681731581839884, 0.9100351728607, 4.141_660_7),
        ] {
            let mut project = project(
                serde_json::json!([
                    { "recordingSegment": 0, "start": source_start, "end": 9.87, "timescale": speed }
                ]),
                &[("um", 2.37, filler_end), ("uh", 5.12, 5.77)],
            );
            assert_eq!(
                remove_filler_words(&mut project, &[10.0])
                    .unwrap()
                    .removed_words,
                2
            );
            let after = serde_json::to_value(&project).unwrap();
            assert_eq!(
                remove_filler_words(&mut project, &[10.0])
                    .unwrap()
                    .removed_words,
                0,
                "speed {speed}"
            );
            assert_eq!(serde_json::to_value(project).unwrap(), after);
        }
    }

    #[test]
    fn cleanup_keeps_the_audible_release_and_pause_before_the_next_word() {
        let mut project = single(&[("Hello", 0.0, 1.0), ("um", 1.0, 3.0), ("next", 3.0, 3.5)]);
        let mut samples = vec![0.0; 16_000 * 10];
        for (index, sample) in samples.iter_mut().enumerate() {
            let time = index as f32 / 16_000.0;
            if (0.1..0.8).contains(&time)
                || (1.0..1.5).contains(&time)
                || (3.0..3.5).contains(&time)
            {
                *sample = 0.1 * (std::f32::consts::TAU * 220.0 * time).sin();
            }
        }
        refine_word_ends(
            &mut project.captions.as_mut().unwrap().segments,
            &samples,
            16_000,
        )
        .unwrap();
        let words = &project.captions.as_ref().unwrap().segments[0].words;
        assert!((1.59..1.63).contains(&words[1].end), "{}", words[1].end);
        assert_eq!((words[0].start, words[0].end), (0.0, 1.0));
        assert_eq!((words[2].start, words[2].end), (3.0, 3.5));
        let summary = remove_filler_words(&mut project, &[10.0]).unwrap();
        assert_eq!(summary.removed_words, 1);
        let clips = &project.timeline.as_ref().unwrap().segments;
        assert!((1.59..1.63).contains(&clips[1].start));
        assert!(3.0 - clips[1].start > 1.3);
        assert_eq!(
            remove_filler_words(&mut project, &[10.0])
                .unwrap()
                .removed_words,
            0
        );
    }

    #[test]
    fn refinement_does_not_hide_invalid_or_overlapping_input() {
        let mut project = single(&[("um", 1.0, 3.0), ("speech", 2.0, 4.0)]);
        let segments = &mut project.captions.as_mut().unwrap().segments;
        let before = serde_json::to_value(&segments).unwrap();
        assert!(refine_word_ends(segments, &vec![0.0; 16_000 * 10], 16_000).is_err());
        assert_eq!(serde_json::to_value(segments).unwrap(), before);
    }

    #[test]
    fn cleaned_clips_allow_manual_recovery_split_delete_and_undo() {
        let mut project = single(&[("um", 2.0, 3.0), ("hmm", 5.0, 6.0), ("ending", 8.0, 9.0)]);
        let original = serde_json::to_value(&project).unwrap();
        let mut history = editor_edits::ProjectHistory::new(project.clone());
        remove_filler_words(&mut project, &[10.0]).unwrap();
        history.record(&project);
        let cleaned = serde_json::to_value(&project).unwrap();
        let timeline = project.timeline.as_mut().unwrap();
        assert_eq!(
            editor_edits::clip_trim_end(timeline, 0, 3.0, 0.001, &[10.0], 10.0),
            Some(3.0)
        );
        let recovered_end =
            editor_edits::clip_trim_end(timeline, 0, 2.1, 0.001, &[10.0], 10.0).unwrap();
        assert_eq!(recovered_end, 2.1);
        timeline.segments[0].end = recovered_end;
        assert!(editor_edits::split_clip_segment(timeline, 5.1, Some(1)));
        assert!(editor_edits::split_clip_segment(timeline, 4.1, Some(1)));
        assert!(editor_edits::delete_clip_segments(timeline, &[2]));
        assert_eq!(timeline.segments.len(), 3);
        assert_eq!(timeline.segments[1].start, 3.0);
        assert!((timeline.segments[1].end - 5.0).abs() < 0.000_001);
        assert!((timeline.segments[2].start - 6.0).abs() < 0.000_001);
        history.record(&project);
        assert_eq!(
            serde_json::to_value(history.undo().unwrap()).unwrap(),
            cleaned
        );
        assert_eq!(
            serde_json::to_value(history.undo().unwrap()).unwrap(),
            original
        );
    }
}
