use super::*;

fn utt(id: &str, source: Source, start: u64, end: u64, text: &str, is_final: bool) -> Utterance {
    Utterance {
        id: id.into(),
        source,
        speaker: None,
        speaker_id: None,
        start_ms: start,
        end_ms: end,
        text: text.into(),
        is_final,
        words: Vec::new(),
    }
}

fn ids(t: &Transcript) -> Vec<&str> {
    t.utterances().iter().map(|u| u.id.as_str()).collect()
}

#[test]
fn upsert_keeps_order_and_finals_replace_partials() {
    let mut t = Transcript::new();
    assert!(t.upsert(utt("b", Source::System, 2_000, 3_000, "hello", false)));
    assert!(t.upsert(utt("a", Source::Mic, 1_000, 1_500, "hi", true)));
    assert!(t.upsert(utt("c", Source::Mic, 2_000, 2_500, "same start", true)));
    assert_eq!(ids(&t), vec!["a", "c", "b"]);
    assert!(t.upsert(utt("b", Source::System, 1_900, 3_100, "hello there", true)));
    assert_eq!(ids(&t), vec!["a", "b", "c"]);
    assert!(!t.upsert(utt(
        "b",
        Source::System,
        1_900,
        3_100,
        "late partial",
        false
    )));
    assert_eq!(t.get("b").unwrap().text, "hello there");
    assert!(!t.upsert(utt("", Source::Mic, 0, 1, "no id", true)));
    assert!(t.upsert(utt(
        "bad",
        Source::Mic,
        5_000,
        4_000,
        "end before start",
        true
    )));
    assert_eq!(t.get("bad").unwrap().end_ms, 5_000);
}

#[test]
fn retract_remove_rename_and_labels() {
    let mut t = Transcript::new();
    t.upsert(utt("p1", Source::Mic, 0, 100, "par", false));
    t.upsert(utt("p2", Source::System, 0, 100, "tial", false));
    t.upsert(utt("f1", Source::System, 200, 300, "final", true));
    assert_eq!(t.retract_partials(Source::Mic), 1);
    assert_eq!(ids(&t), vec!["p2", "f1"]);
    assert_eq!(t.remove(&["p2", "missing"]), 1);
    let mut u = utt("s1", Source::System, 400, 500, "named", true);
    u.speaker = Some("Speaker 1".into());
    t.upsert(u);
    assert_eq!(t.rename_speaker("Speaker 1", "Dana"), 1);
    assert_eq!(t.get("s1").unwrap().speaker.as_deref(), Some("Dana"));
    t.set_speaker_label_for_source(Source::System, Some("  Acme team ".into()));
    assert_eq!(t.label(Source::System, None, None, None), "Acme team");
    assert_eq!(t.label(Source::System, Some("Dana"), None, None), "Dana");
    assert_eq!(t.label(Source::Mic, None, None, None), "You");
    assert_eq!(t.label(Source::Mic, None, None, Some("Richie")), "Richie");
    t.set_speaker_label_for_source(Source::System, Some("   ".into()));
    assert_eq!(t.label(Source::System, None, None, None), "Others");
}

#[test]
fn lookups_by_time() {
    let mut t = Transcript::new();
    t.upsert(utt("a", Source::Mic, 1_000, 2_000, "a", true));
    t.upsert(utt("b", Source::System, 1_500, 4_000, "b", true));
    t.upsert(utt("c", Source::Mic, 5_000, 6_000, "c", true));
    assert_eq!(t.utterance_at(500).map(|u| u.id.as_str()), None);
    assert_eq!(t.utterance_at(1_800).map(|u| u.id.as_str()), Some("b"));
    assert_eq!(t.utterance_at(1_200).map(|u| u.id.as_str()), Some("a"));
    assert_eq!(t.utterance_at(4_500).map(|u| u.id.as_str()), Some("b"));
    assert_eq!(t.utterance_at(10_000).map(|u| u.id.as_str()), Some("c"));
    let in_range: Vec<&str> = t.range(3_000, 5_500).map(|u| u.id.as_str()).collect();
    assert_eq!(in_range, vec!["b", "c"]);
}

#[test]
fn turns_merge_same_speaker_within_gap_only() {
    let mut t = Transcript::new();
    t.upsert(utt("1", Source::Mic, 0, 1_000, "Hello", true));
    t.upsert(utt("2", Source::Mic, 2_500, 3_000, "there.", true));
    t.upsert(utt("3", Source::Mic, 5_000, 6_000, "New turn.", true));
    t.upsert(utt("4", Source::System, 6_500, 7_000, "Hi!", true));
    t.upsert(utt("5", Source::Mic, 7_200, 7_500, "Back to me.", true));
    let mut a = utt("6", Source::System, 7_600, 8_000, "Alice here", true);
    a.speaker = Some("Alice".into());
    t.upsert(a);
    let mut b = utt("7", Source::System, 8_100, 8_500, "Bob here", true);
    b.speaker = Some("Bob".into());
    t.upsert(b);
    t.upsert(utt("8", Source::System, 8_600, 8_700, "   ", true));
    let turns = t.turns();
    let texts: Vec<&str> = turns.iter().map(|t| t.text.as_str()).collect();
    assert_eq!(
        texts,
        vec![
            "Hello there.",
            "New turn.",
            "Hi!",
            "Back to me.",
            "Alice here",
            "Bob here"
        ]
    );
    assert_eq!(turns[0].utterance_ids, vec!["1", "2"]);
    assert_eq!(turns[0].end_ms, 3_000);
}

#[test]
fn minute_groups_split_on_minute_boundaries() {
    let mut t = Transcript::new();
    t.upsert(utt("1", Source::Mic, 10_000, 11_000, "one", true));
    t.upsert(utt("2", Source::System, 59_000, 61_000, "two", true));
    t.upsert(utt("3", Source::Mic, 61_500, 62_000, "three", true));
    t.upsert(utt("4", Source::Mic, 185_000, 186_000, "four", true));
    let groups = t.minute_groups();
    let shape: Vec<(u64, usize)> = groups.iter().map(|g| (g.minute, g.turns.len())).collect();
    assert_eq!(shape, vec![(0, 2), (1, 1), (3, 1)]);
}

