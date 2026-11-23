use super::*;
use crate::{SpeakerNames, names::Label};

const DIM: usize = 16;

/// Returns `table[k]` for a window whose median sample is `k / 100`, so a
/// test writes speaker `k` by filling samples with that value.
struct Scripted {
    table: Vec<Vec<f32>>,
}

impl Embed for Scripted {
    fn dim(&self) -> usize {
        DIM
    }

    fn model_id(&self) -> &str {
        "scripted"
    }

    fn embed(&mut self, windows: &[&[f32]]) -> Result<Vec<Vec<f32>>, Error> {
        Ok(windows
            .iter()
            .map(|w| {
                let mut sorted = w.to_vec();
                sorted.sort_by(f32::total_cmp);
                let k = (sorted[sorted.len() / 2] * 100.0).round() as usize;
                self.table[k].clone()
            })
            .collect())
    }
}

fn axis(i: usize) -> Vec<f32> {
    let mut v = vec![0.0; DIM];
    v[i] = 1.0;
    v
}

/// A unit vector at `sim` cosine similarity to axis `base`, leaning on axis
/// `lean`.
fn near(base: usize, lean: usize, sim: f32) -> Vec<f32> {
    let mut v = vec![0.0; DIM];
    v[base] = sim;
    v[lean] = (1.0 - sim * sim).sqrt();
    v
}

fn blend(parts: &[(usize, f32)]) -> Vec<f32> {
    let mut v = vec![0.0; DIM];
    for &(i, x) in parts {
        v[i] = x;
    }
    crate::embed::normalized(&v)
}

fn speakers(n: usize) -> Vec<Vec<f32>> {
    (0..n).map(axis).collect()
}

fn diarizer(table: Vec<Vec<f32>>) -> MeetingDiarizer {
    MeetingDiarizer::new(Config::default(), Box::new(Scripted { table }), None)
}

/// New voices are shown as soon as they are long enough to be a speaker.
fn eager() -> Config {
    Config {
        confirm_ms: 1_000,
        ..Config::default()
    }
}

fn audio(parts: &[(usize, u64)]) -> Vec<f32> {
    let mut out = Vec::new();
    for &(k, ms) in parts {
        out.extend(std::iter::repeat_n(k as f32 / 100.0, (ms * 16) as usize));
    }
    out
}

fn push(
    d: &mut MeetingDiarizer,
    track: Track,
    start_ms: u64,
    parts: &[(usize, u64)],
) -> SegmentLabels {
    let samples = audio(parts);
    d.push(Segment {
        track,
        key: start_ms,
        start_ms,
        samples: &samples,
    })
    .unwrap()
}

fn only(labels: &SegmentLabels) -> SpeakerId {
    assert_eq!(labels.spans.len(), 1, "{labels:?}");
    labels.spans[0].speaker
}

#[test]
fn one_voice_keeps_one_id() {
    let mut d = diarizer(speakers(2));
    let ids: Vec<SpeakerId> = (0..20)
        .map(|i| only(&push(&mut d, Track::System, i * 5_000, &[(1, 2_500)])))
        .collect();
    assert!(ids.iter().all(|id| *id == ids[0]));
    let pass = d.finish();
    assert!(pass.merged.is_empty());
    assert_eq!(pass.speakers.len(), 1);
    assert_eq!(pass.segments.len(), 20);
}

#[test]
fn alternating_voices_get_stable_ids_in_order_of_first_speech() {
    let mut d = diarizer(speakers(4));
    let mut seen = Vec::new();
    for i in 0..30u64 {
        let k = 1 + (i % 3) as usize;
        let id = only(&push(&mut d, Track::System, i * 4_000, &[(k, 2_000)]));
        seen.push((k, id));
    }
    assert_eq!(
        seen[1].1,
        SpeakerId(1),
        "a new voice waits for a second stretch"
    );
    assert_eq!(seen[2].1, SpeakerId(1));
    for (k, id) in &seen[3..] {
        assert_eq!(id.0 as usize, *k, "{seen:?}");
    }
    assert_eq!(d.speakers().len(), 3);
    let pass = d.finish();
    assert!(pass.merged.is_empty());
    for (i, last) in pass.segments.iter().enumerate() {
        assert_eq!(only(last).0 as usize, 1 + i % 3);
    }
}

#[test]
fn a_long_segment_is_split_where_the_voice_changes() {
    let mut d = diarizer(speakers(3));
    push(&mut d, Track::System, 0, &[(1, 2_000)]);
    push(&mut d, Track::System, 3_000, &[(2, 2_000)]);
    let labels = push(&mut d, Track::System, 10_000, &[(1, 6_000), (2, 6_000)]);
    assert_eq!(labels.spans.len(), 2, "{labels:?}");
    assert_eq!(labels.spans[0].speaker, SpeakerId(1));
    assert_eq!(labels.spans[1].speaker, SpeakerId(2));
    assert_eq!(labels.spans[0].start_ms, 10_000);
    assert_eq!(labels.spans[1].end_ms, 22_000);
    let change = labels.spans[1].start_ms;
    assert!(change.abs_diff(16_000) <= 750, "change at {change}");
    assert_eq!(labels.spans[0].end_ms, change);
}

#[test]
fn a_brief_window_inside_one_voice_is_not_a_speaker_change() {
    let mut d = diarizer(speakers(3));
    push(&mut d, Track::System, 0, &[(1, 2_000)]);
    push(&mut d, Track::System, 3_000, &[(2, 2_000)]);
    let labels = push(
        &mut d,
        Track::System,
        10_000,
        &[(1, 5_000), (2, 900), (1, 5_000)],
    );
    assert_eq!(only(&labels), SpeakerId(1));
}

#[test]
fn short_segments_inherit_the_previous_voice_and_never_start_a_speaker() {
    let mut d = diarizer(speakers(3));
    let first = push(&mut d, Track::System, 0, &[(2, 300)]);
    assert!(first.spans.is_empty());
    let a = only(&push(&mut d, Track::System, 1_000, &[(1, 2_000)]));
    let short = only(&push(&mut d, Track::System, 4_000, &[(2, 300)]));
    assert_eq!(short, a);
    let pass = d.finish();
    assert_eq!(pass.speakers.len(), 1);
    assert_eq!(pass.segments.len(), 3);
    assert!(pass.segments.iter().all(|s| s.main_speaker() == Some(a)));
}

#[test]
fn a_new_voice_needs_enough_speech_before_it_becomes_someone() {
    let mut d = diarizer(speakers(4));
    let a = only(&push(&mut d, Track::System, 0, &[(1, 2_000)]));
    let short = only(&push(&mut d, Track::System, 3_000, &[(2, 1_000)]));
    assert_eq!(short, a);
    let first = only(&push(&mut d, Track::System, 5_000, &[(2, 2_000)]));
    assert_eq!(first, a, "provisional until heard again");
    assert_eq!(d.speakers().len(), 1);
    let again = only(&push(&mut d, Track::System, 8_000, &[(2, 2_000)]));
    assert_ne!(again, a);
    assert_eq!(d.speakers().len(), 2);
    let monologue = only(&push(&mut d, Track::System, 11_000, &[(3, 4_500)]));
    assert!(
        monologue != a && monologue != again,
        "a long first stretch is shown at once"
    );
    let pass = d.finish();
    assert_eq!(pass.segments[2].main_speaker(), Some(again));
}

