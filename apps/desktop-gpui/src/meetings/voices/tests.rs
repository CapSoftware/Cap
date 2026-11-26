use super::*;

const DIM: usize = 16;

/// Speaker `k` is written as samples of value `k / 100`; every window maps to
/// axis `k`, so the test controls exactly who is speaking where.
struct Scripted;

impl Embed for Scripted {
    fn dim(&self) -> usize {
        DIM
    }

    fn model_id(&self) -> &str {
        "scripted"
    }

    fn embed(&mut self, windows: &[&[f32]]) -> Result<Vec<Vec<f32>>, cap_diarize::Error> {
        Ok(windows
            .iter()
            .map(|w| {
                let mut sorted = w.to_vec();
                sorted.sort_by(f32::total_cmp);
                let k = (sorted[sorted.len() / 2] * 100.0).round() as usize;
                let mut v = vec![0.0; DIM];
                v[k] = 1.0;
                v
            })
            .collect())
    }
}

fn voices(id_offset: u32, prior_user: Option<u32>) -> Voices {
    Voices::new(VoicesConfig {
        load: Box::new(|| Ok(Box::new(Scripted) as Box<dyn Embed>)),
        profile: None,
        id_offset,
        prior_user,
    })
}

fn audio(parts: &[(usize, u64)]) -> Vec<f32> {
    parts
        .iter()
        .flat_map(|&(k, ms)| std::iter::repeat_n(k as f32 / 100.0, (ms * 16) as usize))
        .collect()
}

fn sample(ms: u64) -> u64 {
    ms * 16
}

/// One word every 500 ms across the segment, starting at `start_ms`.
fn words(start_ms: u64, len_ms: u64) -> Vec<Word> {
    (0..len_ms / 500)
        .map(|i| Word {
            text: format!("w{}", (start_ms + i * 500) / 500),
            start_ms: start_ms + i * 500,
            end_ms: start_ms + i * 500 + 400,
        })
        .collect()
}

fn speak(v: &mut Voices, source: Source, start_ms: u64, parts: &[(usize, u64)]) -> Vec<Utterance> {
    let len: u64 = parts.iter().map(|p| p.1).sum();
    v.push(source, sample(start_ms), &audio(parts));
    v.split(source, sample(start_ms), words(start_ms, len), true)
}

fn ids(utterances: &[Utterance]) -> Vec<Option<u32>> {
    utterances.iter().map(|u| u.speaker_id).collect()
}

#[test]
fn a_segment_with_two_voices_becomes_one_line_per_voice() {
    let mut v = voices(0, None);
    speak(&mut v, Source::System, 0, &[(1, 2_000)]);
    speak(&mut v, Source::System, 3_000, &[(2, 2_000)]);
    speak(&mut v, Source::System, 6_000, &[(1, 2_000)]);
    speak(&mut v, Source::System, 9_000, &[(2, 2_000)]);
    let lines = speak(&mut v, Source::System, 12_000, &[(1, 6_000), (2, 6_000)]);
    assert_eq!(ids(&lines), vec![Some(1), Some(2)], "{lines:?}");
    let base = utterance_id(Source::System, sample(12_000));
    assert_eq!(lines[0].id, base);
    assert_eq!(lines[1].id, format!("{base}#1"));
    assert_eq!(lines[0].start_ms, 12_000);
    assert!(
        lines[1].start_ms.abs_diff(18_000) <= 750,
        "{}",
        lines[1].start_ms
    );
    let all: Vec<&Word> = lines.iter().flat_map(|u| &u.words).collect();
    assert_eq!(all.len(), 24, "no word is lost or repeated at the change");
}

#[test]
fn the_users_echo_on_the_system_track_produces_no_line() {
    let mut v = voices(0, None);
    let mine = speak(&mut v, Source::Mic, 0, &[(1, 4_000)]);
    assert_eq!(mine.len(), 1);
    let user = mine[0].speaker_id;
    assert!(user.is_some());
    let echo = speak(&mut v, Source::System, 100, &[(1, 3_800)]);
    assert!(echo.is_empty(), "{echo:?}");
    let remote = speak(&mut v, Source::System, 5_000, &[(2, 3_000)]);
    assert_eq!(remote.len(), 1);
    assert_ne!(remote[0].speaker_id, user);
}