#[test]
fn plain_text_export() {
    let mut t = Transcript::new();
    t.upsert(utt("1", Source::Mic, 0, 1_000, "Morning all.", true));
    t.upsert(utt("2", Source::System, 65_000, 66_000, "Morning!", true));
    t.upsert(utt(
        "3",
        Source::System,
        3_700_000,
        3_701_000,
        "Wrapping up.",
        true,
    ));
    let header = Header {
        title: "Weekly sync".into(),
        date: Some("12 Nov 2026".into()),
        participants: vec!["Richie".into(), " ".into(), "Dana".into()],
        self_name: Some("Richie".into()),
    };
    assert_eq!(
        t.to_plain_text(&header),
        "Weekly sync\n12 Nov 2026\nParticipants: Richie, Dana\n\n[00:00] Richie: Morning all.\n[01:05] Others: Morning!\n[1:01:40] Others: Wrapping up.\n"
    );
    assert_eq!(
        t.to_plain_text(&Header::default()),
        "[00:00] You: Morning all.\n[01:05] Others: Morning!\n[1:01:40] Others: Wrapping up.\n"
    );
}

#[test]
fn prompt_budget_keeps_most_recent_text() {
    let mut t = Transcript::new();
    for i in 0..20u64 {
        let source = if i % 2 == 0 {
            Source::Mic
        } else {
            Source::System
        };
        t.upsert(utt(
            &format!("u{i}"),
            source,
            i * 10_000,
            i * 10_000 + 1_000,
            &format!("line number {i} with some words"),
            true,
        ));
    }
    let full = t.labelled_for_prompt(usize::MAX, None);
    assert!(!full.truncated);
    assert!(full.text.starts_with("You: line number 0"));
    assert!(
        full.text
            .ends_with("Others: line number 19 with some words")
    );

    let budget = 120;
    let cut = t.labelled_for_prompt(budget, Some("Richie"));
    assert!(cut.truncated);
    assert!(cut.text.chars().count() <= budget, "{}", cut.text);
    assert!(cut.text.ends_with("Others: line number 19 with some words"));
    assert!(cut.text.starts_with('\u{2026}'));
    assert!(!cut.text.contains("number 0 "));

    let tiny = t.labelled_for_prompt(1, None);
    assert!(tiny.truncated);
    assert!(tiny.text.is_empty());
    assert_eq!(Transcript::new().labelled_for_prompt(0, None).text, "");
}

#[test]
fn a_meeting_too_long_for_the_prompt_keeps_its_start_and_end() {
    let mut t = Transcript::new();
    for i in 0..1_000u64 {
        t.upsert(utt(
            &format!("u{i}"),
            if i % 2 == 0 {
                Source::Mic
            } else {
                Source::System
            },
            i * 10_000,
            i * 10_000 + 1_000,
            &format!("line number {i} with some words"),
            true,
        ));
    }
    let full = t.labelled_for_prompt(usize::MAX, None);
    let budget = full.text.chars().count() / 3;
    let cut = t.labelled_for_prompt(budget, None);
    assert!(cut.truncated);
    assert!(cut.text.chars().count() <= budget);
    let lines: Vec<&str> = cut.text.lines().collect();
    assert_eq!(lines[0], "You: line number 0 with some words");
    assert_eq!(
        *lines.last().unwrap(),
        "Others: line number 999 with some words"
    );
    assert_eq!(
        lines
            .iter()
            .filter(|l| **l == super::MIDDLE_LEFT_OUT)
            .count(),
        1
    );
    let marker = lines
        .iter()
        .position(|l| *l == super::MIDDLE_LEFT_OUT)
        .unwrap();
    // Whole lines on both sides, about half the room each.
    assert!(lines.iter().all(|l| *l == super::MIDDLE_LEFT_OUT
        || l.starts_with("You: line number ")
        || l.starts_with("Others: line number ")));
    let start: usize = lines[..marker].iter().map(|l| l.len() + 1).sum();
    let end: usize = lines[marker + 1..].iter().map(|l| l.len() + 1).sum();
    assert!(start.abs_diff(end) < 100, "start {start} end {end}");
    assert!(!cut.text.contains("line number 500 "));

    // Just over the budget: still whole lines, nothing invented.
    let near = t.labelled_for_prompt(full.text.chars().count() - 1, None);
    assert!(near.truncated);
    assert!(near.text.contains(super::MIDDLE_LEFT_OUT));
    assert!(near.text.starts_with("You: line number 0 "));
    assert!(near.text.ends_with("line number 999 with some words"));

    // Within the budget nothing changes.
    let exact = t.labelled_for_prompt(full.text.chars().count(), None);
    assert!(!exact.truncated);
    assert_eq!(exact.text, full.text);
}

#[test]
fn search_is_case_insensitive_with_snippets() {
    let mut t = Transcript::new();
    t.upsert(utt(
        "1",
        Source::Mic,
        0,
        1_000,
        "We should ship the Ölfeld release on Friday",
        true,
    ));
    t.upsert(utt("2", Source::System, 2_000, 3_000, "Nothing here", true));
    let hits = t.search("ÖLFELD release");
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].utterance_id, "1");
    let (start, end) = hits[0].byte_range;
    assert_eq!(&t.get("1").unwrap().text[start..end], "Ölfeld release");
    assert!(hits[0].snippet.contains("Ölfeld release"));
    assert!(t.search("   ").is_empty());
    assert!(t.search("absent").is_empty());
}

#[test]
fn stats_cover_sources() {
    let mut t = Transcript::new();
    t.upsert(utt("1", Source::Mic, 0, 1_000, "abc", true));
    t.upsert(utt("2", Source::System, 2_000, 4_500, "défg", true));
    let stats = t.stats();
    assert_eq!(stats.utterances, 2);
    assert_eq!(stats.total_chars, 7);
    assert_eq!(stats.mic_speech_ms, 1_000);
    assert_eq!(stats.system_speech_ms, 2_500);
    assert_eq!(stats.last_speech_end_ms, Some(4_500));
}