#[test]
fn a_brief_distinct_voice_is_held_back_live_and_kept_at_the_end() {
    let mut d = diarizer(speakers(4));
    let a = only(&push(&mut d, Track::System, 0, &[(1, 3_000)]));
    let b = only(&push(&mut d, Track::System, 4_000, &[(2, 4_000)]));
    let noise = only(&push(&mut d, Track::System, 9_000, &[(3, 1_800)]));
    assert!(noise == a || noise == b);
    for i in 0..10u64 {
        push(
            &mut d,
            Track::System,
            12_000 + i * 5_000,
            &[(1 + (i % 2) as usize, 3_000)],
        );
    }
    assert_eq!(d.speakers().len(), 2);
    let pass = d.finish();
    assert_eq!(pass.speakers.len(), 3, "unlike everyone, so a real person");
    assert!(
        pass.speakers
            .iter()
            .all(|s| s.id != a && s.id != b || s.speech_ms > 10_000)
    );
}

#[test]
fn final_pass_folds_a_speaker_that_was_split_live_and_reports_it() {
    let mut table = speakers(4);
    table.push(near(1, 3, 0.28));
    let mut config = eager();
    config.small_merge = 0.25;
    let mut d = MeetingDiarizer::new(config, Box::new(Scripted { table }), None);
    let a = only(&push(&mut d, Track::System, 0, &[(1, 2_000)]));
    let b = only(&push(&mut d, Track::System, 3_000, &[(2, 2_000)]));
    let split = only(&push(&mut d, Track::System, 6_000, &[(4, 2_000)]));
    assert!(split != a && split != b);
    for i in 0..10u64 {
        push(
            &mut d,
            Track::System,
            10_000 + i * 3_000,
            &[(1 + (i % 2) as usize, 2_000)],
        );
    }
    let pass = d.finish();
    assert_eq!(pass.merged, vec![(split, a)]);
    assert_eq!(pass.speakers.len(), 2);
    assert_eq!(pass.segments[2].main_speaker(), Some(a));
    assert_eq!(pass.segments[1].main_speaker(), Some(b));
}

#[test]
fn final_pass_corrects_an_early_mistake_with_full_context() {
    let mut table = speakers(4);
    table.push(blend(&[(1, 0.35), (2, 0.6), (3, 0.7193)]));
    let mut d = MeetingDiarizer::new(eager(), Box::new(Scripted { table }), None);
    let a = only(&push(&mut d, Track::System, 0, &[(1, 2_000)]));
    let early = only(&push(&mut d, Track::System, 3_000, &[(4, 2_000)]));
    assert_eq!(early, a, "joins the only speaker so far, unconfidently");
    let b = only(&push(&mut d, Track::System, 6_000, &[(2, 2_000)]));
    assert_ne!(a, b);
    for i in 0..10u64 {
        push(
            &mut d,
            Track::System,
            10_000 + i * 3_000,
            &[(1 + (i % 2) as usize, 2_000)],
        );
    }
    let pass = d.finish();
    assert_eq!(pass.segments[1].main_speaker(), Some(b));
    assert!(pass.merged.is_empty());
}

#[test]
fn the_user_echoed_on_the_system_track_is_not_a_new_person() {
    let mut d = diarizer(speakers(4));
    let user = only(&push(&mut d, Track::Mic, 0, &[(1, 4_000)]));
    assert_eq!(d.user(), Some(user));
    let echo = push(&mut d, Track::System, 100, &[(1, 3_800)]);
    let remote = only(&push(&mut d, Track::System, 5_000, &[(2, 3_000)]));
    assert_eq!(echo.spans.len(), 1);
    assert_eq!(echo.spans[0].speaker, user);
    assert!(echo.spans[0].echo);
    let pass = d.finish();
    assert_eq!(
        pass.speakers
            .iter()
            .filter(|s| s.track == Track::System)
            .count(),
        1
    );
    let final_echo = pass.segments.iter().find(|s| s.key == 100).unwrap();
    assert!(final_echo.spans.iter().all(|s| s.echo && s.speaker == user));
    assert!(pass.speakers.iter().any(|s| s.id == remote));
}

#[test]
fn a_remote_voice_leaking_into_the_microphone_is_marked_as_echo() {
    let mut d = diarizer(speakers(4));
    let user = only(&push(&mut d, Track::Mic, 0, &[(1, 4_000)]));
    let remote = only(&push_samples(
        &mut d,
        Track::System,
        10_000,
        &spoken(2, 10_000, 5_000, 7, 0, 1.0),
    ));
    // The speakers play it into the microphone: same voice, same rhythm.
    let bleed = push_samples(
        &mut d,
        Track::Mic,
        10_200,
        &spoken(2, 10_200, 4_000, 7, 2, 1.0),
    );
    assert_eq!(bleed.spans.len(), 1);
    assert_eq!(bleed.spans[0].speaker, remote);
    assert!(bleed.spans[0].echo);
    let pass = d.finish();
    assert_eq!(pass.user, Some(user));
    assert_eq!(
        pass.speakers
            .iter()
            .filter(|s| s.track == Track::Mic)
            .count(),
        1
    );
}

#[test]
fn the_same_voice_on_the_system_track_while_the_microphone_is_quiet_is_someone_else() {
    let mut table = speakers(3);
    table.push(near(1, 2, 0.6));
    let mut d = diarizer(table);
    let user = only(&push(&mut d, Track::Mic, 0, &[(1, 4_000)]));
    let other = push(&mut d, Track::System, 20_000, &[(3, 4_000)]);
    assert!(!other.spans[0].echo);
    assert_ne!(other.spans[0].speaker, user);
}

#[test]
fn in_person_voices_on_the_microphone_are_separated_and_the_user_is_the_main_voice() {
    let mut d = diarizer(speakers(4));
    let user = only(&push(&mut d, Track::Mic, 0, &[(1, 5_000)]));
    let guest = only(&push(&mut d, Track::Mic, 6_000, &[(2, 4_000)]));
    assert_ne!(user, guest);
    for i in 0..8u64 {
        push(&mut d, Track::Mic, 12_000 + i * 6_000, &[(1, 4_000)]);
    }
    let pass = d.finish();
    assert_eq!(pass.user, Some(user));
    assert!(pass.enrolment.is_none(), "two voices on the microphone");
}

#[test]
fn a_profile_picks_the_user_even_when_someone_else_speaks_first() {
    let profile = VoiceProfile::new("scripted", &axis(2), 60_000);
    let mut d = MeetingDiarizer::new(
        Config::default(),
        Box::new(Scripted { table: speakers(4) }),
        Some(profile),
    );
    let guest = only(&push(&mut d, Track::Mic, 0, &[(1, 5_000)]));
    assert_eq!(d.user(), None, "the first voice is unlike the profile");
    let user = only(&push(&mut d, Track::Mic, 6_000, &[(2, 4_000)]));
    assert_eq!(d.user(), Some(user));
    for i in 0..6u64 {
        push(&mut d, Track::Mic, 12_000 + i * 6_000, &[(1, 5_000)]);
    }
    let pass = d.finish();
    assert_eq!(pass.user, Some(user));
    assert_ne!(pass.user, Some(guest));
}

#[test]
fn a_profile_from_another_model_is_ignored() {
    let profile = VoiceProfile::new("other model", &axis(2), 60_000);
    let mut d = MeetingDiarizer::new(
        Config::default(),
        Box::new(Scripted { table: speakers(4) }),
        Some(profile),
    );
    let first = only(&push(&mut d, Track::Mic, 0, &[(1, 5_000)]));
    assert_eq!(d.user(), Some(first));
}

#[test]
fn enrolment_learns_a_single_microphone_voice_and_refreshes_a_matching_profile() {
    let mut d = diarizer(speakers(3));
    for i in 0..12u64 {
        push(&mut d, Track::Mic, i * 4_000, &[(1, 3_000)]);
    }
    let learnt = d.finish().enrolment.expect("36 s of one voice");
    assert_eq!(learnt.model, "scripted");
    assert!(learnt.similarity(&axis(1)) > 0.99);

    let mut d = MeetingDiarizer::new(
        Config::default(),
        Box::new(Scripted { table: speakers(3) }),
        Some(learnt.clone()),
    );
    for i in 0..12u64 {
        push(&mut d, Track::Mic, i * 4_000, &[(1, 3_000)]);
    }
    let refreshed = d.finish().enrolment.unwrap();
    assert_eq!(refreshed.meetings, 2);

    let mut d = MeetingDiarizer::new(
        Config::default(),
        Box::new(Scripted { table: speakers(3) }),
        Some(learnt),
    );
    for i in 0..12u64 {
        push(&mut d, Track::Mic, i * 4_000, &[(2, 3_000)]);
    }
    assert!(
        d.finish().enrolment.is_none(),
        "someone else used the computer"
    );
}