#[test]
fn the_final_pass_relabels_lines_the_live_labels_got_wrong() {
    let mut v = voices(0, None);
    let mut lines = Vec::new();
    for i in 0..12u64 {
        let k = 1 + (i % 3) as usize;
        lines.extend(speak(&mut v, Source::System, i * 4_000, &[(k, 2_000)]));
    }
    assert_eq!(
        lines[1].speaker_id,
        Some(1),
        "a new voice waits for a second stretch live"
    );
    let done = v.finish().expect("the model was loaded");
    let moved: BTreeMap<String, u32> = done.assign.iter().cloned().collect();
    assert_eq!(moved.get(&lines[1].id), Some(&2), "{:?}", done.assign);
    for (i, line) in lines.iter().enumerate() {
        let want = 1 + (i % 3) as u32;
        let now = moved.get(&line.id).copied().or(line.speaker_id);
        assert_eq!(now, Some(want), "line {i}");
    }
    assert!(
        v.finish().is_some_and(|f| f.assign.is_empty()),
        "state is cleared"
    );
}

#[test]
fn a_resumed_meeting_numbers_new_voices_after_the_old_ones_and_keeps_the_user() {
    let mut v = voices(4, Some(2));
    let mine = speak(&mut v, Source::Mic, 0, &[(1, 4_000)]);
    assert_eq!(ids(&mine), vec![Some(2)]);
    speak(&mut v, Source::System, 5_000, &[(3, 2_000)]);
    let remote = speak(&mut v, Source::System, 8_000, &[(3, 2_000)]);
    let id = remote[0].speaker_id.unwrap();
    assert!(id > 4, "new voice {id} must not reuse an old number");
    let done = v.finish().unwrap();
    assert_eq!(done.pass.user.map(|u| u.0), Some(2));
    assert!(done.pass.speakers.iter().all(|s| s.id.0 == 2 || s.id.0 > 4));
}

#[test]
fn without_the_model_lines_keep_the_track_label() {
    let mut v = Voices::new(VoicesConfig {
        load: Box::new(|| Err("missing".into())),
        profile: None,
        id_offset: 0,
        prior_user: None,
    });
    let lines = speak(&mut v, Source::System, 0, &[(1, 6_000)]);
    assert_eq!(ids(&lines), vec![None]);
    assert_eq!(lines[0].words.len(), 12);
    assert!(v.is_off());
    assert!(v.finish().is_none());
}

#[test]
fn a_partial_line_shows_the_last_voice_on_its_track() {
    let mut v = voices(0, None);
    let mine = speak(&mut v, Source::Mic, 0, &[(1, 4_000)]);
    let partial = v.split(Source::Mic, sample(5_000), words(5_000, 1_000), false);
    assert_eq!(ids(&partial), ids(&mine));
    assert!(!partial[0].is_final);
    let other = v.split(Source::System, sample(5_000), words(5_000, 1_000), false);
    assert_eq!(ids(&other), vec![None], "nothing heard on that track yet");
}

#[test]
fn a_segment_pushed_twice_is_diarized_once() {
    let mut v = voices(0, None);
    speak(&mut v, Source::Mic, 0, &[(1, 4_000)]);
    let before = v.stats();
    assert!(v.push(Source::Mic, 0, &audio(&[(1, 4_000)])).is_none());
    assert_eq!(v.stats(), before);
}

