//! One dictionary for all of Cap: how names and terms are spelled, and what
//! they can sound like in a transcript. The corrector fixes whole words in
//! finished transcription output and never touches ordinary words: a
//! capitalised spelling or spoken form only replaces a capitalised word,
//! sound-alike matches
//! only swap hard c, k and q, and anything already spelled right is left.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

#[cfg(test)]
mod tests;

pub const MAX_ENTRIES: usize = 200;
pub const MAX_SPELLING_CHARS: usize = 64;
pub const MAX_SOUNDS_LIKE: usize = 8;
/// Longest run of transcript words one form can cover.
const MAX_RUN: usize = 4;

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Entry {
    pub spelling: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub sounds_like: Vec<String>,
}

impl Entry {
    pub fn new(spelling: impl Into<String>) -> Self {
        Self {
            spelling: spelling.into(),
            sounds_like: Vec::new(),
        }
    }

    pub fn with_sounds_like(mut self, forms: &[&str]) -> Self {
        self.sounds_like = forms.iter().map(|f| (*f).to_string()).collect();
        self
    }
}

/// Entries Cap adds once by itself. Removing one sticks: the settings keep
/// the names already offered.
pub fn builtins() -> Vec<Entry> {
    vec![Entry::new("Cap").with_sounds_like(&["Kap", "Capp", "Kapp"])]
}

fn clean_text(text: &str, max: usize) -> String {
    text.replace('\0', "")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(max)
        .collect()
}

/// Trim, drop empties and duplicates (case-insensitive spellings; a later
/// duplicate's sounds-like forms join the first), cap sizes.
pub fn normalize(entries: Vec<Entry>) -> Vec<Entry> {
    let mut out: Vec<Entry> = Vec::new();
    for entry in entries {
        let spelling = clean_text(&entry.spelling, MAX_SPELLING_CHARS);
        if spelling.is_empty() {
            continue;
        }
        let index = match out
            .iter()
            .position(|e| e.spelling.eq_ignore_ascii_case(&spelling))
        {
            Some(index) => index,
            None => {
                if out.len() >= MAX_ENTRIES {
                    continue;
                }
                out.push(Entry::new(spelling.clone()));
                out.len() - 1
            }
        };
        for form in entry.sounds_like {
            let form = clean_text(&form, MAX_SPELLING_CHARS);
            let target = &mut out[index];
            if form.is_empty()
                || form == target.spelling
                || target
                    .sounds_like
                    .iter()
                    .any(|f| f.eq_ignore_ascii_case(&form))
                || target.sounds_like.len() >= MAX_SOUNDS_LIKE
            {
                continue;
            }
            target.sounds_like.push(form);
        }
    }
    out
}

/// Add `wrong` as a sounds-like form of `spelling`, creating the entry when
/// there is none. Returns false when nothing changed.
pub fn learn(entries: &mut Vec<Entry>, spelling: &str, wrong: &str) -> bool {
    let before = entries.clone();
    let mut next = std::mem::take(entries);
    let wrong = clean_text(wrong, MAX_SPELLING_CHARS);
    let mut entry = Entry::new(spelling);
    if !wrong.is_empty() && wrong != clean_text(spelling, MAX_SPELLING_CHARS) {
        entry.sounds_like.push(wrong);
    }
    next.push(entry);
    *entries = normalize(next);
    *entries != before
}

pub fn spellings(entries: &[Entry]) -> Vec<String> {
    entries.iter().map(|e| e.spelling.clone()).collect()
}

/// Replace `len` transcript words from `start` with `words`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Fix {
    pub start: usize,
    pub len: usize,
    pub words: Vec<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Kind {
    Form,
    Sound,
}

#[derive(Clone, Debug, Default)]
pub struct Corrector {
    entries: Vec<(String, Vec<String>)>,
    /// Spoken form -> (entry, whether the form is capitalised).
    forms: HashMap<String, (usize, bool)>,
    sounds: HashMap<String, Option<usize>>,
    spelled: HashMap<String, ()>,
    longest: usize,
}