#[test]
fn echo_suppression_removes_loudspeaker_duplicates() {
    let mut t = Transcript::new();
    t.upsert(utt(
        "far1",
        Source::System,
        10_000,
        14_000,
        "So the plan is to launch on Tuesday, right?",
        true,
    ));
    t.upsert(utt(
        "echo1",
        Source::Mic,
        10_400,
        14_200,
        "so the plan is to launch Tuesday right",
        true,
    ));
    t.upsert(utt(
        "me1",
        Source::Mic,
        15_000,
        16_000,
        "Yes, Tuesday works for me.",
        true,
    ));
    t.upsert(utt("far2", Source::System, 20_000, 21_000, "Great.", true));
    t.upsert(utt(
        "long",
        Source::Mic,
        20_200,
        25_000,
        "Great. Also I wanted to raise the budget question before we finish today",
        true,
    ));
    t.upsert(utt(
        "far3",
        Source::System,
        30_000,
        31_000,
        "Can you hear me",
        true,
    ));
    t.upsert(utt(
        "late",
        Source::Mic,
        40_000,
        41_000,
        "can you hear me",
        true,
    ));
    t.upsert(utt(
        "far4a",
        Source::System,
        50_000,
        51_000,
        "First half of",
        true,
    ));
    t.upsert(utt(
        "far4b",
        Source::System,
        51_100,
        52_000,
        "a split sentence",
        true,
    ));
    t.upsert(utt(
        "echo2",
        Source::Mic,
        50_500,
        52_400,
        "first half of a split sentence",
        true,
    ));
    t.upsert(utt(
        "reordered",
        Source::Mic,
        30_000,
        31_000,
        "me hear you can",
        true,
    ));
    let removed = t.suppress_echo(&EchoConfig::default());
    assert_eq!(removed, vec!["echo1".to_string(), "echo2".to_string()]);
    assert!(t.get("me1").is_some());
    assert!(t.get("long").is_some());
    assert!(t.get("late").is_some());
    assert!(t.get("reordered").is_some());
    assert!(t.suppress_echo(&EchoConfig::default()).is_empty());
}

fn timed(id: &str, source: Source, start: u64, text: &str, word_ms: u64) -> Utterance {
    let words: Vec<Word> = text
        .split_whitespace()
        .enumerate()
        .map(|(i, w)| Word {
            text: w.into(),
            start_ms: start + i as u64 * word_ms,
            end_ms: start + (i as u64 + 1) * word_ms,
        })
        .collect();
    let end = words.last().map_or(start, |w| w.end_ms);
    Utterance {
        words,
        ..utt(id, source, start, end, text, true)
    }
}

#[test]
fn short_replies_inside_far_speech_survive() {
    let far_text = "Yes, that's right, and then we ship";
    let replies = [
        "Yes.",
        "Okay",
        "Right",
        "Yes, that's right",
        "Ship it",
        "Then we ship",
    ];
    let offsets = [
        13_500, 14_000, 14_100, 14_400, 15_000, 15_600, 15_900, 16_200,
    ];
    for (heard, with_words) in [(false, false), (false, true), (true, false), (true, true)] {
        let config = EchoConfig {
            short_echoes: heard,
            ..EchoConfig::default()
        };
        for reply in replies {
            for offset in offsets {
                let mut t = Transcript::new();
                if with_words {
                    t.upsert(timed("far", Source::System, 14_000, far_text, 285));
                    t.upsert(timed("me", Source::Mic, offset, reply, 300));
                } else {
                    t.upsert(utt("far", Source::System, 14_000, 16_000, far_text, true));
                    t.upsert(utt("me", Source::Mic, offset, offset + 400, reply, true));
                }
                let removed = t.suppress_echo(&config);
                // The call's own words at the moment it said them, within
                // the echo delay, in a meeting whose microphone is known to
                // hear the call: what the speakers play back, not a reply.
                let copy = heard && with_words && SHORT_COPIES.contains(&(reply, offset));
                assert_eq!(
                    removed.is_empty(),
                    !copy,
                    "{reply:?} at {offset} (words: {with_words}, call heard: {heard})"
                );
                assert_eq!(t.get("me").is_some(), !copy);
            }
        }
    }
}

/// In the sweep above, the replies whose every word the far line says
/// within the short echo window (250 ms before to 300 ms after).
const SHORT_COPIES: [(&str, u64); 6] = [
    ("Yes.", 14_000),
    ("Yes.", 14_100),
    ("Right", 14_400),
    ("Yes, that's right", 14_000),
    ("Yes, that's right", 14_100),
    ("Then we ship", 15_000),
];

/// A sentence that comes back through the speakers starts on the microphone
/// while the call is still saying it. Someone reading the call back waits
/// for it to finish: their words stay, and are no evidence the microphone
/// hears the call.
#[test]
fn only_an_echo_over_the_call_shows_the_microphone_hears_it() {
    for numbers in ["Four one five two nine.", "Anna, Ben, Chris and Dana."] {
        for gap in [0, 150, 600] {
            let mut t = Transcript::new();
            t.upsert(timed("far", Source::System, 10_000, numbers, 220));
            t.upsert(timed("back", Source::Mic, 11_100 + gap, numbers, 320));
            let report = t.suppress_echo_report(&EchoConfig::default());
            assert!(
                report.removed.is_empty() && !report.heard,
                "{numbers} {gap}"
            );
            assert!(t.get("back").is_some());
        }
    }
    let call = "The squire was not pleased with the answer.";
    for lag in [0, 60, 320] {
        let mut t = Transcript::new();
        t.upsert(timed("far", Source::System, 10_000, call, 280));
        t.upsert(timed("echo", Source::Mic, 10_000 + lag, call, 280));
        let report = t.suppress_echo_report(&EchoConfig::default());
        assert_eq!(report.removed, vec!["echo".to_string()], "{lag}");
        assert!(report.heard, "{lag}");
    }
}

