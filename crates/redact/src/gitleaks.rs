//! Provider token rules from gitleaks (`assets/gitleaks-rules.json`, MIT,
//! see `assets/gitleaks-LICENSE`), applied with gitleaks' own keyword,
//! entropy, secret group and allowlist semantics.

use std::sync::{LazyLock, OnceLock};

use regex::{Regex, RegexBuilder, RegexSet, RegexSetBuilder};
use serde::Deserialize;

#[derive(Deserialize)]
struct RulesFile {
    #[serde(default)]
    allowlist: AllowDef,
    rules: Vec<RuleDef>,
}

#[derive(Deserialize, Default)]
struct AllowDef {
    #[serde(default)]
    regexes: Vec<String>,
    #[serde(default)]
    stopwords: Vec<String>,
    #[serde(default)]
    target: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuleDef {
    regex: String,
    #[serde(default)]
    keywords: Vec<String>,
    #[serde(default)]
    entropy: Option<f64>,
    #[serde(default)]
    secret_group: Option<usize>,
    #[serde(default)]
    allowlists: Vec<AllowDef>,
}

#[derive(Clone, Copy, PartialEq)]
enum Target {
    Secret,
    Match,
    Line,
}

struct Allow {
    regexes: Vec<(Regex, Target)>,
    stopwords: Vec<String>,
}

type Compiled = Option<(Regex, Vec<Allow>)>;

struct Rule {
    def: RuleDef,
    /// This rule's keywords, as indices into [`Rules::keywords`].
    keyword_ids: Vec<usize>,
    /// Built on first use: with the Latin word and digit classes for lines
    /// that hold no word character beyond U+024F, and with the full Unicode
    /// classes for the lines that do.
    latin: OnceLock<Compiled>,
    unicode: OnceLock<Compiled>,
}

struct Rules {
    global: Allow,
    global_unicode: OnceLock<Allow>,
    allowlist: AllowDef,
    rules: Vec<Rule>,
    /// Every rule's keywords as literals, so one pass over a line tells
    /// which of them it contains.
    keywords: RegexSet,
}

fn compile(pattern: &str, classes: Classes) -> Option<Regex> {
    let pattern = match classes {
        Classes::Latin => latin_classes(pattern),
        Classes::Unicode => pattern.to_string(),
    };
    RegexBuilder::new(&pattern)
        .size_limit(64 << 20)
        .dfa_size_limit(64 << 20)
        .build()
        .ok()
}

#[derive(Clone, Copy, PartialEq, Debug)]
enum Classes {
    Latin,
    Unicode,
}

/// A word character (Unicode `\w`) beyond U+024F.
static WIDE_WORD: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[\w&&[^\x00-\x{24F}]]").expect("wide word class"));

/// The classes a line is matched with: on a line without word characters
/// beyond U+024F the Latin classes accept exactly what the Unicode ones do.
fn classes_for(text: &str) -> Classes {
    if WIDE_WORD.is_match(text) {
        Classes::Unicode
    } else {
        Classes::Latin
    }
}

/// `pattern` with `\w` and `\d` limited to the Latin blocks (U+0000 to
/// U+024F), so the rules' long repeats of the full Unicode classes do not
/// build automata of tens of megabytes each. Used only for lines whose word
/// characters all lie in those blocks, where it matches the same text.
fn latin_classes(pattern: &str) -> String {
    let mut out = String::with_capacity(pattern.len() + 32);
    let mut chars = pattern.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('w') => out.push_str("[\\w&&\\x00-\\x{24F}]"),
            Some('d') => out.push_str("[\\d&&\\x00-\\x{24F}]"),
            Some(next) => {
                out.push('\\');
                out.push(next);
            }
            None => out.push('\\'),
        }
    }
    out
}

fn allow(def: &AllowDef, classes: Classes) -> Allow {
    let target = match def.target.as_deref() {
        Some("match") => Target::Match,
        Some("line") => Target::Line,
        _ => Target::Secret,
    };
    Allow {
        regexes: def
            .regexes
            .iter()
            .filter_map(|pattern| compile(pattern, classes))
            .map(|regex| (regex, target))
            .collect(),
        stopwords: def.stopwords.clone(),
    }
}