#[test]
fn a_partial_line_shows_who_is_speaking_now_once_their_voice_is_known() {
    let mut v = voices(0, None);
    let mut at = 0;
    for k in [1, 2, 1, 2] {
        speak(&mut v, Source::System, at, &[(k, 4_500)]);
        at += 5_000;
    }
    let first = speak(&mut v, Source::System, at, &[(1, 4_500)]);
    at += 5_000;
    let open = audio(&[(2, 2_000)]);
    let before = v.split(Source::System, sample(at), words(at, 2_000), false);
    assert_eq!(
        ids(&before),
        ids(&first),
        "before listening: the last voice"
    );
    v.peek(Source::System, sample(at), &open);
    let partial = v.split(Source::System, sample(at), words(at, 2_000), false);
    let closed = speak(&mut v, Source::System, at, &[(2, 4_500)]);
    assert_ne!(ids(&partial), ids(&first));
    assert_eq!(
        ids(&partial)[0],
        ids(&closed)[0],
        "the partial already shows who closes it"
    );
}

#[test]
fn a_provisional_split_matches_the_final_one_and_leaves_it_to_come() {
    let mut v = voices(0, None);
    speak(&mut v, Source::System, 0, &[(1, 2_000)]);
    speak(&mut v, Source::System, 3_000, &[(2, 2_000)]);
    speak(&mut v, Source::System, 6_000, &[(1, 2_000)]);
    speak(&mut v, Source::System, 9_000, &[(2, 2_000)]);
    let start = 12_000;
    v.push(
        Source::System,
        sample(start),
        &audio(&[(1, 6_000), (2, 6_000)]),
    );
    let emitted = v.emitted.len();
    let shown = v.split_provisional(Source::System, sample(start), words(start, 12_000));
    let again = v.split_provisional(Source::System, sample(start), words(start, 12_000));
    assert_eq!(shown, again, "showing a line does not use up its labels");
    assert_eq!(v.emitted.len(), emitted, "nor counts it for the final pass");
    assert!(shown.iter().all(|u| u.is_final));
    let last = v.split(Source::System, sample(start), words(start, 12_000), true);
    let key = |lines: &[Utterance]| -> Vec<(String, Option<u32>)> {
        lines.iter().map(|u| (u.id.clone(), u.speaker_id)).collect()
    };
    assert_eq!(key(&shown), key(&last), "same lines, same voices");
    assert_eq!(ids(&last), vec![Some(1), Some(2)]);
    assert_eq!(v.emitted.len(), emitted + 2);
}

/// Voice `k` whose loudness follows rhythm `rhythm` frame by frame (20 ms);
/// the scripted model still hears voice `k`.
fn spoken(k: usize, start_ms: u64, ms: u64, rhythm: u64) -> Vec<f32> {
    let base = k as f32 / 100.0;
    (0..(ms * 16) as usize)
        .map(|i| {
            let f = start_ms / 20 + (i / 320) as u64;
            let mut x = f.wrapping_mul(2_654_435_761) ^ rhythm.wrapping_mul(97);
            x ^= x >> 13;
            let g = 1.0 + (x % 50) as f32 / 10.0;
            if i % 320 < 192 { base } else { base * g }
        })
        .collect()
}

fn say(v: &mut Voices, source: Source, start_ms: u64, samples: &[f32]) -> Vec<Utterance> {
    let len = samples.len() as u64 / 16;
    v.push(source, sample(start_ms), samples);
    v.split(source, sample(start_ms), words(start_ms, len), true)
}

#[test]
fn lines_that_were_only_the_call_through_the_speakers_go_at_the_end() {
    let mut v = voices(0, None);
    let mut leaked = Vec::new();
    let mut call = Vec::new();
    for i in 0..3u64 {
        let t = i * 4_000;
        // The microphone's copy of the call closes before the call's own.
        leaked.extend(say(&mut v, Source::Mic, t, &spoken(3, t, 3_900, 7 + i)));
        call.extend(say(&mut v, Source::System, t, &spoken(2, t, 3_900, 7 + i)));
    }
    let mine = say(&mut v, Source::Mic, 15_000, &spoken(1, 15_000, 6_000, 50));
    assert!(!leaked.is_empty() && !call.is_empty() && mine.len() == 1);
    let done = v.finish().expect("the model was loaded");
    let echoes = v.take_echoes();
    for line in &leaked {
        assert!(
            echoes.contains(&line.id),
            "{} not removed: {echoes:?}",
            line.id
        );
        assert!(done.assign.iter().all(|(id, _)| id != &line.id));
    }
    assert!(call.iter().chain(&mine).all(|l| !echoes.contains(&l.id)));
    let moved: BTreeMap<String, u32> = done.assign.iter().cloned().collect();
    let me = moved.get(&mine[0].id).copied().or(mine[0].speaker_id);
    assert_eq!(
        done.pass.user.map(|u| u.0),
        me,
        "the user is the one speaking, not the speakers"
    );
    assert!(v.take_echoes().is_empty(), "taken once");
}