/// A headset: nothing of the call reaches the microphone, and the person
/// answers "Yes." a tenth of a second after the other side's "Yes, good."
/// Without evidence that the microphone hears the call, that stays theirs.
#[test]
fn a_headset_backchannel_over_the_same_word_is_kept() {
    let mut t = Transcript::new();
    t.upsert(timed(
        "far",
        Source::System,
        14_000,
        "Yes, good. Let's ship it.",
        280,
    ));
    t.upsert(timed("me", Source::Mic, 14_100, "Yes.", 300));
    t.upsert(timed(
        "far2",
        Source::System,
        20_000,
        "Right, thanks everyone.",
        280,
    ));
    t.upsert(timed("me2", Source::Mic, 20_050, "Right, thanks.", 300));
    assert!(t.suppress_echo(&EchoConfig::default()).is_empty());
    assert!(t.get("me").is_some() && t.get("me2").is_some());
}

/// Short echoes from real meetings played through laptop speakers: the mic
/// heard the call's words within 60 ms of the call track, as one to three
/// word lines the sentence check never compared.
#[test]
fn short_echoes_of_the_call_are_removed() {
    let mut t = Transcript::new();
    t.upsert(timed(
        "far1",
        Source::System,
        25_640,
        "Soft heart, he said gently to her.",
        300,
    ));
    t.upsert(timed("echo1", Source::Mic, 25_620, "Soft heart,", 300));
    t.upsert(timed(
        "far2",
        Source::System,
        36_000,
        "Je propose une décision. Merci.",
        300,
    ));
    t.upsert(timed("echo2", Source::Mic, 37_260, "Merci.", 300));
    t.upsert(timed(
        "far3",
        Source::System,
        80_000,
        "He has come over the ocean for rest, and change of scene.",
        250,
    ));
    t.upsert(timed("echo3", Source::Mic, 82_710, "scene.", 250));
    // The user's own short replies while the call talks: other words, the
    // same word well after the call said it, or no word times to compare.
    t.upsert(timed("reply1", Source::Mic, 26_000, "Okay.", 300));
    t.upsert(timed("reply2", Source::Mic, 27_400, "Gently.", 300));
    t.upsert(utt("reply3", Source::Mic, 37_200, 37_600, "Merci.", true));
    let heard = EchoConfig {
        short_echoes: true,
        ..EchoConfig::default()
    };
    let removed = t.suppress_echo(&heard);
    assert_eq!(removed, vec!["echo1", "echo2", "echo3"]);
    for id in ["reply1", "reply2", "reply3"] {
        assert!(t.get(id).is_some(), "{id} was removed");
    }
}

#[test]
fn delayed_echo_of_a_long_sentence_is_removed() {
    let far_text = "We should move the launch to next Thursday because the vendor needs more time";
    let echo_text = "we should move the lunch to next Thursday because the vendors needs more time";
    for delay in [100, 250, 400] {
        for with_words in [false, true] {
            let mut t = Transcript::new();
            if with_words {
                t.upsert(timed("far", Source::System, 30_000, far_text, 320));
                t.upsert(timed("echo", Source::Mic, 30_000 + delay, echo_text, 330));
            } else {
                t.upsert(utt("far", Source::System, 30_000, 34_500, far_text, true));
                t.upsert(utt(
                    "echo",
                    Source::Mic,
                    30_000 + delay,
                    34_700 + delay,
                    echo_text,
                    true,
                ));
            }
            t.upsert(utt(
                "reply",
                Source::Mic,
                35_500,
                36_000,
                "Okay sounds good",
                true,
            ));
            let removed = t.suppress_echo(&EchoConfig::default());
            assert_eq!(
                removed,
                vec!["echo".to_string()],
                "delay {delay} words {with_words}"
            );
            assert!(t.get("reply").is_some());
        }
    }
}

#[test]
fn simultaneous_or_earlier_speech_is_kept() {
    let far_text = "We should move the launch to next Thursday because the vendor needs more time";
    let mut t = Transcript::new();
    t.upsert(timed("far", Source::System, 30_000, far_text, 320));
    t.upsert(timed(
        "talk",
        Source::Mic,
        30_000,
        "sorry I think the budget question matters more than the date here",
        310,
    ));
    t.upsert(timed(
        "first",
        Source::Mic,
        28_800,
        "we should move the launch to next Thursday",
        300,
    ));
    let removed = t.suppress_echo(&EchoConfig::default());
    assert!(removed.is_empty(), "{removed:?}");
    assert_eq!(t.len(), 3);
}

#[test]
fn stats_saturate_on_hostile_durations() {
    let mut t = Transcript::new();
    t.upsert(utt("a", Source::Mic, 0, u64::MAX - 1, "x", true));
    t.upsert(utt("b", Source::Mic, 1, u64::MAX, "y", true));
    t.upsert(utt("c", Source::System, 0, u64::MAX, "z", true));
    t.upsert(utt("d", Source::System, 0, u64::MAX, "w", true));
    let stats = t.stats();
    assert_eq!(stats.mic_speech_ms, u64::MAX);
    assert_eq!(stats.system_speech_ms, u64::MAX);
    assert_eq!(stats.last_speech_end_ms, Some(u64::MAX));
}

#[test]
fn jsonl_round_trip_with_edits() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("transcript.jsonl");
    let mut a = utt("a", Source::Mic, 0, 1_000, "hello", true);
    a.words = vec![Word {
        text: "hello".into(),
        start_ms: 0,
        end_ms: 900,
    }];
    let mut s = utt("s", Source::System, 1_000, 2_000, "hi", true);
    s.speaker = Some("Speaker 1".into());
    append_jsonl(
        &path,
        &[LogLine::Upsert {
            utterance: a.clone(),
        }],
    )
    .unwrap();
    append_jsonl(&path, &[LogLine::Upsert { utterance: s }]).unwrap();
    append_jsonl(
        &path,
        &[
            LogLine::RenameSpeaker {
                from: "Speaker 1".into(),
                to: "Dana".into(),
            },
            LogLine::Upsert {
                utterance: utt("b", Source::Mic, 3_000, 4_000, "bye", true),
            },
            LogLine::Delete {
                ids: vec!["b".into()],
            },
            LogLine::SourceLabel {
                source: Source::System,
                label: Some("Acme".into()),
            },
        ],
    )
    .unwrap();
    append_jsonl(&path, &[]).unwrap();
    let (t, report) = Transcript::load_jsonl(&path).unwrap();
    assert_eq!(
        report,
        LoadReport {
            lines: 6,
            skipped: 0
        }
    );
    assert_eq!(ids(&t), vec!["a", "s"]);
    assert_eq!(t.get("a").unwrap(), &a);
    assert_eq!(t.get("s").unwrap().speaker.as_deref(), Some("Dana"));
    assert_eq!(t.speaker_label_for_source(Source::System), Some("Acme"));

    let path2 = dir.path().join("compact.jsonl");
    append_jsonl(&path2, &t.to_log_lines()).unwrap();
    let (t2, _) = Transcript::load_jsonl(&path2).unwrap();
    assert_eq!(t2, t);
}

