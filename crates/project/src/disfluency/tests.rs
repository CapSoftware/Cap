use super::*;

fn tokens(text: &str) -> Vec<(String, f64, f64)> {
    let mut time = 0.0;
    let mut out = Vec::new();
    for raw in text.split_whitespace() {
        if raw == "|" {
            time += 1.2;
            continue;
        }
        out.push((raw.to_string(), time, time + 0.25));
        time += 0.3;
    }
    out
}

fn detect(text: &str) -> Vec<(DisfluencyKind, String)> {
    let owned = tokens(text);
    let borrowed: Vec<_> = owned
        .iter()
        .map(|(text, start, end)| DisfluencyToken {
            text,
            start: *start,
            end: *end,
        })
        .collect();
    detect_disfluencies(&borrowed)
        .into_iter()
        .map(|found| {
            let text = owned[found.words.clone()]
                .iter()
                .map(|(text, _, _)| text.as_str())
                .collect::<Vec<_>>()
                .join(" ");
            (found.kind, text)
        })
        .collect()
}

use DisfluencyKind::*;

#[test]
fn starter_helpers_keep_their_contract() {
    assert_eq!(normalize_word("Um,"), "um");
    assert_eq!(normalize_word("\"Don't!\""), "don't");
    assert_eq!(normalize_word("..."), "");
    assert!(is_hesitation_filler("Uh."));
    assert!(is_hesitation_filler("hmm"));
    assert!(!is_hesitation_filler("ummmm"));
    assert!(!is_hesitation_filler("umbrella"));
}

#[test]
fn drawn_out_hesitations_are_caught() {
    for spelling in [
        "ummmm", "Uhhhh,", "UMMM", "hmmmm", "mmmmm", "errrm", "errr", "aaah", "ahhhh", "ehhh",
        "uhmmm", "ehm", "um-", "(um)", "[uh]", "Umm...",
    ] {
        assert!(is_hesitation(spelling), "{spelling}");
    }
}

#[test]
fn words_that_only_look_like_hesitations_are_left() {
    for word in [
        "uh-huh", "mm-hmm", "mhm", "uh-uh", "a", "I", "umbrella", "hum", "her", "era", "aha", "oh",
        "huh", "m", "em", "hey", "um1", "",
    ] {
        assert!(!is_hesitation(word), "{word}");
    }
}

#[test]
fn hesitations_are_found_anywhere() {
    assert_eq!(
        detect("Um, so I think, uh, we can go."),
        vec![
            (Hesitation, "Um,".into()),
            (Discourse, "so".into()),
            (Hesitation, "uh,".into())
        ]
    );
}

#[test]
fn repeated_words_mark_every_copy_but_the_last() {
    assert_eq!(
        detect("I I think we we we should go"),
        vec![
            (Repetition, "I".into()),
            (Repetition, "we".into()),
            (Repetition, "we".into())
        ]
    );
    assert_eq!(
        detect("open the the settings"),
        vec![(Repetition, "the".into())]
    );
}

#[test]
fn repeated_phrases_are_found_through_hesitations() {
    assert_eq!(
        detect("I want to, um, I want to show you this"),
        vec![
            (Repetition, "I want to,".into()),
            (Hesitation, "um,".into())
        ]
    );
    assert_eq!(
        detect("click on the, uh, the button"),
        vec![(Repetition, "the,".into()), (Hesitation, "uh,".into())]
    );
}

#[test]
fn intentional_doubles_are_kept() {
    for sentence in [
        "it is very very fast",
        "she had had enough",
        "I know that that works",
        "no no no, not that one",
        "call nine one one",
        "the code is 4 4 2",
        "bye bye everyone",
        "what it is is a cache",
        "it was really really good",
    ] {
        assert!(
            detect(sentence).iter().all(|(kind, _)| *kind != Repetition),
            "{sentence}"
        );
    }
}

#[test]
fn repeats_across_a_sentence_break_or_long_pause_are_kept() {
    assert!(detect("Go. Go now.").is_empty());
    assert!(detect("we tested it | it worked").is_empty());
}

#[test]
fn cut_off_fragments_are_false_starts() {
    assert_eq!(
        detect("we need the wh- the settings"),
        vec![(FalseStart, "the wh-".into())]
    );
}

#[test]
fn restarted_clauses_are_false_starts() {
    assert_eq!(
        detect("we should, um, we need to restart"),
        vec![
            (FalseStart, "we should,".into()),
            (Hesitation, "um,".into())
        ]
    );
    assert_eq!(
        detect("it was- it is really simple"),
        vec![(FalseStart, "it was-".into())]
    );
}

#[test]
fn complete_clauses_before_a_hesitation_are_not_false_starts() {
    assert_eq!(
        detect("I think, um, I can fix it"),
        vec![(Hesitation, "um,".into())]
    );
    assert_eq!(
        detect("the thing is, uh, the server is down"),
        vec![(Hesitation, "uh,".into())]
    );
    assert!(detect("I went home and I slept").is_empty());
}

#[test]
fn like_is_only_a_filler_when_set_off() {
    assert_eq!(
        detect("it was, like, huge"),
        vec![(Discourse, "like,".into())]
    );
    assert_eq!(
        detect("Like, I don't know."),
        vec![(Discourse, "Like,".into())]
    );
    for sentence in [
        "I like pizza",
        "it looks like a bug",
        "just like that",
        "would you like to see it",
        "I like it.",
        "feels like, um, forever",
    ] {
        assert!(
            detect(sentence).iter().all(|(kind, _)| *kind != Discourse),
            "{sentence}"
        );
    }
}

