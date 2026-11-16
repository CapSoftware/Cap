use std::ops::Range;

use cap_project::{
    CaptionSegment, CaptionWord, CaptionsData, ClipTransition, ClipTransitionType,
    ProjectConfiguration, TextLayout, TimelineConfiguration,
};

use super::cuts::{
    self, CutReport, LONG_GAP, ONSET_GUARD, Removing, RestoreBlocker, TAIL_GUARD,
    apply_source_cuts, follow_refined_words, gap_cut, plan_pause_cuts, plan_word_cuts,
    quietest_point, restore_words,
};
use super::energy::{EnergyEnvelope, EnvelopeTrack, HOP_SECONDS, clip_envelope};
use super::model::{TranscriptDoc, TranscriptEdl, flatten_words};
use crate::editor_edits;

/// Collapses a sorted, possibly overlapping list of word indices into runs.
fn runs_of(words: impl IntoIterator<Item = usize>) -> Vec<Range<usize>> {
    let mut sorted: Vec<usize> = words.into_iter().collect();
    sorted.sort_unstable();
    sorted.dedup();
    let mut runs: Vec<Range<usize>> = Vec::new();
    for word in sorted {
        match runs.last_mut() {
            Some(run) if run.end == word => run.end += 1,
            _ => runs.push(word..word + 1),
        }
    }
    runs
}

fn captions(words: &[(&str, f64, f64)]) -> CaptionsData {
    let segments = words
        .chunks(6)
        .enumerate()
        .map(|(index, chunk)| CaptionSegment {
            id: format!("segment-{index}"),
            start: chunk[0].1 as f32,
            end: chunk[chunk.len() - 1].2 as f32,
            text: chunk
                .iter()
                .map(|(text, ..)| *text)
                .collect::<Vec<_>>()
                .join(" "),
            words: chunk
                .iter()
                .map(|(text, start, end)| CaptionWord {
                    text: (*text).to_string(),
                    start: *start as f32,
                    end: *end as f32,
                })
                .collect(),
        })
        .collect();
    CaptionsData {
        segments,
        settings: Default::default(),
        source_timed: true,
    }
}

/// `count` words, each 0.3 s long with 0.2 s of silence after it.
fn spoken(texts: &[&str]) -> Vec<(String, f64, f64)> {
    texts
        .iter()
        .enumerate()
        .map(|(index, text)| {
            let start = 1.0 + index as f64 * 0.5;
            ((*text).to_string(), start, start + 0.3)
        })
        .collect()
}

fn borrowed(words: &[(String, f64, f64)]) -> Vec<(&str, f64, f64)> {
    words
        .iter()
        .map(|(text, start, end)| (text.as_str(), *start, *end))
        .collect()
}

fn project(words: &[(&str, f64, f64)], durations: &[f64]) -> ProjectConfiguration {
    let mut project = ProjectConfiguration::default();
    assert!(editor_edits::ensure_timeline(&mut project, durations));
    project.captions = Some(captions(words));
    project
}

fn timeline(project: &ProjectConfiguration) -> &TimelineConfiguration {
    project.timeline.as_ref().unwrap()
}

fn timeline_mut(project: &mut ProjectConfiguration) -> &mut TimelineConfiguration {
    project.timeline.as_mut().unwrap()
}

fn model(project: &ProjectConfiguration, durations: &[f64]) -> (TranscriptDoc, TranscriptEdl) {
    let doc = TranscriptDoc::build(project.captions.as_ref().unwrap());
    let edl = TranscriptEdl::build(&doc, timeline(project), durations);
    (doc, edl)
}

fn cut_words(
    project: &mut ProjectConfiguration,
    durations: &[f64],
    runs: &[(usize, usize)],
) -> CutReport {
    let doc = TranscriptDoc::build(project.captions.as_ref().unwrap());
    let runs: Vec<Range<usize>> = runs.iter().map(|(start, end)| *start..*end).collect();
    let cuts = plan_word_cuts(&doc, None, None, &runs);
    apply_source_cuts(timeline_mut(project), durations, &cuts)
}

fn kept(project: &ProjectConfiguration, durations: &[f64]) -> Vec<bool> {
    model(project, durations).1.kept
}

fn bounds(project: &ProjectConfiguration) -> Vec<(f64, f64)> {
    timeline(project)
        .segments
        .iter()
        .map(|segment| (segment.start, segment.end))
        .collect()
}

fn close(a: f64, b: f64) -> bool {
    (a - b).abs() < 1e-6
}

#[test]
fn flattening_folds_punctuation_and_sorts() {
    let data = captions(&[
        ("world", 0.6, 0.9),
        ("hello", 0.1, 0.5),
        (",", 0.5, 0.5),
        ("", 1.0, 1.1),
        ("again", 1.2, 1.5),
        (".", 1.5, 1.5),
        ("it", 2.0, 2.1),
        ("'s", 2.1, 2.2),
    ]);
    let words = flatten_words(&data);
    let texts: Vec<_> = words.iter().map(|word| word.text.as_str()).collect();
    assert_eq!(texts, ["hello,", "world", "again.", "it's"]);
    assert!(close(words[3].end, 2.2));
}

#[test]
fn paragraphs_break_at_long_pauses_and_sentence_ends() {
    let data = captions(&[
        ("One", 0.0, 0.2),
        ("two.", 0.3, 0.5),
        ("Three", 1.4, 1.6),
        ("four", 1.7, 1.9),
        ("five", 4.0, 4.2),
    ]);
    let doc = TranscriptDoc::build(&data);
    let ranges: Vec<_> = doc.paragraphs.iter().map(|p| p.words.clone()).collect();
    assert_eq!(ranges, [0..2, 2..4, 4..5]);
    assert_eq!(doc.paragraphs[0].text.as_ref(), "One two.");
    assert_eq!(doc.paragraphs[0].spans, [0..3, 4..8]);
    assert_eq!(doc.paragraphs[0].word_at_byte(3), 0);
    assert_eq!(doc.paragraphs[0].word_at_byte(4), 1);
    assert_eq!(doc.paragraphs[0].word_at_byte(99), 1);
}

#[test]
fn long_runs_without_punctuation_still_break() {
    let words: Vec<_> = (0..400)
        .map(|index| {
            (
                "word".to_string(),
                index as f64 * 0.3,
                index as f64 * 0.3 + 0.25,
            )
        })
        .collect();
    let doc = TranscriptDoc::build(&captions(&borrowed(&words)));
    assert!(doc.paragraphs.len() >= 2);
    assert!(doc.paragraphs.iter().all(|p| p.words.len() <= 280));
    assert_eq!(
        doc.paragraphs.iter().map(|p| p.words.len()).sum::<usize>(),
        400
    );
}

#[test]
fn deleting_a_word_cuts_inside_the_silences_around_it() {
    let words = spoken(&["so", "um", "the", "export", "works"]);
    let durations = [5.0];
    let mut project = project(&borrowed(&words), &durations);
    let report = cut_words(&mut project, &durations, &[(1, 2)]);
    assert_eq!(report.applied, 1);
    assert_eq!(kept(&project, &durations), [true, false, true, true, true]);

    let segments = bounds(&project);
    assert_eq!(segments.len(), 2);
    let (doc, _) = model(&project, &durations);
    let before = &doc.words[0];
    let removed = &doc.words[1];
    let after = &doc.words[2];
    assert!(segments[0].1 >= before.end + TAIL_GUARD - 1e-9);
    assert!(segments[0].1 <= removed.start);
    assert!(segments[1].0 >= removed.end);
    assert!(segments[1].0 <= after.start - ONSET_GUARD + 1e-9);
    assert!(close(
        editor_edits::clip_timeline_duration(timeline(&project)),
        5.0 - (segments[1].0 - segments[0].1)
    ));
}

#[test]
fn cutting_neighbours_one_at_a_time_matches_cutting_them_together() {
    let words = spoken(&["a", "b", "c", "d", "e"]);
    let durations = [5.0];
    let mut together = project(&borrowed(&words), &durations);
    cut_words(&mut together, &durations, &[(1, 3)]);
    let mut apart = project(&borrowed(&words), &durations);
    cut_words(&mut apart, &durations, &[(1, 2)]);
    cut_words(&mut apart, &durations, &[(2, 3)]);
    let total =
        |project: &ProjectConfiguration| editor_edits::clip_timeline_duration(timeline(project));
    assert!(close(total(&together), total(&apart)));
    assert_eq!(kept(&together, &durations), kept(&apart, &durations));
    let played: f64 = bounds(&apart).iter().map(|(s, e)| e - s).sum();
    assert!(close(played, total(&together)));
}

#[test]
fn other_tracks_ripple_with_the_cut() {
    let words = spoken(&["one", "two", "three", "four"]);
    let durations = [4.0];
    let mut project = project(&borrowed(&words), &durations);
    timeline_mut(&mut project)
        .text_segments
        .push(editor_edits::default_text_segment(3.0, 3.5, 0));
    let before = editor_edits::clip_timeline_duration(timeline(&project));
    cut_words(&mut project, &durations, &[(1, 2)]);
    let removed = before - editor_edits::clip_timeline_duration(timeline(&project));
    let text = &timeline(&project).text_segments[0];
    assert!(close(text.start, 3.0 - removed));
    assert!(close(text.end, 3.5 - removed));
}

#[test]
fn restoring_undoes_the_cut_exactly() {
    let words = spoken(&["so", "um", "the", "export", "works"]);
    let durations = [5.0];
    let original = project(&borrowed(&words), &durations);
    let mut project = original.clone();
    timeline_mut(&mut project)
        .text_segments
        .push(editor_edits::default_text_segment(3.0, 3.5, 0));
    let with_text = project.clone();
    cut_words(&mut project, &durations, &[(1, 2)]);
    let doc = TranscriptDoc::build(project.captions.as_ref().unwrap());
    let restored = restore_words(timeline_mut(&mut project), &durations, &[], &doc, 1..2).unwrap();
    assert_eq!(restored, 1);
    assert_eq!(bounds(&project), bounds(&original));
    let text = &timeline(&project).text_segments[0];
    let expected = &timeline(&with_text).text_segments[0];
    assert!(close(text.start, expected.start) && close(text.end, expected.end));
    assert_eq!(kept(&project, &durations), [true; 5]);
}