#[test]
fn enrolment_needs_enough_speech() {
    let mut d = diarizer(speakers(2));
    for i in 0..3u64 {
        push(&mut d, Track::Mic, i * 4_000, &[(1, 3_000)]);
    }
    assert!(d.finish().enrolment.is_none());
}

#[test]
fn memory_stays_bounded_and_every_segment_is_still_labelled() {
    let config = Config {
        max_embeddings: 50,
        ..Config::default()
    };
    let mut d = MeetingDiarizer::new(config, Box::new(Scripted { table: speakers(3) }), None);
    for i in 0..400u64 {
        push(
            &mut d,
            Track::System,
            i * 3_000,
            &[(1 + (i % 2) as usize, 2_000)],
        );
    }
    assert!(d.stats().embeddings_kept <= 50);
    let pass = d.finish();
    assert_eq!(pass.segments.len(), 400);
    assert!(pass.segments.iter().all(|s| !s.spans.is_empty()));
    assert_eq!(pass.speakers.len(), 2);
}

#[test]
fn spans_tile_each_segment() {
    let mut d = diarizer(speakers(4));
    push(&mut d, Track::System, 0, &[(1, 2_000)]);
    push(&mut d, Track::System, 3_000, &[(2, 2_000)]);
    push(&mut d, Track::System, 6_000, &[(3, 2_000)]);
    let labels = push(
        &mut d,
        Track::System,
        10_000,
        &[(1, 4_000), (3, 4_000), (2, 4_000)],
    );
    assert_eq!(labels.spans.len(), 3);
    assert_eq!(labels.spans.first().unwrap().start_ms, 10_000);
    assert_eq!(labels.spans.last().unwrap().end_ms, 22_000);
    for pair in labels.spans.windows(2) {
        assert_eq!(pair[0].end_ms, pair[1].start_ms);
    }
    let pass = d.finish();
    let last = pass.segments.last().unwrap();
    assert_eq!(last.spans, labels.spans);
}

#[test]
fn names_follow_the_meeting_from_live_labels_to_the_final_pass() {
    let mut table = speakers(5);
    table.push(near(2, 4, 0.28));
    let mut config = eager();
    config.small_merge = 0.25;
    let mut d = MeetingDiarizer::new(config, Box::new(Scripted { table }), None);
    let mut names = SpeakerNames::new(None);
    let user = only(&push(&mut d, Track::Mic, 0, &[(1, 4_000)]));
    let p1 = only(&push(&mut d, Track::System, 5_000, &[(2, 3_000)]));
    let p2 = only(&push(&mut d, Track::System, 9_000, &[(5, 2_000)]));
    let p3 = only(&push(&mut d, Track::System, 12_000, &[(3, 3_000)]));
    names.observe(&d.speakers());
    assert_eq!(names.label(user), Some(Label::User));
    assert_eq!(names.label(p1), Some(Label::Person(1)));
    assert_eq!(names.label(p2), Some(Label::Person(2)));
    assert_eq!(names.label(p3), Some(Label::Person(3)));
    names.rename(p2, "Dana");
    for i in 0..6u64 {
        push(
            &mut d,
            Track::System,
            20_000 + i * 4_000,
            &[(2 + (i % 2) as usize, 3_000)],
        );
    }
    let pass = d.finish();
    assert_eq!(pass.merged, vec![(p2, p1)]);
    let changes = names.apply_final(&pass);
    assert_eq!(names.label(p1), Some(Label::Named("Dana".into())));
    assert_eq!(names.label(p3), Some(Label::Person(2)));
    assert_eq!(names.label(p2), None);
    assert_eq!(names.label(user), Some(Label::User));
    assert_eq!(changes.len(), 3, "{changes:?}");
}

#[test]
fn final_pass_splits_two_voices_that_were_heard_as_one() {
    let mut table = speakers(4);
    table.push(blend(&[(1, 0.45), (3, 0.893)]));
    let mut d = diarizer(table);
    let a = only(&push(&mut d, Track::System, 0, &[(1, 3_000)]));
    let mut mixed = Vec::new();
    for i in 0..12u64 {
        let k = if i % 2 == 0 { 1 } else { 4 };
        mixed.push((
            k,
            only(&push(
                &mut d,
                Track::System,
                4_000 + i * 4_000,
                &[(k, 3_000)],
            )),
        ));
    }
    assert!(
        mixed.iter().all(|(_, id)| *id == a),
        "the second voice joins live"
    );
    let pass = d.finish();
    assert_eq!(pass.speakers.len(), 2);
    for (i, (k, _)) in mixed.iter().enumerate() {
        let speaker = pass.segments[i + 1].main_speaker().unwrap();
        assert_eq!(speaker == a, *k == 1, "segment {i}");
    }
}

#[test]
fn final_pass_keeps_one_steady_voice_whole() {
    let mut table = speakers(4);
    table.push(blend(&[(1, 0.9), (3, 0.436)]));
    table.push(blend(&[(1, 0.9), (2, 0.436)]));
    let mut d = diarizer(table);
    for i in 0..20u64 {
        push(
            &mut d,
            Track::System,
            i * 4_000,
            &[(4 + (i % 2) as usize, 3_000)],
        );
    }
    let pass = d.finish();
    assert_eq!(pass.speakers.len(), 1);
}

#[test]
fn a_voice_made_only_of_the_users_echo_folds_into_the_user_at_the_end() {
    let mut d = diarizer(speakers(4));
    let remote = only(&push(&mut d, Track::System, 0, &[(2, 4_000)]));
    let mut ghost = None;
    for i in 0..6u64 {
        let t = 10_000 + i * 8_000;
        let echo = push(&mut d, Track::System, t + 150, &[(1, 3_000)]);
        ghost.get_or_insert(echo.spans[0].speaker);
        push(&mut d, Track::Mic, t, &[(1, 3_200)]);
        push(&mut d, Track::System, t + 4_000, &[(2, 3_000)]);
    }
    assert!(ghost.is_some());
    let pass = d.finish();
    let user = pass.user.unwrap();
    let system: Vec<SpeakerId> = pass
        .speakers
        .iter()
        .filter(|s| s.track == Track::System)
        .map(|s| s.id)
        .collect();
    assert_eq!(system, vec![remote]);
    for seg in pass
        .segments
        .iter()
        .filter(|s| s.track == Track::System && s.key % 8_000 == 2_150)
    {
        assert!(
            seg.spans.iter().all(|s| s.echo && s.speaker == user),
            "{seg:?}"
        );
    }
}

#[test]
fn the_call_leaking_into_the_microphone_never_becomes_a_person_in_the_room() {
    let mut d = diarizer(speakers(4));
    let user = only(&push(&mut d, Track::Mic, 0, &[(1, 5_000)]));
    for i in 0..6u64 {
        let t = 10_000 + i * 10_000;
        push(&mut d, Track::Mic, t + 30, &[(2, 4_000)]);
        push(&mut d, Track::System, t, &[(2, 4_000)]);
        push(&mut d, Track::Mic, t + 5_000, &[(1, 4_000)]);
    }
    let pass = d.finish();
    assert_eq!(pass.user, Some(user));
    let mic: Vec<&SpeakerInfo> = pass
        .speakers
        .iter()
        .filter(|s| s.track == Track::Mic)
        .collect();
    assert_eq!(mic.len(), 1, "{:?}", pass.speakers);
    assert!(pass.enrolment.is_some() || mic[0].speech_ms < 30_000);
}

