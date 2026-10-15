use std::collections::{BTreeMap, BTreeSet};

/// One strict expected failure: `case` failing with `class`, on exactly the
/// listed seed indices (or on at least one seed when `seeds` is absent).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Xfail {
    pub case: String,
    pub class: String,
    pub reason: String,
    pub link: String,
    pub seeds: Option<BTreeSet<u64>>,
}

fn parse_seeds(text: &str, line: usize) -> BTreeSet<u64> {
    let mut seeds = BTreeSet::new();
    for item in text.split_whitespace() {
        let parse = |value: &str| {
            value
                .parse::<u64>()
                .unwrap_or_else(|_| panic!("expectations line {line}: bad seed {value}"))
        };
        match item.split_once('-') {
            Some((first, last)) => seeds.extend(parse(first)..=parse(last)),
            None => {
                seeds.insert(parse(item));
            }
        }
    }
    seeds
}

pub fn format_seeds(seeds: &BTreeSet<u64>) -> String {
    let mut runs: Vec<(u64, u64)> = Vec::new();
    for &seed in seeds {
        match runs.last_mut() {
            Some((_, last)) if *last + 1 == seed => *last = seed,
            _ => runs.push((seed, seed)),
        }
    }
    runs.iter()
        .map(|&(first, last)| match last - first {
            0 => first.to_string(),
            1 => format!("{first} {last}"),
            _ => format!("{first}-{last}"),
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// Reads the `[[xfail]]` tables of the shared expectations format: string
/// values only, one `key = "value"` per line, `#` comments.
pub fn parse(text: &str) -> Vec<Xfail> {
    let mut entries = Vec::new();
    let mut current: Option<Xfail> = None;
    for (number, line) in text.lines().enumerate() {
        let number = number + 1;
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if line == "[[xfail]]" {
            entries.extend(current.take());
            current = Some(Xfail {
                case: String::new(),
                class: String::new(),
                reason: String::new(),
                link: String::new(),
                seeds: None,
            });
            continue;
        }
        let (key, value) = line
            .split_once('=')
            .unwrap_or_else(|| panic!("expectations line {number}: expected key = value"));
        let value = value
            .trim()
            .strip_prefix('"')
            .and_then(|value| value.strip_suffix('"'))
            .unwrap_or_else(|| panic!("expectations line {number}: values are quoted"))
            .to_string();
        let entry = current
            .as_mut()
            .unwrap_or_else(|| panic!("expectations line {number}: outside [[xfail]]"));
        match key.trim() {
            "case" => entry.case = value,
            "class" => entry.class = value,
            "reason" => entry.reason = value,
            "link" => entry.link = value,
            "seeds" => entry.seeds = Some(parse_seeds(&value, number)),
            other => panic!("expectations line {number}: unknown key {other}"),
        }
    }
    entries.extend(current);
    for entry in &entries {
        assert!(
            !entry.case.is_empty() && !entry.class.is_empty() && !entry.reason.is_empty(),
            "every xfail needs case, class and reason: {entry:?}"
        );
    }
    entries
}

pub struct Verdict {
    /// (case, class, seeds) failing without a matching xfail.
    pub unexpected: Vec<(String, String, BTreeSet<u64>)>,
    /// Xfails whose failure did not happen, with the seeds that passed.
    pub unexpected_passes: Vec<(Xfail, BTreeSet<u64>)>,
}

/// Compares observed failures with the xfails for the cases that ran.
/// Strict both ways: an xfail whose failure did not happen is an error too.
pub fn judge(
    xfails: &[Xfail],
    ran: &BTreeSet<String>,
    observed: &BTreeMap<(String, String), BTreeSet<u64>>,
) -> Verdict {
    let mut unexpected = Vec::new();
    for ((case, class), seeds) in observed {
        let entry = xfails
            .iter()
            .find(|xfail| &xfail.case == case && &xfail.class == class);
        let uncovered: BTreeSet<u64> = match entry.and_then(|entry| entry.seeds.as_ref()) {
            Some(expected) => seeds.difference(expected).copied().collect(),
            None if entry.is_some() => BTreeSet::new(),
            None => seeds.clone(),
        };
        if !uncovered.is_empty() {
            unexpected.push((case.clone(), class.clone(), uncovered));
        }
    }

    let mut unexpected_passes = Vec::new();
    for xfail in xfails.iter().filter(|xfail| ran.contains(&xfail.case)) {
        let seen = observed.get(&(xfail.case.clone(), xfail.class.clone()));
        let passed: BTreeSet<u64> = match (&xfail.seeds, seen) {
            (Some(expected), Some(seen)) => expected.difference(seen).copied().collect(),
            (Some(expected), None) => expected.clone(),
            (None, Some(_)) => BTreeSet::new(),
            (None, None) => BTreeSet::from([u64::MAX]),
        };
        if !passed.is_empty() {
            unexpected_passes.push((xfail.clone(), passed));
        }
    }
    Verdict {
        unexpected,
        unexpected_passes,
    }
}

/// Writes the expectations that would make `observed` pass, keeping the
/// reason and link of existing entries for the same (case, class).
pub fn bless(xfails: &[Xfail], observed: &BTreeMap<(String, String), BTreeSet<u64>>) -> String {
    let mut text = String::new();
    for ((case, class), seeds) in observed {
        let known = xfails
            .iter()
            .find(|xfail| &xfail.case == case && &xfail.class == class);
        text.push_str(&format!(
            "[[xfail]]\ncase = \"{case}\"\nclass = \"{class}\"\nseeds = \"{}\"\nreason = \"{}\"\nlink = \"{}\"\n\n",
            format_seeds(seeds),
            known.map_or("TODO", |xfail| xfail.reason.as_str()),
            known.map_or("", |xfail| xfail.link.as_str()),
        ));
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seed_lists_round_trip() {
        let seeds = parse_seeds("0 2 3 5-9 12", 1);
        assert_eq!(seeds, BTreeSet::from([0, 2, 3, 5, 6, 7, 8, 9, 12]));
        assert_eq!(format_seeds(&seeds), "0 2 3 5-9 12");
    }

    #[test]
    fn strict_in_both_directions() {
        let xfails =
            parse("[[xfail]]\ncase = \"a\"\nclass = \"stale\"\nseeds = \"1 2\"\nreason = \"r\"\n");
        let ran = BTreeSet::from(["a".to_string()]);
        let observed = BTreeMap::from([(
            ("a".to_string(), "stale".to_string()),
            BTreeSet::from([2, 3]),
        )]);
        let verdict = judge(&xfails, &ran, &observed);
        assert_eq!(verdict.unexpected.len(), 1);
        assert_eq!(verdict.unexpected[0].2, BTreeSet::from([3]));
        assert_eq!(verdict.unexpected_passes.len(), 1);
        assert_eq!(verdict.unexpected_passes[0].1, BTreeSet::from([1]));
    }
}