#[test]
fn you_know_and_i_mean_need_to_be_set_off() {
    assert_eq!(
        detect("it was hard, you know?"),
        vec![(Discourse, "you know?".into())]
    );
    assert_eq!(
        detect("You know, this is better"),
        vec![(Discourse, "You know,".into())]
    );
    assert_eq!(
        detect("I mean, it works"),
        vec![(Discourse, "I mean,".into())]
    );
    for sentence in [
        "you know how to do it",
        "do you know where it is",
        "what I mean is simple",
        "I mean it.",
        "you know what to click",
    ] {
        assert!(detect(sentence).is_empty(), "{sentence}");
    }
}

#[test]
fn hedges_only_count_with_commas() {
    assert_eq!(
        detect("it was, kind of, a mess"),
        vec![(Discourse, "kind of,".into())]
    );
    assert!(detect("it's kind of cool").is_empty());
    assert!(detect("a different sort of tool").is_empty());
}

#[test]
fn adverbs_need_to_be_set_off() {
    assert_eq!(
        detect("Basically, you click here"),
        vec![(Discourse, "Basically,".into())]
    );
    assert_eq!(
        detect("Actually, it works"),
        vec![(Discourse, "Actually,".into())]
    );
    assert!(detect("it actually works").is_empty());
    assert!(detect("it works, actually.").is_empty());
    assert!(detect("it was literally translated").is_empty());
}

#[test]
fn sentence_openers_are_fillers() {
    assert_eq!(
        detect("So today we will look at exports"),
        vec![(Discourse, "So".into())]
    );
    assert_eq!(
        detect("Okay, so let's start."),
        vec![(Discourse, "Okay,".into()), (Discourse, "so".into())]
    );
    assert_eq!(
        detect("Okay. Let's start."),
        vec![(Discourse, "Okay.".into())]
    );
    assert_eq!(
        detect("Well, that is it."),
        vec![(Discourse, "Well,".into())]
    );
    assert_eq!(
        detect("Right, so the next step"),
        vec![(Discourse, "Right,".into()), (Discourse, "so".into())]
    );
}

#[test]
fn so_in_the_middle_or_as_a_degree_word_is_kept() {
    for sentence in [
        "it was so fast",
        "I saved it so I could share it",
        "So much for that.",
        "So far so good.",
        "So what?",
        "We went home, so we rested.",
        "it was okay",
        "turn right here",
        "Is that right?",
        "Well done.",
    ] {
        assert!(
            detect(sentence).iter().all(|(kind, _)| *kind != Discourse),
            "{sentence}"
        );
    }
}

#[test]
fn right_as_a_tag_question_is_a_filler() {
    assert_eq!(
        detect("that makes sense, right?"),
        vec![(Discourse, "right?".into())]
    );
}

#[test]
fn punctuation_tokens_attach_to_the_previous_word() {
    let owned = [
        ("it", 0.0, 0.2),
        ("was", 0.3, 0.5),
        (",", 0.5, 0.5),
        ("like", 0.6, 0.8),
        (",", 0.8, 0.8),
        ("huge", 0.9, 1.2),
    ];
    let tokens: Vec<_> = owned
        .iter()
        .map(|(text, start, end)| DisfluencyToken {
            text,
            start: *start,
            end: *end,
        })
        .collect();
    let found = detect_disfluencies(&tokens);
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].kind, Discourse);
    assert_eq!(found[0].words, 3..4);
    assert_eq!(found[0].phrase, "like");
}

#[test]
fn each_token_belongs_to_one_result() {
    let owned = tokens("um um um so so the the the, like, uh, you know, I I I");
    let borrowed: Vec<_> = owned
        .iter()
        .map(|(text, start, end)| DisfluencyToken {
            text,
            start: *start,
            end: *end,
        })
        .collect();
    let found = detect_disfluencies(&borrowed);
    assert!(
        found
            .windows(2)
            .all(|pair| pair[0].words.end <= pair[1].words.start)
    );
    assert!(found.iter().all(|found| !found.words.is_empty()));
    assert_eq!(
        found
            .iter()
            .filter(|found| found.kind == Hesitation)
            .count(),
        4
    );
}

#[test]
fn hostile_inputs_do_not_panic() {
    assert!(detect_disfluencies(&[]).is_empty());
    let odd = [
        DisfluencyToken {
            text: "",
            start: f64::NAN,
            end: f64::NAN,
        },
        DisfluencyToken {
            text: ",",
            start: 0.0,
            end: 0.0,
        },
        DisfluencyToken {
            text: "um",
            start: f64::INFINITY,
            end: f64::NEG_INFINITY,
        },
        DisfluencyToken {
            text: "-",
            start: 1.0,
            end: 0.5,
        },
        DisfluencyToken {
            text: "日本語",
            start: 2.0,
            end: 2.5,
        },
        DisfluencyToken {
            text: "日本語",
            start: 2.5,
            end: 3.0,
        },
    ];
    let found = detect_disfluencies(&odd);
    assert!(found.iter().any(|found| found.kind == Hesitation));
}

#[test]
fn twenty_thousand_words_classify_quickly() {
    let sentence = "So, um, I think we we should, uh, we need to look at, like, the export settings, you know? It was really really good. ";
    let text = sentence.repeat(20_000 / sentence.split_whitespace().count() + 1);
    let owned = tokens(&text);
    let borrowed: Vec<_> = owned
        .iter()
        .map(|(text, start, end)| DisfluencyToken {
            text,
            start: *start,
            end: *end,
        })
        .collect();
    let started = std::time::Instant::now();
    let found = detect_disfluencies(&borrowed);
    let elapsed = started.elapsed();
    assert!(found.len() > 5_000);
    assert!(
        elapsed < std::time::Duration::from_millis(if cfg!(debug_assertions) { 500 } else { 60 }),
        "{elapsed:?} for {} words",
        borrowed.len()
    );
}