#[test]
fn the_model_only_ever_sees_a_few_input_lengths() {
    let d = diarizer(speakers(2));
    let mut lengths = std::collections::BTreeSet::new();
    for ms in (500..30_000u64).step_by(7) {
        for (a, b) in d.windows((ms * 16) as usize) {
            assert!(b <= (ms * 16) as usize);
            lengths.insert(b - a);
        }
    }
    assert!(lengths.len() <= 12, "{lengths:?}");
}

/// Partial words show who is speaking now, and listening early changes
/// nothing the meeting's labels depend on: every segment comes out the same
/// with or without it, the work done early is reused at the close, and the
/// final pass agrees.
#[test]
fn peeking_at_an_open_segment_names_the_voice_now_and_changes_no_label() {
    let script: Vec<(usize, u64)> = (0..24u64)
        .map(|i| (1 + (i % 3) as usize, 2_000 + (i % 4) * 2_500))
        .collect();
    let run = |peek: bool| {
        let mut d = diarizer(speakers(4));
        let mut labels = Vec::new();
        let mut peeked = Vec::new();
        let mut at = 0;
        for &(k, ms) in &script {
            let samples = audio(&[(k, ms)]);
            if peek {
                for len in [1_500u64, 3_500, 5_500, 7_500] {
                    let len = (len * 16) as usize;
                    if len < samples.len() {
                        peeked.push((
                            k,
                            d.peek(Segment {
                                track: Track::System,
                                key: at,
                                start_ms: at,
                                samples: &samples[..len],
                            })
                            .unwrap(),
                        ));
                    }
                }
            }
            labels.push(
                d.push(Segment {
                    track: Track::System,
                    key: at,
                    start_ms: at,
                    samples: &samples,
                })
                .unwrap(),
            );
            at += ms + 1_000;
        }
        let stats = d.stats();
        (labels, d.finish(), peeked, stats)
    };
    let (plain, plain_final, _, plain_stats) = run(false);
    let (early, early_final, peeked, early_stats) = run(true);
    assert_eq!(plain, early);
    assert_eq!(plain_final, early_final);
    assert_eq!(plain_stats.reused_windows, 0);
    assert!(early_stats.reused_windows > 0, "{early_stats:?}");
    let settled: Vec<_> = peeked.iter().skip(peeked.len() / 2).collect();
    assert!(
        settled
            .iter()
            .all(|(k, id)| *id == Some(SpeakerId(*k as u32))),
        "{peeked:?}"
    );
}

/// People in one room around one microphone often trade turns with no pause,
/// so one segment holds several voices nobody has heard yet. Each becomes
/// its own person instead of one voice averaged from all of them.
#[test]
fn people_in_one_room_trading_turns_without_a_pause_are_told_apart() {
    let mut d = diarizer(speakers(4));
    let labels = push(&mut d, Track::Mic, 0, &[(1, 8_000), (2, 9_000), (1, 5_000)]);
    let ids: Vec<SpeakerId> = labels.spans.iter().map(|s| s.speaker).collect();
    assert_eq!(ids.len(), 3, "{labels:?}");
    assert_eq!(ids[0], ids[2], "the first voice again");
    assert_ne!(ids[0], ids[1]);
    assert_eq!(d.speakers().len(), 2);
    let pass = d.finish();
    let mic = pass
        .speakers
        .iter()
        .filter(|s| s.track == Track::Mic)
        .count();
    assert_eq!(mic, 2);
}

/// Other people heard too briefly to become anyone are still other people:
/// the voice is not learnt from a meeting where they spoke.
#[test]
fn enrolment_skips_a_meeting_with_other_voices_on_the_microphone() {
    let meeting = |guests: bool| {
        let mut d = diarizer(speakers(3));
        let mut at = 0;
        for i in 0..10u64 {
            push(&mut d, Track::Mic, at, &[(1, 4_000)]);
            at += 5_000;
            if guests && i % 3 == 0 {
                push(&mut d, Track::Mic, at, &[(2, 2_000)]);
                at += 3_000;
            }
        }
        (d.stats().mic_absorbed_ms, d.finish().enrolment)
    };
    let (absorbed, learnt) = meeting(false);
    assert_eq!(absorbed, 0);
    assert!(learnt.is_some(), "40 s of one voice");
    let (absorbed, learnt) = meeting(true);
    assert!(absorbed > 0);
    assert!(learnt.is_none(), "a guest spoke {absorbed} ms");
}

/// Several people around one laptop: the person at the computer is the one
/// its microphone hears clearly loudest, even when someone further away
/// spoke first and talked most. Live and final agree.
#[test]
fn on_a_shared_microphone_the_user_is_the_clearly_loudest_voice() {
    let mut d = diarizer(speakers(5));
    let mut at = 0;
    for _ in 0..4 {
        push(&mut d, Track::Mic, at, &[(1, 6_000)]);
        at += 7_000;
        push(&mut d, Track::Mic, at, &[(3, 4_000)]);
        at += 5_000;
    }
    let near = d
        .speakers()
        .iter()
        .find(|s| s.id != d.speakers()[0].id)
        .map(|s| s.id);
    assert_eq!(d.user(), near, "the louder voice, live");
    let pass = d.finish();
    assert_eq!(pass.user, near, "and at the end");
}

/// Two voices about as loud: nothing changes, the first voice stays the
/// user live and the voice with the most speech is the user at the end.
#[test]
fn similar_levels_keep_the_usual_choice() {
    let mut d = diarizer(speakers(12));
    let first = only(&push(&mut d, Track::Mic, 0, &[(10, 6_000)]));
    let mut at = 7_000;
    for _ in 0..4 {
        push(&mut d, Track::Mic, at, &[(11, 4_000)]);
        at += 5_000;
        push(&mut d, Track::Mic, at, &[(10, 6_000)]);
        at += 7_000;
    }
    assert_eq!(d.user(), Some(first));
    assert_eq!(d.finish().user, Some(first));
}

/// Speech of voice `k` whose loudness rises and falls frame by frame (20 ms)
/// in the rhythm numbered `rhythm`, `lag` frames late. The scripted model
/// still hears voice `k`: most of every frame stays at its value.
fn spoken(k: usize, start_ms: u64, ms: u64, rhythm: u64, lag: u64, gain: f32) -> Vec<f32> {
    let frame = 320;
    let base = k as f32 / 100.0;
    let first = start_ms / 20;
    (0..(ms * 16) as usize)
        .map(|i| {
            let f = first + (i / frame) as u64;
            let mut x = f.wrapping_sub(lag).wrapping_mul(2_654_435_761) ^ rhythm.wrapping_mul(97);
            x ^= x >> 13;
            let g = 1.0 + (x % 50) as f32 / 10.0;
            gain * if i % frame < 192 { base } else { base * g }
        })
        .collect()
}

fn push_samples(
    d: &mut MeetingDiarizer,
    track: Track,
    start_ms: u64,
    samples: &[f32],
) -> SegmentLabels {
    d.push(Segment {
        track,
        key: start_ms,
        start_ms,
        samples,
    })
    .unwrap()
}

