//! Who is who, from what people said: "I'm Kristen" names the person saying
//! it, and "Jun?" or "thanks, Ben" at the edge of a turn names whoever answers
//! next. Calendar attendees make a spoken name trustworthy. Precision first:
//! a name is only `Confident` when the evidence agrees and nothing contradicts
//! it; one weak hint is only a `Suggestion` the person confirms with a click.

use std::collections::HashMap;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Certainty {
    Suggestion,
    Confident,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Guess {
    /// The speaker the name belongs to, as the caller keyed the turns.
    pub speaker: String,
    pub name: String,
    pub certainty: Certainty,
}

/// One turn of the meeting: who spoke (a stable key such as a voice id) and
/// what they said.
#[derive(Clone, Copy, Debug)]
pub struct Turn<'a> {
    pub speaker: &'a str,
    pub text: &'a str,
}

const SELF_WEIGHT: u32 = 3;
const ADDRESS_WEIGHT: u32 = 1;

/// Capitalised words that are never anyone's name here.
const NOT_NAMES: &[&str] = &[
    "i",
    "ok",
    "okay",
    "yeah",
    "yes",
    "yep",
    "no",
    "nope",
    "so",
    "sorry",
    "just",
    "here",
    "there",
    "not",
    "going",
    "good",
    "fine",
    "sure",
    "done",
    "back",
    "ready",
    "happy",
    "glad",
    "late",
    "still",
    "also",
    "actually",
    "really",
    "pretty",
    "the",
    "a",
    "an",
    "and",
    "but",
    "or",
    "hi",
    "hey",
    "hello",
    "thanks",
    "thank",
    "great",
    "cool",
    "right",
    "well",
    "oh",
    "um",
    "uh",
    "hmm",
    "like",
    "you",
    "we",
    "they",
    "he",
    "she",
    "it",
    "this",
    "that",
    "what",
    "everyone",
    "everybody",
    "all",
    "guys",
    "folks",
    "team",
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
    "sunday",
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
    "today",
    "tomorrow",
    "yesterday",
    "now",
    "then",
    "please",
    "perfect",
    "nice",
    "awesome",
    "exactly",
    "totally",
    "absolutely",
    "definitely",
    "anyway",
    "alright",
    "bye",
    "morning",
    "afternoon",
    "evening",
    "welcome",
    "excited",
    "afraid",
    "curious",
    "wondering",
    "trying",
    "talking",
    "thinking",
    "working",
    "looking",
    "calling",
    "joining",
    "speaking",
    "new",
    "on",
    "in",
    "at",
    "from",
    "with",
    "about",
    "one",
    "two",
    "three",
    "mr",
    "mrs",
    "ms",
    "dr",
    "god",
    "jesus",
    "lord",
    "english",
    "spanish",
    "french",
    "german",
    "zoom",
    "slack",
    "google",
    "microsoft",
    "apple",
    "siri",
    "alexa",
    "who",
    "how",
    "why",
    "when",
    "where",
    "which",
    "can",
    "could",
    "would",
    "should",
    "will",
    "did",
    "do",
    "does",
    "is",
    "are",
    "was",
    "were",
    "let",
    "lets",
    "let's",
    "if",
    "because",
    "maybe",
    "probably",
    "noted",
    "mm",
    "hm",
    "mhm",
    "gotcha",
    "true",
    "correct",
    "agreed",
    "fair",
    "lovely",
    "brilliant",
    "amazing",
    "interesting",
    "honestly",
    "basically",
    "literally",
    "genial",
    "vale",
    "bueno",
    "claro",
    "perfecto",
    "gracias",
    "hola",
    "oui",
    "merci",
    "bon",
    "ja",
    "nein",
    "danke",
    "genau",
    "super",
    "bien",
    "sí",
    "si",
    "listo",
    "apuntado",
    "exacto",
];