#[test]
fn loader_tolerates_torn_lines_unknown_fields_and_ops() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("transcript.jsonl");
    let content = concat!(
        "{\"op\":\"upsert\",\"utterance\":{\"id\":\"a\",\"source\":\"mic\",\"startMs\":0,\"endMs\":5,\"text\":\"x\",\"isFinal\":true,\"newField\":[1,2]}}\n",
        "{\"id\":\"bare\",\"source\":\"system\",\"startMs\":10,\"endMs\":20,\"text\":\"legacy line\",\"isFinal\":true}\n",
        "{\"op\":\"futureOp\",\"payload\":1}\n",
        "{\"op\":\"upsert\",\"utterance\":{\"id\":\"weird\",\"source\":\"satellite\",\"text\":\"unknown source\"}}\n",
        "not json at all\n",
        "\n",
        "[1,2,3]\n",
        "{\"text\":\"no id\"}\n",
        "{\"op\":\"upsert\",\"utterance\":{\"id\":\"torn\",\"te"
    );
    std::fs::write(&path, content).unwrap();
    let (t, report) = Transcript::load_jsonl(&path).unwrap();
    assert_eq!(ids(&t), vec!["a", "weird", "bare"]);
    assert_eq!(t.get("weird").unwrap().source, Source::Mic);
    assert_eq!(report.lines, 8);
    assert_eq!(report.skipped, 5);

    append_jsonl(
        &path,
        &[LogLine::Upsert {
            utterance: utt("after", Source::Mic, 30, 40, "after tear", true),
        }],
    )
    .unwrap();
    let (t, _) = Transcript::load_jsonl(&path).unwrap();
    assert!(
        t.get("after").is_some(),
        "append after a torn line must start a new line"
    );

    let missing = dir.path().join("nope.jsonl");
    let (t, report) = Transcript::load_jsonl(&missing).unwrap();
    assert!(t.is_empty());
    assert_eq!(report, LoadReport::default());

    let binary = dir.path().join("binary.jsonl");
    std::fs::write(&binary, [0xff, 0xfe, b'\n', 0x00, 0x01]).unwrap();
    let (t, report) = Transcript::load_jsonl(&binary).unwrap();
    assert!(t.is_empty());
    assert_eq!(report.skipped, 2);
}

#[test]
fn utterance_json_is_camel_case() {
    let json = serde_json::to_string(&utt("a", Source::System, 1, 2, "t", true)).unwrap();
    assert!(json.contains("\"startMs\":1"));
    assert!(json.contains("\"isFinal\":true"));
    assert!(json.contains("\"source\":\"system\""));
    let line = serde_json::to_string(&LogLine::RenameSpeaker {
        from: "a".into(),
        to: "b".into(),
    })
    .unwrap();
    assert_eq!(
        line,
        "{\"op\":\"renameSpeaker\",\"from\":\"a\",\"to\":\"b\"}"
    );
}

#[test]
fn timestamps_format() {
    assert_eq!(format_timestamp(0), "00:00");
    assert_eq!(format_timestamp(59_999), "00:59");
    assert_eq!(format_timestamp(3_599_000), "59:59");
    assert_eq!(format_timestamp(3_600_000), "1:00:00");
    assert_eq!(format_timestamp(u64::MAX), format_timestamp(u64::MAX));
}

fn voiced(id: &str, source: Source, start: u64, text: &str, speaker: u32) -> Utterance {
    Utterance {
        speaker_id: Some(speaker),
        ..utt(id, source, start, start + 1_000, text, true)
    }
}

fn info(id: u32, track: cap_diarize::Track, first_ms: u64, is_user: bool) -> cap_diarize::SpeakerInfo {
    cap_diarize::SpeakerInfo {
        id: SpeakerId(id),
        track,
        first_ms,
        speech_ms: 10_000,
        is_user,
    }
}

fn names_for(speakers: &[cap_diarize::SpeakerInfo]) -> SpeakerNames {
    let mut names = SpeakerNames::new(None);
    names.observe(speakers);
    names
}

#[test]
fn documents_without_voices_load_and_label_as_before() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("transcript.jsonl");
    std::fs::write(
        &path,
        concat!(
            r#"{"op":"upsert","utterance":{"id":"m1","source":"mic","startMs":0,"endMs":900,"text":"Hello","isFinal":true}}"#,
            "\n",
            r#"{"op":"upsert","utterance":{"id":"s1","source":"system","speakerId":"oops","startMs":1000,"endMs":1900,"text":"Hi","isFinal":true}}"#,
            "\n",
        ),
    )
    .unwrap();
    let (t, report) = Transcript::load_jsonl(&path).unwrap();
    assert_eq!(report.skipped, 0);
    assert_eq!(t.len(), 2);
    assert!(t.utterances().iter().all(|u| u.speaker_id.is_none()));
    assert!(t.names().is_none());
    let turns = t.turns();
    assert_eq!(t.turn_speaker(&turns[0]), SpeakerLabel::User);
    assert_eq!(t.turn_speaker(&turns[1]), SpeakerLabel::Others);
    let json = serde_json::to_string(&utt("x", Source::Mic, 0, 1, "a", true)).unwrap();
    assert!(!json.contains("speakerId"), "{json}");
}