#[test]
fn shapes_ripple_with_a_cut_and_come_back_when_it_is_restored() {
    let words = spoken(&["so", "um", "the", "export", "works"]);
    let durations = [5.0];
    let mut project = project(&borrowed(&words), &durations);
    let shape = |start: f64, end: f64| cap_project::ShapeSegment {
        start,
        end,
        ..Default::default()
    };
    timeline_mut(&mut project).shape_segments = vec![shape(3.0, 3.5), shape(1.2, 3.5)];
    let before = editor_edits::clip_timeline_duration(timeline(&project));

    cut_words(&mut project, &durations, &[(1, 2)]);
    let removed = before - editor_edits::clip_timeline_duration(timeline(&project));
    assert!(removed > 0.2);
    let shapes = &timeline(&project).shape_segments;
    assert!(close(shapes[0].start, 3.0 - removed) && close(shapes[0].end, 3.5 - removed));
    assert!(close(shapes[1].start, 1.2) && close(shapes[1].end, 3.5 - removed));

    let doc = TranscriptDoc::build(project.captions.as_ref().unwrap());
    let restored = restore_words(timeline_mut(&mut project), &durations, &[], &doc, 1..2).unwrap();
    assert_eq!(restored, 1);
    let shapes = &timeline(&project).shape_segments;
    assert!(
        close(shapes[0].start, 3.0) && close(shapes[0].end, 3.5),
        "{:?}",
        (shapes[0].start, shapes[0].end)
    );
    assert!(
        close(shapes[1].start, 1.2) && close(shapes[1].end, 3.5),
        "{:?}",
        (shapes[1].start, shapes[1].end)
    );
}

#[test]
fn restore_reaches_a_cut_at_the_start_and_end() {
    let words = spoken(&["um", "hello", "there", "uh"]);
    let durations = [4.0];
    let mut project = project(&borrowed(&words), &durations);
    cut_words(&mut project, &durations, &[(0, 1), (3, 4)]);
    assert_eq!(kept(&project, &durations), [false, true, true, false]);
    assert!(close(timeline(&project).segments[0].start, 1.41));
    let doc = TranscriptDoc::build(project.captions.as_ref().unwrap());
    restore_words(timeline_mut(&mut project), &durations, &[], &doc, 0..1).unwrap();
    restore_words(timeline_mut(&mut project), &durations, &[], &doc, 3..4).unwrap();
    assert_eq!(kept(&project, &durations), [true; 4]);
    assert_eq!(bounds(&project), [(0.0, 4.0)]);
}

#[test]
fn restore_refuses_a_cut_between_reordered_clips() {
    let words = spoken(&["a", "b", "c", "d"]);
    let durations = [4.0];
    let mut project = project(&borrowed(&words), &durations);
    cut_words(&mut project, &durations, &[(1, 2)]);
    timeline_mut(&mut project).segments.swap(0, 1);
    let before = bounds(&project);
    let doc = TranscriptDoc::build(project.captions.as_ref().unwrap());
    let result = restore_words(timeline_mut(&mut project), &durations, &[], &doc, 1..2);
    assert_eq!(result, Err(RestoreBlocker::NotAdjacent));
    assert_eq!(bounds(&project), before);
}

#[test]
fn a_timeline_cut_shows_up_as_cut_words() {
    let words = spoken(&["a", "b", "c", "d", "e"]);
    let durations = [5.0];
    let mut project = project(&borrowed(&words), &durations);
    let timeline = timeline_mut(&mut project);
    assert!(editor_edits::split_clip_segment(timeline, 1.9, None));
    assert!(editor_edits::split_clip_segment(timeline, 2.9, None));
    assert!(editor_edits::delete_clip_segments(timeline, &[1]));
    assert_eq!(kept(&project, &durations), [true, true, false, false, true]);
}

#[test]
fn words_in_later_recordings_map_through_the_recording_offsets() {
    let durations = [3.0, 3.0];
    let words = [
        ("first", 1.0, 1.4),
        ("take", 1.6, 2.0),
        ("second", 4.0, 4.4),
        ("take", 4.6, 5.0),
    ];
    let mut project = project(&words, &durations);
    assert_eq!(timeline(&project).segments.len(), 2);
    let (_, edl) = model(&project, &durations);
    assert!(close(edl.source_to_output(4.0).unwrap(), 4.0));
    assert!(close(edl.output_to_source(4.2).unwrap(), 4.2));
    cut_words(&mut project, &durations, &[(2, 3)]);
    assert_eq!(kept(&project, &durations), [true, true, false, true]);
    let segments = &timeline(&project).segments;
    assert_eq!(segments.len(), 3);
    assert!(
        segments[1..]
            .iter()
            .all(|segment| segment.recording_clip == 1)
    );
    assert!(close(segments[1].start, 0.0));
    assert!(segments[1].end >= 1.0 - LONG_GAP / 2.0 && segments[1].end < 1.0 - ONSET_GUARD);
    assert!(segments[2].start > 1.4 && segments[2].start < 1.6);
}

#[test]
fn fast_clips_cut_in_playback_time() {
    let words = spoken(&["a", "b", "c", "d"]);
    let durations = [4.0];
    let mut project = project(&borrowed(&words), &durations);
    timeline_mut(&mut project).segments[0].timescale = 2.0;
    let (_, edl) = model(&project, &durations);
    assert!(close(edl.source_to_output(2.0).unwrap(), 1.0));
    cut_words(&mut project, &durations, &[(1, 2)]);
    assert_eq!(kept(&project, &durations), [true, false, true, true]);
    let played: f64 = bounds(&project).iter().map(|(s, e)| e - s).sum();
    assert!(close(
        editor_edits::clip_timeline_duration(timeline(&project)),
        played / 2.0
    ));
}

#[test]
fn cuts_next_to_a_transition_are_skipped_and_reported() {
    let words = spoken(&["a", "b", "c", "d", "e", "f", "g", "h"]);
    let durations = [5.0];
    let mut project = project(&borrowed(&words), &durations);
    let timeline = timeline_mut(&mut project);
    assert!(editor_edits::split_clip_segment(timeline, 2.85, None));
    timeline.transitions.push(ClipTransition {
        segment_index: 1,
        kind: ClipTransitionType::CrossFade,
        duration: 0.5,
    });
    let before = bounds(&project);
    let report = cut_words(&mut project, &durations, &[(3, 4)]);
    assert_eq!(report.applied, 0);
    assert!(report.transition >= 1);
    assert_eq!(bounds(&project), before);
}

#[test]
fn cuts_under_a_fullscreen_text_hold_are_skipped() {
    let words = spoken(&["a", "b", "c", "d"]);
    let durations = [4.0];
    let mut project = project(&borrowed(&words), &durations);
    let mut hold = editor_edits::default_text_segment(1.6, 1.9, 0);
    hold.layout = TextLayout::Fullscreen;
    timeline_mut(&mut project).text_segments.push(hold);
    let report = cut_words(&mut project, &durations, &[(1, 2)]);
    assert_eq!(report.hold, 1);
    assert_eq!(report.applied, 0);
}

#[test]
fn the_last_clip_is_never_cut_away() {
    let words = spoken(&["a", "b"]);
    let durations = [2.0];
    let mut project = project(&borrowed(&words), &durations);
    let report = apply_source_cuts(timeline_mut(&mut project), &durations, &[0.0..2.0]);
    assert_eq!(report.last_clip, 1);
    assert_eq!(bounds(&project), [(0.0, 2.0)]);
}

#[test]
fn slivers_at_clip_edges_are_absorbed() {
    let durations = [4.0];
    let mut project = project(&[("a", 1.0, 1.3)], &durations);
    let report = apply_source_cuts(timeline_mut(&mut project), &durations, &[0.005..1.0]);
    assert_eq!(report.applied, 1);
    assert_eq!(bounds(&project), [(1.0, 4.0)]);
}

#[test]
fn touching_words_cut_at_their_shared_boundary() {
    let data = captions(&[("one", 0.0, 0.5), ("two", 0.5, 1.0), ("three", 1.0, 1.5)]);
    let doc = TranscriptDoc::build(&data);
    let point = gap_cut(&doc, None, 1, Removing::After);
    assert!(close(point, 0.5));
}

#[test]
fn cut_points_snap_to_the_quietest_moment_in_the_gap() {
    let duration = 3.0;
    let mut samples = Vec::new();
    for index in 0..(duration * 48_000.0) as usize {
        let time = index as f64 / 48_000.0;
        let quiet = (1.42..1.46).contains(&time);
        let amplitude = if quiet { 0.0005 } else { 0.05 };
        samples.push((amplitude * (time * 440.0 * std::f64::consts::TAU).sin()) as f32);
    }
    let envelope = EnergyEnvelope::new(
        vec![clip_envelope(
            &[EnvelopeTrack {
                slices: vec![&samples],
                channels: 1,
                offset_seconds: 0.0,
            }],
            duration,
        )],
        &[duration],
    );
    let point = quietest_point(Some(&envelope), 1.3, 1.7);
    assert!((1.42..=1.46).contains(&point), "{point}");
    assert!(close(quietest_point(None, 1.3, 1.7), 1.5));

    let flat = vec![0.01f32; (duration * 48_000.0) as usize];
    let envelope = EnergyEnvelope::new(
        vec![clip_envelope(
            &[EnvelopeTrack {
                slices: vec![&flat],
                channels: 1,
                offset_seconds: 0.0,
            }],
            duration,
        )],
        &[duration],
    );
    let point = quietest_point(Some(&envelope), 1.0, 2.0);
    assert!((point - 1.5).abs() <= HOP_SECONDS, "{point}");
}

#[test]
fn the_envelope_honours_track_offsets_and_split_slices() {
    let mut samples = vec![0.0f32; 96_000];
    for sample in &mut samples[48_000..48_480] {
        *sample = 0.5;
    }
    let (head, tail) = samples.split_at(1_001);
    let envelope = clip_envelope(
        &[EnvelopeTrack {
            slices: vec![head, tail],
            channels: 2,
            offset_seconds: 0.25,
        }],
        1.0,
    );
    let loud: Vec<_> = envelope
        .iter()
        .enumerate()
        .filter(|(_, energy)| **energy > 0.0)
        .map(|(index, _)| index)
        .collect();
    assert_eq!(loud, [(0.25 / HOP_SECONDS).round() as usize]);
}

#[test]
fn shortening_pauses_leaves_the_target_silence() {
    let words = [
        ("before", 1.0, 1.4),
        ("after", 4.0, 4.4),
        ("close", 4.6, 5.0),
    ];
    let durations = [6.0];
    let mut project = project(&words, &durations);
    let (doc, edl) = model(&project, &durations);
    let pauses = plan_pause_cuts(&doc, &edl, None, 1.0, 0.5);
    assert_eq!(pauses.len(), 1);
    assert_eq!(pauses[0].after_word, 0);
    let cuts: Vec<_> = pauses.iter().flat_map(|pause| pause.cuts.clone()).collect();
    apply_source_cuts(timeline_mut(&mut project), &durations, &cuts);
    let (_, edl) = model(&project, &durations);
    let gap = edl.source_to_output(4.0).unwrap() - edl.source_to_output(1.4).unwrap();
    assert!((gap - 0.5).abs() < 1e-6, "{gap}");
    assert_eq!(edl.kept, [true, true, true]);
    assert!(plan_pause_cuts(&doc, &edl, None, 1.0, 0.5).is_empty());
}

#[test]
fn runs_collapse_neighbouring_words() {
    assert_eq!(runs_of([5, 1, 2, 3, 7, 6, 2]), [1..4, 5..8]);
    assert!(runs_of([]).is_empty());
}

