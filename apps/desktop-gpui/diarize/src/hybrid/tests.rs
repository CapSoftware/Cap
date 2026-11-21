use super::*;
use crate::SegmentLabels;
use crate::nemotron::TrackVoices;

fn span(a: u64, b: u64, id: u32) -> Span {
    Span { start_ms: a, end_ms: b, speaker: SpeakerId(id), echo: false }
}

fn echo(a: u64, b: u64, id: u32) -> Span {
    Span { echo: true, ..span(a, b, id) }
}

fn seg(track: Track, key: u64, spans: Vec<Span>) -> SegmentLabels {
    SegmentLabels { track, key, spans }
}

fn pass(segments: Vec<SegmentLabels>, user: Option<u32>) -> FinalPass {
    let mut p = FinalPass { segments, user: user.map(SpeakerId), ..Default::default() };
    recount(&mut p);
    p
}

/// Voices on a track: (start_ms, end_ms, voice) over one continuous part from 0.
fn voices(track_ms: u64, turns: &[(u64, u64, usize)]) -> TrackVoices {
    TrackVoices::scripted(track_ms, turns)
}

fn ids(p: &FinalPass, track: Track) -> Vec<(u64, u64, u32, bool)> {
    p.segments
        .iter()
        .filter(|s| s.track == track)
        .flat_map(|s| s.spans.iter().map(|sp| (sp.start_ms, sp.end_ms, sp.speaker.0, sp.echo)))
        .collect()
}

#[test]
fn nemotron_never_merges_big_ids_even_when_it_hears_fewer_people() {
    // two call-side ids of 60 s and 40 s; the model hears one voice: on call audio it under-counts, so no merge
    let mut p = pass(
        vec![seg(Track::System, 1, vec![span(0, 60_000, 2)]), seg(Track::System, 2, vec![span(60_000, 100_000, 5)])],
        None,
    );
    let before = p.clone();
    let st = apply(&mut p, &[TrackVoices::default(), voices(100_000, &[(0, 100_000, 0)])]);
    assert_eq!(p.segments, before.segments);
    assert!(p.merged.is_empty());
    assert_eq!(st.merged_ids, 0);
}

#[test]
fn a_small_fragment_of_one_person_joins_them() {
    // 200 s and a 12 s fragment of the same remote person (6%): the fragment merges into the big id
    let mut p = pass(
        vec![seg(Track::System, 1, vec![span(0, 200_000, 2)]), seg(Track::System, 2, vec![span(205_000, 217_000, 9)])],
        None,
    );
    let st = apply(&mut p, &[TrackVoices::default(), voices(220_000, &[(0, 220_000, 0)])]);
    assert_eq!(p.speakers.len(), 1);
    assert_eq!(p.speakers[0].id, SpeakerId(2));
    assert_eq!(p.merged, vec![(SpeakerId(9), SpeakerId(2))]);
    assert_eq!(st.merged_ids, 1);
}

#[test]
fn the_calls_leak_on_the_microphone_is_not_counted_as_a_person() {
    // the mic holds the user plus the call heard through the speakers (echo); the model hears both as voices
    let mut p = pass(
        vec![seg(Track::Mic, 1, vec![span(0, 30_000, 1), echo(30_000, 90_000, 4)])],
        Some(1),
    );
    let before = p.clone();
    apply(&mut p, &[voices(90_000, &[(0, 30_000, 0), (30_000, 90_000, 1)]), TrackVoices::default()]);
    assert_eq!(p.segments, before.segments, "one person on the mic: nothing to split");
}

#[test]
fn two_people_at_one_microphone_are_cut_apart_and_the_newcomer_gets_a_new_id() {
    // one mic segment the embeddings gave entirely to the user; the model hears a second voice for 12 s
    let mut p = pass(vec![seg(Track::Mic, 1, vec![span(0, 40_000, 1)])], Some(1));
    let v = [voices(40_000, &[(0, 20_000, 0), (20_000, 32_000, 1), (32_000, 40_000, 0)]), TrackVoices::default()];
    let st = apply(&mut p, &v);
    let spans = ids(&p, Track::Mic);
    assert_eq!(spans.len(), 3, "{spans:?}");
    assert_eq!(spans[0].2, 1);
    assert_ne!(spans[1].2, 1);
    assert_eq!(spans[2].2, 1);
    assert_eq!(p.user, Some(SpeakerId(1)), "the user stays the user");
    assert_eq!(st.new_voices, 1);
}