fn fold(word: &str) -> String {
    word.chars()
        .filter_map(|c| {
            let c = c.to_lowercase().next().unwrap_or(c);
            Some(match c {
                'á' | 'à' | 'â' | 'ä' | 'ã' | 'å' => 'a',
                'é' | 'è' | 'ê' | 'ë' => 'e',
                'í' | 'ì' | 'î' | 'ï' => 'i',
                'ó' | 'ò' | 'ô' | 'ö' | 'õ' | 'ø' => 'o',
                'ú' | 'ù' | 'û' | 'ü' => 'u',
                'ñ' => 'n',
                'ç' => 'c',
                '’' => '\'',
                other => other,
            })
        })
        .collect()
}

/// A word as spoken, with what follows it.
#[derive(Clone, Debug)]
struct Word<'a> {
    bare: &'a str,
    /// Punctuation right after the word (",", "?", "." ...), if any.
    after: Option<char>,
}

fn words(text: &str) -> Vec<Word<'_>> {
    text.split_whitespace()
        .filter_map(|raw| {
            let trimmed = raw.trim_start_matches(|c: char| !c.is_alphanumeric());
            let end = trimmed
                .char_indices()
                .rev()
                .find(|(_, c)| c.is_alphanumeric())
                .map(|(i, c)| i + c.len_utf8())?;
            let bare = &trimmed[..end];
            let after = trimmed[end..].chars().find(|c| !c.is_alphanumeric());
            Some(Word { bare, after })
        })
        .collect()
}

/// A word that could be someone's first name: capitalised, letters only (a
/// hyphen or apostrophe inside is fine), not a common word.
fn name_like(word: &str) -> bool {
    let mut chars = word.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    // "Asante-Boateng" and "O'Brien" are names; "Mm-hm" and "I'm" are not.
    let parts_ok = word.split('-').all(|part| {
        part.chars().next().is_some_and(char::is_uppercase)
            && part
                .split(['\'', '’'])
                .skip(1)
                .all(|tail| tail.chars().count() >= 2)
    });
    first.is_uppercase()
        && parts_ok
        && word.chars().count() >= 2
        && word
            .chars()
            .all(|c| c.is_alphabetic() || c == '-' || c == '\'' || c == '’')
        && word.chars().skip(1).any(char::is_lowercase)
        && !NOT_NAMES.contains(&fold(word).as_str())
}