#[test]
fn farm_voices_cut_out_a_person_the_embeddings_heard_as_one() {
    // the embeddings hear one voice on the call side for 30 s; the farm (no Nemotron here) hears two
    let mut v = voices(0, None);
    let mut lines = Vec::new();
    for i in 0..6u64 {
        let start = i * 5_000;
        lines.extend(speak(&mut v, Source::System, start, &[(1, 5_000)]));
        for w in words(start, 5_000) {
            v.farm_word(Source::System, w.start_ms, w.end_ms, if i < 3 { 0 } else { 1 });
        }
    }
    let done = v.finish().expect("the model was loaded");
    let moved: BTreeMap<String, u32> = done.assign.iter().cloned().collect();
    let now = |l: &Utterance| moved.get(&l.id).copied().or(l.speaker_id);
    let first: Vec<_> = lines.iter().filter(|l| l.start_ms < 15_000).map(now).collect();
    let last: Vec<_> = lines.iter().filter(|l| l.start_ms >= 15_000).map(now).collect();
    assert!(first.iter().all(|s| *s == first[0]) && last.iter().all(|s| *s == last[0]), "{first:?} {last:?}");
    assert_ne!(first[0], last[0], "the second person gets their own voice");
}

#[test]
fn without_farm_voices_or_nemotron_the_final_labels_are_the_embeddings() {
    let mut v = voices(0, None);
    let mut lines = Vec::new();
    for i in 0..6u64 {
        lines.extend(speak(&mut v, Source::System, i * 5_000, &[(1, 5_000)]));
    }
    let done = v.finish().expect("the model was loaded");
    assert!(done.assign.is_empty(), "{:?}", done.assign);
}

/// Hears each 30 s step as one voice, alternating: voice 0, then 1, then 0.
struct Alternate {
    step: usize,
}

impl cap_diarize::nemotron::NemoModel for Alternate {
    fn step(
        &mut self,
        feats: &[f32],
        cached: &[f32],
        _mask: &[i64],
    ) -> Result<cap_diarize::nemotron::StepOut, cap_diarize::Error> {
        use cap_diarize::nemotron::cache::{HIDDEN, SPEAKERS, SUB};
        let n_mel = feats.len() / cap_diarize::nemotron::mel::N_MELS;
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
        Ok(cap_diarize::nemotron::StepOut {
            logits,
            chunk_embeds,
            silence: vec![0.0; HIDDEN],
        })
    }
}

fn two_minute_call(schedule: cap_diarize::nemotron::Schedule) -> (Voices, Vec<Utterance>, FinalVoices) {
    let mut v = voices(0, None).with_nemotron(Box::new(Alternate { step: 0 }), schedule);
    let mut lines = Vec::new();
    for i in 0..12u64 {
        lines.extend(speak(&mut v, Source::System, i * 10_000, &[(1, 10_000)]));
    }
    let done = v.finish().expect("the model was loaded");
    (v, lines, done)
}