#[test]
fn the_call_heard_through_the_speakers_is_never_the_user() {
    // The call speaks first and the laptop speakers play it into the
    // microphone, where it sounds like nobody on the call (room, speaker).
    let mut d = diarizer(speakers(4));
    let mut leak_live_ids = Vec::new();
    for i in 0..3u64 {
        let t = i * 4_000;
        // The microphone's copy closes first, before the call's segment.
        let leak = push_samples(&mut d, Track::Mic, t, &spoken(3, t, 3_900, 7, 0, 1.0));
        leak_live_ids.extend(leak.spans.iter().filter(|s| !s.echo).map(|s| s.speaker));
        push_samples(&mut d, Track::System, t, &spoken(2, t, 3_900, 7, 0, 1.0));
    }
    let user = only(&push_samples(
        &mut d,
        Track::Mic,
        15_000,
        &spoken(1, 15_000, 6_000, 11, 0, 1.0),
    ));
    assert_eq!(d.user(), Some(user), "the user takes over live");
    assert!(
        d.speakers()
            .iter()
            .all(|s| s.track != Track::Mic || s.id == user),
        "the speakers' copy is no one: {:?}",
        d.speakers()
    );
    for i in 0..4u64 {
        let t = 25_000 + i * 8_000;
        let system = spoken(2, t, 3_500, 13 + i, 0, 1.0);
        push_samples(&mut d, Track::System, t, &system);
        let leak = push_samples(&mut d, Track::Mic, t, &spoken(3, t, 3_500, 13 + i, 1, 1.0));
        assert!(leak.spans.iter().all(|s| s.echo), "{leak:?}");
        push_samples(
            &mut d,
            Track::Mic,
            t + 4_000,
            &spoken(1, t + 4_000, 3_500, 40 + i, 0, 1.0),
        );
    }
    let pass = d.finish();
    assert_eq!(pass.user, Some(user));
    let mic: Vec<&SpeakerInfo> = pass
        .speakers
        .iter()
        .filter(|s| s.track == Track::Mic)
        .collect();
    assert_eq!(mic.len(), 1, "{:?}", pass.speakers);
    for seg in pass
        .segments
        .iter()
        .filter(|s| s.track == Track::Mic && s.key < 12_000)
    {
        assert!(seg.spans.iter().all(|s| s.echo), "{seg:?}");
    }
}

#[test]
fn the_users_voice_sent_back_by_the_call_is_not_a_leak() {
    // The far end returns the user's voice 160 ms later and quieter: the
    // microphone holds the original.
    let mut d = diarizer(speakers(4));
    let user = only(&push_samples(
        &mut d,
        Track::Mic,
        0,
        &spoken(1, 0, 5_000, 3, 0, 1.0),
    ));
    for i in 0..5u64 {
        let t = 6_000 + i * 6_000;
        push_samples(
            &mut d,
            Track::System,
            t,
            &spoken(1, t, 5_000, 20 + i, 8, 0.4),
        );
        let mine = push_samples(&mut d, Track::Mic, t, &spoken(1, t, 5_000, 20 + i, 0, 1.0));
        assert!(
            mine.spans.iter().all(|s| !s.echo && s.speaker == user),
            "{mine:?}"
        );
    }
    let pass = d.finish();
    assert_eq!(pass.user, Some(user));
    let mic_speech: u64 = pass
        .segments
        .iter()
        .filter(|s| s.track == Track::Mic)
        .flat_map(|s| &s.spans)
        .filter(|s| !s.echo)
        .map(|s| s.end_ms - s.start_ms)
        .sum();
    assert!(mic_speech >= 29_000, "{mic_speech}");
}

#[test]
fn a_voice_with_almost_no_words_folds_into_the_nearest_person_and_names_survive() {
    // Laughter on the call sounds unlike its speech; it says nothing.
    let mut table = speakers(4);
    table.push(near(2, 3, 0.2));
    let run = |words: bool| {
        let mut d = MeetingDiarizer::new(
            eager(),
            Box::new(Scripted {
                table: table.clone(),
            }),
            None,
        );
        let mut names = SpeakerNames::new(None);
        let mut laugh = None;
        let mut remote = None;
        for i in 0..8u64 {
            let t = i * 10_000;
            let talk = push(&mut d, Track::System, t, &[(2, 6_000)]);
            remote = remote.or(Some(only(&talk)));
            if words {
                let ms: Vec<u64> = (0..18).map(|w| t + 200 + w * 300).collect();
                d.transcribed(Track::System, t, &ms);
            }
            let l = push(&mut d, Track::System, t + 7_000, &[(4, 2_500)]);
            laugh = laugh.or(Some(only(&l)));
            if words {
                d.transcribed(Track::System, t + 7_000, &[]);
            }
        }
        names.observe(&d.speakers());
        let remote = remote.unwrap();
        names.rename(remote, "Dana");
        let pass = d.finish();
        names.apply_final(&pass);
        (pass, names, remote, laugh.unwrap())
    };
    let (pass, _, _, laugh) = run(false);
    assert_eq!(
        pass.speakers.len(),
        2,
        "without words nothing changes: {:?}",
        pass.speakers
    );
    assert!(pass.speakers.iter().any(|s| s.id == laugh));
    let (pass, names, remote, laugh) = run(true);
    assert_eq!(pass.speakers.len(), 1, "{:?}", pass.speakers);
    assert_eq!(pass.speakers[0].id, remote);
    assert!(pass.merged.contains(&(laugh, remote)), "{:?}", pass.merged);
    assert_eq!(names.label(remote), Some(Label::Named("Dana".into())));
    assert_eq!(names.label(laugh), None);
}

#[test]
fn a_different_person_on_the_microphone_still_stands_apart_at_the_end() {
    for (sim, voices) in [(0.5, 2), (0.7, 1)] {
        let mut table = speakers(4);
        table.push(near(1, 3, sim));
        let mut d = MeetingDiarizer::new(Config::default(), Box::new(Scripted { table }), None);
        for i in 0..6u64 {
            push(&mut d, Track::Mic, i * 12_000, &[(1, 5_000)]);
            push(&mut d, Track::Mic, i * 12_000 + 6_000, &[(4, 4_500)]);
        }
        let pass = d.finish();
        let mic = pass
            .speakers
            .iter()
            .filter(|s| s.track == Track::Mic)
            .count();
        assert_eq!(mic, voices, "similarity {sim}: {:?}", pass.speakers);
    }
}

#[test]
fn the_speakers_copy_louder_than_a_quiet_user_is_still_the_call() {
    // Voice 3 on the microphone is about 10 dB louder than the user (voice 1).
    let mut d = diarizer(speakers(4));
    for i in 0..3u64 {
        let t = i * 4_000;
        push_samples(&mut d, Track::Mic, t, &spoken(3, t, 3_900, 7 + i, 0, 1.0));
        push_samples(
            &mut d,
            Track::System,
            t,
            &spoken(2, t, 3_900, 7 + i, 0, 1.0),
        );
    }
    let user = only(&push_samples(
        &mut d,
        Track::Mic,
        15_000,
        &spoken(1, 15_000, 6_000, 50, 0, 1.0),
    ));
    let pass = d.finish();
    assert_eq!(pass.user, Some(user));
    for seg in pass
        .segments
        .iter()
        .filter(|s| s.track == Track::Mic && s.key < 12_000)
    {
        assert!(seg.spans.iter().all(|s| s.echo), "{seg:?}");
    }
}