static RULES: LazyLock<Rules> = LazyLock::new(|| {
    let file: RulesFile = serde_json::from_str(include_str!("../assets/gitleaks-rules.json"))
        .expect("bundled gitleaks rules parse");
    let mut literals = Vec::new();
    let rules = file
        .rules
        .into_iter()
        .map(|def| {
            let keyword_ids = def
                .keywords
                .iter()
                .map(|keyword| {
                    literals.push(regex::escape(keyword));
                    literals.len() - 1
                })
                .collect();
            Rule {
                def,
                keyword_ids,
                latin: OnceLock::new(),
                unicode: OnceLock::new(),
            }
        })
        .collect();
    Rules {
        global: allow(&file.allowlist, Classes::Latin),
        global_unicode: OnceLock::new(),
        allowlist: file.allowlist,
        rules,
        keywords: RegexSetBuilder::new(&literals)
            .size_limit(64 << 20)
            .dfa_size_limit(64 << 20)
            .build()
            .expect("gitleaks keywords compile"),
    }
});

impl Allow {
    fn allows(&self, secret: &str, whole: &str, line: &str) -> bool {
        let lower = secret.to_lowercase();
        self.stopwords
            .iter()
            .any(|word| lower.contains(word.as_str()))
            || self.regexes.iter().any(|(regex, target)| {
                regex.is_match(match target {
                    Target::Secret => secret,
                    Target::Match => whole,
                    Target::Line => line,
                })
            })
    }
}

fn shannon_entropy(text: &str) -> f64 {
    let mut counts = std::collections::HashMap::new();
    let mut total = 0.0;
    for ch in text.chars() {
        *counts.entry(ch).or_insert(0.0) += 1.0;
        total += 1.0;
    }
    if total == 0.0 {
        return 0.0;
    }
    counts
        .values()
        .map(|count: &f64| {
            let p = count / total;
            -p * p.log2()
        })
        .sum()
}

/// Byte ranges of every secret the rules find in `text`.
pub fn find(text: &str) -> Vec<(usize, usize)> {
    find_with(text, classes_for(text))
}