#[test]
fn a_short_extra_voice_does_not_become_a_person() {
    let mut p = pass(vec![seg(Track::Mic, 1, vec![span(0, 40_000, 1)])], Some(1));
    let v = [voices(40_000, &[(0, 20_000, 0), (20_000, 24_000, 1), (24_000, 40_000, 0)]), TrackVoices::default()];
    apply(&mut p, &v);
    assert!(ids(&p, Track::Mic).iter().all(|s| s.2 == 1), "{:?}", ids(&p, Track::Mic));
    assert_eq!(p.speakers.len(), 1);
}

#[test]
fn echoes_and_leaks_stay_as_they_were() {
    let mut p = pass(
        vec![seg(Track::Mic, 1, vec![span(0, 10_000, 1), echo(10_000, 30_000, 3)]), seg(Track::System, 2, vec![span(10_000, 30_000, 3)])],
        Some(1),
    );
    // the model hears the leaked call on the mic as a second voice: the echo flag wins
    let v = [voices(30_000, &[(0, 10_000, 0), (10_000, 30_000, 1)]), voices(30_000, &[(10_000, 30_000, 0)])];
    apply(&mut p, &v);
    let mic = ids(&p, Track::Mic);
    assert!(mic.contains(&(10_000, 30_000, 3, true)), "{mic:?}");
    assert!(mic.iter().filter(|s| !s.3).all(|s| s.2 == 1));
}

#[test]
fn a_track_with_all_eight_voices_keeps_its_labels() {
    let spans: Vec<Span> = (0..10).map(|k| span(k * 10_000, k * 10_000 + 9_000, 10 + k as u32)).collect();
    let mut p = pass(vec![seg(Track::System, 1, spans.clone())], None);
    let turns: Vec<(u64, u64, usize)> = (0..10).map(|k| (k * 10_000, k * 10_000 + 9_000, (k as usize).min(7))).collect();
    let st = apply(&mut p, &[TrackVoices::default(), voices(100_000, &turns)]);
    assert_eq!(st.tracks_kept, 2);
    assert_eq!(p.segments[0].spans, spans);
}

#[test]
fn no_model_output_changes_nothing() {
    let mut p = pass(vec![seg(Track::System, 1, vec![span(0, 5_000, 2), span(5_000, 9_000, 4)])], None);
    let before = p.clone();
    let st = apply(&mut p, &[TrackVoices::default(), TrackVoices::default()]);
    assert_eq!(p, before);
    assert_eq!(st.tracks_kept, 2);
}

#[test]
fn the_user_keeps_their_id_when_a_room_voice_is_cut_out() {
    let mut p = pass(vec![seg(Track::Mic, 1, vec![span(0, 60_000, 7)])], Some(7));
    apply(&mut p, &[voices(60_000, &[(0, 40_000, 0), (40_000, 60_000, 1)]), TrackVoices::default()]);
    assert_eq!(p.user, Some(SpeakerId(7)));
    assert!(p.speakers.iter().any(|s| s.id == SpeakerId(7) && s.is_user && s.speech_ms == 40_000));
    assert!(p.speakers.iter().any(|s| s.id != SpeakerId(7) && !s.is_user && s.speech_ms == 20_000));
}

#[test]
fn the_user_follows_their_own_voice_when_chatter_was_folded_into_them() {
    // cafe chatter the whole time the call talks, folded into the user's id (1) with the user's own
    // words in the call's pauses; the model hears the two apart and the chatter is the bigger voice
    let mut mic = Vec::new();
    let mut sys = Vec::new();
    let mut turns = Vec::new();
    for i in 0..6u64 {
        let t = i * 22_000;
        mic.push(seg(Track::Mic, t, vec![span(t, t + 12_000, 1)]));
        mic.push(seg(
            Track::Mic,
            t + 13_000,
            vec![span(t + 13_000, t + 20_000, 1)],
        ));
        sys.push(seg(Track::System, t, vec![span(t, t + 12_000, 2)]));
        turns.push((t, t + 12_000, 0));
        turns.push((t + 13_000, t + 20_000, 1));
    }
    mic.extend(sys);
    let mut p = pass(mic, Some(1));
    let st = apply(&mut p, &[voices(132_000, &turns), TrackVoices::default()]);
    assert_eq!(st.new_voices, 1);
    let own = ids(&p, Track::Mic)
        .iter()
        .find(|s| s.0 == 13_000)
        .map(|s| s.2);
    assert_eq!(p.user.map(|u| u.0), own, "{:?}", ids(&p, Track::Mic));
    assert_ne!(p.user, Some(SpeakerId(1)), "the chatter is not the user");
}