#[test]
fn a_voice_heard_while_the_call_is_silent_is_never_judged_the_call() {
    // The user talks alone, then the laptop speakers start playing the call
    // into the microphone. Its copy sounds like the user (same room, same
    // microphone) and closes before the call's own segment, so it joins the
    // user's voice untested. The user's speech alone, with the call silent,
    // must keep that voice a person: later the user's words are not echo.
    let mut table = speakers(4);
    table.push(near(1, 3, 0.7));
    let mut d = diarizer(table);
    let user = only(&push_samples(
        &mut d,
        Track::Mic,
        0,
        &spoken(1, 0, 6_000, 3, 0, 1.0),
    ));
    push_samples(
        &mut d,
        Track::System,
        7_000,
        &spoken(2, 7_000, 3_000, 5, 0, 1.0),
    );
    push_samples(
        &mut d,
        Track::Mic,
        11_000,
        &spoken(1, 11_000, 4_000, 6, 0, 1.0),
    );
    for i in 0..4u64 {
        let t = 16_000 + i * 4_000;
        // The microphone's copy of the call (voice 4, like the user's)
        // closes first.
        push_samples(&mut d, Track::Mic, t, &spoken(4, t, 3_900, 20 + i, 0, 1.0));
        push_samples(
            &mut d,
            Track::System,
            t,
            &spoken(2, t, 3_900, 20 + i, 0, 1.0),
        );
    }
    for i in 0..3u64 {
        let t = 34_000 + i * 6_000;
        let mine = push_samples(&mut d, Track::Mic, t, &spoken(1, t, 5_000, 40 + i, 0, 1.0));
        assert!(
            mine.spans.iter().all(|s| !s.echo && s.speaker == user),
            "the user alone, the call silent: {mine:?}"
        );
        push_samples(
            &mut d,
            Track::System,
            t + 5_200,
            &spoken(2, t + 5_200, 600, 60 + i, 0, 1.0),
        );
    }
    assert_eq!(d.user(), Some(user));
    let pass = d.finish();
    assert_eq!(pass.user, Some(user));
}

#[test]
fn a_brief_remark_in_the_room_never_turns_the_call_into_a_person() {
    // The user says nothing. The speakers' copy of the call (voice 3) is a
    // voice of its own; someone in the room who sounds like it (voice 5)
    // says a word or two twice while the call is silent. The copy stays the
    // call: later copies that close before the call's segment are echo.
    let mut table = speakers(5);
    table.push(near(3, 4, 0.75));
    let mut d = diarizer(table);
    for i in 0..6u64 {
        let t = i * 8_000;
        push_samples(&mut d, Track::Mic, t, &spoken(3, t, 3_900, 7 + i, 0, 1.0));
        push_samples(
            &mut d,
            Track::System,
            t,
            &spoken(2, t, 3_900, 7 + i, 0, 1.0),
        );
        if i == 1 || i == 3 {
            push_samples(
                &mut d,
                Track::Mic,
                t + 4_600,
                &spoken(5, t + 4_600, 2_000, 30 + i, 0, 1.0),
            );
        }
    }
    for i in 6..10u64 {
        let t = i * 8_000;
        let copy = push_samples(&mut d, Track::Mic, t, &spoken(3, t, 3_900, 7 + i, 0, 1.0));
        assert!(copy.spans.iter().all(|s| s.echo), "{copy:?}");
        push_samples(
            &mut d,
            Track::System,
            t,
            &spoken(2, t, 3_900, 7 + i, 0, 1.0),
        );
    }
}

#[test]
fn the_computer_audio_dropping_out_never_turns_the_call_into_a_person() {
    // The call's copy (voice 3) closes before the call's segment. Then the
    // computer audio drops for 12 s while the speakers keep playing: the
    // copy is heard with the call "silent", in one silence. It must still
    // be judged the call once the computer audio is back.
    let mut d = diarizer(speakers(4));
    push_samples(&mut d, Track::Mic, 0, &spoken(3, 0, 3_900, 7, 0, 1.0));
    push_samples(&mut d, Track::System, 0, &spoken(2, 0, 3_900, 7, 0, 1.0));
    for i in 1..4u64 {
        let t = i * 4_000;
        push_samples(&mut d, Track::Mic, t, &spoken(3, t, 3_900, 7 + i, 0, 1.0));
    }
    for i in 4..24u64 {
        let t = i * 4_000;
        push_samples(&mut d, Track::Mic, t, &spoken(3, t, 3_900, 7 + i, 0, 1.0));
        push_samples(
            &mut d,
            Track::System,
            t,
            &spoken(2, t, 3_900, 7 + i, 0, 1.0),
        );
    }
    let t = 24 * 4_000;
    let copy = push_samples(&mut d, Track::Mic, t, &spoken(3, t, 3_900, 40, 0, 1.0));
    assert!(copy.spans.iter().all(|s| s.echo), "{copy:?}");
    assert!(
        d.speakers().iter().all(|s| s.track != Track::Mic),
        "the call's copy is no one: {:?}",
        d.speakers()
    );
}

#[test]
fn the_call_louder_than_the_user_is_never_echo_of_the_user() {
    // The user talks first. Then a remote whose voice sounds like the
    // user's (voice 4) talks, louder than the user, and the laptop speakers
    // play them into the microphone a little later; that copy closes first
    // and joins the user's voice. The call's own words are not the user sent
    // back by the far end: the microphone follows the call, not the reverse.
    let mut table = speakers(4);
    table.push(near(1, 2, 0.75));
    let mut d = diarizer(table);
    let user = only(&push_samples(
        &mut d,
        Track::Mic,
        0,
        &spoken(1, 0, 6_000, 3, 0, 1.0),
    ));
    for i in 0..3u64 {
        let t = 8_000 + i * 6_000;
        push_samples(&mut d, Track::Mic, t, &spoken(4, t, 5_000, 20 + i, 2, 1.0));
        let call = push_samples(
            &mut d,
            Track::System,
            t,
            &spoken(4, t, 5_000, 20 + i, 0, 1.0),
        );
        assert!(
            call.spans.iter().all(|s| !s.echo && s.speaker != user),
            "{call:?}"
        );
    }
}

#[test]
fn quieter_chatter_in_the_room_heard_through_the_call_never_takes_the_user() {
    // A cafe: other people's chatter, about 10 dB under the user, fills the
    // microphone the whole time the call talks; the user speaks less but
    // clearly louder, with the call quiet. (The scripted model hears the
    // sample value: the user at 0.09 is voice 9, the chatter at 0.03 voice 3.)
    let mut d = diarizer(speakers(11));
    let mut user = None;
    for i in 0..6u64 {
        let t = i * 22_000;
        push_samples(
            &mut d,
            Track::System,
            t,
            &spoken(2, t, 12_000, 5 + i, 0, 1.0),
        );
        push_samples(
            &mut d,
            Track::Mic,
            t,
            &spoken(10, t, 12_000, 30 + i, 0, 0.3),
        );
        let mine = push_samples(
            &mut d,
            Track::Mic,
            t + 13_000,
            &spoken(9, t + 13_000, 7_000, 60 + i, 0, 1.0),
        );
        user = user.or(Some(only(&mine)));
    }
    let pass = d.finish();
    assert_eq!(pass.user, user, "{:?}", pass.speakers);
}

/// Hears each 30 s step as one voice, alternating: voice 0, then 1, then 0.
struct Alternate {
    step: usize,
}

impl crate::nemotron::NemoModel for Alternate {
    fn step(&mut self, feats: &[f32], cached: &[f32], _mask: &[i64]) -> Result<crate::nemotron::StepOut, Error> {
        use crate::nemotron::cache::{HIDDEN, SPEAKERS, SUB};
        let n_mel = feats.len() / crate::nemotron::mel::N_MELS;
        let n_emb = n_mel.div_ceil(SUB);
        let n_cached = cached.len() / HIDDEN;
        let v = self.step % 2;
        self.step += 1;
        let mut logits = vec![-8.0f32; (n_cached + n_emb) * SUB * SPEAKERS];
        for f in 0..n_mel {
            logits[(n_cached * SUB + f) * SPEAKERS + v] = 8.0;
        }
        let mut chunk_embeds = vec![0.0f32; n_emb * HIDDEN];
        for e in 0..n_emb {
            chunk_embeds[e * HIDDEN + v] = 1.0;
        }
        Ok(crate::nemotron::StepOut { logits, chunk_embeds, silence: vec![0.0; HIDDEN] })
    }
}

/// Two minutes of the call that the speaker model hears as one voice.
fn one_voice_call(d: &mut MeetingDiarizer) {
    for i in 0..12 {
        push(d, Track::System, i * 10_500, &[(1, 10_000)]);
    }
}

