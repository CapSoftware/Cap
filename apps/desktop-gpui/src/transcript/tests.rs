use std::ops::Range;

use cap_project::{
    CaptionSegment, CaptionWord, CaptionsData, ClipTransition, ClipTransitionType,
    ProjectConfiguration, TextLayout, TimelineConfiguration,
};

use super::cuts::{
    self, CutReport, ONSET_GUARD, RestoreBlocker, TAIL_GUARD, apply_source_cuts, gap_cut,
    plan_pause_cuts, plan_word_cuts, quietest_point, restore_words,
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
    let cuts = plan_word_cuts(&doc, None, &runs);
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
    let restored = restore_words(timeline_mut(&mut project), &durations, &doc, 1..2).unwrap();
    assert_eq!(restored, 1);
    assert_eq!(bounds(&project), bounds(&original));
    let text = &timeline(&project).text_segments[0];
    let expected = &timeline(&with_text).text_segments[0];
    assert!(close(text.start, expected.start) && close(text.end, expected.end));
    assert_eq!(kept(&project, &durations), [true; 5]);
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
    restore_words(timeline_mut(&mut project), &durations, &doc, 0..1).unwrap();
    restore_words(timeline_mut(&mut project), &durations, &doc, 3..4).unwrap();
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
    let result = restore_words(timeline_mut(&mut project), &durations, &doc, 1..2);
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
    assert_eq!(segments.len(), 2);
    assert_eq!(segments[1].recording_clip, 1);
    assert!(segments[1].start > 1.4 && segments[1].start < 1.6);
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
    let point = gap_cut(&doc, None, 1);
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
    let cuts: Vec<_> = pauses.iter().map(|pause| pause.cut.clone()).collect();
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
    assert!(plan_word_cuts(&doc, None, std::slice::from_ref(&(0..3))).is_empty());
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
    let cuts = plan_word_cuts(&doc, None, &runs);
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
    restore_words(timeline_mut(&mut project), &durations, &doc, 1..2).unwrap();
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
    restore_words(timeline_mut(&mut project), &durations, &doc, 1..2).unwrap();
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
    restore_words(timeline_mut(&mut project), &durations, &doc, 1..2).unwrap();
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
fn pauses_across_a_clip_boundary_are_left_alone() {
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
    assert!(plan_pause_cuts(&doc, &edl, None, 1.0, 0.5).is_empty());
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
    let cuts: Vec<_> = pauses.iter().map(|pause| pause.cut.clone()).collect();
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
    let result = restore_words(timeline_mut(&mut project), &durations, &doc, 3..5);
    assert_eq!(result, Err(RestoreBlocker::Transition));
    assert_eq!(bounds(&project), before);
}
