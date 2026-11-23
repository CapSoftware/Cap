use std::{
    collections::{HashMap, HashSet},
    sync::LazyLock,
};

fn lexicon(text: &'static str) -> impl Iterator<Item = &'static str> {
    text.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
}

/// Given names that are not ordinary words.
static FIRST_NAMES: LazyLock<HashSet<&'static str>> =
    LazyLock::new(|| lexicon(include_str!("../assets/first-names.txt")).collect());
/// Given names that are also words ("Amber", "Will"): a name only next to a
/// common surname or after a word that introduces a name.
static AMBIGUOUS_FIRST_NAMES: LazyLock<HashSet<&'static str>> =
    LazyLock::new(|| lexicon(include_str!("../assets/first-names-ambiguous.txt")).collect());
/// Surname to frequency rank (0 is the most common).
static LAST_NAMES: LazyLock<HashMap<&'static str, usize>> = LazyLock::new(|| {
    lexicon(include_str!("../assets/last-names.txt"))
        .enumerate()
        .map(|(rank, name)| (name, rank))
        .collect()
});

const COMMON_SURNAME_RANK: usize = 1500;

/// Capitalised words that start interface labels and prose far more often
/// than names, even though they are in the given-name lists.
const NEVER_FIRST: [&str; 62] = [
    "will",
    "may",
    "june",
    "april",
    "august",
    "mark",
    "bill",
    "page",
    "case",
    "chase",
    "max",
    "art",
    "sky",
    "river",
    "storm",
    "rich",
    "rob",
    "pat",
    "ray",
    "jack",
    "frank",
    "lane",
    "dean",
    "victoria",
    "georgia",
    "florida",
    "carolina",
    "jordan",
    "israel",
    "paris",
    "london",
    "sydney",
    "austin",
    "phoenix",
    "charlotte",
    "madison",
    "chrome",
    "safari",
    "siri",
    "alexa",
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
    "july",
    "september",
    "october",
    "november",
    "december",
    "spring",
    "summer",
    "autumn",
    "winter",
    "pacific",
    "atlantic",
    "general",
];

/// Words in the given-name lists that never start a name on screen.
const NOT_NAMES: [&str; 22] = [
    "chrome",
    "safari",
    "siri",
    "alexa",
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
    "july",
    "september",
    "october",
    "november",
    "december",
    "pacific",
    "atlantic",
    "general",
];

const SURNAME_STOP: [&str; 68] = [
    "street",
    "road",
    "avenue",
    "the",
    "and",
    "or",
    "of",
    "for",
    "in",
    "on",
    "to",
    "is",
    "was",
    "new",
    "file",
    "edit",
    "view",
    "help",
    "window",
    "settings",
    "button",
    "menu",
    "folder",
    "project",
    "team",
    "workspace",
    "dashboard",
    "inc",
    "llc",
    "ltd",
    "corp",
    "company",
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
    "app",
    "studio",
    "pro",
    "plus",
    "max",
    "mini",
    "ai",
    "api",
    "id",
    "account",
    "profile",
    "admin",
    "user",
    "guest",
    "update",
    "release",
    "version",
];

const CONTEXT: [&str; 19] = [
    "name", "from", "to", "cc", "bcc", "hi", "hello", "hey", "dear", "thanks", "regards", "author",
    "owner", "assignee", "reviewer", "contact", "signed", "by", "with",
];

/// Titles that introduce a name and are hidden with it.
const TITLES: [&str; 9] = [
    "mr", "mrs", "ms", "miss", "mx", "dr", "prof", "sir", "madam",
];

fn is_capitalized_word(word: &str) -> bool {
    let mut chars = word.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    let rest = chars.as_str();
    first.is_uppercase()
        && !rest.is_empty()
        && rest
            .chars()
            .all(|c| c.is_alphabetic() || c == '\'' || c == '-')
        && rest.chars().any(char::is_lowercase)
}

fn is_upper_word(word: &str) -> bool {
    word.chars().count() >= 2
        && word
            .chars()
            .all(|c| c.is_uppercase() || c == '\'' || c == '-')
}

fn is_initial(word: &str) -> bool {
    let mut chars = word.chars();
    matches!((chars.next(), chars.next(), chars.next()), (Some(c), Some('.'), None) if c.is_uppercase())
}

struct Word<'a> {
    text: &'a str,
    start: usize,
    end: usize,
}

fn words(text: &str) -> Vec<Word<'_>> {
    let mut result = Vec::new();
    let mut start: Option<(usize, usize)> = None;
    let mut char_index = 0;
    for (byte, ch) in text.char_indices() {
        // A '.' straight before a capital ends the word: the recogniser
        // drops the space in "office.Jeanna Lavallee".
        let next_upper = text[byte + ch.len_utf8()..]
            .chars()
            .next()
            .is_some_and(char::is_uppercase);
        let part = ch.is_alphanumeric() || ch == '\'' || ch == '-' || (ch == '.' && !next_upper);
        match (part, start) {
            (true, None) => start = Some((byte, char_index)),
            (false, Some((byte_start, char_start))) => {
                result.push(Word {
                    text: &text[byte_start..byte],
                    start: char_start,
                    end: char_index,
                });
                start = None;
            }
            _ => {}
        }
        char_index += 1;
    }
    if let Some((byte_start, char_start)) = start {
        result.push(Word {
            text: &text[byte_start..],
            start: char_start,
            end: char_index,
        });
    }
    for word in &mut result {
        let trimmed = word.text.trim_end_matches('.');
        if trimmed.len() < word.text.len() && !is_initial(word.text) {
            word.end -= word.text.len() - trimmed.len();
            word.text = trimmed;
        }
    }
    result
}