#[test]
fn after_stop_nemotron_moves_the_same_lines_as_live_nemotron_only_later() {
    use cap_diarize::nemotron::Schedule;
    let (mut live, _, live_done) = two_minute_call(Schedule::Live);
    assert!(live.take_late().is_none(), "live Nemotron is already in the final pass");
    assert!(!live_done.assign.is_empty(), "Nemotron splits the call the embeddings heard as one");

    let (mut later, lines, later_done) = two_minute_call(Schedule::AfterStop);
    assert!(later_done.assign.is_empty(), "the final pass does not wait for Nemotron");
    let late = later
        .take_late()
        .expect("Nemotron hears the meeting after Stop")
        .resolve()
        .expect("lines move");
    assert_eq!(late.voices.assign, live_done.assign);
    assert_eq!(late.voices.pass.speakers, live_done.pass.speakers);
    assert_eq!(late.voices.pass.user, live_done.pass.user);
    // each moved line names the voice it had when the meeting finished
    let finished: BTreeMap<String, Option<u32>> = lines.iter().map(|l| (l.id.clone(), l.speaker_id)).collect();
    assert_eq!(late.expect.len(), late.voices.assign.len());
    for (id, was) in &late.expect {
        assert_eq!(finished[id], *was, "{id}");
    }
}

#[test]
fn the_farm_standing_in_means_no_after_stop_pass() {
    let mut v = voices(0, None).with_nemotron(Box::new(Alternate { step: 0 }), cap_diarize::nemotron::Schedule::AfterStop);
    for i in 0..6u64 {
        let start = i * 5_000;
        speak(&mut v, Source::System, start, &[(1, 5_000)]);
        for w in words(start, 5_000) {
            v.farm_word(Source::System, w.start_ms, w.end_ms, if i < 3 { 0 } else { 1 });
        }
    }
    let done = v.finish().expect("the model was loaded");
    assert!(!done.assign.is_empty(), "the farm's voices are in the final pass");
    assert!(v.take_late().is_none());
}

#[test]
fn a_segment_repaired_late_gets_its_voice_and_goes_through_the_final_pass() {
    let mut v = voices(0, None);
    let first = speak(&mut v, Source::System, 0, &[(1, 2_000)]);
    let second = speak(&mut v, Source::System, 3_000, &[(2, 2_000)]);
    for t in [9_000, 15_000, 21_000] {
        speak(&mut v, Source::System, t, &[(1, 2_000)]);
        speak(&mut v, Source::System, t + 3_000, &[(2, 2_000)]);
    }
    let live = v.current(Source::System);
    // Transcribed again from the saved audio after the meeting moved on.
    let late = speak(&mut v, Source::System, 6_000, &[(1, 2_000)]);
    assert_eq!(late.len(), 1);
    assert!(late[0].speaker_id.is_some(), "a repaired line has a voice");
    assert_eq!(v.current(Source::System), live, "live captions keep the voice heard last");
    let done = v.finish().expect("the model was loaded");
    let moved: BTreeMap<String, u32> = done.assign.iter().cloned().collect();
    let voice = |u: &Utterance| moved.get(&u.id).copied().or(u.speaker_id);
    assert_eq!(voice(&late[0]), voice(&first[0]), "the final pass puts it with the same person");
    assert_ne!(voice(&late[0]), voice(&second[0]), "and not with the other one");
}

#[test]
fn a_late_microphone_copy_of_the_call_is_still_the_call() {
    let mut v = voices(0, None);
    let mut call = Vec::new();
    for i in 0..3u64 {
        let t = i * 4_000;
        call.extend(say(&mut v, Source::System, t, &spoken(2, t, 3_900, 7 + i)));
    }
    let mine = say(&mut v, Source::Mic, 15_000, &spoken(1, 15_000, 6_000, 50));
    // The microphone's copies of the call come back only after Stop.
    let mut leaked = Vec::new();
    for i in 0..3u64 {
        let t = i * 4_000;
        leaked.extend(say(&mut v, Source::Mic, t, &spoken(3, t, 3_900, 7 + i)));
    }
    assert!(!call.is_empty() && mine.len() == 1);
    v.finish().expect("the model was loaded");
    let echoes = v.take_echoes();
    // With the call's levels already known, the copies are heard as the call
    // at once (no line at all) or at the end (removed): never kept.
    for line in &leaked {
        assert!(echoes.contains(&line.id), "{} kept: {echoes:?}", line.id);
    }
    assert!(call.iter().chain(&mine).all(|l| !echoes.contains(&l.id)));
}