impl Corrector {
    pub fn new(entries: &[Entry]) -> Self {
        let mut corrector = Corrector::default();
        for entry in normalize(entries.to_vec()) {
            let index = corrector.entries.len();
            let parts: Vec<String> = entry.spelling.split(' ').map(str::to_string).collect();
            corrector.longest = corrector.longest.max(parts.len());
            corrector.spelled.insert(entry.spelling.clone(), ());
            for form in &entry.sounds_like {
                let key = form_key(form);
                if key.is_empty() {
                    continue;
                }
                corrector.longest = corrector.longest.max(key.split(' ').count());
                let cased = form.chars().next().is_some_and(char::is_uppercase);
                corrector.forms.entry(key).or_insert((index, cased));
            }
            let letters: usize = entry
                .spelling
                .chars()
                .filter(|c| c.is_alphanumeric())
                .count();
            if letters >= 3 {
                let key = sound_key(&entry.spelling);
                if !key.is_empty() {
                    let slot = corrector.sounds.entry(key).or_insert(Some(index));
                    if *slot != Some(index) {
                        *slot = None;
                    }
                }
            }
            corrector.entries.push((entry.spelling, parts));
        }
        corrector.longest = corrector.longest.clamp(1, MAX_RUN);
        corrector
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// The fixes for one line's words, in order, never overlapping.
    pub fn fixes<S: AsRef<str>>(&self, words: &[S]) -> Vec<Fix> {
        if self.is_empty() || words.is_empty() {
            return Vec::new();
        }
        let mut out = Vec::new();
        let mut i = 0;
        while i < words.len() {
            match self.best_at(words, i) {
                Some(fix) => {
                    i += fix.len;
                    out.push(fix);
                }
                None => i += 1,
            }
        }
        out
    }

    fn best_at<S: AsRef<str>>(&self, words: &[S], i: usize) -> Option<Fix> {
        let most = self.longest.min(words.len() - i);
        let mut sound: Option<Fix> = None;
        for n in (1..=most).rev() {
            let Some(run) = Run::read(&words[i..i + n]) else {
                continue;
            };
            if let Some(&(index, cased)) = self.forms.get(&form_key(&run.core)) {
                // A capitalised form ("Kap") is a name: it only matches a
                // capitalised word, so a lowercase word stays.
                let capitalised = run.words[0].chars().next().is_some_and(char::is_uppercase);
                if !cased || capitalised {
                    return self.fix(i, n, index, &run, Kind::Form);
                }
            }
            if sound.is_none()
                && let Some(Some(index)) = self.sounds.get(&sound_key(&run.core))
            {
                sound = self.fix(i, n, *index, &run, Kind::Sound);
            }
        }
        sound
    }

    fn fix(&self, start: usize, len: usize, index: usize, run: &Run, kind: Kind) -> Option<Fix> {
        let (spelling, parts) = &self.entries[index];
        if run.core == *spelling || self.spelled.contains_key(&run.core) {
            return None;
        }
        if kind == Kind::Sound && !case_allows(spelling, &run.words) {
            return None;
        }
        let mut words: Vec<String> = parts.clone();
        if let Some(first) = words.first_mut() {
            first.insert_str(0, &run.lead);
        }
        if let Some(last) = words.last_mut() {
            last.push_str(&run.suffix);
            last.push_str(&run.trail);
        }
        Some(Fix { start, len, words })
    }

    /// Correct plain word strings in place (one string per word).
    pub fn apply_strings(&self, words: &mut Vec<String>) -> usize {
        let fixes = self.fixes(words);
        let count = fixes.len();
        for fix in fixes.into_iter().rev() {
            words.splice(fix.start..fix.start + fix.len, fix.words);
        }
        count
    }

    /// Correct timed words in place. A fix that changes the number of words
    /// spreads the run's time evenly over the new words.
    pub fn apply_timed<W>(
        &self,
        words: &mut Vec<W>,
        text: impl Fn(&W) -> &str,
        make: impl Fn(&W, String, u64, u64) -> W,
        span: impl Fn(&W) -> (u64, u64),
    ) -> usize {
        let fixes = {
            let texts: Vec<&str> = words.iter().map(&text).collect();
            self.fixes(&texts)
        };
        let count = fixes.len();
        for fix in fixes.into_iter().rev() {
            let run = &words[fix.start..fix.start + fix.len];
            let (start, _) = span(&run[0]);
            let (_, end) = span(&run[run.len() - 1]);
            let replaced: Vec<W> = if fix.words.len() == fix.len {
                run.iter()
                    .zip(fix.words)
                    .map(|(w, t)| {
                        let (s, e) = span(w);
                        make(w, t, s, e)
                    })
                    .collect()
            } else {
                let k = fix.words.len() as u64;
                let total = end.saturating_sub(start);
                fix.words
                    .into_iter()
                    .enumerate()
                    .map(|(j, t)| {
                        let j = j as u64;
                        make(
                            &run[0],
                            t,
                            start + total * j / k,
                            start + total * (j + 1) / k,
                        )
                    })
                    .collect()
            };
            words.splice(fix.start..fix.start + fix.len, replaced);
        }
        count
    }
}

/// A run of transcript words as one phrase: outer punctuation kept apart,
/// a possessive kept apart, inner punctuation not allowed.
struct Run {
    lead: String,
    core: String,
    suffix: String,
    trail: String,
    words: Vec<String>,
}

impl Run {
    fn read<S: AsRef<str>>(words: &[S]) -> Option<Run> {
        let last = words.len() - 1;
        let mut lead = String::new();
        let mut trail = String::new();
        let mut cores = Vec::with_capacity(words.len());
        for (j, word) in words.iter().enumerate() {
            let word = word.as_ref();
            let start = word.find(|c: char| c.is_alphanumeric())?;
            let end = word
                .char_indices()
                .rev()
                .find(|(_, c)| c.is_alphanumeric())
                .map(|(at, c)| at + c.len_utf8())?;
            if (j > 0 && start > 0) || (j < last && end < word.len()) {
                return None;
            }
            if j == 0 {
                lead = word[..start].to_string();
            }
            if j == last {
                trail = word[end..].to_string();
            }
            cores.push(word[start..end].to_string());
        }
        let mut suffix = String::new();
        if let Some(core) = cores.last_mut() {
            for possessive in ["'s", "\u{2019}s", "'S"] {
                if core.len() > possessive.len() + 1 && core.ends_with(possessive) {
                    suffix = core[core.len() - possessive.len()..].to_string();
                    core.truncate(core.len() - possessive.len());
                    break;
                }
            }
        }
        Some(Run {
            lead,
            core: cores.join(" "),
            suffix,
            trail,
            words: cores,
        })
    }
}

/// Explicit sounds-like forms match whatever the case and spacing.
fn form_key(text: &str) -> String {
    text.split(|c: char| c.is_whitespace() || c == '-')
        .map(|part| {
            part.chars()
                .filter(|c| c.is_alphanumeric() || *c == '\'' || *c == '\u{2019}')
                .flat_map(char::to_lowercase)
                .collect::<String>()
        })
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

/// How a word sounds, coarsely: only the hard c, k and q spellings fold
/// together, so Kap and Cap meet but Cape, Cup, Call and Sell never move.
fn sound_key(text: &str) -> String {
    let lower: Vec<char> = text
        .chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect();
    let mut out = String::with_capacity(lower.len());
    let mut i = 0;
    while i < lower.len() {
        let c = lower[i];
        let next = lower.get(i + 1).copied();
        match c {
            'c' if next == Some('k') => {
                out.push('k');
                i += 2;
                continue;
            }
            'c' if matches!(next, Some('e' | 'i' | 'y')) => out.push('c'),
            'c' | 'q' => out.push('k'),
            _ => out.push(c),
        }
        i += 1;
    }
    out
}

/// A sound-alike match keeps the casing contract of the spelling: a
/// capitalised name only replaces a capitalised word, and an all-caps word
/// (an acronym) is left alone unless the spelling is one too.
fn case_allows(spelling: &str, words: &[String]) -> bool {
    let Some(first) = spelling.chars().next() else {
        return false;
    };
    let spelling_caps = spelling
        .chars()
        .filter(|c| c.is_alphabetic())
        .all(char::is_uppercase);
    let single = words.len() == 1;
    words.iter().all(|word| {
        let Some(head) = word.chars().next() else {
            return false;
        };
        let letters: Vec<char> = word.chars().filter(|c| c.is_alphabetic()).collect();
        let shouting = letters.len() > 1 && letters.iter().all(|c| c.is_uppercase());
        if single && shouting && !spelling_caps {
            return false;
        }
        !first.is_uppercase() || head.is_uppercase()
    })
}