#[test]
fn hostile_transcripts_do_not_panic() {
    let durations = [10.0];
    let mut project = project(
        &[
            ("zero", 1.0, 1.0),
            ("backwards", 3.0, 2.0),
            ("normal", 4.0, 4.5),
            ("zero", 4.5, 4.5),
        ],
        &durations,
    );
    let (doc, edl) = model(&project, &durations);
    assert_eq!(doc.words.len(), 4);
    assert!(edl.kept.iter().all(|kept| *kept));
    cut_words(&mut project, &durations, &[(0, 2), (3, 4)]);
    let mut empty = ProjectConfiguration::default();
    assert!(editor_edits::ensure_timeline(&mut empty, &durations));
    empty.captions = Some(captions(&[]));
    let doc = TranscriptDoc::build(empty.captions.as_ref().unwrap());
    assert!(doc.is_empty());
    assert!(plan_word_cuts(&doc, None, None, std::slice::from_ref(&(0..3))).is_empty());
}

#[test]
fn two_hour_timestamps_keep_their_precision() {
    let base = 7_100.0;
    let words: Vec<(String, f64, f64)> = (0..10)
        .map(|index| {
            let start = base + index as f64 * 0.5;
            (format!("w{index}"), start, start + 0.3)
        })
        .collect();
    let durations = [7_200.0];
    let mut project = project(&borrowed(&words), &durations);
    cut_words(&mut project, &durations, &[(4, 5)]);
    let (doc, edl) = model(&project, &durations);
    assert_eq!(
        edl.kept,
        [true, true, true, true, false, true, true, true, true, true]
    );
    let after = edl.source_to_output(doc.words[5].start).unwrap();
    let before = edl.source_to_output(doc.words[3].end).unwrap();
    assert!(
        after - before > 0.15 && after - before < 0.5,
        "{}",
        after - before
    );
}

#[test]
fn removing_hundreds_of_fillers_from_twenty_thousand_words_is_fast() {
    let mut words = Vec::with_capacity(20_000);
    let mut time = 0.5;
    for index in 0..20_000 {
        let text = if index % 40 == 20 {
            "um,".to_string()
        } else {
            format!("w{index}")
        };
        words.push((text, time, time + 0.25));
        time += if index % 400 == 399 { 1.96 } else { 0.36 };
    }
    let durations = [time + 1.0];
    let mut project = project(&borrowed(&words), &durations);

    let started = std::time::Instant::now();
    let doc = TranscriptDoc::build(project.captions.as_ref().unwrap());
    let build = started.elapsed();
    let runs: Vec<_> = doc
        .fillers
        .iter()
        .map(|filler| filler.words.clone())
        .collect();
    assert_eq!(runs.len(), 500);

    let started = std::time::Instant::now();
    let cuts = plan_word_cuts(&doc, None, None, &runs);
    let report = apply_source_cuts(timeline_mut(&mut project), &durations, &cuts);
    let apply = started.elapsed();
    assert_eq!(report.applied, 500);
    assert_eq!(timeline(&project).segments.len(), 501);

    let started = std::time::Instant::now();
    let edl = TranscriptEdl::build(&doc, timeline(&project), &durations);
    let rebuild = started.elapsed();
    let cut: Vec<_> = (0..doc.words.len())
        .filter(|word| !edl.kept[*word])
        .collect();
    assert_eq!(cut.len(), 500);
    assert!(cut.iter().all(|word| doc.words[*word].text == "um,"));

    let started = std::time::Instant::now();
    let pauses = plan_pause_cuts(&doc, &edl, None, 1.0, 0.5);
    let pause_plan = started.elapsed();
    assert_eq!(pauses.len(), 49);
    assert!(pauses.iter().all(|pause| pause.after_word % 400 == 399));

    let limit = |release_ms: u64| {
        std::time::Duration::from_millis(if cfg!(debug_assertions) {
            release_ms * 15
        } else {
            release_ms
        })
    };
    println!(
        "20k words: doc {build:?}, 500 cuts {apply:?}, edl {rebuild:?}, pauses {pause_plan:?}"
    );
    assert!(build < limit(80), "{build:?}");
    assert!(apply < limit(16), "{apply:?}");
    assert!(rebuild < limit(8), "{rebuild:?}");
    assert!(pause_plan < limit(2), "{pause_plan:?}");
}

#[test]
fn output_and_source_times_round_trip_through_a_transition() {
    let durations = [10.0];
    let mut project = project(&[("a", 1.0, 1.2)], &durations);
    let timeline = timeline_mut(&mut project);
    assert!(editor_edits::split_clip_segment(timeline, 5.0, None));
    timeline.segments[1].start = 6.0;
    timeline.transitions.push(ClipTransition {
        segment_index: 1,
        kind: ClipTransitionType::CrossFade,
        duration: 1.0,
    });
    let (_, edl) = model(&project, &durations);
    assert!(close(edl.output_to_source(2.0).unwrap(), 2.0));
    assert!(close(edl.output_to_source(4.5).unwrap(), 6.5));
    assert!(close(edl.source_to_output(7.0).unwrap(), 5.0));
}

#[test]
fn search_matches_phrases_and_prefixes() {
    let data = captions(&[
        ("You", 0.0, 0.1),
        ("know,", 0.2, 0.3),
        ("I", 0.4, 0.5),
        ("know", 0.6, 0.7),
        ("you", 0.8, 0.9),
        ("knowingly", 1.0, 1.1),
    ]);
    let doc = TranscriptDoc::build(&data);
    assert_eq!(super::view::find_matches(&doc, "you know"), [0..2, 4..6]);
    assert_eq!(super::view::find_matches(&doc, "KNOW"), [1..2, 3..4, 5..6]);
    assert!(super::view::find_matches(&doc, "  ").is_empty());
}

#[test]
fn cuts_unknown_to_the_planner_are_no_ops() {
    let durations = [2.0];
    let mut project = project(&[("a", 0.5, 0.8)], &durations);
    let report = cuts::apply_source_cuts(timeline_mut(&mut project), &durations, &[5.0..6.0]);
    assert_eq!(report, CutReport::default());
}

#[test]
fn restoring_brings_back_mask_keyframes_with_the_material() {
    let words = spoken(&["one", "two", "three", "four"]);
    let durations = [4.0];
    let mut project = project(&borrowed(&words), &durations);
    let mut mask = editor_edits::default_mask_segment(0.0, 4.0, 0);
    mask.keyframes.intensity = vec![
        cap_project::MaskScalarKeyframe {
            time: 1.0,
            value: 0.2,
        },
        cap_project::MaskScalarKeyframe {
            time: 3.0,
            value: 0.8,
        },
    ];
    timeline_mut(&mut project).mask_segments.push(mask);
    cut_words(&mut project, &durations, &[(1, 2)]);
    let doc = TranscriptDoc::build(project.captions.as_ref().unwrap());
    restore_words(timeline_mut(&mut project), &durations, &[], &doc, 1..2).unwrap();
    let mask = &timeline(&project).mask_segments[0];
    assert!(close(mask.end, 4.0));
    let times: Vec<f64> = mask
        .keyframes
        .intensity
        .iter()
        .map(|key| key.time)
        .collect();
    assert!(close(times[0], 1.0) && close(times[1], 3.0), "{times:?}");
}

#[test]
fn restoring_puts_back_a_whole_take_that_was_cut() {
    let durations = [2.0, 2.0, 2.0];
    let words = [
        ("first", 0.5, 0.9),
        ("middle", 2.5, 2.9),
        ("last", 4.5, 4.9),
    ];
    let mut project = project(&words, &durations);
    assert!(editor_edits::delete_clip_segments(
        timeline_mut(&mut project),
        &[1]
    ));
    assert_eq!(kept(&project, &durations), [true, false, true]);
    let doc = TranscriptDoc::build(project.captions.as_ref().unwrap());
    restore_words(timeline_mut(&mut project), &durations, &[], &doc, 1..2).unwrap();
    assert_eq!(kept(&project, &durations), [true, true, true]);
    let clips: Vec<u32> = timeline(&project)
        .segments
        .iter()
        .map(|segment| segment.recording_clip)
        .collect();
    assert_eq!(clips, [0, 1, 2]);
    assert!(close(
        editor_edits::clip_timeline_duration(timeline(&project)),
        6.0
    ));
}

#[test]
fn a_restored_take_keeps_the_speed_of_its_neighbours() {
    let durations = [2.0, 2.0, 2.0];
    let words = [
        ("first", 0.5, 0.9),
        ("middle", 2.5, 2.9),
        ("last", 4.5, 4.9),
    ];
    let mut project = project(&words, &durations);
    for segment in &mut timeline_mut(&mut project).segments {
        segment.timescale = 2.0;
    }
    assert!(editor_edits::delete_clip_segments(
        timeline_mut(&mut project),
        &[1]
    ));
    let doc = TranscriptDoc::build(project.captions.as_ref().unwrap());
    restore_words(timeline_mut(&mut project), &durations, &[], &doc, 1..2).unwrap();
    assert!(
        timeline(&project)
            .segments
            .iter()
            .all(|segment| segment.timescale == 2.0)
    );
    assert!(close(
        editor_edits::clip_timeline_duration(timeline(&project)),
        3.0
    ));
}

#[test]
fn a_pause_across_a_clip_boundary_is_measured_at_each_clip_speed() {
    let words = [("before", 1.0, 1.4), ("after", 5.0, 5.4)];
    let durations = [6.0];
    let mut project = project(&words, &durations);
    assert!(editor_edits::split_clip_segment(
        timeline_mut(&mut project),
        3.0,
        None
    ));
    timeline_mut(&mut project).segments[1].timescale = 2.0;
    let (doc, edl) = model(&project, &durations);
    let pauses = plan_pause_cuts(&doc, &edl, None, 1.0, 0.5);
    assert_eq!(pauses.len(), 1);
    assert!(close(pauses[0].length, 1.6 + 1.0), "{}", pauses[0].length);
    assert_eq!(pauses[0].cuts.len(), 2);
    let cuts: Vec<_> = pauses.iter().flat_map(|pause| pause.cuts.clone()).collect();
    apply_source_cuts(timeline_mut(&mut project), &durations, &cuts);
    let (_, edl) = model(&project, &durations);
    let gap = edl.source_to_output(5.0).unwrap() - edl.source_to_output(1.4).unwrap();
    assert!((gap - 0.5).abs() < 1e-6, "{gap}");
    assert!(plan_pause_cuts(&doc, &edl, None, 1.0, 0.5).is_empty());
}

#[test]
fn a_pause_that_crosses_a_transition_is_left_alone() {
    let words = [("before", 1.0, 1.4), ("after", 5.0, 5.4)];
    let durations = [6.0];
    let mut project = project(&words, &durations);
    let timeline = timeline_mut(&mut project);
    assert!(editor_edits::split_clip_segment(timeline, 3.0, None));
    timeline.transitions.push(ClipTransition {
        segment_index: 1,
        kind: ClipTransitionType::CrossFade,
        duration: 0.5,
    });
    let (doc, edl) = model(&project, &durations);
    assert!(plan_pause_cuts(&doc, &edl, None, 1.0, 0.5).is_empty());
}