#[test]
fn after_stop_nemotron_corrects_the_final_pass_exactly_as_live_nemotron_does() {
    let mut plain = diarizer(speakers(2));
    one_voice_call(&mut plain);
    let plain = plain.finish();

    let mut live = diarizer(speakers(2));
    live.set_nemotron(Box::new(Alternate { step: 0 }));
    one_voice_call(&mut live);
    let live_pass = live.finish();
    assert!(live.stats().nemotron_applied);
    assert!(live.take_late().is_none(), "live Nemotron is already in the final pass");
    assert!(live_pass.speakers.len() > plain.speakers.len(), "Nemotron split the call: {:?}", live_pass.speakers);

    let mut later = diarizer(speakers(2));
    later.set_nemotron_with(Box::new(Alternate { step: 0 }), crate::nemotron::Schedule::AfterStop, || {});
    one_voice_call(&mut later);
    let first = later.finish();
    assert_eq!(first, plain, "the final pass goes out with the speaker model's labels");
    assert!(!later.stats().nemotron_applied);
    let (corrected, stats) = later.take_late().expect("a correction on its way").wait().expect("Nemotron's voices");
    assert_eq!(corrected.segments, live_pass.segments);
    assert_eq!(corrected.speakers, live_pass.speakers);
    assert_eq!(corrected.merged, live_pass.merged);
    assert_eq!(corrected.user, live_pass.user);
    assert_eq!(corrected.enrolment, None);
    assert_eq!(stats.new_voices, live.stats().nemotron_new_voices);
    assert!(later.take_late().is_none());
}

#[test]
fn the_farm_standing_in_cancels_the_after_stop_pass() {
    let mut d = diarizer(speakers(2));
    d.set_nemotron_with(Box::new(Alternate { step: 0 }), crate::nemotron::Schedule::AfterStop, || {});
    one_voice_call(&mut d);
    d.cancel_after_stop_nemotron();
    d.finish();
    assert!(d.take_late().is_none());
    // a live Nemotron is never cancelled: its voices are already heard
    let mut live = diarizer(speakers(2));
    live.set_nemotron(Box::new(Alternate { step: 0 }));
    one_voice_call(&mut live);
    live.cancel_after_stop_nemotron();
    live.finish();
    assert!(live.stats().nemotron_applied);
}

#[test]
fn the_call_is_never_echo_of_its_own_copy_closed_first() {
    // A remote who sounds like the user (voice 4) talks; the room microphone
    // hears them through the speakers starting 20 ms after the call's own
    // segment, a frame or two late, and that copy closes first (a slow
    // machine transcribing in real time). The call's first words are the
    // call, not the user sent back.
    let mut table = speakers(4);
    table.push(near(1, 2, 0.75));
    let mut d = diarizer(table);
    let user = only(&push_samples(
        &mut d,
        Track::Mic,
        0,
        &spoken(1, 0, 6_000, 3, 0, 1.0),
    ));
    for (i, (late_start, short_end)) in [(20, 0), (20, 0), (40, 60), (20, 40)]
        .into_iter()
        .enumerate()
    {
        let t = 8_000 + i as u64 * 7_000;
        let ms = 5_860;
        push_samples(
            &mut d,
            Track::Mic,
            t + late_start,
            &spoken(
                4,
                t + late_start,
                ms - late_start - short_end,
                20 + i as u64,
                2,
                1.0,
            ),
        );
        let call = push_samples(
            &mut d,
            Track::System,
            t,
            &spoken(4, t, ms, 20 + i as u64, 0, 1.0),
        );
        assert!(
            call.spans.iter().all(|s| !s.echo && s.speaker != user),
            "call {i}: {call:?}"
        );
    }
}

#[test]
fn the_users_voice_sent_back_late_stays_echo() {
    // The far end returns the user's voice 160 ms later, so the
    // call's copy starts and ends after the microphone's original.
    let mut d = diarizer(speakers(4));
    let user = only(&push_samples(
        &mut d,
        Track::Mic,
        0,
        &spoken(1, 0, 5_000, 3, 0, 1.0),
    ));
    for i in 0..4u64 {
        let t = 6_000 + i * 6_000;
        push_samples(&mut d, Track::Mic, t, &spoken(1, t, 5_000, 20 + i, 0, 1.0));
        let back = push_samples(
            &mut d,
            Track::System,
            t + 160,
            &spoken(1, t + 160, 5_000, 20 + i, 8, 1.0),
        );
        assert!(
            back.spans.iter().all(|s| s.echo && s.speaker == user),
            "{back:?}"
        );
    }
}

#[test]
fn the_call_is_never_echo_of_a_level_copy_while_it_dips() {
    // The speakers' copy goes through a limiter: it stays at the room's
    // usual level while a new remote (voice 4, who sounds like the user) is
    // quieter on the call than the call usually is. The copy closes first
    // and joins the user; the call's words are still the call.
    let mut table = speakers(7);
    table[4] = near(1, 2, 0.75);
    let mut d = diarizer(table);
    let user = only(&push_samples(
        &mut d,
        Track::Mic,
        0,
        &spoken(1, 0, 6_000, 3, 0, 1.0),
    ));
    for i in 0..3u64 {
        let t = 7_000 + i * 5_000;
        push_samples(
            &mut d,
            Track::System,
            t,
            &spoken(6, t, 4_000, 10 + i, 0, 1.0),
        );
        push_samples(&mut d, Track::Mic, t, &spoken(3, t, 4_000, 10 + i, 2, 1.0));
    }
    for i in 0..3u64 {
        let t = 23_000 + i * 7_000;
        push_samples(
            &mut d,
            Track::Mic,
            t + 20,
            &spoken(4, t + 20, 5_840, 30 + i, 2, 1.0),
        );
        let call = push_samples(
            &mut d,
            Track::System,
            t,
            &spoken(4, t, 5_860, 30 + i, 0, 1.0),
        );
        assert!(
            call.spans.iter().all(|s| !s.echo && s.speaker != user),
            "call {i}: {call:?}"
        );
    }
}

#[test]
fn two_remotes_trading_turns_without_a_pause_on_the_call_are_told_apart() {
    // The call's first segment holds two people back to back, before anyone
    // is known: each gets their own voice, as on the microphone.
    let mut d = diarizer(speakers(4));
    let first = push(&mut d, Track::System, 0, &[(2, 12_000), (3, 10_000)]);
    let ids: Vec<SpeakerId> = first.spans.iter().map(|s| s.speaker).collect();
    assert_eq!(first.spans.len(), 2, "{first:?}");
    assert_ne!(ids[0], ids[1]);
    let again = only(&push(&mut d, Track::System, 24_000, &[(3, 4_000)]));
    assert_eq!(again, ids[1]);
}

#[test]
fn a_one_word_reply_over_the_same_word_on_a_headset_is_kept() {
    // A headset: nothing of the call reaches the microphone. The user says
    // "Right." a beat after the other side's "Right, ..."; the short clip
    // sounds closer to the remote than to the user's long speech.
    let mut table = speakers(4);
    table.push(near(2, 1, 0.8));
    let mut d = diarizer(table);
    for i in 0..4u64 {
        let t = i * 12_000;
        push_samples(&mut d, Track::Mic, t, &spoken(1, t, 5_000, 3 + i, 0, 1.0));
        // The reply closes long before the other side's sentence does.
        push_samples(
            &mut d,
            Track::Mic,
            t + 6_100,
            &spoken(4, t + 6_100, 600, 20 + i, 5, 1.0),
        );
        push_samples(
            &mut d,
            Track::System,
            t + 6_000,
            &spoken(2, t + 6_000, 5_000, 20 + i, 0, 1.0),
        );
    }
    let pass = d.finish();
    let user = pass.user.expect("a user");
    for seg in pass
        .segments
        .iter()
        .filter(|s| s.track == Track::Mic && s.key % 12_000 == 6_100)
    {
        assert!(
            seg.spans.iter().all(|s| !s.echo && s.speaker == user),
            "{seg:?}"
        );
    }
}