fn find_with(text: &str, classes: Classes) -> Vec<(usize, usize)> {
    let rules = &*RULES;
    let lower = text.to_lowercase();
    let present = rules.keywords.matches(&lower);
    let global = match classes {
        Classes::Latin => &rules.global,
        Classes::Unicode => rules
            .global_unicode
            .get_or_init(|| allow(&rules.allowlist, Classes::Unicode)),
    };
    let mut found = Vec::new();
    for rule in &rules.rules {
        if !rule.keyword_ids.is_empty() && !rule.keyword_ids.iter().any(|id| present.matched(*id)) {
            continue;
        }
        let slot = match classes {
            Classes::Latin => &rule.latin,
            Classes::Unicode => &rule.unicode,
        };
        let Some((regex, allowlists)) = slot
            .get_or_init(|| {
                compile(&rule.def.regex, classes).map(|regex| {
                    let allowlists = rule
                        .def
                        .allowlists
                        .iter()
                        .map(|def| allow(def, classes))
                        .collect();
                    (regex, allowlists)
                })
            })
            .as_ref()
        else {
            continue;
        };
        for captures in regex.captures_iter(text) {
            let Some(whole) = captures.get(0) else {
                continue;
            };
            let secret = match rule.def.secret_group {
                Some(group) => captures.get(group),
                None => (1..captures.len())
                    .find_map(|group| captures.get(group))
                    .or(Some(whole)),
            };
            let Some(secret) = secret.filter(|m| !m.as_str().is_empty()) else {
                continue;
            };
            if rule
                .def
                .entropy
                .is_some_and(|minimum| shannon_entropy(secret.as_str()) < minimum)
            {
                continue;
            }
            if global.allows(secret.as_str(), whole.as_str(), text)
                || allowlists
                    .iter()
                    .any(|allow| allow.allows(secret.as_str(), whole.as_str(), text))
            {
                continue;
            }
            found.push((secret.start(), secret.end()));
        }
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nearly_every_rule_compiles() {
        let rules = &*RULES;
        let failed = rules
            .rules
            .iter()
            .filter(|rule| compile(&rule.def.regex, Classes::Latin).is_none())
            .map(|rule| rule.def.regex.chars().take(40).collect::<String>())
            .collect::<Vec<_>>();
        assert!(rules.rules.len() > 200);
        assert!(failed.len() <= 3, "rules that do not compile: {failed:?}");
    }

    #[test]
    fn latin_classes_rewrite_only_word_and_digit_shorthands() {
        assert_eq!(
            latin_classes(r"a\w[\w.-]{2}\d\\w\s\b\x{41}"),
            r"a[\w&&\x00-\x{24F}][[\w&&\x00-\x{24F}].-]{2}[\d&&\x00-\x{24F}]\\w\s\b\x{41}"
        );
        let original = Regex::new(r"(?i)\b[\w.-]{3,8}\d\b").unwrap();
        let latin = Regex::new(&latin_classes(r"(?i)\b[\w.-]{3,8}\d\b")).unwrap();
        for text in [
            "café-éte9 x",
            "ÀÉÎÕÜ_ß3",
            "naïve…1 ok",
            "a·b·c7",
            "€9 ×y.z8",
            "“q_1”\u{2014}é2",
        ] {
            assert_eq!(
                original
                    .find_iter(text)
                    .map(|m| m.range())
                    .collect::<Vec<_>>(),
                latin.find_iter(text).map(|m| m.range()).collect::<Vec<_>>(),
                "{text}"
            );
        }
    }

    #[test]
    fn latin_and_unicode_rules_compile_alike() {
        for rule in &RULES.rules {
            assert_eq!(
                compile(&rule.def.regex, Classes::Latin).is_some(),
                compile(&rule.def.regex, Classes::Unicode).is_some(),
                "{}",
                rule.def.regex
            );
        }
    }

    #[test]
    fn lines_in_any_script_find_what_the_unicode_rules_find() {
        let token = [
            "xoxb",
            "123456789012",
            "1234567890123",
            "AbCdEfGhIjKlMnOpQrStUvWx",
        ]
        .join("-");
        let key = format!("ghp_{}", "aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3z5A");
        let mut lines = Vec::new();
        for value in [token.as_str(), key.as_str()] {
            for word in [
                "ключ",
                "κλειδί",
                "密钥",
                "مفتاح",
                "café",
                "naïve",
                "Ŧoken",
                "ǅ",
                "x",
            ] {
                lines.push(format!("{word}{value}"));
                lines.push(format!("{value}{word}"));
                lines.push(format!("{word} {value} {word}"));
                lines.push(format!("{word}={value}"));
                lines.push(format!("export {word}_TOKEN={value}"));
            }
        }
        let jwt = [
            "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
            "eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ",
            "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
        ]
        .join(".");
        let stripe = format!("sk_live_{}", "4eC39HqLyjWDarjtT1zdp7dc");
        lines.extend([
            format!("密钥 {key} を使う"),
            format!("Токен: {stripe}"),
            format!("API कुंजी {token}"),
            format!("{jwt} の値"),
        ]);
        for line in &lines {
            assert_eq!(find(line), find_with(line, Classes::Unicode), "{line}");
        }
        assert_eq!(classes_for("token café é ÿ"), Classes::Latin);
        assert_eq!(classes_for("token ключ"), Classes::Unicode);
        assert_eq!(classes_for("…→✓€ symbols only"), Classes::Latin);
    }

    #[test]
    fn keyword_set_agrees_with_substring_search() {
        let rules = &*RULES;
        let mut lines = vec![
            "the quick brown fox".to_string(),
            "export SLACK=xoxb-1".to_string(),
            String::new(),
        ];
        for (i, rule) in rules.rules.iter().enumerate() {
            for keyword in &rule.def.keywords {
                lines.push(format!("x{keyword}y {i}"));
                lines.push(keyword.chars().skip(1).collect());
                lines.push(keyword.to_uppercase());
            }
        }
        for line in &lines {
            let lower = line.to_lowercase();
            let present = rules.keywords.matches(&lower);
            for rule in &rules.rules {
                for (keyword, id) in rule.def.keywords.iter().zip(&rule.keyword_ids) {
                    assert_eq!(
                        present.matched(*id),
                        lower.contains(keyword.as_str()),
                        "{keyword:?} in {line:?}"
                    );
                }
            }
        }
    }

    #[test]
    fn finds_provider_tokens() {
        let token = [
            "xoxb",
            "123456789012",
            "1234567890123",
            "AbCdEfGhIjKlMnOpQrStUvWx",
        ]
        .join("-");
        let text = format!("export SLACK={token}");
        let text = text.as_str();
        let found = find(text);
        assert!(!found.is_empty());
        assert!(text[found[0].0..found[0].1].starts_with("xoxb-"));
        assert!(find("the quick brown fox jumps over the lazy dog").is_empty());
    }
}