#[test]
fn a_pause_left_by_an_earlier_cut_joins_into_one() {
    let words = [("before", 1.0, 1.4), ("um", 2.2, 2.5), ("after", 3.3, 3.7)];
    let durations = [5.0];
    let mut project = project(&words, &durations);
    let (doc, edl) = model(&project, &durations);
    assert!(plan_pause_cuts(&doc, &edl, None, 1.0, 0.5).is_empty());
    apply_source_cuts(timeline_mut(&mut project), &durations, &[2.15..2.55]);
    let (doc, edl) = model(&project, &durations);
    assert_eq!(edl.kept, [true, false, true]);
    let pauses = plan_pause_cuts(&doc, &edl, None, 1.0, 0.5);
    assert_eq!(pauses.len(), 1);
    assert_eq!((pauses[0].after_word, pauses[0].next_word), (0, 2));
    assert!(close(pauses[0].length, 1.9 - 0.4), "{}", pauses[0].length);
    let cuts: Vec<_> = pauses.iter().flat_map(|pause| pause.cuts.clone()).collect();
    assert_eq!(cuts.len(), 2);
    apply_source_cuts(timeline_mut(&mut project), &durations, &cuts);
    let (_, edl) = model(&project, &durations);
    let gap = edl.source_to_output(3.3).unwrap() - edl.source_to_output(1.4).unwrap();
    assert!((gap - 0.5).abs() < 1e-6, "{gap}");
}

#[test]
fn pauses_are_measured_and_kept_in_playback_time() {
    let words = [("before", 1.0, 1.4), ("after", 5.0, 5.4)];
    let durations = [6.0];
    let mut project = project(&words, &durations);
    timeline_mut(&mut project).segments[0].timescale = 2.0;
    let (doc, edl) = model(&project, &durations);
    assert!(plan_pause_cuts(&doc, &edl, None, 2.0, 0.5).is_empty());
    let pauses = plan_pause_cuts(&doc, &edl, None, 1.5, 0.5);
    assert_eq!(pauses.len(), 1);
    assert!(close(pauses[0].length, 1.8));
    let cuts: Vec<_> = pauses.iter().flat_map(|pause| pause.cuts.clone()).collect();
    apply_source_cuts(timeline_mut(&mut project), &durations, &cuts);
    let (_, edl) = model(&project, &durations);
    let gap = edl.source_to_output(5.0).unwrap() - edl.source_to_output(1.4).unwrap();
    assert!((gap - 0.5).abs() < 1e-6, "{gap}");
}

#[cfg(target_os = "linux")]
mod keyboard {
    use gpui::{
        AppContext, Context, Entity, InteractiveElement, IntoElement, Render, Styled, Window, div,
    };

    use crate::editor_window::EditorWindow;
    use crate::transcript::WordSelection;

    struct KeyView {
        editor: Entity<EditorWindow>,
        _project: tempfile::TempDir,
    }

    impl Render for KeyView {
        fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
            self.editor.update(cx, |editor, cx| {
                div()
                    .size_full()
                    .track_focus(&editor.transcript.focus)
                    .on_key_down(cx.listener(EditorWindow::transcript_key_down))
            })
        }
    }

    fn fixture(
        cx: &mut gpui::TestAppContext,
    ) -> (Entity<EditorWindow>, &mut gpui::VisualTestContext) {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().to_path_buf();
        let (view, cx) = cx.add_window_view(move |window, cx| {
            let editor = cx.new(|cx| EditorWindow::new(path, window, cx));
            editor.update(cx, |editor, cx| {
                let words = super::spoken(&["One", "two.", "Three", "four", "five"]);
                editor.project = super::project(&super::borrowed(&words), &[5.0]);
                editor.clip_display_durations = vec![5.0];
                editor.transcript.open = true;
                editor.transcript.dirty = true;
                editor.transcript_refresh();
                window.focus(&editor.transcript.focus, cx);
            });
            KeyView {
                editor,
                _project: directory,
            }
        });
        (view.read_with(cx, |view, _| view.editor.clone()), cx)
    }

    fn selection(
        editor: &Entity<EditorWindow>,
        cx: &mut gpui::VisualTestContext,
    ) -> Option<WordSelection> {
        editor.read_with(cx, |editor, _| editor.transcript.selection)
    }

    #[gpui::test]
    fn arrows_extend_and_collapse_the_word_selection(cx: &mut gpui::TestAppContext) {
        let (editor, cx) = fixture(cx);
        cx.simulate_keystrokes("right");
        assert_eq!(selection(&editor, cx), Some(WordSelection::single(0)));
        cx.simulate_keystrokes("right right");
        assert_eq!(selection(&editor, cx), Some(WordSelection::single(2)));
        cx.simulate_keystrokes("shift-right shift-right");
        assert_eq!(
            selection(&editor, cx),
            Some(WordSelection {
                anchor: 2,
                focus: 4
            })
        );
        cx.simulate_keystrokes("shift-left shift-left shift-left");
        assert_eq!(
            selection(&editor, cx),
            Some(WordSelection {
                anchor: 2,
                focus: 1
            })
        );
        cx.simulate_keystrokes("escape");
        assert_eq!(selection(&editor, cx), None);
        cx.simulate_keystrokes("ctrl-a");
        assert_eq!(selection(&editor, cx).map(WordSelection::range), Some(0..5));
        cx.simulate_keystrokes("home");
        assert_eq!(selection(&editor, cx), Some(WordSelection::single(0)));
        cx.simulate_keystrokes("end");
        assert_eq!(selection(&editor, cx), Some(WordSelection::single(4)));
    }

    #[gpui::test]
    fn copy_puts_the_selected_words_on_the_clipboard(cx: &mut gpui::TestAppContext) {
        let (editor, cx) = fixture(cx);
        editor.update(cx, |editor, _| {
            editor.transcript.selection = Some(WordSelection {
                anchor: 1,
                focus: 3,
            });
        });
        cx.simulate_keystrokes("ctrl-c");
        let copied = cx.read_from_clipboard().and_then(|item| item.text());
        assert_eq!(copied.as_deref(), Some("two. Three four"));
    }

    #[gpui::test]
    fn a_loudness_envelope_loaded_with_old_audio_offsets_is_dropped(cx: &mut gpui::TestAppContext) {
        let (editor, cx) = fixture(cx);
        editor.update(cx, |editor, cx| {
            editor.transcript.energy_loading = true;
            editor.transcript.dirty = false;
            let envelope = super::EnergyEnvelope::new(vec![vec![0.01; 200]], &[1.0]);
            let installed = editor.transcript_energy_loaded(
                vec![(0.0, 0.0)],
                Some(vec![(0.25, 0.0)]),
                envelope,
                cx,
            );
            assert!(!installed);
            assert!(editor.transcript.energy.is_none());
            assert!(editor.transcript.dirty);
            assert!(!editor.transcript.energy_loading);

            let envelope = super::EnergyEnvelope::new(vec![vec![0.01; 200]], &[1.0]);
            let installed = editor.transcript_energy_loaded(
                vec![(0.25, 0.0)],
                Some(vec![(0.25, 0.0)]),
                envelope,
                cx,
            );
            assert!(installed);
            assert!(editor.transcript.energy.is_some());
        });
    }
}

#[test]
fn a_restore_that_fails_part_way_changes_nothing() {
    let words = spoken(&["a", "b", "c", "d", "e", "f", "g", "h"]);
    let durations = [5.0];
    let mut project = project(&borrowed(&words), &durations);
    cut_words(&mut project, &durations, &[(3, 4)]);
    let timeline = timeline_mut(&mut project);
    assert!(editor_edits::split_clip_segment(timeline, 2.55, None));
    assert!(editor_edits::split_clip_segment(timeline, 2.85, None));
    assert!(editor_edits::delete_clip_segments(timeline, &[2]));
    timeline.transitions.push(ClipTransition {
        segment_index: 2,
        kind: ClipTransitionType::CrossFade,
        duration: 0.06,
    });
    assert!(timeline.effective_transition(2).is_some());
    let before = bounds(&project);
    assert_eq!(kept(&project, &durations)[3..5], [false, false]);
    let doc = TranscriptDoc::build(project.captions.as_ref().unwrap());
    let result = restore_words(timeline_mut(&mut project), &durations, &[], &doc, 3..5);
    assert_eq!(result, Err(RestoreBlocker::Transition));
    assert_eq!(bounds(&project), before);
}

#[test]
fn partly_trimmed_words_map_to_their_surviving_part() {
    let words = [
        ("first", 0.5, 1.0),
        ("middle", 1.2, 1.7),
        ("last", 1.9, 2.4),
    ];
    let durations = [3.0];
    let mut project = project(&words, &durations);
    let segment = &mut timeline_mut(&mut project).segments[0];
    segment.start = 0.65;
    segment.end = 2.2;
    let (doc, edl) = model(&project, &durations);
    assert!(edl.is_kept(0) && edl.is_kept(2));
    assert_eq!(edl.source_to_output(doc.words[0].start), None);
    assert_eq!(edl.source_to_output(doc.words[2].end), None);

    let start = edl.output_start_of(&doc.voiced[0]).unwrap();
    assert!(close(start, 0.0), "{start}");
    let end = edl.output_end_of(&doc.voiced[2]).unwrap();
    assert!(close(end, 2.2 - 0.65), "{end}");
    let middle = edl.output_start_of(&doc.voiced[1]).unwrap();
    assert!(close(middle, 1.2 - 0.65), "{middle}");
}

#[test]
fn a_restored_take_comes_back_with_its_own_settings() {
    let durations = [2.0, 2.0, 2.0];
    let words = [
        ("first", 0.5, 0.9),
        ("middle", 2.5, 2.9),
        ("last", 4.5, 4.9),
    ];
    let mut project = project(&words, &durations);
    let middle = &mut timeline_mut(&mut project).segments[1];
    middle.timescale = 2.0;
    middle.volume = Some(0.5);
    middle.speed_audio_mode = Some(cap_project::ClipSpeedAudioMode::MaintainPitch);
    middle.hide_cursor = Some(true);
    middle.name = Some("Second take".into());
    let original = middle.clone();
    let mut history = editor_edits::ProjectHistory::new(project.clone());

    let report = apply_source_cuts(timeline_mut(&mut project), &durations, &[2.0..4.0]);
    assert_eq!(report.applied, 1);
    assert_eq!(timeline(&project).segments.len(), 2);
    history.record(&project);
    assert_eq!(kept(&project, &durations), [true, false, true]);

    let settings = |segment: &cap_project::TimelineSegment| {
        (
            segment.recording_clip,
            segment.timescale,
            segment.start,
            segment.end,
            segment.name.clone(),
            segment.speed_audio_mode,
            segment.volume,
            segment.hide_cursor,
        )
    };
    let removed = history.removed_takes(timeline(&project));
    assert_eq!(removed.len(), 1);
    assert_eq!(settings(&removed[0]), settings(&original));
    let doc = TranscriptDoc::build(project.captions.as_ref().unwrap());
    restore_words(timeline_mut(&mut project), &durations, &removed, &doc, 1..2).unwrap();
    assert_eq!(kept(&project, &durations), [true, true, true]);
    let segments = &timeline(&project).segments;
    assert_eq!(segments.len(), 3);
    assert_eq!(settings(&segments[1]), settings(&original));
    assert!(segments[0].timescale == 1.0 && segments[2].timescale == 1.0);
    assert!(segments[0].volume.is_none() && segments[2].hide_cursor.is_none());
    assert!(close(
        editor_edits::clip_timeline_duration(timeline(&project)),
        2.0 + 1.0 + 2.0
    ));
}