#[test]
fn a_short_copy_of_the_call_is_still_echo_when_the_speakers_play_it() {
    // Laptop speakers: the microphone repeats the call's sentences (voice 3,
    // in the call's rhythm), so its short copies of the call are echo too.
    let mut d = diarizer(speakers(4));
    push_samples(&mut d, Track::Mic, 0, &spoken(1, 0, 6_000, 3, 0, 1.0));
    for i in 0..4u64 {
        let t = 8_000 + i * 8_000;
        push_samples(
            &mut d,
            Track::System,
            t,
            &spoken(2, t, 4_000, 10 + i, 0, 1.0),
        );
        push_samples(&mut d, Track::Mic, t, &spoken(3, t, 4_000, 10 + i, 2, 1.0));
        let w = t + 5_000;
        push_samples(
            &mut d,
            Track::Mic,
            w + 40,
            &spoken(3, w + 40, 600, 30 + i, 2, 1.0),
        );
        push_samples(
            &mut d,
            Track::System,
            w,
            &spoken(2, w, 1_000, 30 + i, 0, 1.0),
        );
    }
    let pass = d.finish();
    let copies: Vec<&SegmentLabels> = pass
        .segments
        .iter()
        .filter(|s| s.track == Track::Mic && s.key % 8_000 == 5_040)
        .collect();
    assert_eq!(copies.len(), 4);
    for seg in copies {
        assert!(seg.spans.iter().all(|s| s.echo), "{seg:?}");
    }
}

#[test]
fn a_headset_after_the_speakers_keeps_its_short_replies() {
    // The meeting starts on the laptop speakers (the microphone repeats the
    // call, voice 3), then moves to a headset at 40 s. The short copies on
    // the speakers stay echo; the user's one-word replies on the headset,
    // a beat after the same word on the call, stay the user's.
    let mut table = speakers(4);
    table.push(near(2, 1, 0.8));
    let mut d = diarizer(table);
    push_samples(&mut d, Track::Mic, 0, &spoken(1, 0, 6_000, 3, 0, 1.0));
    for i in 0..3u64 {
        let t = 8_000 + i * 10_000;
        push_samples(
            &mut d,
            Track::System,
            t,
            &spoken(2, t, 4_000, 10 + i, 0, 1.0),
        );
        push_samples(&mut d, Track::Mic, t, &spoken(3, t, 4_000, 10 + i, 2, 1.0));
        let w = t + 5_000;
        push_samples(
            &mut d,
            Track::Mic,
            w + 40,
            &spoken(3, w + 40, 600, 30 + i, 2, 1.0),
        );
        push_samples(
            &mut d,
            Track::System,
            w,
            &spoken(2, w, 1_000, 30 + i, 0, 1.0),
        );
    }
    for i in 0..4u64 {
        let t = 40_000 + i * 12_000;
        push_samples(&mut d, Track::Mic, t, &spoken(1, t, 5_000, 50 + i, 0, 1.0));
        push_samples(
            &mut d,
            Track::Mic,
            t + 6_100,
            &spoken(4, t + 6_100, 600, 60 + i, 5, 1.0),
        );
        push_samples(
            &mut d,
            Track::System,
            t + 6_000,
            &spoken(2, t + 6_000, 5_000, 60 + i, 0, 1.0),
        );
    }
    d.set_echo_stretches(&[(0, false), (40_000, false)]);
    let pass = d.finish();
    let user = pass.user.expect("a user");
    let mic = |key: u64| {
        pass.segments
            .iter()
            .find(|s| s.track == Track::Mic && s.key == key)
    };
    for i in 0..3u64 {
        let copy = mic(8_000 + i * 10_000 + 5_040).expect("a copy");
        assert!(copy.spans.iter().all(|s| s.echo), "{copy:?}");
    }
    for i in 0..4u64 {
        let reply = mic(40_000 + i * 12_000 + 6_100).expect("a reply");
        assert!(
            reply.spans.iter().all(|s| !s.echo && s.speaker == user),
            "{reply:?}"
        );
    }
}

#[test]
fn a_one_word_reply_labelled_after_the_call_line_on_a_headset_is_kept() {
    // As above, but the other side's line is labelled first (a short line,
    // or a slow machine): the reply already overlaps the call when it is
    // labelled, and must not be taken for its echo there either.
    let mut table = speakers(4);
    table.push(near(2, 1, 0.8));
    let mut d = diarizer(table);
    for i in 0..4u64 {
        let t = i * 12_000;
        push_samples(&mut d, Track::Mic, t, &spoken(1, t, 5_000, 3 + i, 0, 1.0));
        push_samples(
            &mut d,
            Track::System,
            t + 6_000,
            &spoken(2, t + 6_000, 1_500, 20 + i, 0, 1.0),
        );
        let reply = push_samples(
            &mut d,
            Track::Mic,
            t + 6_100,
            &spoken(4, t + 6_100, 600, 20 + i, 5, 1.0),
        );
        assert!(reply.spans.iter().all(|s| !s.echo), "live {i}: {reply:?}");
    }
    d.set_echo_stretches(&[(0, false)]);
    let pass = d.finish();
    let user = pass.user.expect("a user");
    for seg in pass
        .segments
        .iter()
        .filter(|s| s.track == Track::Mic && s.key % 12_000 == 6_100)
    {
        assert!(
            seg.spans.iter().all(|s| !s.echo && s.speaker == user),
            "{seg:?}"
        );
    }
}

#[test]
fn a_remote_first_heard_in_a_short_line_is_learnt_from_what_follows() {
    // Remote B's first line is short (1.75 s, voice 4), their next line
    // only loosely like it (voice 5), and their third (voice 6) a little
    // like remote A (voice 2): B is learnt from the speech that joined them,
    // so the third line is still B.
    let mut table = speakers(4);
    table.push(axis(3));
    table.push(blend(&[(3, 0.45), (6, 0.89)]));
    table.push(blend(&[(6, 0.8), (2, 0.5), (3, 0.2)]));
    let mut d = diarizer(table);
    let a = only(&push(&mut d, Track::System, 0, &[(2, 6_000)]));
    push(&mut d, Track::System, 8_000, &[(4, 1_750)]);
    push(&mut d, Track::System, 11_000, &[(5, 3_000)]);
    let third = only(&push(&mut d, Track::System, 15_000, &[(6, 3_000)]));
    assert_ne!(third, a, "{:?}", d.speakers());
}

#[test]
fn a_different_remote_borderline_to_a_new_voice_never_merges_into_it() {
    // Remote B's first line is short (voice 4). Later, after A has spoken
    // again, C (another person) says a short line only loosely like B
    // (voice 5), then a long one (voice 6) unlike B's own voice. C must
    // not be learnt into B and then taken for B.
    let mut table = speakers(4);
    table.push(axis(3));
    table.push(blend(&[(3, 0.4), (7, 0.917)]));
    table.push(blend(&[(3, 0.2), (7, 0.98)]));
    let mut d = diarizer(table);
    let a = only(&push(&mut d, Track::System, 0, &[(2, 6_000)]));
    push(&mut d, Track::System, 8_000, &[(4, 1_750)]);
    push(&mut d, Track::System, 11_000, &[(2, 4_000)]);
    push(&mut d, Track::System, 17_000, &[(5, 1_500)]);
    let c = push(&mut d, Track::System, 20_000, &[(6, 6_000)]);
    let b_voices: Vec<SpeakerId> = d
        .speakers()
        .iter()
        .filter(|s| s.first_ms >= 8_000 && s.first_ms < 9_000)
        .map(|s| s.id)
        .collect();
    let c = only(&c);
    assert_ne!(c, a);
    assert!(!b_voices.contains(&c), "C taken for B: {:?}", d.speakers());
}