#[derive(PartialEq, Eq, Clone, Copy)]
enum First {
    No,
    Ambiguous,
    Strong,
}

fn first_kind(word: &str) -> First {
    if !(is_capitalized_word(word) || is_upper_word(word)) {
        return First::No;
    }
    let lower = word.to_lowercase();
    if NOT_NAMES.contains(&lower.as_str()) {
        First::No
    } else if NEVER_FIRST.contains(&lower.as_str()) {
        First::Ambiguous
    } else if FIRST_NAMES.contains(lower.as_str()) {
        First::Strong
    } else if AMBIGUOUS_FIRST_NAMES.contains(lower.as_str()) {
        First::Ambiguous
    } else {
        First::No
    }
}

fn surname_like(word: &str) -> bool {
    (is_capitalized_word(word) || is_upper_word(word))
        && word.chars().count() >= 2
        && !SURNAME_STOP.contains(&word.to_lowercase().as_str())
}

fn surname_rank(word: &str) -> Option<usize> {
    LAST_NAMES.get(word.to_lowercase().as_str()).copied()
}

/// Spans (char indices) that read as a person's name: a given name followed
/// by a surname, or a given name after a word that introduces one ("Name:",
/// "Hi", "From:").
pub fn find_names(text: &str) -> Vec<(usize, usize)> {
    let words = words(text);
    let mut spans = Vec::new();
    let mut index = 0;
    while index < words.len() {
        let word = &words[index];
        let previous = index.checked_sub(1).map(|i| &words[i]);
        let previous_lower = previous.map(|w| w.text.to_lowercase()).unwrap_or_default();
        let after_context = CONTEXT.contains(&previous_lower.as_str());
        // "Surname, Given": a known surname, a comma, then a given name.
        if surname_like(word.text)
            && surname_rank(word.text).is_some()
            && let Some(next) = words.get(index + 1)
            && text
                .chars()
                .skip(word.end)
                .take(next.start - word.end)
                .collect::<String>()
                .trim()
                == ","
            && first_kind(next.text) != First::No
        {
            spans.push((word.start, next.end));
            index += 2;
            continue;
        }
        let kind = first_kind(word.text);
        // A word-like given name inside a run of capitalised words ("Pacific
        // Spring Green") is part of a title, not a name.
        let in_title = previous.is_some_and(|p| {
            p.end + 1 >= word.start
                && is_capitalized_word(p.text)
                && !after_context
                && first_kind(p.text) == First::No
        });
        if kind != First::No && !(kind == First::Ambiguous && in_title) {
            let mut end_index = index;
            let mut cursor = index + 1;
            while cursor < words.len() && cursor <= index + 3 {
                let next = &words[cursor];
                let adjacent = next.start <= words[cursor - 1].end + 1;
                if adjacent && (surname_like(next.text) || is_initial(next.text)) {
                    end_index = cursor;
                    cursor += 1;
                } else {
                    break;
                }
            }
            let second = words.get(index + 1).filter(|_| end_index > index);
            let has_surname = end_index > index && surname_like(words[end_index].text);
            let second_common = second.is_some_and(|w| {
                is_initial(w.text) || surname_rank(w.text).is_some_and(|r| r < COMMON_SURNAME_RANK)
            });
            let accept = match kind {
                First::Strong => has_surname || after_context,
                First::Ambiguous => (has_surname && second_common) || after_context,
                First::No => false,
            };
            let titled = previous
                .filter(|p| TITLES.contains(&p.text.trim_end_matches('.').to_lowercase().as_str()));
            let accept = accept || (titled.is_some() && kind != First::No);
            if accept {
                let start = titled.map_or(word.start, |title| title.start);
                let last = &words[end_index];
                let end = if has_surname || end_index == index {
                    last.end
                } else {
                    word.end
                };
                spans.push((start, end));
                index = end_index + 1;
                continue;
            }
        }
        index += 1;
    }
    spans
}

#[cfg(test)]
mod tests {
    use super::find_names;

    fn names(text: &str) -> Vec<String> {
        find_names(text)
            .into_iter()
            .map(|(s, e)| text.chars().skip(s).take(e - s).collect())
            .collect()
    }

    #[test]
    fn full_names_are_found() {
        assert_eq!(
            names("Assigned to Sarah Connor today"),
            vec!["Sarah Connor"]
        );
        assert_eq!(names("From: Michael J. Fox"), vec!["Michael J. Fox"]);
        assert_eq!(names("Hi Priya, thanks"), vec!["Priya"]);
        assert_eq!(names("Name: Olusegun Obasanjo"), vec!["Olusegun Obasanjo"]);
        assert_eq!(names("Will Smith joined"), vec!["Will Smith"]);
        assert_eq!(names("Contact Mrs. Ryan Dover"), vec!["Mrs. Ryan Dover"]);
        assert_eq!(names("the office.Jeanna Lavallee"), vec!["Jeanna Lavallee"]);
    }

    #[test]
    fn interface_words_are_not_names() {
        assert!(names("May 2024 release notes").is_empty());
        assert!(names("Will Update Settings").is_empty());
        assert!(names("Open File Menu").is_empty());
        assert!(names("the quick brown fox").is_empty());
        assert!(names("Austin Texas weather").is_empty());
        assert!(names("Grace Period Ends").is_empty());
    }
}