struct Speech {
    envelope: EnergyEnvelope,
    voiced: Vec<(f64, f64)>,
    duration: f64,
}

fn synthetic_speech(voiced: &[(f64, f64)], duration: f64) -> Speech {
    synthetic_speech_in(voiced, duration, |_| 0.002)
}

fn synthetic_speech_in(
    voiced: &[(f64, f64)],
    duration: f64,
    room_level: impl Fn(f64) -> f64,
) -> Speech {
    let rate = 48_000.0;
    let mut state: u32 = 0x9e37_79b9;
    let mut noise = move || {
        state ^= state << 13;
        state ^= state >> 17;
        state ^= state << 5;
        (state as f64 / u32::MAX as f64) * 2.0 - 1.0
    };
    let samples: Vec<f32> = (0..(duration * rate) as usize)
        .map(|index| {
            let time = index as f64 / rate;
            let room = noise() * room_level(time);
            let Some(&(start, end)) = voiced
                .iter()
                .find(|(start, end)| (*start..*end).contains(&time))
            else {
                return room as f32;
            };
            let local = time - start;
            let closure = end - start > 0.3
                && ((end - start) / 2.0..(end - start) / 2.0 + 0.06).contains(&local);
            let voice = if local < 0.05 {
                noise() * 0.015
            } else if closure {
                0.0
            } else {
                let syllable = 0.6 + 0.4 * (std::f64::consts::TAU * 4.0 * local).sin();
                (1..=4)
                    .map(|harmonic| {
                        (std::f64::consts::TAU * 140.0 * harmonic as f64 * time).sin()
                            / harmonic as f64
                    })
                    .sum::<f64>()
                    * 0.05
                    * syllable
            };
            (room + voice) as f32
        })
        .collect();
    let clip = clip_envelope(
        &[EnvelopeTrack {
            slices: vec![samples.as_slice()],
            channels: 1,
            offset_seconds: 0.0,
        }],
        duration,
    );
    Speech {
        envelope: EnergyEnvelope::new(vec![clip], &[duration]),
        voiced: voiced.to_vec(),
        duration,
    }
}

impl Speech {
    fn overlaps_voice(&self, range: &Range<f64>) -> bool {
        self.voiced
            .iter()
            .any(|(start, end)| range.start < *end && *start < range.end)
    }

    fn all_quiet(&self, range: &Range<f64>) -> bool {
        let threshold = self.envelope.silence_threshold_db(range.start).unwrap();
        let mut time = range.start;
        while time <= range.end {
            if self.envelope.smoothed_db(time).unwrap() >= threshold {
                return false;
            }
            time += HOP_SECONDS;
        }
        true
    }
}

const RICHIE_VOICED: [(f64, f64); 8] = [
    (0.50, 0.80),
    (0.86, 1.25),
    (1.30, 1.75),
    (2.95, 3.40),
    (4.70, 5.10),
    (5.16, 5.50),
    (7.70, 8.10),
    (8.16, 8.70),
];

const RICHIE_WORDS: [(&str, f64, f64); 8] = [
    ("Just", 0.50, 0.86),
    ("doing", 0.86, 1.30),
    ("works.", 1.30, 2.95),
    ("Um", 2.95, 4.60),
    ("Yeah,", 4.60, 5.16),
    ("should", 5.16, 7.30),
    ("make", 7.30, 8.16),
    ("faster.", 8.16, 9.90),
];

fn stretched_fixture() -> (Speech, ProjectConfiguration, TranscriptDoc) {
    let speech = synthetic_speech(&RICHIE_VOICED, 10.0);
    let project = project(&RICHIE_WORDS, &[speech.duration]);
    let mut doc = TranscriptDoc::build(project.captions.as_ref().unwrap());
    doc.refine_voiced(Some(&speech.envelope));
    (speech, project, doc)
}

#[test]
fn silences_are_found_from_the_audio_in_room_noise() {
    let voiced = [
        (0.5, 1.0),
        (1.1, 1.6),
        (1.75, 2.2),
        (2.6, 3.1),
        (4.3, 4.8),
        (6.8, 7.3),
    ];
    let speech = synthetic_speech(&voiced, 8.0);
    let found = speech.envelope.silences();
    let threshold = speech.envelope.silence_threshold_db(1.0).unwrap();
    assert!((-50.0..-40.0).contains(&threshold), "{threshold}");
    for silence in found {
        assert!(!speech.overlaps_voice(silence), "{silence:?}");
    }
    let between: Vec<_> = found
        .iter()
        .filter(|silence| silence.start > 0.5 && silence.end <= 6.8 + 1e-6)
        .collect();
    assert_eq!(between.len(), 3, "{found:?}");
    for (silence, (start, end)) in between.iter().zip([(2.2, 2.6), (3.1, 4.3), (4.8, 6.8)]) {
        assert!(
            silence.start - start < 0.03 && end - silence.end < 0.03,
            "{silence:?}"
        );
    }
}

#[test]
fn stretched_words_are_trimmed_to_their_voiced_part() {
    let (_, _, doc) = stretched_fixture();
    let near = |a: f64, b: f64| (a - b).abs() < 0.03;
    for (index, word) in doc.words.iter().enumerate() {
        let span = &doc.voiced[index];
        let (start, end) = match index {
            2 => (word.start, 1.75),
            3 => (word.start, 3.40),
            5 => (word.start, 5.50),
            6 => (7.70, word.end),
            7 => (word.start, 8.70),
            _ => (word.start, word.end),
        };
        assert!(
            near(span.start, start) && near(span.end, end),
            "{index} {span:?}"
        );
        if !matches!(index, 2 | 3 | 5 | 6 | 7) {
            assert_eq!(*span, word.start..word.end);
        }
    }
}

#[test]
fn accurate_word_times_are_left_as_they_are() {
    let speech = synthetic_speech(&RICHIE_VOICED, 10.0);
    let words: Vec<_> = [
        "Just", "doing", "works.", "Um", "Yeah,", "should", "make", "faster.",
    ]
    .iter()
    .zip(RICHIE_VOICED)
    .map(|(text, (start, end))| (*text, start, end))
    .collect();
    let project = project(&words, &[speech.duration]);
    let mut doc = TranscriptDoc::build(project.captions.as_ref().unwrap());
    let plain = doc.voiced.clone();
    doc.refine_voiced(Some(&speech.envelope));
    assert_eq!(doc.voiced, plain);
}

#[test]
fn stretched_words_get_their_pauses_from_the_audio() {
    let (speech, mut project, doc) = stretched_fixture();
    let durations = [speech.duration];
    let plain = TranscriptDoc::build(project.captions.as_ref().unwrap());
    let edl = TranscriptEdl::build(&plain, timeline(&project), &durations);
    assert!(plan_pause_cuts(&plain, &edl, Some(&speech.envelope), 1.0, 0.5).is_empty());

    let edl = TranscriptEdl::build(&doc, timeline(&project), &durations);
    let pauses = plan_pause_cuts(&doc, &edl, Some(&speech.envelope), 1.0, 0.5);
    let found: Vec<_> = pauses
        .iter()
        .map(|pause| (pause.after_word, pause.next_word))
        .collect();
    assert_eq!(found, [(2, 3), (3, 4), (5, 6)]);
    for (pause, length) in pauses.iter().zip([1.2, 1.2, 2.2]) {
        assert!((pause.length - length).abs() < 0.05, "{pause:?}");
        for cut in &pause.cuts {
            assert!(!speech.overlaps_voice(cut), "{cut:?}");
            assert!(speech.all_quiet(cut), "{cut:?}");
        }
    }
    let cuts: Vec<_> = pauses.iter().flat_map(|pause| pause.cuts.clone()).collect();
    apply_source_cuts(timeline_mut(&mut project), &durations, &cuts);
    let edl = TranscriptEdl::build(&doc, timeline(&project), &durations);
    assert!(edl.kept.iter().all(|kept| *kept));
    for (before, after) in [(2, 3), (3, 4), (5, 6)] {
        let gap = edl.output_start_of(&doc.voiced[after]).unwrap()
            - edl.output_end_of(&doc.voiced[before]).unwrap();
        assert!((gap - 0.5).abs() < 0.01, "{before} {gap}");
    }
    assert!(plan_pause_cuts(&doc, &edl, Some(&speech.envelope), 1.0, 0.5).is_empty());
}

#[test]
fn deleting_a_stretched_word_keeps_the_silence_beside_it() {
    let (speech, mut project, doc) = stretched_fixture();
    let durations = [speech.duration];
    let cuts = plan_word_cuts(&doc, Some(&speech.envelope), None, &[3..4]);
    assert_eq!(cuts.len(), 1);
    let cut = &cuts[0];
    assert!(
        cut.start <= 2.95 - ONSET_GUARD && cut.end >= 3.40 + TAIL_GUARD,
        "{cut:?}"
    );
    let silence_removed = (2.95 - cut.start) + (cut.end - 3.40);
    assert!(silence_removed <= LONG_GAP + 1e-9, "{cut:?}");
    for (start, end) in RICHIE_VOICED.iter().filter(|(start, _)| *start != 2.95) {
        assert!(!(cut.start < *end && *start < cut.end), "{cut:?}");
    }

    apply_source_cuts(timeline_mut(&mut project), &durations, &cuts);
    let edl = TranscriptEdl::build(&doc, timeline(&project), &durations);
    assert_eq!(edl.kept, [true, true, true, false, true, true, true, true]);
    let pauses = plan_pause_cuts(&doc, &edl, Some(&speech.envelope), 1.0, 0.5);
    assert_eq!(
        (pauses[0].after_word, pauses[0].next_word),
        (2, 4),
        "{pauses:?}"
    );
    assert!(pauses[0].length > 1.5, "{:?}", pauses[0]);
}

#[test]
fn deleting_neighbours_one_at_a_time_matches_deleting_them_together() {
    let (speech, _, doc) = stretched_fixture();
    let together = plan_word_cuts(&doc, Some(&speech.envelope), None, &[2..4]);
    let first = plan_word_cuts(&doc, Some(&speech.envelope), None, &[2..3]);
    let mut kept = vec![true; doc.words.len()];
    kept[2] = false;
    let second = plan_word_cuts(&doc, Some(&speech.envelope), Some(&kept), &[3..4]);
    assert!(close(first[0].start, together[0].start));
    assert!(close(second[0].end, together[0].end));
    assert!(
        second[0].start <= first[0].end + 1e-9,
        "{first:?} {second:?}"
    );
}