/// The name in "I'm X", "I am X", "my name is X", "this is X" / "it's X" near
/// the start of a turn, or "X here" opening it.
fn self_introduction(turn: &[Word<'_>]) -> Option<String> {
    let lower: Vec<String> = turn.iter().map(|w| fold(w.bare)).collect();
    let at = |i: usize| turn.get(i).map(|w| w.bare).filter(|w| name_like(w));
    for i in 0..lower.len() {
        let near_start = i < 6;
        let candidate = match lower[i].as_str() {
            "i'm" | "im" => at(i + 1),
            "i" if lower.get(i + 1).map(String::as_str) == Some("am") => at(i + 2),
            "my" if lower.get(i + 1).map(String::as_str) == Some("name")
                && lower.get(i + 2).map(String::as_str) == Some("is") =>
            {
                at(i + 3)
            }
            "my" if lower.get(i + 1).map(String::as_str) == Some("name's") => at(i + 2),
            "this" | "it's" if near_start => {
                let next = if lower[i] == "this" {
                    (lower.get(i + 1).map(String::as_str) == Some("is")).then_some(i + 2)
                } else {
                    Some(i + 1)
                };
                // "This is Ben" names the speaker only when it is all they
                // say there: "this is Ben's team" or "this is Ben, our ..."
                // introduces someone else.
                next.and_then(|n| {
                    let word = turn.get(n)?;
                    let ends = word
                        .after
                        .is_some_and(|c| matches!(c, '.' | '!' | ',' | '?'))
                        || n + 1 == turn.len();
                    (ends && !word.bare.ends_with("'s"))
                        .then(|| at(n))
                        .flatten()
                })
            }
            _ => None,
        };
        if let Some(name) = candidate
            && !name.ends_with("'s")
        {
            // "I'm Ben" is an introduction; "I'm Ben's manager" is not.
            return Some(name.to_string());
        }
        if i == 0
            && lower.get(1).map(String::as_str) == Some("here")
            && let Some(name) = at(0)
        {
            return Some(name.to_string());
        }
    }
    None
}

/// The name someone speaks to at the edge of a turn: "Jun?", "Jun, you
/// want to go?", "thanks, Ben.", "hey Kristen", "... right, Ana?".
fn addressed(turn: &[Word<'_>]) -> Option<String> {
    let lead = ["hey", "hi", "hello", "thanks", "thank", "over", "morning"];
    let n = turn.len();
    if n == 0 {
        return None;
    }
    let vocative = |w: &Word<'_>| w.after.is_some_and(|c| matches!(c, ',' | '?' | '!' | '.'));
    // Last word: "... Jun?" or "..., Ben." after a comma.
    let last = &turn[n - 1];
    if name_like(last.bare)
        && last.after.is_some_and(|c| matches!(c, '?' | '.' | '!'))
        && (n == 1
            || turn[n - 2]
                .after
                .is_some_and(|c| matches!(c, ',' | '.' | '?' | '!'))
            || lead.contains(&fold(turn[n - 2].bare).as_str()))
    {
        return Some(last.bare.to_string());
    }
    // Near the start, after nothing but fillers: "Jun, ...", "OK, Jun?",
    // "And Jun, the flaky test?".
    for (i, word) in turn.iter().take(3).enumerate() {
        if name_like(word.bare) && vocative(word) {
            return Some(word.bare.to_string());
        }
        if !NOT_NAMES.contains(&fold(word.bare).as_str()) || i == 2 {
            break;
        }
    }
    // "hey Kristen", "thanks Ben," at the start.
    if n >= 2 && lead.contains(&fold(turn[0].bare).as_str()) {
        let next = if fold(turn[0].bare) == "thank" && fold(turn[1].bare) == "you" {
            turn.get(2)
        } else {
            turn.get(1)
        };
        if let Some(word) = next
            && name_like(word.bare)
        {
            return Some(word.bare.to_string());
        }
    }
    None
}

fn edit_distance(a: &str, b: &str) -> usize {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    for (i, ca) in a.iter().enumerate() {
        let mut row = vec![i + 1];
        for (j, cb) in b.iter().enumerate() {
            let cost = usize::from(ca != cb);
            row.push((prev[j] + cost).min(prev[j + 1] + 1).min(row[j] + 1));
        }
        prev = row;
    }
    prev[b.len()]
}

/// The attendee a spoken first name means, allowing for how a transcript
/// spells names it has not heard before ("Kwami" for Kwame, "Thomas" for
/// Tomás). Ambiguous matches mean nobody.
fn attendee_for<'a>(spoken: &str, attendees: &'a [String]) -> Option<&'a String> {
    let spoken = fold(spoken);
    let mut found: Vec<&String> = attendees
        .iter()
        .filter(|a| {
            let first = a.split_whitespace().next().map(fold).unwrap_or_default();
            first == spoken
                || (spoken.chars().count() >= 4
                    && first.chars().count() >= 4
                    && edit_distance(&first, &spoken) <= 1)
        })
        .collect();
    found.dedup();
    match found.as_slice() {
        [only] => Some(*only),
        _ => None,
    }
}