#[test]
fn when_the_counts_agree_nothing_moves() {
    // two remote people; the model gives most of the second one's speech to the first (the room-1 failure of a
    // per-span relabel): with both counting two people the embedding labels stand
    let mut p = pass(
        vec![seg(Track::System, 1, vec![span(0, 60_000, 2)]), seg(Track::System, 2, vec![span(60_000, 100_000, 3)])],
        None,
    );
    let before = p.clone();
    let st = apply(&mut p, &[TrackVoices::default(), voices(100_000, &[(0, 80_000, 0), (80_000, 100_000, 1)])]);
    assert_eq!(p.segments, before.segments);
    assert_eq!((st.merged_ids, st.new_voices), (0, 0));
}

#[test]
fn a_person_counts_from_a_share_of_a_short_track_and_from_10_s_on_a_long_one() {
    assert_eq!(person_ms(28_000), 4_200);
    assert_eq!(person_ms(10_000), MIN_PERSON_MS);
    assert_eq!(person_ms(66_700), BIG_MS);
    assert_eq!(person_ms(3_600_000), BIG_MS);
}

#[test]
fn a_third_person_in_a_short_meeting_is_cut_out() {
    // 28 s at one microphone: the embeddings hear two people, Nemotron three (the third talks 6 s)
    let mut p = pass(
        vec![
            seg(Track::Mic, 1, vec![span(0, 12_000, 1)]),
            seg(Track::Mic, 2, vec![span(12_000, 22_000, 2)]),
            seg(Track::Mic, 3, vec![span(22_000, 28_000, 2)]),
        ],
        Some(1),
    );
    let v = [voices(28_000, &[(0, 12_000, 0), (12_000, 22_000, 1), (22_000, 28_000, 2)]), TrackVoices::default()];
    let stats = apply(&mut p, &v);
    assert_eq!(stats.new_voices, 1, "{:?}", ids(&p, Track::Mic));
    let mic = ids(&p, Track::Mic);
    let third = mic.iter().find(|s| s.0 == 22_000).expect("the last span").2;
    assert!(third != 1 && third != 2, "{mic:?}");
    assert_eq!(p.speakers.len(), 3);
    assert_eq!(p.user, Some(SpeakerId(1)));
}

#[test]
fn a_brief_voice_in_a_short_meeting_is_still_not_a_person() {
    // 28 s, a 2 s interjection: under MIN_PERSON_MS
    let mut p = pass(vec![seg(Track::Mic, 1, vec![span(0, 14_000, 1)]), seg(Track::Mic, 2, vec![span(14_000, 28_000, 2)])], Some(1));
    let v = [voices(28_000, &[(0, 14_000, 0), (14_000, 26_000, 1), (26_000, 28_000, 2)]), TrackVoices::default()];
    let stats = apply(&mut p, &v);
    assert_eq!(stats.new_voices, 0, "{:?}", ids(&p, Track::Mic));
    assert_eq!(p.speakers.len(), 2);
}

#[test]
fn a_short_meeting_never_ends_with_more_people_than_nemotron_heard() {
    // two ids, Nemotron hears three voices, two of them nobody's main voice: one new person, the bigger voice
    let mut p = pass(vec![seg(Track::Mic, 1, vec![span(0, 18_000, 1)]), seg(Track::Mic, 2, vec![span(18_000, 28_000, 2)])], Some(1));
    let v = [
        voices(28_000, &[(0, 10_000, 0), (10_000, 16_000, 1), (16_000, 18_000, 0), (18_000, 23_000, 0), (23_000, 28_000, 2)]),
        TrackVoices::default(),
    ];
    let stats = apply(&mut p, &v);
    assert_eq!(stats.new_voices, 1, "{:?}", ids(&p, Track::Mic));
    assert_eq!(p.speakers.len(), 3, "{:?}", p.speakers);
    let mic = ids(&p, Track::Mic);
    // the 6 s voice (10-16 s) is the one cut out, the 5 s one stays with its id
    let new_id = mic.iter().find(|s| s.0 == 10_000).map(|s| s.2).expect("a cut at 10 s");
    assert!(new_id != 1 && new_id != 2, "{mic:?}");
}