#[test]
fn short_gaps_cut_at_the_same_point_from_either_side() {
    let (speech, _, doc) = stretched_fixture();
    for index in [1, 2, 5, 7] {
        let after = gap_cut(&doc, Some(&speech.envelope), index, Removing::After);
        let before = gap_cut(&doc, Some(&speech.envelope), index, Removing::Before);
        let gap = doc.voiced[index].start - doc.voiced[index - 1].end;
        if gap <= LONG_GAP {
            assert!(close(after, before), "{index}");
        }
    }
}

#[test]
fn silence_detection_on_two_hours_is_fast() {
    let hops = (7200.0 / HOP_SECONDS) as usize;
    let clip: Vec<f32> = (0..hops)
        .map(|hop| {
            let phase = hop % 400;
            if phase < 300 {
                0.003 * (1.0 + (hop % 7) as f32)
            } else {
                0.000_002 * (1.0 + (hop % 3) as f32)
            }
        })
        .collect();
    let started = std::time::Instant::now();
    let envelope = EnergyEnvelope::new(vec![clip], &[7200.0]);
    let elapsed = started.elapsed();
    assert_eq!(envelope.silences().len(), hops / 400);
    let limit = std::time::Duration::from_millis(if cfg!(debug_assertions) { 3000 } else { 200 });
    println!("2 h silence detection {elapsed:?}");
    assert!(elapsed < limit, "{elapsed:?}");
}

#[test]
fn a_word_whose_audio_sits_in_its_neighbour_is_treated_as_silence() {
    let speech = synthetic_speech(&[(0.2, 0.9), (2.2, 2.9)], 3.5);
    let words = [
        ("as", 0.2, 0.85),
        ("fast.", 0.85, 1.9),
        ("Hopefully", 1.9, 2.9),
    ];
    let durations = [speech.duration];
    let mut project = project(&words, &durations);
    let mut doc = TranscriptDoc::build(project.captions.as_ref().unwrap());
    doc.refine_voiced(Some(&speech.envelope));
    assert!(doc.voiced[1].is_empty(), "{:?}", doc.voiced[1]);
    assert!(
        (doc.voiced[1].start - 0.9).abs() < 0.03,
        "{:?}",
        doc.voiced[1]
    );
    assert!(
        (doc.voiced[2].start - 2.2).abs() < 0.03,
        "{:?}",
        doc.voiced[2]
    );

    let edl = TranscriptEdl::build(&doc, timeline(&project), &durations);
    let pauses = plan_pause_cuts(&doc, &edl, Some(&speech.envelope), 1.0, 0.5);
    assert_eq!(pauses.len(), 1, "{pauses:?}");
    assert_eq!((pauses[0].after_word, pauses[0].next_word), (0, 2));
    for cut in &pauses[0].cuts {
        assert!(!speech.overlaps_voice(cut), "{cut:?}");
        assert!(speech.all_quiet(cut), "{cut:?}");
    }
    let cuts: Vec<_> = pauses.iter().flat_map(|pause| pause.cuts.clone()).collect();
    apply_source_cuts(timeline_mut(&mut project), &durations, &cuts);
    let edl = TranscriptEdl::build(&doc, timeline(&project), &durations);
    assert_eq!(edl.kept, [true, true, true]);
}

fn shape(start: f64, end: f64) -> cap_project::ShapeSegment {
    cap_project::ShapeSegment {
        start,
        end,
        ..Default::default()
    }
}

fn shape_bounds(project: &ProjectConfiguration) -> Vec<(f64, f64)> {
    timeline(project)
        .shape_segments
        .iter()
        .map(|segment| (segment.start, segment.end))
        .collect()
}

#[test]
fn shapes_follow_shortened_pauses_and_come_back_on_undo() {
    let (speech, mut project, doc) = stretched_fixture();
    let durations = [speech.duration];
    timeline_mut(&mut project).shape_segments =
        vec![shape(0.6, 0.9), shape(5.2, 7.9), shape(8.2, 8.6)];
    let original = shape_bounds(&project);
    let mut history = editor_edits::ProjectHistory::new(project.clone());
    let before = editor_edits::clip_timeline_duration(timeline(&project));

    let edl = TranscriptEdl::build(&doc, timeline(&project), &durations);
    let pauses = plan_pause_cuts(&doc, &edl, Some(&speech.envelope), 1.0, 0.5);
    assert_eq!(pauses.len(), 3);
    let inside_spanning: f64 = pauses
        .iter()
        .filter(|pause| pause.after_word == 5)
        .map(|pause| pause.saves)
        .sum();
    let cuts: Vec<_> = pauses.iter().flat_map(|pause| pause.cuts.clone()).collect();
    apply_source_cuts(timeline_mut(&mut project), &durations, &cuts);
    history.record(&project);
    let removed = before - editor_edits::clip_timeline_duration(timeline(&project));
    let saved: f64 = pauses.iter().map(|pause| pause.saves).sum();
    assert!((removed - saved).abs() < 1e-6, "{removed} {saved}");

    let shapes = shape_bounds(&project);
    assert_eq!(shapes[0], original[0]);
    let before_spanning = saved - inside_spanning;
    assert!(
        close(shapes[1].0, original[1].0 - before_spanning),
        "{shapes:?}"
    );
    assert!(close(shapes[1].1, original[1].1 - saved), "{shapes:?}");
    assert!(close(shapes[2].0, original[2].0 - removed), "{shapes:?}");
    assert!(close(shapes[2].1, original[2].1 - removed), "{shapes:?}");

    let undone = history.undo().unwrap().clone();
    assert_eq!(shape_bounds(&undone), original);
}

#[test]
fn shapes_follow_a_deleted_stretched_word_and_come_back_on_restore() {
    let (speech, mut project, doc) = stretched_fixture();
    let durations = [speech.duration];
    timeline_mut(&mut project).shape_segments = vec![shape(1.0, 1.2), shape(5.0, 5.4)];
    let original = shape_bounds(&project);
    let before = editor_edits::clip_timeline_duration(timeline(&project));

    let cuts = plan_word_cuts(&doc, Some(&speech.envelope), None, &[3..4]);
    apply_source_cuts(timeline_mut(&mut project), &durations, &cuts);
    let removed = before - editor_edits::clip_timeline_duration(timeline(&project));
    assert!(close(removed, cuts[0].end - cuts[0].start));
    let shapes = shape_bounds(&project);
    assert_eq!(shapes[0], original[0]);
    assert!(close(shapes[1].0, original[1].0 - removed), "{shapes:?}");
    assert!(close(shapes[1].1, original[1].1 - removed), "{shapes:?}");

    let restored = restore_words(timeline_mut(&mut project), &durations, &[], &doc, 3..4).unwrap();
    assert_eq!(restored, 1);
    let shapes = shape_bounds(&project);
    for (shape, original) in shapes.iter().zip(&original) {
        assert!(
            close(shape.0, original.0) && close(shape.1, original.1),
            "{shapes:?}"
        );
    }
}

#[test]
fn a_noise_gated_recording_finds_its_digital_silence_and_keeps_every_word() {
    let speech = synthetic_speech_in(&RICHIE_VOICED, 10.0, |_| 0.0);
    let threshold = speech.envelope.silence_threshold_db(1.0).unwrap();
    assert!(threshold < -80.0, "{threshold}");
    for silence in speech.envelope.silences() {
        assert!(!speech.overlaps_voice(silence), "{silence:?}");
    }
    let words: Vec<_> = [
        "Just", "doing", "works.", "Um", "Yeah,", "should", "make", "faster.",
    ]
    .iter()
    .zip(RICHIE_VOICED)
    .map(|(text, (start, end))| (*text, start, end))
    .collect();
    let accurate = project(&words, &[speech.duration]);
    let mut doc = TranscriptDoc::build(accurate.captions.as_ref().unwrap());
    let plain = doc.voiced.clone();
    doc.refine_voiced(Some(&speech.envelope));
    assert_eq!(doc.voiced, plain);

    let stretched = project(&RICHIE_WORDS, &[speech.duration]);
    let mut doc = TranscriptDoc::build(stretched.captions.as_ref().unwrap());
    doc.refine_voiced(Some(&speech.envelope));
    assert!(doc.voiced.iter().all(|span| !span.is_empty()));
    let edl = TranscriptEdl::build(&doc, timeline(&stretched), &[speech.duration]);
    let pauses = plan_pause_cuts(&doc, &edl, Some(&speech.envelope), 1.0, 0.5);
    assert_eq!(pauses.len(), 3, "{pauses:?}");
    for cut in pauses.iter().flat_map(|pause| &pause.cuts) {
        assert!(!speech.overlaps_voice(cut), "{cut:?}");
    }
}

#[test]
fn a_recording_with_no_quiet_moment_reports_no_silence() {
    let speech = synthetic_speech_in(&[(0.0, 6.0)], 6.0, |_| 0.0);
    assert!(
        speech.envelope.silences().is_empty(),
        "{:?}",
        speech.envelope.silences()
    );
    let quiet: Vec<f32> = (0..1200)
        .map(|hop| 0.001 * (1.0 + 0.3 * ((hop % 9) as f32 / 9.0)))
        .collect();
    let envelope = EnergyEnvelope::new(vec![quiet], &[6.0]);
    assert!(envelope.silences().is_empty());
    assert!(envelope.silence_threshold_db(1.0).unwrap() <= -90.0);
}

#[test]
fn restoring_a_trimmed_word_leaves_a_shortened_pause_cut() {
    let speech = synthetic_speech(&[(0.5, 0.9), (3.5, 4.0), (4.1, 4.5)], 5.0);
    let words = [("a", 0.5, 0.9), ("long", 1.0, 4.0), ("b", 4.0, 4.5)];
    let durations = [speech.duration];
    let mut project = project(&words, &durations);
    let mut doc = TranscriptDoc::build(project.captions.as_ref().unwrap());
    doc.refine_voiced(Some(&speech.envelope));
    assert!(
        (doc.voiced[1].start - 3.5).abs() < 0.03,
        "{:?}",
        doc.voiced[1]
    );

    let edl = TranscriptEdl::build(&doc, timeline(&project), &durations);
    let pauses = plan_pause_cuts(&doc, &edl, Some(&speech.envelope), 1.0, 0.5);
    assert_eq!(pauses.len(), 1, "{pauses:?}");
    apply_source_cuts(timeline_mut(&mut project), &durations, &pauses[0].cuts);
    let shortened = bounds(&project);

    let edl = TranscriptEdl::build(&doc, timeline(&project), &durations);
    let cuts = plan_word_cuts(&doc, Some(&speech.envelope), Some(&edl.kept), &[1..2]);
    apply_source_cuts(timeline_mut(&mut project), &durations, &cuts);
    let edl = TranscriptEdl::build(&doc, timeline(&project), &durations);
    assert_eq!(edl.kept, [true, false, true]);

    let restored = restore_words(timeline_mut(&mut project), &durations, &[], &doc, 1..2).unwrap();
    assert_eq!(restored, 1);
    let edl = TranscriptEdl::build(&doc, timeline(&project), &durations);
    assert_eq!(edl.kept, [true, true, true]);
    let after = bounds(&project);
    assert_eq!(after.len(), shortened.len(), "{after:?} {shortened:?}");
    for (a, b) in after.iter().zip(&shortened) {
        assert!(
            close(a.0, b.0) && close(a.1, b.1),
            "{after:?} {shortened:?}"
        );
    }
}

