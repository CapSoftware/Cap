use std::collections::BTreeMap;

const SHIPPED: &str = include_str!(concat!(env!("OUT_DIR"), "/i18n_shipped.rs"));
const TESTED: &str = include_str!(concat!(env!("OUT_DIR"), "/i18n_upstream.rs"));

fn english(code: &'static str) -> BTreeMap<&'static str, &'static str> {
    code.lines()
        .filter_map(|line| {
            let doc = line
                .trim()
                .strip_prefix("#[doc = \"`")?
                .strip_suffix("\"]")?;
            doc.split_once("`: ")
        })
        .collect()
}

fn overlay() -> BTreeMap<String, String> {
    let mut section = "";
    let mut wording = BTreeMap::new();
    for line in include_str!("../locales-fork/en.toml").lines() {
        if let Some(name) = line
            .strip_prefix('[')
            .and_then(|rest| rest.strip_suffix(']'))
        {
            section = name;
        } else if let Some((name, value)) = line.split_once(" = ") {
            let value = value.strip_prefix('"').and_then(|v| v.strip_suffix('"'));
            wording.insert(
                format!("{section}.{name}"),
                fork_brand::text(value.expect("overlay values are one-line strings"))
                    .replace("%upstream%", fork_brand::UPSTREAM_NAME)
                    .replace("%releases%", fork_brand::RELEASES_URL)
                    .replace("%cli%", fork_brand::CLI_NAME),
            );
        }
    }
    wording
}

fn placeholders(line: &str) -> Vec<String> {
    let mut names: Vec<String> = line
        .replace("\\u{", "")
        .split('{')
        .skip(1)
        .filter_map(|rest| rest.split_once('}').map(|(name, _)| name.to_string()))
        .collect();
    names.sort_unstable();
    names
}

fn kept(key: &str) -> bool {
    fork_brand::KEEP_UPSTREAM_NAME.iter().any(|kept| {
        key.strip_prefix(kept)
            .is_some_and(|rest| rest.is_empty() || rest.starts_with('.'))
    })
}

#[test]
fn shipped_catalog_has_the_tested_catalogs_code() {
    assert_eq!(SHIPPED.lines().count(), TESTED.lines().count());
    for (shipped, tested) in SHIPPED.lines().zip(TESTED.lines()) {
        if shipped == tested {
            continue;
        }
        let quoted = |line: &str| line.trim().starts_with('"') || line.contains("#[doc = ");
        let formatted = |line: &str| line.contains("=> format!(\"") || line.contains("=> \"");
        assert!(
            (quoted(shipped) && quoted(tested)) || (formatted(shipped) && formatted(tested)),
            "only text may differ:\n{tested}\n{shipped}"
        );
        assert_eq!(
            shipped.split('"').next(),
            tested.split('"').next(),
            "{shipped}"
        );
        assert_eq!(placeholders(shipped), placeholders(tested), "{shipped}");
    }
}

#[test]
fn shipped_english_is_upstream_rebranded_or_overlaid() {
    let shipped = english(SHIPPED);
    let tested = english(TESTED);
    assert_eq!(
        shipped.keys().collect::<Vec<_>>(),
        tested.keys().collect::<Vec<_>>()
    );
    let overlay = overlay();
    for key in overlay.keys() {
        assert!(shipped.contains_key(key.as_str()), "{key}");
    }
    for (key, text) in &shipped {
        let upstream = tested[key];
        if let Some(wording) = overlay.get(*key) {
            assert!(text.starts_with(wording.as_str()), "{key}: {text}");
        } else if kept(key) {
            assert_eq!(*text, upstream, "{key}");
        } else {
            assert_eq!(fork_brand::text(text), fork_brand::text(upstream), "{key}");
        }
    }
}

#[test]
fn width_budgets_measure_the_shipped_text() {
    for (shipped, tested) in crate::i18n_shipped::FITS.iter().zip(&crate::i18n::FITS) {
        assert_eq!(shipped.key, tested.key);
        assert_eq!(
            shipped.text, tested.text,
            "{}: the fork changes a width-budgeted label, which upstream's fit test no longer measures",
            shipped.key
        );
    }
}