#[test]
fn voices_split_turns_and_resolve_to_user_people_and_names() {
    use cap_diarize::Track;
    let mut t = Transcript::new();
    t.upsert(voiced("m1", Source::Mic, 0, "Morning.", 1));
    t.upsert(voiced("s1", Source::System, 1_200, "Hi, Dana here.", 2));
    t.upsert(voiced("s2", Source::System, 2_400, "And Sam.", 3));
    t.upsert(voiced("s3", Source::System, 3_600, "Back to Dana.", 2));
    t.set_names(names_for(&[
        info(1, Track::Mic, 0, true),
        info(2, Track::System, 1_200, false),
        info(3, Track::System, 2_400, false),
    ]));
    let turns = t.turns();
    assert_eq!(turns.len(), 4, "a new voice on the same track is a new turn");
    let labels: Vec<SpeakerLabel> = turns.iter().map(|turn| t.turn_speaker(turn)).collect();
    assert_eq!(
        labels,
        vec![
            SpeakerLabel::User,
            SpeakerLabel::Person(1),
            SpeakerLabel::Person(2),
            SpeakerLabel::Person(1),
        ]
    );
    assert_eq!(
        t.labelled_for_prompt(usize::MAX, Some("Richie")).text,
        "Richie: Morning.\nPerson 1: Hi, Dana here.\nPerson 2: And Sam.\nPerson 1: Back to Dana."
    );

    let mut names = t.names().cloned().unwrap();
    names.rename(SpeakerId(2), "Dana");
    t.apply(LogLine::SpeakerNames { names });
    assert_eq!(
        t.labelled_for_prompt(usize::MAX, None).text,
        "You: Morning.\nDana: Hi, Dana here.\nPerson 2: And Sam.\nDana: Back to Dana."
    );
    assert_eq!(
        t.named_speakers(Some("Richie")),
        vec![("Richie".to_string(), true), ("Dana".to_string(), false)]
    );
}

#[test]
fn final_pass_relabels_utterances_and_renames_follow_merges() {
    use cap_diarize::{FinalPass, Track};
    let mut t = Transcript::new();
    t.upsert(voiced("m1", Source::Mic, 0, "Morning.", 1));
    t.upsert(voiced("s1", Source::System, 1_200, "Dana speaking.", 2));
    t.upsert(voiced("s2", Source::System, 2_400, "Still Dana.", 3));
    let live = [
        info(1, Track::Mic, 0, true),
        info(2, Track::System, 1_200, false),
        info(3, Track::System, 2_400, false),
    ];
    let mut names = names_for(&live);
    names.rename(SpeakerId(3), "Dana");
    t.apply(LogLine::SpeakerNames {
        names: names.clone(),
    });
    assert_eq!(t.turns().len(), 3);

    let pass = FinalPass {
        merged: vec![(SpeakerId(3), SpeakerId(2))],
        speakers: vec![live[0].clone(), live[1].clone()],
        user: Some(SpeakerId(1)),
        ..FinalPass::default()
    };
    names.apply_final(&pass);
    t.apply(LogLine::Speakers {
        assign: vec![("s2".into(), 2)],
    });
    t.apply(LogLine::SpeakerNames { names });
    let turns = t.turns();
    assert_eq!(turns.len(), 2);
    assert_eq!(t.turn_speaker(&turns[1]), SpeakerLabel::Named("Dana".into()));
    assert_eq!(turns[1].text, "Dana speaking. Still Dana.");
}

#[test]
fn voice_lines_round_trip_through_the_log() {
    use cap_diarize::Track;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("transcript.jsonl");
    let mut names = names_for(&[info(4, Track::System, 0, false)]);
    names.rename(SpeakerId(4), "Ana");
    append_jsonl(
        &path,
        &[
            LogLine::Upsert {
                utterance: voiced("s1", Source::System, 0, "Hola", 7),
            },
            LogLine::Speakers {
                assign: vec![("s1".into(), 4), ("missing".into(), 9)],
            },
            LogLine::SpeakerNames { names },
        ],
    )
    .unwrap();
    let (t, report) = Transcript::load_jsonl(&path).unwrap();
    assert_eq!(report.skipped, 0);
    assert_eq!(t.utterances()[0].speaker_id, Some(4));
    assert_eq!(
        t.turn_speaker(&t.turns()[0]),
        SpeakerLabel::Named("Ana".into())
    );
    let copy = dir.path().join("copy.jsonl");
    append_jsonl(&copy, &t.to_log_lines()).unwrap();
    let (again, _) = Transcript::load_jsonl(&copy).unwrap();
    assert_eq!(again, t);
    assert_eq!(t.max_speaker_id(), 4);
    assert_eq!(t.speaking_ids(), vec![4]);
}

#[test]
fn a_typed_name_wins_and_unknown_voices_fall_back_to_the_track() {
    use cap_diarize::Track;
    let mut t = Transcript::new();
    let mut typed = voiced("s1", Source::System, 0, "Hi", 2);
    typed.speaker = Some("Jo".into());
    t.upsert(typed);
    t.upsert(voiced("s2", Source::System, 3_000, "Who am I", 8));
    t.upsert(voiced("m1", Source::Mic, 6_000, "Me", 9));
    t.set_names(names_for(&[info(2, Track::System, 0, false)]));
    let labels: Vec<SpeakerLabel> = t.turns().iter().map(|x| t.turn_speaker(x)).collect();
    assert_eq!(
        labels,
        vec![
            SpeakerLabel::Named("Jo".into()),
            SpeakerLabel::Others,
            SpeakerLabel::User
        ]
    );
}

fn gap(source: Source, start: u64, end: u64) -> Gap {
    Gap {
        id: Gap::id_for(source, start),
        source,
        start_sample: start,
        end_sample: end,
        segments: vec![(start, end - start)],
        reason: "dropped".into(),
    }
}

#[test]
fn gaps_survive_the_file_and_close_by_id() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("transcript.jsonl");
    let a = gap(Source::Mic, 16_000, 48_000);
    let b = gap(Source::System, 160_000, 200_000);
    append_jsonl(
        &path,
        &[
            LogLine::Gap { gap: a.clone() },
            LogLine::Gap { gap: b.clone() },
            LogLine::GapClosed { ids: vec![a.id.clone()] },
        ],
    )
    .unwrap();
    let (t, report) = Transcript::load_jsonl(&path).unwrap();
    assert_eq!(report.skipped, 0);
    assert_eq!(t.gaps(), &[b.clone()]);
    let copy = dir.path().join("compact.jsonl");
    append_jsonl(&copy, &t.to_log_lines()).unwrap();
    let (t2, _) = Transcript::load_jsonl(&copy).unwrap();
    assert_eq!(t2.gaps(), &[b]);
}