#[test]
fn a_few_words_in_a_long_quiet_recording_still_find_their_pause() {
    let voiced = [(1.0, 1.4), (1.5, 1.9), (30.0, 30.4), (30.5, 30.9)];
    let speech = synthetic_speech(&voiced, 40.0);
    let threshold = speech.envelope.silence_threshold_db(1.0).unwrap();
    assert!((-55.0..-35.0).contains(&threshold), "{threshold}");
    let words = [
        ("one", 1.0, 1.45),
        ("two", 1.45, 29.0),
        ("three", 29.0, 30.45),
        ("four", 30.45, 30.9),
    ];
    let durations = [speech.duration];
    let project = project(&words, &durations);
    let mut doc = TranscriptDoc::build(project.captions.as_ref().unwrap());
    doc.refine_voiced(Some(&speech.envelope));
    assert!(
        (doc.voiced[1].end - 1.9).abs() < 0.03,
        "{:?}",
        doc.voiced[1]
    );
    assert!(
        (doc.voiced[2].start - 30.0).abs() < 0.03,
        "{:?}",
        doc.voiced[2]
    );
    let edl = TranscriptEdl::build(&doc, timeline(&project), &durations);
    let pauses = plan_pause_cuts(&doc, &edl, Some(&speech.envelope), 1.0, 0.5);
    assert_eq!(pauses.len(), 1, "{pauses:?}");
    assert_eq!((pauses[0].after_word, pauses[0].next_word), (1, 2));
    for cut in &pauses[0].cuts {
        assert!(!speech.overlaps_voice(cut), "{cut:?}");
        assert!(speech.all_quiet(cut), "{cut:?}");
    }
}

#[test]
fn a_background_that_changes_level_still_counts_as_quiet() {
    let voiced = [
        (3.0, 3.5),
        (3.6, 4.1),
        (6.0, 6.5),
        (6.6, 7.1),
        (10.0, 10.5),
        (10.6, 11.1),
        (14.0, 14.5),
        (14.6, 15.1),
    ];
    let speech = synthetic_speech_in(
        &voiced,
        20.0,
        |time| if time < 2.0 { 0.0008 } else { 0.0035 },
    );
    let threshold = speech.envelope.silence_threshold_db(1.0).unwrap();
    assert!((-55.0..-35.0).contains(&threshold), "{threshold}");
    let found = speech.envelope.silences();
    for silence in found {
        assert!(!speech.overlaps_voice(silence), "{silence:?}");
    }
    for (start, end) in [(4.1, 6.0), (7.1, 10.0), (11.1, 14.0)] {
        assert!(
            found
                .iter()
                .any(|silence| silence.start - start < 0.03 && end - silence.end < 0.03),
            "{start} {found:?}"
        );
    }
}

#[test]
fn a_brief_loud_sound_does_not_turn_a_quiet_word_into_silence() {
    let level = |db: f64| 10f64.powf(db / 10.0) as f32;
    let hops = (60.0 / HOP_SECONDS) as usize;
    let at = |seconds: f64| (seconds / HOP_SECONDS) as usize;
    let mut clip: Vec<f32> = (0..hops)
        .map(|hop| level(-60.0 + (hop % 5) as f64 * 0.4))
        .collect();
    let mut fill = |from: f64, until: f64, db: f64| {
        for (offset, hop) in clip[at(from)..at(until)].iter_mut().enumerate() {
            *hop = level(db + (offset % 5) as f64 * 0.25 - 0.5);
        }
    };
    for second in 0..18 {
        let start = 2.0 + second as f64 * 3.0;
        fill(start, start + 1.0, -40.0);
    }
    fill(10.2, 10.7, -48.0);
    fill(30.2, 30.7, -20.0);
    let envelope = EnergyEnvelope::new(vec![clip], &[60.0]);
    let threshold = envelope.silence_threshold_db(1.0).unwrap();
    assert!(threshold < -48.5, "{threshold}");
    assert!(
        envelope.silences_overlapping(10.21..10.69).is_empty(),
        "{:?}",
        envelope.silences_overlapping(10.21..10.69)
    );
    let between = envelope.silences_overlapping(3.0..5.0);
    assert!(
        between
            .iter()
            .any(|silence| silence.start < 3.05 && silence.end > 4.95),
        "{between:?}"
    );
}

#[test]
fn a_silence_across_a_recording_boundary_is_one_pause() {
    let level = |db: f64| 10f64.powf(db / 10.0) as f32;
    let take = |voiced: Range<f64>| -> Vec<f32> {
        (0..(5.0 / HOP_SECONDS) as usize)
            .map(|hop| {
                let time = hop as f64 * HOP_SECONDS;
                let db = if voiced.contains(&time) { -20.0 } else { -60.0 };
                level(db + (hop % 5) as f64 * 0.4)
            })
            .collect()
    };
    let durations = [5.0, 5.0];
    let envelope = EnergyEnvelope::new(vec![take(1.0..3.8), take(0.9..2.0)], &durations);
    let words = [
        ("before", 1.0, 3.0),
        ("pausing", 3.0, 5.4),
        ("again", 5.4, 7.0),
    ];
    let project = project(&words, &durations);
    let mut doc = TranscriptDoc::build(project.captions.as_ref().unwrap());
    doc.refine_voiced(Some(&envelope));
    assert!(
        (doc.voiced[1].end - 3.8).abs() < 0.03,
        "{:?}",
        doc.voiced[1]
    );
    assert!(
        (doc.voiced[2].start - 5.9).abs() < 0.03,
        "{:?}",
        doc.voiced[2]
    );

    let edl = TranscriptEdl::build(&doc, timeline(&project), &durations);
    let pauses = plan_pause_cuts(&doc, &edl, Some(&envelope), 1.0, 0.5);
    assert_eq!(pauses.len(), 1, "{pauses:?}");
    assert!(
        (pauses[0].length - 2.1).abs() < 0.05,
        "{}",
        pauses[0].length
    );
    for cut in &pauses[0].cuts {
        assert!(cut.start > 3.8 && cut.end < 5.9, "{cut:?}");
    }
}

fn three_words_with_a_cut(cut: Range<f64>) -> (ProjectConfiguration, TranscriptDoc, TranscriptEdl) {
    let words = [
        ("before", 1.0, 1.4),
        ("middle", 2.2, 2.8),
        ("after", 4.0, 4.4),
    ];
    let durations = [5.0];
    let mut project = project(&words, &durations);
    apply_source_cuts(timeline_mut(&mut project), &durations, &[cut]);
    let (doc, edl) = model(&project, &durations);
    (project, doc, edl)
}

#[test]
fn a_pause_never_cuts_the_audible_tail_of_a_mostly_cut_word() {
    let (_, doc, edl) = three_words_with_a_cut(2.2..2.55);
    assert_eq!(edl.kept, [true, false, true]);
    let pauses = plan_pause_cuts(&doc, &edl, None, 1.0, 0.5);
    assert_eq!(pauses.len(), 1, "{pauses:?}");
    assert_eq!((pauses[0].after_word, pauses[0].next_word), (1, 2));
    assert!(close(pauses[0].length, 1.2), "{:?}", pauses[0]);
    for cut in pauses.iter().flat_map(|pause| &pause.cuts) {
        assert!(cut.end <= 2.55 || cut.start >= 2.8, "{cut:?}");
    }
}

#[test]
fn a_pause_never_cuts_the_audible_head_of_a_mostly_cut_word() {
    let (_, doc, edl) = three_words_with_a_cut(2.45..2.8);
    assert_eq!(edl.kept, [true, false, true]);
    let pauses = plan_pause_cuts(&doc, &edl, None, 1.0, 0.5);
    assert_eq!(pauses.len(), 1, "{pauses:?}");
    assert_eq!((pauses[0].after_word, pauses[0].next_word), (1, 2));
    assert!(close(pauses[0].length, 1.2), "{:?}", pauses[0]);
    for cut in pauses.iter().flat_map(|pause| &pause.cuts) {
        assert!(cut.end <= 2.2 || cut.start >= 2.45, "{cut:?}");
    }
}

#[test]
fn a_word_cut_entirely_still_lets_the_pause_around_it_join() {
    let (_, doc, edl) = three_words_with_a_cut(2.15..2.85);
    assert_eq!(edl.kept, [true, false, true]);
    let pauses = plan_pause_cuts(&doc, &edl, None, 1.0, 0.5);
    assert_eq!(pauses.len(), 1, "{pauses:?}");
    assert_eq!((pauses[0].after_word, pauses[0].next_word), (0, 2));
    assert!(close(pauses[0].length, 0.75 + 1.15), "{:?}", pauses[0]);
    for cut in pauses.iter().flat_map(|pause| &pause.cuts) {
        assert!(cut.end <= 2.15 || cut.start >= 2.85, "{cut:?}");
    }
}

#[test]
fn removing_neighbouring_fillers_together_matches_removing_them_one_at_a_time() {
    let words = [
        ("we", 1.0, 1.3),
        ("um", 1.5, 1.8),
        ("uh", 3.0, 3.3),
        ("the", 3.5, 3.8),
        ("export", 4.0, 4.4),
    ];
    let durations = [5.0];
    let doc = TranscriptDoc::build(&captions(&words));
    let runs: Vec<Range<usize>> = doc
        .fillers
        .iter()
        .map(|filler| filler.words.clone())
        .collect();
    assert_eq!(runs, [1..2, 2..3]);

    let mut together = project(&words, &durations);
    let cuts = plan_word_cuts(&doc, None, None, &runs);
    apply_source_cuts(timeline_mut(&mut together), &durations, &cuts);

    let mut apart = project(&words, &durations);
    for run in &runs {
        let (doc, edl) = model(&apart, &durations);
        let cuts = plan_word_cuts(&doc, None, Some(&edl.kept), std::slice::from_ref(run));
        apply_source_cuts(timeline_mut(&mut apart), &durations, &cuts);
    }

    assert_eq!(kept(&apart, &durations), [true, false, false, true, true]);
    assert_eq!(kept(&together, &durations), kept(&apart, &durations));
    assert_eq!(bounds(&together), bounds(&apart));
}

