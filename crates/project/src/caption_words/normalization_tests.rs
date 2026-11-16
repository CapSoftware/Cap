use super::*;
use std::{hint::black_box, time::Instant};

fn baseline_normalize(words: Vec<CaptionWord>) -> Vec<CaptionWord> {
    let mut normalized: Vec<CaptionWord> = Vec::with_capacity(words.len());
    for word in words {
        let text = word.text.trim();
        if text.is_empty() {
            continue;
        }
        if caption_token_attaches_to_previous(text)
            && let Some(previous) = normalized.last_mut()
        {
            previous.text.push_str(text);
            previous.end = word.end;
        } else {
            normalized.push(CaptionWord {
                text: text.to_string(),
                start: word.start,
                end: word.end,
            });
        }
    }
    for word in &mut normalized {
        word.end = word.end.min(word.start + MAX_CAPTION_WORD_DURATION);
    }
    normalized
}

fn assert_words_equal(actual: &[CaptionWord], expected: &[CaptionWord]) {
    assert_eq!(actual.len(), expected.len());
    for (actual, expected) in actual.iter().zip(expected) {
        assert_eq!(actual.text, expected.text);
        assert_eq!(actual.start.to_bits(), expected.start.to_bits());
        assert_eq!(actual.end.to_bits(), expected.end.to_bits());
    }
}

#[test]
fn normalization_matches_previous_text_and_float_bits() {
    let texts = [
        "",
        " ",
        "\t\n",
        "\u{2003}\u{a0}",
        "hello",
        "  hello\t",
        "é日",
        "  नमस्ते ",
        ",",
        " . ",
        "!?",
        "’s",
        "、",
        "。",
        "[",
        "(test)",
        "a\u{300}",
        "\u{200b}",
    ];
    let times = [
        0.0,
        -0.0,
        1.0,
        -1.0,
        f32::MAX,
        f32::MIN,
        f32::INFINITY,
        f32::NEG_INFINITY,
        f32::from_bits(0x7fc00123),
    ];
    for first in texts {
        for second in texts {
            for (index, start) in times.into_iter().enumerate() {
                let words = [first, second, " ", ",", "word", " . ", "。"]
                    .into_iter()
                    .enumerate()
                    .map(|(offset, text)| CaptionWord {
                        text: text.to_string(),
                        start,
                        end: times[(index + offset + 1) % times.len()],
                    })
                    .collect::<Vec<_>>();
                let expected = baseline_normalize(words.clone());
                let actual = normalize_caption_words(words);
                assert_words_equal(&actual, &expected);
                assert_eq!(
                    caption_text_from_words(&actual),
                    caption_text_from_words(&expected)
                );
                let chunk_text = |words: &[CaptionWord]| {
                    caption_word_chunks(words)
                        .into_iter()
                        .map(caption_text_from_words)
                        .collect::<Vec<_>>()
                };
                assert_eq!(chunk_text(&actual), chunk_text(&expected));
            }
        }
    }
    assert!(normalize_caption_words(Vec::new()).is_empty());
}

#[test]
fn normalization_retains_owned_word_and_vector_allocations() {
    let words: Vec<_> = ["  first  ", "second", "\u{2003}third\u{2003}"]
        .into_iter()
        .map(|text| CaptionWord {
            text: text.to_string(),
            ..Default::default()
        })
        .collect();
    let vector = words.as_ptr();
    let strings: Vec<_> = words.iter().map(|word| word.text.as_ptr()).collect();
    let words = normalize_caption_words(words);
    assert_eq!(words.as_ptr(), vector);
    for (word, pointer) in words.iter().zip(strings) {
        assert_eq!(word.text.as_ptr(), pointer);
    }
    assert_eq!(caption_text_from_words(&words), "first second third");
}

fn fixture(count: usize, padded: bool) -> Vec<CaptionWord> {
    let tokens = [
        "Recording",
        "a",
        "clear",
        "demonstration",
        ",",
        "with",
        "Cap",
        ".",
    ];
    (0..count)
        .map(|index| {
            let token = tokens[index % tokens.len()];
            CaptionWord {
                text: if padded {
                    format!(" {token} ")
                } else {
                    token.into()
                },
                start: index as f32 * 0.4,
                end: index as f32 * 0.4 + 0.3,
            }
        })
        .collect()
}

fn measure(words: &[CaptionWord], normalize: fn(Vec<CaptionWord>) -> Vec<CaptionWord>) -> f64 {
    let iterations = (120_000 / words.len()).clamp(8, 500);
    let inputs: Vec<_> = (0..iterations).map(|_| words.to_vec()).collect();
    let started = Instant::now();
    for input in inputs {
        black_box(normalize(black_box(input)));
    }
    started.elapsed().as_secs_f64() * 1e6 / iterations as f64
}

#[test]
#[ignore]
fn benchmark_caption_word_normalization() {
    println!("words,padded,before_us,after_us,speedup");
    for count in [32, 1_000, 12_000] {
        for padded in [false, true] {
            let words = fixture(count, padded);
            assert_words_equal(
                &normalize_caption_words(words.clone()),
                &baseline_normalize(words.clone()),
            );
            for _ in 0..3 {
                black_box(baseline_normalize(words.clone()));
                black_box(normalize_caption_words(words.clone()));
            }
            let mut before = Vec::new();
            let mut after = Vec::new();
            for run in 0..9 {
                if run % 2 == 0 {
                    before.push(measure(&words, baseline_normalize));
                    after.push(measure(&words, normalize_caption_words));
                } else {
                    after.push(measure(&words, normalize_caption_words));
                    before.push(measure(&words, baseline_normalize));
                }
            }
            before.sort_by(f64::total_cmp);
            after.sort_by(f64::total_cmp);
            println!(
                "{count},{padded},{:.3},{:.3},{:.2}",
                before[4],
                after[4],
                before[4] / after[4]
            );
        }
    }
}
