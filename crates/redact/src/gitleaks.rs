//! Provider token rules from gitleaks (`assets/gitleaks-rules.json`, MIT,
//! see `assets/gitleaks-LICENSE`), applied with gitleaks' own keyword,
//! entropy, secret group and allowlist semantics.

use std::sync::{LazyLock, OnceLock};

use regex::{Regex, RegexBuilder};
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

struct Rule {
    def: RuleDef,
    compiled: OnceLock<Option<(Regex, Vec<Allow>)>>,
}

struct Rules {
    global: Allow,
    rules: Vec<Rule>,
}

fn compile(pattern: &str) -> Option<Regex> {
    RegexBuilder::new(pattern)
        .size_limit(64 << 20)
        .dfa_size_limit(64 << 20)
        .build()
        .ok()
}

fn allow(def: &AllowDef) -> Allow {
    let target = match def.target.as_deref() {
        Some("match") => Target::Match,
        Some("line") => Target::Line,
        _ => Target::Secret,
    };
    Allow {
        regexes: def
            .regexes
            .iter()
            .filter_map(|pattern| compile(pattern))
            .map(|regex| (regex, target))
            .collect(),
        stopwords: def.stopwords.clone(),
    }
}

static RULES: LazyLock<Rules> = LazyLock::new(|| {
    let file: RulesFile = serde_json::from_str(include_str!("../assets/gitleaks-rules.json"))
        .expect("bundled gitleaks rules parse");
    Rules {
        global: allow(&file.allowlist),
        rules: file
            .rules
            .into_iter()
            .map(|def| Rule {
                def,
                compiled: OnceLock::new(),
            })
            .collect(),
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
    let rules = &*RULES;
    let lower = text.to_lowercase();
    let mut found = Vec::new();
    for rule in &rules.rules {
        if !rule.def.keywords.is_empty()
            && !rule
                .def
                .keywords
                .iter()
                .any(|keyword| lower.contains(keyword.as_str()))
        {
            continue;
        }
        let Some((regex, allowlists)) = rule
            .compiled
            .get_or_init(|| {
                compile(&rule.def.regex)
                    .map(|regex| (regex, rule.def.allowlists.iter().map(allow).collect()))
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
            if rules.global.allows(secret.as_str(), whole.as_str(), text)
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
            .filter(|rule| compile(&rule.def.regex).is_none())
            .map(|rule| rule.def.regex.chars().take(40).collect::<String>())
            .collect::<Vec<_>>();
        assert!(rules.rules.len() > 200);
        assert!(failed.len() <= 3, "rules that do not compile: {failed:?}");
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