const FIRST_PASS: [(&str, f64, f64); 7] = [
    ("feels", 0.24, 0.56),
    ("the", 0.56, 0.72),
    ("same,", 0.72, 1.12),
    ("uh", 1.28, 1.52),
    ("works", 1.6, 2.0),
    ("very", 2.0, 2.24),
    ("similar,", 2.24, 2.72),
];
const REFINED: [(&str, f64, f64); 7] = [
    ("feels", 0.06, 0.3),
    ("the", 0.36, 0.42),
    ("same,", 0.48, 0.885),
    ("uh", 1.62, 1.68),
    ("works", 1.78, 1.98),
    ("very", 2.0, 2.14),
    ("similar,", 2.18, 2.575),
];
const SPOKEN_UH: Range<f64> = 1.5..1.7;

fn plays(project: &ProjectConfiguration, source: &Range<f64>) -> bool {
    bounds(project)
        .iter()
        .any(|(start, end)| *start < source.end && source.start < *end)
}

fn add_zoom(project: &mut ProjectConfiguration, start: f64, end: f64) {
    timeline_mut(project).zoom_segments.push(
        serde_json::from_value(serde_json::json!({
            "start": start,
            "end": end,
            "amount": 1.5,
            "mode": {"manual": {"x": 0.0, "y": 0.0}},
            "glideDirection": "none",
            "glideSpeed": 0.5,
            "instantAnimation": false,
            "edgeSnapRatio": 0.25
        }))
        .unwrap(),
    );
}

fn follow(project: &mut ProjectConfiguration, durations: &[f64]) -> usize {
    let before = TranscriptDoc::build(&captions(&FIRST_PASS));
    let after = TranscriptDoc::build(&captions(&REFINED));
    follow_refined_words(timeline_mut(project), durations, &[], &before, &after, None)
}

#[test]
fn a_filler_cut_on_first_pass_timings_moves_to_where_the_filler_is_spoken() {
    let durations = [5.16];
    let mut project = project(&FIRST_PASS, &durations);
    cut_words(&mut project, &durations, &[(3, 4)]);
    assert!(
        plays(&project, &SPOKEN_UH),
        "the first pass places the cut in the silence before the filler: {:?}",
        bounds(&project)
    );

    assert_eq!(follow(&mut project, &durations), 1);

    assert!(!plays(&project, &SPOKEN_UH), "{:?}", bounds(&project));
    let mut refined = self::project(&REFINED, &durations);
    cut_words(&mut refined, &durations, &[(3, 4)]);
    assert_eq!(bounds(&project).len(), 2);
    for (moved, direct) in bounds(&project).iter().zip(bounds(&refined)) {
        assert!(close(moved.0, direct.0) && close(moved.1, direct.1));
    }
    assert_eq!(follow(&mut project, &durations), 0);
}

#[test]
fn a_moved_filler_cut_leaves_the_other_tracks_as_cutting_on_refined_timings_would() {
    let durations = [5.16];
    let mut project = project(&FIRST_PASS, &durations);
    add_zoom(&mut project, 0.2, 0.9);
    add_zoom(&mut project, 3.0, 4.0);
    cut_words(&mut project, &durations, &[(3, 4)]);
    assert_eq!(follow(&mut project, &durations), 1);

    let mut refined = self::project(&REFINED, &durations);
    add_zoom(&mut refined, 0.2, 0.9);
    add_zoom(&mut refined, 3.0, 4.0);
    cut_words(&mut refined, &durations, &[(3, 4)]);

    let zooms = |project: &ProjectConfiguration| -> Vec<(f64, f64)> {
        timeline(project)
            .zoom_segments
            .iter()
            .map(|zoom| (zoom.start, zoom.end))
            .collect()
    };
    assert_eq!(zooms(&project).len(), 2);
    for (moved, direct) in zooms(&project).iter().zip(zooms(&refined)) {
        assert!(
            close(moved.0, direct.0) && close(moved.1, direct.1),
            "{moved:?} {direct:?}"
        );
    }
}

#[test]
fn a_trim_made_on_the_timeline_stays_put_when_word_timings_are_refined() {
    let durations = [5.16];
    let mut project = project(&FIRST_PASS, &durations);
    apply_source_cuts(timeline_mut(&mut project), &durations, &[1.2..1.55]);
    let trimmed = bounds(&project);
    assert!(
        !kept(&project, &durations)[3],
        "the trim covers the first pass's filler"
    );

    assert_eq!(follow(&mut project, &durations), 0);
    assert_eq!(bounds(&project), trimmed);
}

#[test]
fn landing_a_refinement_moves_the_cut_in_the_project_and_in_undo_entries_that_have_it() {
    let durations = [5.16];
    let uncut = project(&FIRST_PASS, &durations);
    let mut cut = uncut.clone();
    cut_words(&mut cut, &durations, &[(3, 4)]);
    cap_project::synchronize_captions(&mut cut, &durations);
    let input = uncut.captions.as_ref().unwrap().segments.clone();
    let refined = crate::transcription::RefinedCaptions::new(&input, captions(&REFINED).segments);
    let mut landing = super::RefinementLanding::new(&refined, &durations, &[], None);

    let mut entry = uncut.clone();
    assert_eq!(landing.land(&mut entry), Some(0));
    assert_eq!(bounds(&entry), bounds(&uncut));

    assert_eq!(landing.land(&mut cut), Some(1));
    assert!(!plays(&cut, &SPOKEN_UH), "{:?}", bounds(&cut));
    let spoken: Vec<&str> = timeline(&cut)
        .caption_segments
        .iter()
        .flat_map(|segment| &segment.words)
        .map(|word| word.text.as_str())
        .collect();
    assert_eq!(
        spoken,
        ["feels", "the", "same,", "works", "very", "similar,"]
    );
    assert_eq!(landing.land(&mut cut), None);
}

fn add_music(project: &mut ProjectConfiguration, start: f64, end: f64) {
    timeline_mut(project).audio_segments.push(
        serde_json::from_value(serde_json::json!({
            "start": start,
            "end": end,
            "path": "music.mp3",
            "fadeIn": 0.5,
            "fadeOut": 0.5
        }))
        .unwrap(),
    );
}

#[test]
fn a_moved_filler_cut_leaves_music_playing_across_it_without_a_gap() {
    let durations = [5.16];
    let mut project = project(&FIRST_PASS, &durations);
    add_music(&mut project, 0.0, 5.16);
    cut_words(&mut project, &durations, &[(3, 4)]);
    assert_eq!(follow(&mut project, &durations), 1);

    let mut refined = self::project(&REFINED, &durations);
    add_music(&mut refined, 0.0, 5.16);
    cut_words(&mut refined, &durations, &[(3, 4)]);

    let music = |project: &ProjectConfiguration| -> Vec<[f64; 5]> {
        timeline(project)
            .audio_segments
            .iter()
            .map(|piece| {
                [
                    piece.start,
                    piece.end,
                    piece.trim_start,
                    piece.fade_in,
                    piece.fade_out,
                ]
            })
            .collect()
    };
    let moved = music(&project);
    assert_eq!(moved.len(), 2);
    assert!(close(moved[0][1], moved[1][0]), "{moved:?}");
    for (moved, direct) in moved.iter().zip(music(&refined)) {
        for (moved, direct) in moved.iter().zip(direct) {
            assert!(close(*moved, direct), "{moved:?} {direct:?}");
        }
    }
}

#[test]
fn a_cut_follows_its_own_word_past_recovered_ones_or_stays_when_it_cannot_tell() {
    let durations = [5.16];
    let before = TranscriptDoc::build(&captions(&FIRST_PASS));
    let recovered = |word: (&'static str, f64, f64)| {
        let mut words = REFINED.to_vec();
        words.insert(3, word);
        TranscriptDoc::build(&captions(&words))
    };

    let mut project = project(&FIRST_PASS, &durations);
    cut_words(&mut project, &durations, &[(3, 4)]);
    let cut = bounds(&project);
    let twin = recovered(("uh", 1.0, 1.1));
    assert_eq!(
        follow_refined_words(
            timeline_mut(&mut project),
            &durations,
            &[],
            &before,
            &twin,
            None
        ),
        0
    );
    assert_eq!(bounds(&project), cut);

    let other = recovered(("so", 1.0, 1.1));
    assert_eq!(
        follow_refined_words(
            timeline_mut(&mut project),
            &durations,
            &[],
            &before,
            &other,
            None
        ),
        1
    );
    assert!(!plays(&project, &SPOKEN_UH), "{:?}", bounds(&project));
    assert_eq!(
        kept(&project, &durations),
        [true, true, true, false, true, true, true]
    );
}

#[test]
fn a_cut_made_before_the_loudness_envelope_loaded_still_moves() {
    let durations = [5.16];
    let mut project = project(&FIRST_PASS, &durations);
    cut_words(&mut project, &durations, &[(3, 4)]);

    let spoken = |time: f64| {
        SPOKEN_UH.contains(&time)
            || REFINED
                .iter()
                .any(|(text, start, end)| *text != "uh" && (*start..*end).contains(&time))
    };
    let clip: Vec<f32> = (0..(durations[0] / HOP_SECONDS) as usize)
        .map(|hop| {
            let time = hop as f64 * HOP_SECONDS;
            if spoken(time) {
                1e-2
            } else if (1.17..1.19).contains(&time) {
                1e-9
            } else {
                1e-7
            }
        })
        .collect();
    let envelope = EnergyEnvelope::new(vec![clip], &durations);
    let mut before = TranscriptDoc::build(&captions(&FIRST_PASS));
    before.refine_voiced(Some(&envelope));
    let mut after = TranscriptDoc::build(&captions(&REFINED));
    after.refine_voiced(Some(&envelope));
    let filler = 3..4;
    let heard = plan_word_cuts(
        &before,
        Some(&envelope),
        None,
        std::slice::from_ref(&filler),
    );
    assert!(
        !close(heard[0].start, bounds(&project)[0].1),
        "with the envelope the same cut is planned elsewhere: {heard:?}"
    );

    assert_eq!(
        follow_refined_words(
            timeline_mut(&mut project),
            &durations,
            &[],
            &before,
            &after,
            Some(&envelope)
        ),
        1
    );
    assert!(!plays(&project, &SPOKEN_UH), "{:?}", bounds(&project));
}

#[test]
fn a_cut_stays_put_when_the_music_split_by_it_was_given_a_fade_since() {
    let durations = [5.16];
    let mut project = project(&FIRST_PASS, &durations);
    add_music(&mut project, 0.0, 5.16);
    cut_words(&mut project, &durations, &[(3, 4)]);
    timeline_mut(&mut project).audio_segments[1].fade_in = 0.3;
    let cut = bounds(&project);

    assert_eq!(follow(&mut project, &durations), 0);

    assert_eq!(bounds(&project), cut);
    let music = &timeline(&project).audio_segments;
    assert_eq!(music.len(), 2);
    assert_eq!(music[1].fade_in, 0.3);
    assert!(close(music[0].end, music[1].start));
}
