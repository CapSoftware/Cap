use super::*;

fn words(text: &str) -> Vec<String> {
    text.split(' ').map(str::to_string).collect()
}

fn fixed(corrector: &Corrector, text: &str) -> String {
    let mut w = words(text);
    corrector.apply_strings(&mut w);
    w.join(" ")
}

/// A realistic dictionary with ordinary-word traps.
fn realistic() -> Corrector {
    let mut entries = builtins();
    entries.extend(
        [
            "Notion",
            "Bear",
            "Linear",
            "Figma",
            "Anthropic",
            "Siobhan",
            "Kubernetes",
            "Claude",
            "Cursor",
            "Slack",
            "Zoom",
            "Vercel",
            "Supabase",
            "PlanetScale",
            "Stripe",
            "Apple",
            "Mark",
            "Will",
            "Grace",
            "Rose",
            "Hope",
            "Bill",
            "Frank",
            "Amber",
            "Kit",
            "Carl",
            "Sage",
            "Max",
        ]
        .iter()
        .map(|s| Entry::new(*s)),
    );
    entries.push(Entry::new("GPUI").with_sounds_like(&["gee pee you eye"]));
    entries.push(Entry::new("OpenAI").with_sounds_like(&["open ai"]));
    Corrector::new(&entries)
}

#[test]
fn the_product_name_is_spelled_right() {
    let c = realistic();
    assert_eq!(
        fixed(&c, "I think Kap is the best screen recording app."),
        "I think Cap is the best screen recording app."
    );
    assert_eq!(fixed(&c, "Kap, honestly."), "Cap, honestly.");
    assert_eq!(fixed(&c, "(Kapp's) new release"), "(Cap's) new release");
    assert_eq!(fixed(&c, "We moved to Capp today"), "We moved to Cap today");
    assert_eq!(fixed(&c, "KAP is great"), "Cap is great");
}

#[test]
fn ordinary_words_are_never_touched() {
    let c = realistic();
    for line in [
        "He wore a cap to the game and a kap is not a word.",
        "Put the cap back on the pen.",
        "Cape Town, Cup final, Call me, Cop show, Cab ride, Gap year.",
        "I have a notion that the bear will mark the rose with hope.",
        "Will you bill Frank? Grace is amber and sage.",
        "CAP theorem and the CAPS key stay as they are.",
        "Sell the cell. Seal it. Kind of. Cart and Kart.",
        "Kitten, Karla, Markus, Willow, Apples and Claudette.",
        "Linear algebra is linear.",
    ] {
        assert_eq!(fixed(&c, line), line, "changed: {line}");
    }
}

#[test]
fn sound_alikes_only_fold_hard_c_k_and_q() {
    let c = Corrector::new(&[
        Entry::new("Claude"),
        Entry::new("Cursor"),
        Entry::new("Karl"),
    ]);
    assert_eq!(
        fixed(&c, "Ask Klaude about Kursor"),
        "Ask Claude about Cursor"
    );
    assert_eq!(fixed(&c, "Carl said hi"), "Karl said hi");
    assert_eq!(fixed(&c, "ask klaude"), "ask klaude");
}

#[test]
fn spoken_forms_cover_several_words() {
    let c = realistic();
    assert_eq!(
        fixed(&c, "We render with gee pee you eye now."),
        "We render with GPUI now."
    );
    assert_eq!(fixed(&c, "Open AI shipped"), "OpenAI shipped");
    assert_eq!(fixed(&c, "open, ai"), "open, ai");
}

#[test]
fn already_right_and_other_spellings_stay() {
    let c = Corrector::new(&[Entry::new("Cap"), Entry::new("Kap")]);
    assert_eq!(fixed(&c, "Cap and Kap"), "Cap and Kap");
}

#[test]
fn ambiguous_sound_keys_are_skipped() {
    let c = Corrector::new(&[Entry::new("Kart"), Entry::new("Cart")]);
    assert_eq!(fixed(&c, "Qart"), "Qart");
}

#[test]
fn an_empty_dictionary_does_nothing() {
    let c = Corrector::new(&[]);
    assert!(c.is_empty());
    assert!(c.fixes(&words("Kap is here")).is_empty());
}

#[test]
fn timed_words_keep_their_times() {
    #[derive(Clone, Debug, PartialEq)]
    struct W(String, u64, u64);
    let c = realistic();
    let mut w = vec![
        W("with".into(), 0, 100),
        W("gee".into(), 100, 200),
        W("pee".into(), 200, 300),
        W("you".into(), 300, 400),
        W("eye.".into(), 400, 500),
        W("Kap".into(), 500, 700),
    ];
    let n = c.apply_timed(
        &mut w,
        |w| &w.0,
        |_, text, s, e| W(text, s, e),
        |w| (w.1, w.2),
    );
    assert_eq!(n, 2);
    assert_eq!(
        w,
        vec![
            W("with".into(), 0, 100),
            W("GPUI.".into(), 100, 500),
            W("Cap".into(), 500, 700),
        ]
    );
}

#[test]
fn normalize_merges_and_caps() {
    let entries = normalize(vec![
        Entry::new("  Cap "),
        Entry::new("cap").with_sounds_like(&["Kap", "kap", "Cap", ""]),
        Entry::new(""),
        Entry::new("Siobhan").with_sounds_like(&["shiv awn"]),
    ]);
    assert_eq!(
        entries,
        vec![
            Entry::new("Cap").with_sounds_like(&["Kap"]),
            Entry::new("Siobhan").with_sounds_like(&["shiv awn"]),
        ]
    );
    let many: Vec<Entry> = (0..300).map(|i| Entry::new(format!("t{i}"))).collect();
    assert_eq!(normalize(many).len(), MAX_ENTRIES);
}

#[test]
fn learn_adds_or_extends() {
    let mut entries = vec![Entry::new("Cap")];
    assert!(learn(&mut entries, "Cap", "Kap"));
    assert_eq!(entries, vec![Entry::new("Cap").with_sounds_like(&["Kap"])]);
    assert!(!learn(&mut entries, "cap", "kap"));
    assert!(learn(&mut entries, "Siobhan", "Shivaun"));
    assert_eq!(
        entries[1],
        Entry::new("Siobhan").with_sounds_like(&["Shivaun"])
    );
}

#[test]
fn correction_is_cheap() {
    let c = realistic();
    let line = words(
        "so I think Kap is the best screen recording app and we should ship it to everyone on Linear before Friday okay",
    );
    let started = std::time::Instant::now();
    for _ in 0..2000 {
        let mut w = line.clone();
        c.apply_strings(&mut w);
    }
    let per_line = started.elapsed() / 2000;
    assert!(
        per_line < std::time::Duration::from_millis(1),
        "{per_line:?}"
    );
}