#[test]
fn a_gap_again_replaces_itself_and_an_empty_one_is_ignored() {
    let mut t = Transcript::new();
    let mut a = gap(Source::Mic, 0, 100);
    t.apply(LogLine::Gap { gap: a.clone() });
    a.end_sample = 400;
    t.apply(LogLine::Gap { gap: a.clone() });
    assert_eq!(t.gaps(), &[a]);
    t.apply(LogLine::Gap { gap: gap(Source::Mic, 50, 51) });
    t.apply(LogLine::Gap {
        gap: Gap { id: "x".into(), start_sample: 9, end_sample: 9, ..Gap::default() },
    });
    assert_eq!(t.gaps().len(), 2);
    assert_eq!(t.close_gaps(&["nope"]), 0);
}

#[test]
fn readers_without_the_ledger_skip_its_lines() {
    let line = serde_json::to_string(&LogLine::Gap { gap: gap(Source::Mic, 0, 10) }).unwrap();
    assert!(line.contains("\"op\":\"gap\""));
    let closed = serde_json::to_string(&LogLine::GapClosed { ids: vec!["gm0".into()] }).unwrap();
    assert!(closed.contains("\"op\":\"gapClosed\""));
}

/// A voice left out of the notes keeps its lines in the transcript but is
/// never in what a summary or Ask is given, nor among the people heard. The
/// choice is kept in the log, follows a rename, and can be undone.
#[test]
fn a_voice_left_out_of_the_notes_stays_in_the_transcript_only() {
    let mut t = Transcript::new();
    t.upsert(utt("m1", Source::Mic, 0, 1_000, "Let's start.", true));
    let mut tv = utt("s1", Source::System, 5_000, 6_000, "Dinner is ready!", true);
    tv.speaker_id = Some(7);
    t.upsert(tv);
    let mut named = utt(
        "s2",
        Source::System,
        10_000,
        11_000,
        "Budget looks fine.",
        true,
    );
    named.speaker = Some("Ana".into());
    t.upsert(named);
    let mut names = SpeakerNames::new(None);
    names.observe(&[cap_diarize::SpeakerInfo {
        id: SpeakerId(7),
        track: cap_diarize::Track::System,
        first_ms: 5_000,
        speech_ms: 1_000,
        is_user: false,
    }]);
    names.set_left_out(SpeakerId(7), true);
    t.set_names(names);
    t.apply(LogLine::LeaveOut {
        voice: Voice::Named("Ana".into()),
        out: true,
        forget: false,
    });
    let prompt = t.labelled_for_prompt(usize::MAX, Some("Richie")).text;
    assert!(prompt.contains("Let's start."), "{prompt}");
    assert!(
        !prompt.contains("Dinner") && !prompt.contains("Budget"),
        "{prompt}"
    );
    assert_eq!(t.len(), 3, "every line stays in the transcript");
    assert!(
        !t.named_speakers(Some("Richie"))
            .iter()
            .any(|(name, _)| name == "Ana")
    );

    // A rename carries the choice; the log keeps it across a reload.
    t.rename_speaker("Ana", "Ana Ruiz");
    assert!(t.is_left_out(Source::System, Some("Ana Ruiz"), None));
    let mut reloaded = Transcript::new();
    for line in t.to_log_lines() {
        let json = serde_json::to_string(&line).unwrap();
        reloaded.apply(parse_line(&json).expect("a line this version reads"));
    }
    assert_eq!(reloaded, t);
    let line = serde_json::to_string(&LogLine::LeaveOut {
        voice: Voice::Source(Source::Mic),
        out: true,
        forget: false,
    })
    .unwrap();
    assert_eq!(
        line,
        r#"{"op":"leaveOut","voice":{"kind":"source","value":"mic"},"out":true}"#
    );

    // Taking it back in puts the lines back in the prompt.
    t.apply(LogLine::LeaveOut {
        voice: Voice::Named("Ana Ruiz".into()),
        out: false,
        forget: false,
    });
    assert!(
        t.labelled_for_prompt(usize::MAX, None)
            .text
            .contains("Budget")
    );
}