#[test]
fn a_late_segment_reaches_nemotron_after_stop() {
    let mut v = voices(0, None).with_nemotron(
        Box::new(Alternate { step: 0 }),
        cap_diarize::nemotron::Schedule::AfterStop,
    );
    let mut lines = Vec::new();
    for i in (0..12u64).filter(|i| *i != 5) {
        lines.extend(speak(&mut v, Source::System, i * 10_000, &[(1, 10_000)]));
    }
    let repaired = speak(&mut v, Source::System, 50_000, &[(1, 10_000)]);
    v.finish().expect("the model was loaded");
    let late = v.take_late().expect("Nemotron hears the meeting after Stop");
    let ids: Vec<&str> = late.lines.iter().map(|l| l.id.as_str()).collect();
    assert!(ids.contains(&repaired[0].id.as_str()), "the repaired line is among the lines Nemotron may move");
    let _ = lines;
}

/// A clip on the call side whose words the farm labelled with `letter`.
fn farm_said(v: &mut Voices, start_ms: u64, person: usize, letter: usize) {
    let samples = audio(&[(person, 2_000)]);
    v.push(Source::System, sample(start_ms), &samples);
    let ws = words(start_ms, 2_000);
    let farm: Vec<(u64, u64, usize)> = ws.iter().map(|w| (w.start_ms, w.end_ms, letter)).collect();
    v.farm_clip(Source::System, &farm);
    v.split(Source::System, sample(start_ms), ws, true);
}

/// The farm voice each person's turns ended up on.
fn farm_voice_of(v: &Voices, spans: &[(u64, u64)]) -> Vec<usize> {
    let mut out: Vec<usize> = v.farm[1]
        .iter()
        .filter(|(a, _, _)| spans.iter().any(|(s, e)| a >= s && a < e))
        .map(|(_, _, voice)| *voice)
        .collect();
    out.dedup();
    out
}

#[test]
fn a_farm_restart_that_swaps_its_letters_keeps_each_person_on_one_voice() {
    let mut v = voices(0, None);
    let (mut one, mut two) = (Vec::new(), Vec::new());
    for i in 0..8u64 {
        let t = i * 6_000;
        // Before the restart A is person 1 and B person 2; after it, swapped.
        let (a, b) = if i < 4 { (0, 1) } else { (1, 0) };
        farm_said(&mut v, t, 1, a);
        farm_said(&mut v, t + 3_000, 2, b);
        one.push((t, t + 2_000));
        two.push((t + 3_000, t + 5_000));
    }
    let p1 = farm_voice_of(&v, &one);
    let p2 = farm_voice_of(&v, &two);
    assert_eq!(p1.len(), 1, "person 1 on one farm voice: {p1:?}");
    assert_eq!(p2.len(), 1, "person 2 on one farm voice: {p2:?}");
    assert_ne!(p1, p2);
}

#[test]
fn backup_letters_that_change_every_clip_still_name_each_person_once() {
    let mut v = voices(0, None);
    let (mut one, mut two) = (Vec::new(), Vec::new());
    for i in 0..8u64 {
        let t = i * 6_000;
        // Each clip names whoever speaks first "A" (after a few clips in
        // which the voices become known).
        let first_is_one = i < 3 || i % 2 == 0;
        let (p_first, p_second) = if first_is_one { (1, 2) } else { (2, 1) };
        farm_said(&mut v, t, p_first, 0);
        farm_said(&mut v, t + 3_000, p_second, 1);
        let (s1, s2) = ((t, t + 2_000), (t + 3_000, t + 5_000));
        if first_is_one {
            one.push(s1);
            two.push(s2);
        } else {
            two.push(s1);
            one.push(s2);
        }
    }
    let p1 = farm_voice_of(&v, &one);
    let p2 = farm_voice_of(&v, &two);
    assert_eq!(p1.len(), 1, "{p1:?}");
    assert_eq!(p2.len(), 1, "{p2:?}");
    assert_ne!(p1, p2);
}