/// Names for the meeting's speakers. `user` is the speaker who is the person
/// using Cap (never renamed here). `attendees` are the calendar's names, if
/// the meeting has an event.
pub fn guess(turns: &[Turn<'_>], user: Option<&str>, attendees: &[String]) -> Vec<Guess> {
    // name (folded) -> speaker -> weight; and the spelling to show.
    let mut votes: HashMap<String, HashMap<String, u32>> = HashMap::new();
    let mut shown: HashMap<String, String> = HashMap::new();
    let mut vote = |name: &str, speaker: &str, weight: u32| {
        let display = match attendee_for(name, attendees) {
            Some(attendee) => attendee.clone(),
            None => name.to_string(),
        };
        let key = fold(&display);
        shown.entry(key.clone()).or_insert(display);
        *votes
            .entry(key)
            .or_default()
            .entry(speaker.to_string())
            .or_default() += weight;
    };
    let parsed: Vec<Vec<Word<'_>>> = turns.iter().map(|t| words(t.text)).collect();
    for (index, turn) in turns.iter().enumerate() {
        if let Some(name) = self_introduction(&parsed[index]) {
            vote(&name, turn.speaker, SELF_WEIGHT);
        }
        if let Some(name) = addressed(&parsed[index])
            && let Some(next) = turns[index + 1..]
                .iter()
                .find(|t| t.speaker != turn.speaker)
        {
            // Spoken to by this speaker, so not them; whoever answers next.
            vote(&name, next.speaker, ADDRESS_WEIGHT);
        }
    }
    let mut candidates: Vec<(u32, Guess)> = Vec::new();
    for (key, by_speaker) in &votes {
        let mut ranked: Vec<(&String, &u32)> = by_speaker.iter().collect();
        ranked.sort_by(|a, b| b.1.cmp(a.1).then(a.0.cmp(b.0)));
        let (speaker, &top) = ranked[0];
        let runner_up = ranked.get(1).map_or(0, |r| *r.1);
        let attendee = attendees.iter().any(|a| fold(a) == *key);
        // With a calendar, a name nobody on it has is someone talked about,
        // not someone in the room.
        if !attendees.is_empty() && !attendee {
            continue;
        }
        let total: u32 = by_speaker.values().sum();
        // The name points at one speaker, clearly.
        if runner_up * 2 >= top && runner_up > 0 {
            continue;
        }
        if user.is_some_and(|u| u == speaker) {
            continue;
        }
        let certainty = if attendee && top >= 2 && runner_up == 0 {
            Certainty::Confident
        } else if top >= SELF_WEIGHT + ADDRESS_WEIGHT && runner_up == 0 && total == top {
            Certainty::Confident
        } else if top >= 2 || attendee {
            Certainty::Suggestion
        } else {
            continue;
        };
        candidates.push((
            top,
            Guess {
                speaker: speaker.clone(),
                name: shown[key].clone(),
                certainty,
            },
        ));
    }
    // One name per speaker and one speaker per name: strongest first; a
    // speaker with two strong names keeps neither as confident.
    candidates.sort_by(|a, b| {
        b.1.certainty
            .cmp(&a.1.certainty)
            .then(b.0.cmp(&a.0))
            .then(a.1.speaker.cmp(&b.1.speaker))
    });
    let mut out: Vec<Guess> = Vec::new();
    for (weight, guess) in &candidates {
        if out.iter().any(|g| g.speaker == guess.speaker) {
            continue;
        }
        let rival = candidates.iter().any(|(w, other)| {
            other.speaker == guess.speaker && other.name != guess.name && *w * 2 >= *weight
        });
        let mut guess = guess.clone();
        if rival {
            guess.certainty = Certainty::Suggestion;
        }
        out.push(guess);
    }
    out.sort_by(|a, b| a.speaker.cmp(&b.speaker));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t<'a>(speaker: &'a str, text: &'a str) -> Turn<'a> {
        Turn { speaker, text }
    }

    #[test]
    fn introductions_name_the_speaker() {
        let turns = [
            t("1", "Hi everyone, I'm Kristen, I run design."),
            t("2", "Thanks Kristen. And I'm Ben from sales."),
            t("1", "Great to meet you, Ben."),
        ];
        let guesses = guess(&turns, None, &[]);
        assert!(
            guesses.contains(&Guess {
                speaker: "1".into(),
                name: "Kristen".into(),
                certainty: Certainty::Confident,
            }),
            "{guesses:?}"
        );
        assert!(guesses.iter().any(|g| g.speaker == "2" && g.name == "Ben"));
    }

    #[test]
    fn addressing_names_whoever_answers() {
        let turns = [
            t("1", "Updates first. Jun?"),
            t("3", "Yeah, regression is seventy percent done."),
            t("1", "Thanks. Eleanor, you want to go?"),
            t("2", "Sure."),
            t("1", "And Jun, the flaky test?"),
            t("3", "Still flaky."),
        ];
        let attendees = vec![
            "Priya Raghunathan".into(),
            "Jun Takahara".into(),
            "Eleanor Whitcombe".into(),
        ];
        let guesses = guess(&turns, Some("1"), &attendees);
        let jun = guesses.iter().find(|g| g.speaker == "3").unwrap();
        assert_eq!(jun.name, "Jun Takahara");
        assert_eq!(jun.certainty, Certainty::Confident);
        let eleanor = guesses.iter().find(|g| g.speaker == "2").unwrap();
        assert_eq!(
            eleanor.certainty,
            Certainty::Suggestion,
            "one hint is only a suggestion"
        );
    }

    #[test]
    fn ordinary_words_and_third_parties_are_not_names() {
        let turns = [
            t(
                "1",
                "I'm Sorry, I'm Not sure. This is Ben's team, by the way.",
            ),
            t("2", "Kwame knows about it."),
            t("1", "Yeah, Monday?"),
            t("2", "OK."),
        ];
        assert!(
            guess(&turns, None, &[]).is_empty(),
            "{:?}",
            guess(&turns, None, &[])
        );
    }

    #[test]
    fn the_user_is_never_renamed_and_contradictions_stay_unnamed() {
        let turns = [
            t("1", "I'm Dana."),
            t("2", "Hi Dana. I'm Marcus."),
            t("3", "I'm Marcus too, actually."),
        ];
        let guesses = guess(&turns, Some("1"), &[]);
        assert!(guesses.iter().all(|g| g.speaker != "1"));
        assert!(
            guesses.iter().all(|g| g.name != "Marcus"),
            "two people claim it: nobody gets it {guesses:?}"
        );
    }

    #[test]
    fn transcript_spellings_of_attendees_resolve_to_the_calendar_name() {
        let attendees = vec!["Kwame Asante-Boateng".into(), "Tomás Echeverría".into()];
        assert_eq!(
            attendee_for("Kwami", &attendees).unwrap(),
            "Kwame Asante-Boateng"
        );
        assert_eq!(
            attendee_for("Thomas", &attendees).unwrap(),
            "Tomás Echeverría"
        );
        assert!(attendee_for("Tom", &attendees).is_none());
    }

    /// The eval: meetings whose speakers are known, labels hidden behind
    /// voice keys, the note-taker as the user. Run with
    /// NAMES_EVAL_DIR=<corpus> cargo test -p cap-meetings names_eval -- --ignored --nocapture
    #[test]
    #[ignore]
    fn names_eval() {
        let Ok(dir) = std::env::var("NAMES_EVAL_DIR") else {
            return;
        };
        let mut rows = Vec::new();
        let mut totals = [[0usize; 5]; 2];
        let mut entries: Vec<_> = std::fs::read_dir(&dir).unwrap().flatten().collect();
        entries.sort_by_key(|e| e.file_name());
        for entry in entries {
            let path = entry.path();
            let (Ok(facts), Ok(text)) = (
                std::fs::read_to_string(path.join("factsheet.json")),
                std::fs::read_to_string(path.join("transcript.txt")),
            ) else {
                continue;
            };
            let facts: serde_json::Value = serde_json::from_str(&facts).unwrap();
            let people: Vec<(String, String, bool)> = facts["participants"]
                .as_array()
                .unwrap()
                .iter()
                .map(|p| {
                    (
                        p["label"].as_str().unwrap_or_default().to_string(),
                        p["name"].as_str().unwrap_or_default().to_string(),
                        p["role"]
                            .as_str()
                            .unwrap_or_default()
                            .contains("note-taker"),
                    )
                })
                .collect();
            if people.iter().any(|(l, _, _)| l == "Others" || l == "You") {
                continue;
            }
            let mut keys: Vec<String> = Vec::new();
            let lines: Vec<(String, String)> = text
                .lines()
                .filter_map(|l| l.split_once(": "))
                .map(|(label, said)| {
                    if !keys.contains(&label.to_string()) {
                        keys.push(label.to_string());
                    }
                    (label.to_string(), said.to_string())
                })
                .collect();
            let key_of =
                |label: &str| format!("v{}", keys.iter().position(|k| k == label).unwrap());
            let user_label = people
                .iter()
                .find(|(_, _, taker)| *taker)
                .map(|(l, _, _)| l.clone())
                .unwrap_or_else(|| keys[0].clone());
            let user_key = key_of(&user_label);
            let keyed: Vec<(String, String)> =
                lines.iter().map(|(l, s)| (key_of(l), s.clone())).collect();
            let turns: Vec<Turn<'_>> = keyed
                .iter()
                .map(|(k, s)| Turn {
                    speaker: k,
                    text: s,
                })
                .collect();
            let others = keys.len() - 1;
            for (mode, attendees) in [
                Vec::new(),
                people
                    .iter()
                    .map(|(_, name, _)| name.clone())
                    .collect::<Vec<_>>(),
            ]
            .into_iter()
            .enumerate()
            {
                let guesses = guess(&turns, Some(&user_key), &attendees);
                let right = |g: &Guess| {
                    let label = keys[g.speaker[1..].parse::<usize>().unwrap()].clone();
                    let truth = people
                        .iter()
                        .find(|(l, _, _)| *l == label)
                        .map(|(l, n, _)| (fold(l), fold(n)))
                        .unwrap();
                    let said = fold(g.name.split_whitespace().next().unwrap_or(""));
                    let first = truth.1.split_whitespace().next().unwrap_or("").to_string();
                    said == truth.0 || said == first || edit_distance(&said, &truth.0) <= 1
                };
                let confident: Vec<&Guess> = guesses
                    .iter()
                    .filter(|g| g.certainty == Certainty::Confident)
                    .collect();
                let suggested: Vec<&Guess> = guesses
                    .iter()
                    .filter(|g| g.certainty == Certainty::Suggestion)
                    .collect();
                let c_right = confident.iter().filter(|g| right(g)).count();
                let s_right = suggested.iter().filter(|g| right(g)).count();
                let t = &mut totals[mode];
                t[0] += others;
                t[1] += confident.len();
                t[2] += c_right;
                t[3] += suggested.len();
                t[4] += s_right;
                rows.push(format!(
                    "{:<22} {:<9} speakers {} confident {}/{} suggested {}/{} wrong: {:?}",
                    entry.file_name().to_string_lossy(),
                    if mode == 0 { "no-cal" } else { "calendar" },
                    others,
                    c_right,
                    confident.len(),
                    s_right,
                    suggested.len(),
                    guesses
                        .iter()
                        .filter(|g| !right(g))
                        .map(|g| (&g.name, g.certainty))
                        .collect::<Vec<_>>()
                ));
            }
        }
        for row in &rows {
            println!("{row}");
        }
        for (mode, t) in totals.iter().enumerate() {
            let pct = |a: usize, b: usize| {
                if b == 0 {
                    100.
                } else {
                    100. * a as f64 / b as f64
                }
            };
            println!(
                "NAMES {} speakers {} | confident precision {:.1}% ({}/{}) recall {:.1}% | suggestions precision {:.1}% ({}/{}) | any-name recall {:.1}%",
                if mode == 0 { "no-calendar" } else { "calendar" },
                t[0],
                pct(t[2], t[1]),
                t[2],
                t[1],
                pct(t[2], t[0]),
                pct(t[4], t[3]),
                t[4],
                t[3],
                pct(t[2] + t[4], t[0]),
            );
        }
    }
}