/// The most specific choice decides whether a line is left out: its own
/// name, then its told-apart voice, then its track. A line moved to a name
/// with "Just this line" keeps its voice's choice until the name has one,
/// and a voice put back in stays in when its track was left out from an
/// unidentified line. Forgetting a choice puts things back exactly.
#[test]
fn the_most_specific_voice_choice_decides_what_is_left_out() {
    use cap_diarize::Track;
    let mut t = Transcript::new();
    let line = |id: &str, start: u64, text: &str, name: Option<&str>, voice: Option<u32>| {
        let mut u = utt(id, Source::System, start, start + 1_000, text, true);
        u.speaker = name.map(str::to_string);
        u.speaker_id = voice;
        u
    };
    t.upsert(line("s1", 0, "Moved to Bob.", Some("Bob"), Some(7)));
    t.upsert(line("s2", 4_000, "Voice seven.", None, Some(7)));
    t.upsert(line("s3", 8_000, "Voice eight.", None, Some(8)));
    t.upsert(line("s4", 12_000, "Nobody knows me.", None, None));
    let mut names = SpeakerNames::new(None);
    names.observe(&[
        cap_diarize::SpeakerInfo {
            id: SpeakerId(7),
            track: Track::System,
            first_ms: 0,
            speech_ms: 1_000,
            is_user: false,
        },
        cap_diarize::SpeakerInfo {
            id: SpeakerId(8),
            track: Track::System,
            first_ms: 8_000,
            speech_ms: 1_000,
            is_user: false,
        },
    ]);
    names.set_left_out(SpeakerId(7), true);
    t.set_names(names);
    let prompt = |t: &Transcript| t.labelled_for_prompt(usize::MAX, None).text;
    let all_in = |t: &Transcript, words: &[&str]| words.iter().all(|w| prompt(t).contains(w));
    let none_in = |t: &Transcript, words: &[&str]| !words.iter().any(|w| prompt(t).contains(w));

    // The moved line keeps its voice's choice.
    assert!(t.is_left_out(Source::System, Some("Bob"), Some(7)));
    assert!(
        none_in(&t, &["Moved to Bob", "Voice seven"]),
        "{}",
        prompt(&t)
    );
    assert!(all_in(&t, &["Voice eight", "Nobody knows me"]));
    assert!(!t.named_speakers(None).iter().any(|(name, _)| name == "Bob"));
    // Its own name decides once it has a choice, and forgetting it undoes that.
    t.apply(LogLine::leave_out(Voice::Named("Bob".into()), Some(false)));
    assert!(all_in(&t, &["Moved to Bob"]) && none_in(&t, &["Voice seven"]));
    t.apply(LogLine::leave_out(Voice::Named("Bob".into()), None));
    assert_eq!(t.voice_choice(&Voice::Named("Bob".into())), None);
    assert!(none_in(&t, &["Moved to Bob"]));

    // A track left out from an unidentified line takes voices with no
    // choice of their own along...
    let before = t.clone();
    t.apply(LogLine::leave_out(
        Voice::Source(Source::System),
        Some(true),
    ));
    assert!(
        none_in(&t, &["Nobody knows me", "Voice eight"]),
        "{}",
        prompt(&t)
    );
    // ...but a voice put back in stays in.
    let mut names = t.names().unwrap().clone();
    names.set_left_out(SpeakerId(8), false);
    t.set_names(names);
    assert!(all_in(&t, &["Voice eight"]) && none_in(&t, &["Nobody knows me"]));
    let mut names = t.names().unwrap().clone();
    names.choose_left_out(SpeakerId(8), None);
    t.set_names(names);
    assert!(none_in(&t, &["Voice eight"]));
    t.apply(LogLine::leave_out(Voice::Source(Source::System), None));
    assert_eq!(t, before, "forgetting both choices puts it back exactly");

    // Every choice survives a reload, a put-back-in one too.
    t.apply(LogLine::leave_out(Voice::Named("Bob".into()), Some(false)));
    t.apply(LogLine::leave_out(Voice::Source(Source::Mic), Some(true)));
    let mut reloaded = Transcript::new();
    for line in t.to_log_lines() {
        let json = serde_json::to_string(&line).unwrap();
        reloaded.apply(parse_line(&json).expect("a line this version reads"));
    }
    assert_eq!(reloaded, t);
    // Versions before `forget` read it as put back in, as they always did.
    let forget =
        serde_json::to_string(&LogLine::leave_out(Voice::Source(Source::Mic), None)).unwrap();
    assert_eq!(
        forget,
        r#"{"op":"leaveOut","voice":{"kind":"source","value":"mic"},"out":false,"forget":true}"#
    );
}

/// The left-out stamp is empty until a line is left out, and follows what is
/// left out, not how.
#[test]
fn the_left_out_basis_follows_the_lines_left_out() {
    let mut t = Transcript::new();
    t.upsert(utt("m1", Source::Mic, 0, 1_000, "Mine.", true));
    t.upsert(utt("s1", Source::System, 2_000, 3_000, "Theirs.", true));
    assert_eq!(t.left_out_basis(), "");
    t.apply(LogLine::leave_out(
        Voice::Source(Source::System),
        Some(true),
    ));
    let system = t.left_out_basis();
    assert_eq!(system.len(), 16);
    t.apply(LogLine::leave_out(Voice::Source(Source::Mic), Some(true)));
    assert_ne!(t.left_out_basis(), system);
    t.apply(LogLine::leave_out(Voice::Source(Source::Mic), None));
    assert_eq!(t.left_out_basis(), system, "stable for the same lines");
    t.apply(LogLine::leave_out(
        Voice::Source(Source::System),
        Some(false),
    ));
    assert_eq!(t.left_out_basis(), "");
}

/// Renaming a name onto one with a choice of its own ("Same person as")
/// merges the two choices as merged voices do: left out wins, either way.
#[test]
fn merging_names_keeps_a_left_out_choice() {
    let named = |id: &str, start: u64, text: &str, name: &str| {
        let mut u = utt(id, Source::System, start, start + 1_000, text, true);
        u.speaker = Some(name.into());
        u
    };
    let fresh = || {
        let mut t = Transcript::new();
        t.upsert(named("s1", 0, "Bob speaking.", "Bob"));
        t.upsert(named("s2", 4_000, "Alice speaking.", "Alice"));
        t.apply(LogLine::leave_out(
            Voice::Source(Source::System),
            Some(true),
        ));
        t
    };
    let prompt = |t: &Transcript| t.labelled_for_prompt(usize::MAX, None).text;
    for (from, from_out, to, to_out) in
        [("Alice", false, "Bob", true), ("Alice", true, "Bob", false)]
    {
        let mut t = fresh();
        t.apply(LogLine::leave_out(
            Voice::Named(from.into()),
            Some(from_out),
        ));
        t.apply(LogLine::leave_out(Voice::Named(to.into()), Some(to_out)));
        t.rename_speaker(from, to);
        assert_eq!(t.voice_choice(&Voice::Named(to.into())), Some(true));
        assert_eq!(t.voice_choice(&Voice::Named(from.into())), None);
        assert!(
            !prompt(&t).contains("Bob speaking") && !prompt(&t).contains("Alice speaking"),
            "{}",
            prompt(&t)
        );
    }
    // Both put back in stay in; a name with no choice takes the moved one.
    let mut t = fresh();
    t.apply(LogLine::leave_out(
        Voice::Named("Alice".into()),
        Some(false),
    ));
    t.apply(LogLine::leave_out(Voice::Named("Bob".into()), Some(false)));
    t.rename_speaker("Alice", "Bob");
    assert_eq!(t.voice_choice(&Voice::Named("Bob".into())), Some(false));
    assert!(prompt(&t).contains("Alice speaking") && prompt(&t).contains("Bob speaking"));
    let mut t = fresh();
    t.apply(LogLine::leave_out(
        Voice::Named("Alice".into()),
        Some(false),
    ));
    t.rename_speaker("Alice", "Carol");
    assert_eq!(t.voice_choice(&Voice::Named("Carol".into())), Some(false));
}
