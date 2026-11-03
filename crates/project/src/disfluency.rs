pub const HESITATION_FILLERS: &[&str] = &[
    "um", "umm", "uh", "uhh", "uhm", "er", "erm", "ah", "ahh", "eh", "hm", "hmm", "mm", "mmm",
];

pub fn normalize_word(text: &str) -> String {
    text.trim_matches(|c: char| !c.is_alphanumeric() && c != '\'')
        .to_lowercase()
}

pub fn is_hesitation_filler(text: &str) -> bool {
    HESITATION_FILLERS.contains(&normalize_word(text).as_str())
}

/// [`is_hesitation_filler`] plus drawn-out spellings such as "ummmm" and
/// "hmmmm".
pub fn is_hesitation(text: &str) -> bool {
    let normalized = normalize_word(text);
    HESITATION_FILLERS.contains(&normalized.as_str()) || is_drawn_out_hesitation(&normalized)
}

#[cfg(test)]
mod corpus_tests;
#[cfg(test)]
mod tests;

const DRAWN_OUT_HESITATIONS: &[&str] = &["um", "uh", "uhm", "er", "erm", "ehm", "ah", "eh", "hm"];

/// "Ummmm", "uhhh", "errrm", "hmmmm" and "mmmm" collapse onto a listed form
/// once repeated letters are squeezed. Backchannels such as "uh-huh" and
/// "mm-hmm" keep their hyphen, so they never match and are left in.
fn is_drawn_out_hesitation(normalized: &str) -> bool {
    if normalized.is_empty() || !normalized.chars().all(|c| c.is_ascii_alphabetic()) {
        return false;
    }
    if normalized.len() >= 2 && normalized.chars().all(|c| c == 'm') {
        return true;
    }
    let mut squeezed = String::with_capacity(normalized.len());
    for c in normalized.chars() {
        if !squeezed.ends_with(c) {
            squeezed.push(c);
        }
    }
    DRAWN_OUT_HESITATIONS.contains(&squeezed.as_str())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum DisfluencyKind {
    Hesitation,
    Repetition,
    FalseStart,
    Discourse,
}

impl DisfluencyKind {
    pub const ALL: [Self; 4] = [
        Self::Hesitation,
        Self::Repetition,
        Self::FalseStart,
        Self::Discourse,
    ];

    fn priority(self) -> u8 {
        match self {
            Self::Hesitation => 0,
            Self::Repetition => 1,
            Self::FalseStart => 2,
            Self::Discourse => 3,
        }
    }
}

/// One removable stretch of the transcript. `words` indexes the token slice
/// passed to [`detect_disfluencies`] and always starts and ends on a spoken
/// word. `phrase` is the lowercased words it covers, which is what the review
/// list groups discourse fillers by.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Disfluency {
    pub kind: DisfluencyKind,
    pub words: std::ops::Range<usize>,
    pub phrase: String,
}

#[derive(Clone, Copy, Debug)]
pub struct DisfluencyToken<'a> {
    pub text: &'a str,
    pub start: f64,
    pub end: f64,
}

/// A pause this long reads as a sentence break even when the recognizer did
/// not punctuate one.
const SENTENCE_PAUSE: f64 = 1.0;
const MAX_REPEATED_PHRASE: usize = 4;
const MAX_FALSE_START: usize = 3;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
enum Trailing {
    #[default]
    None,
    Comma,
    Terminal,
    Question,
    Break,
}

impl Trailing {
    fn from_text(text: &str) -> Self {
        let trimmed = text.trim_end_matches(['"', '\'', '”', '’', ')', ']']);
        if trimmed.ends_with("...") || trimmed.ends_with('…') {
            return Self::Break;
        }
        match trimmed.chars().last() {
            Some('?') => Self::Question,
            Some('.' | '!' | '。' | '！' | '？') => Self::Terminal,
            Some(',' | ';' | ':' | '，' | '、') => Self::Comma,
            Some('-' | '—' | '–') => Self::Break,
            _ => Self::None,
        }
    }

    fn merge(self, other: Self) -> Self {
        if other == Self::None { self } else { other }
    }

    fn ends_sentence(self) -> bool {
        matches!(self, Self::Terminal | Self::Question)
    }

    fn sets_off(self) -> bool {
        self != Self::None
    }
}

#[derive(Debug)]
struct Word {
    index: usize,
    norm: String,
    trailing: Trailing,
    cut_off: bool,
    start: f64,
    end: f64,
    hesitation: bool,
}

fn words_of(tokens: &[DisfluencyToken<'_>]) -> Vec<Word> {
    let mut words: Vec<Word> = Vec::with_capacity(tokens.len());
    for (index, token) in tokens.iter().enumerate() {
        let norm = normalize_word(token.text);
        let trailing = Trailing::from_text(token.text.trim());
        if norm.is_empty() {
            if let Some(previous) = words.last_mut() {
                previous.trailing = previous.trailing.merge(trailing);
            }
            continue;
        }
        let trimmed = token.text.trim().trim_end_matches(['"', '\'', '”', '’']);
        let cut_off = (trimmed.ends_with('-') || trimmed.ends_with('—') || trimmed.ends_with('–'))
            && !trimmed.ends_with("--");
        words.push(Word {
            index,
            hesitation: is_hesitation(&norm),
            norm,
            trailing,
            cut_off,
            start: token.start,
            end: token.end,
        });
    }
    words
}

fn is_number_word(norm: &str) -> bool {
    norm.chars().all(|c| c.is_ascii_digit() || c == '\'')
        || matches!(
            norm,
            "zero"
                | "oh"
                | "one"
                | "two"
                | "three"
                | "four"
                | "five"
                | "six"
                | "seven"
                | "eight"
                | "nine"
                | "ten"
                | "hundred"
                | "thousand"
                | "million"
                | "billion"
        )
}

/// Doubled words that English uses on purpose: intensifiers, emphatic
/// answers, and the grammatical "had had" / "that that" / "is is".
fn is_intentional_double(norm: &str) -> bool {
    is_number_word(norm)
        || matches!(
            norm,
            "very"
                | "really"
                | "no"
                | "yes"
                | "yeah"
                | "bye"
                | "ha"
                | "haha"
                | "ho"
                | "la"
                | "knock"
                | "many"
                | "much"
                | "more"
                | "far"
                | "long"
                | "had"
                | "that"
                | "is"
                | "do"
                | "well"
                | "go"
                | "chop"
                | "tick"
                | "night"
                | "boo"
                | "hush"
                | "bang"
                | "beep"
                | "blah"
                | "bla"
                | "yada"
                | "wow"
                | "hey"
                | "hi"
                | "oh"
                | "ok"
                | "okay"
                | "please"
                | "quick"
                | "come"
                | "now"
                | "pretty"
                | "super"
        )
}

/// Words a restarted clause can begin with. A false start is only proposed
/// when the abandoned and the restarted clause both open on one of these, so
/// a content word that merely recurs is never cut.
fn is_clause_opener(norm: &str) -> bool {
    matches!(
        norm,
        "i" | "i'm"
            | "i've"
            | "i'll"
            | "i'd"
            | "we"
            | "we're"
            | "we've"
            | "we'll"
            | "you"
            | "you're"
            | "you'll"
            | "he"
            | "she"
            | "it"
            | "it's"
            | "they"
            | "they're"
            | "this"
            | "that"
            | "these"
            | "those"
            | "there"
            | "there's"
            | "the"
            | "a"
            | "an"
            | "my"
            | "our"
            | "your"
            | "if"
            | "when"
            | "what"
            | "how"
            | "why"
            | "so"
            | "and"
            | "but"
            | "to"
            | "in"
            | "on"
            | "at"
            | "for"
            | "with"
            | "let's"
            | "let"
            | "can"
            | "is"
            | "was"
            | "do"
            | "does"
            | "did"
    )
}

/// A clause ending in one of these is complete before an "um", so "I think,
/// um, I can" keeps its "I think". "Is" and "was" only count after a noun
/// phrase ("the thing is, um, the server"), not after a lone pronoun ("this
/// is, uh, this was").
fn takes_clause_complement(norm: &str, clause_len: usize) -> bool {
    if matches!(norm, "is" | "was") {
        return clause_len >= 3;
    }
    matches!(
        norm,
        "think"
            | "thought"
            | "guess"
            | "know"
            | "knew"
            | "mean"
            | "meant"
            | "believe"
            | "feel"
            | "felt"
            | "said"
            | "say"
            | "says"
            | "hope"
            | "bet"
            | "suppose"
            | "remember"
            | "realized"
            | "realised"
            | "found"
            | "noticed"
            | "see"
            | "saw"
            | "wish"
            | "heard"
            | "decided"
            | "figured"
            | "wonder"
            | "promise"
            | "assume"
            | "understand"
            | "imagine"
    )
}

fn longest_silence(words: &[Word], from: usize, to: usize) -> f64 {
    (from + 1..=to.min(words.len().saturating_sub(1)))
        .map(|at| words[at].start - words[at - 1].end)
        .fold(0.0, f64::max)
}

struct Context<'a> {
    words: &'a [Word],
}

impl Context<'_> {
    fn gap_before(&self, at: usize) -> f64 {
        match at
            .checked_sub(1)
            .and_then(|previous| self.words.get(previous))
        {
            Some(previous) => self.words[at].start - previous.end,
            None => f64::INFINITY,
        }
    }

    /// Whether `at` opens a sentence, looking back past hesitations and
    /// other opening markers ("Um, okay, so"). With `pauses`, a long silence
    /// counts as a sentence break even without punctuation.
    fn starts_sentence(&self, at: usize, pauses: bool) -> bool {
        let mut cursor = at;
        loop {
            let Some(previous) = cursor.checked_sub(1) else {
                return true;
            };
            if self.words[previous].trailing.ends_sentence()
                || (pauses && self.gap_before(cursor) >= SENTENCE_PAUSE)
            {
                return true;
            }
            if !self.words[previous].hesitation && !is_opening_marker(&self.words[previous].norm) {
                return false;
            }
            cursor = previous;
        }
    }

    fn set_off_before(&self, at: usize) -> bool {
        if self.starts_sentence(at, true) {
            return true;
        }
        let previous = &self.words[at - 1];
        previous.trailing.sets_off() || previous.hesitation || previous.cut_off
    }

    /// Set off on the right by a comma, a dash, an ellipsis, a hesitation
    /// or a long pause. A full stop only counts when `sentence_end` allows
    /// it: "it works, actually." keeps its "actually".
    fn set_off_after(&self, last: usize, sentence_end: bool) -> bool {
        let word = &self.words[last];
        match word.trailing {
            Trailing::Comma | Trailing::Break => return true,
            Trailing::Terminal | Trailing::Question => return sentence_end,
            Trailing::None => {}
        }
        match self.words.get(last + 1) {
            None => sentence_end,
            Some(next) => next.hesitation || self.gap_before(last + 1) >= SENTENCE_PAUSE,
        }
    }

    fn matches(&self, at: usize, phrase: &[&str]) -> bool {
        phrase.len() <= self.words.len().saturating_sub(at)
            && phrase
                .iter()
                .zip(&self.words[at..])
                .all(|(expected, word)| word.norm == *expected)
            && self.words[at..at + phrase.len() - 1]
                .iter()
                .all(|word| !word.trailing.sets_off())
    }
}

/// Sentence-opening markers that may precede another marker without ending
/// the sentence start: "Okay, so, basically".
fn is_opening_marker(norm: &str) -> bool {
    matches!(
        norm,
        "so" | "okay" | "ok" | "alright" | "right" | "well" | "basically" | "actually" | "like"
    )
}

fn detect_hesitations(words: &[Word], out: &mut Vec<(DisfluencyKind, usize, usize)>) {
    for (at, word) in words.iter().enumerate() {
        if word.hesitation {
            out.push((DisfluencyKind::Hesitation, at, at + 1));
        }
    }
}

/// Immediate repeats of one to four words, matched with hesitations and
/// cut-off fragments skipped so "the, um, the" is still a repeat. Every copy
/// but the last is marked, because the last one flows into the rest of the
/// sentence. A copy abandoned with a fragment ("the wh- the") is a false
/// start rather than a repeat.
fn detect_repetitions(words: &[Word], out: &mut Vec<(DisfluencyKind, usize, usize)>) {
    let spoken: Vec<usize> = (0..words.len())
        .filter(|&at| !words[at].hesitation && !words[at].cut_off)
        .collect();
    let mut cursor = 0;
    while cursor < spoken.len() {
        let mut matched = None;
        for size in (1..=MAX_REPEATED_PHRASE).rev() {
            if cursor + size * 2 > spoken.len() {
                continue;
            }
            let first = &spoken[cursor..cursor + size];
            let second = &spoken[cursor + size..cursor + size * 2];
            if !first
                .iter()
                .zip(second)
                .all(|(a, b)| words[*a].norm == words[*b].norm)
            {
                continue;
            }
            if first
                .iter()
                .chain(&second[..size - 1])
                .any(|&at| words[at].trailing.ends_sentence())
            {
                continue;
            }
            let last_of_first = first[size - 1];
            if size == 1 && is_intentional_double(&words[last_of_first].norm)
                || size > 1
                    && first
                        .iter()
                        .all(|&at| is_intentional_double(&words[at].norm))
            {
                continue;
            }
            if longest_silence(words, first[0], second[size - 1]) >= SENTENCE_PAUSE {
                continue;
            }
            let coordinated = |at: &usize| matches!(words[*at].norm.as_str(), "and" | "or" | "nor");
            let chained = cursor
                .checked_sub(1)
                .is_some_and(|previous| words[spoken[previous]].norm == words[last_of_first].norm);
            if size > 1 && (coordinated(&last_of_first) || first.iter().any(coordinated) && chained)
            {
                continue;
            }
            if size == 1
                && words[last_of_first].norm == "so"
                && spoken
                    .get(cursor + 2)
                    .is_some_and(|&next| so_is_degree_word(&words[next]))
            {
                continue;
            }
            matched = Some(size);
            break;
        }
        match matched {
            Some(size) => {
                let first = spoken[cursor];
                let last = spoken[cursor + size - 1];
                let fragment = words[last + 1..spoken[cursor + size]]
                    .iter()
                    .any(|word| word.cut_off);
                let kind = if fragment {
                    DisfluencyKind::FalseStart
                } else {
                    DisfluencyKind::Repetition
                };
                out.push((kind, first, last + 1));
                cursor += size;
            }
            None => cursor += 1,
        }
    }
}

/// A cut-off fragment ("wh-", "comp—") is always a false start. A clause is
/// a false start when it starts at a clause boundary, is abandoned with a
/// dash, an ellipsis, a fragment or a hesitation, and the speaker restarts on
/// the same opening word with different words: "we should, um, we need to".
/// "For the bug report, uh, the user" is not one: its "the" is inside a
/// phrase, not opening a clause.
fn detect_false_starts(words: &[Word], out: &mut Vec<(DisfluencyKind, usize, usize)>) {
    for (at, word) in words.iter().enumerate() {
        if word.cut_off && !word.hesitation {
            out.push((DisfluencyKind::FalseStart, at, at + 1));
        }
    }
    let context = Context { words };
    for start in 0..words.len() {
        let opener = &words[start];
        if opener.hesitation || opener.cut_off || !is_clause_opener(&opener.norm) {
            continue;
        }
        let at_boundary = context.set_off_before(start)
            || start.checked_sub(1).is_some_and(|previous| {
                matches!(
                    words[previous].norm.as_str(),
                    "and" | "but" | "so" | "then" | "because" | "or" | "if" | "when"
                )
            });
        if !at_boundary {
            continue;
        }
        for size in 2..=MAX_FALSE_START {
            let last = start + size - 1;
            let Some(abandoned) = words.get(last) else {
                break;
            };
            if words[start..=last]
                .iter()
                .any(|word| word.hesitation || word.cut_off)
                || words[start..last]
                    .iter()
                    .any(|word| word.trailing.sets_off())
                || abandoned.trailing.ends_sentence()
            {
                break;
            }
            let mut restart = last + 1;
            let mut interrupted = abandoned.trailing == Trailing::Break;
            while words
                .get(restart)
                .is_some_and(|next| next.hesitation || next.cut_off)
            {
                interrupted = true;
                restart += 1;
            }
            let Some(restarted) = words.get(restart) else {
                break;
            };
            if !interrupted
                || restarted.norm != opener.norm
                || takes_clause_complement(&abandoned.norm, size)
                || longest_silence(words, last, restart) >= SENTENCE_PAUSE
            {
                continue;
            }
            let restated = words[restart..]
                .iter()
                .take(size)
                .map(|word| word.norm.as_str())
                .eq(words[start..=last].iter().map(|word| word.norm.as_str()));
            if !restated {
                out.push((DisfluencyKind::FalseStart, start, last + 1));
            }
            break;
        }
    }
}

/// Phrases that are fillers when set off from the sentence, and whether a
/// full stop after them counts as setting them off.
const SET_OFF_PHRASES: &[(&[&str], bool)] = &[
    (&["you", "know", "what", "i", "mean"], true),
    (&["you", "know"], true),
    (&["i", "mean"], false),
    (&["sort", "of"], false),
    (&["kind", "of"], false),
    (&["like"], false),
    (&["basically"], false),
    (&["actually"], false),
    (&["literally"], false),
    (&["honestly"], false),
];

const SENTENCE_OPENERS: &[&[&str]] = &[
    &["all", "right"],
    &["okay"],
    &["ok"],
    &["alright"],
    &["right"],
    &["well"],
];

/// "So" opening a sentence is almost always a discourse marker, unless it is
/// the start of "so much", "so far" and the like.
fn so_is_degree_word(next: &Word) -> bool {
    matches!(
        next.norm.as_str(),
        "much"
            | "many"
            | "far"
            | "long"
            | "few"
            | "little"
            | "what"
            | "to"
            | "called"
            | "good"
            | "bad"
            | "cool"
            | "fast"
            | "slow"
            | "easy"
            | "hard"
            | "big"
            | "small"
            | "close"
            | "sorry"
            | "glad"
            | "happy"
            | "do"
            | "did"
            | "does"
    )
}

fn detect_discourse(words: &[Word], out: &mut Vec<(DisfluencyKind, usize, usize)>) {
    let context = Context { words };
    for at in 0..words.len() {
        if words[at].hesitation {
            continue;
        }
        if let Some((phrase, sentence_end)) = SET_OFF_PHRASES
            .iter()
            .find(|(phrase, _)| context.matches(at, phrase))
        {
            let last = at + phrase.len() - 1;
            let surrounded =
                context.set_off_before(at) && context.set_off_after(last, *sentence_end);
            let opening = context.starts_sentence(at, false)
                && matches!(words[last].trailing, Trailing::Comma | Trailing::Break);
            if surrounded || opening {
                out.push((DisfluencyKind::Discourse, at, last + 1));
                continue;
            }
        }
        if words[at].norm == "right"
            && words[at].trailing == Trailing::Question
            && at > 0
            && (words[at - 1].trailing == Trailing::Comma || words[at - 1].hesitation)
        {
            out.push((DisfluencyKind::Discourse, at, at + 1));
            continue;
        }
        if !context.starts_sentence(at, false) {
            continue;
        }
        if words[at].norm == "so" {
            let continues = !words[at].trailing.ends_sentence();
            if let Some(next) = words.get(at + 1)
                && continues
                && (words[at].trailing.sets_off() || !so_is_degree_word(next))
            {
                out.push((DisfluencyKind::Discourse, at, at + 1));
            }
            continue;
        }
        if let Some(phrase) = SENTENCE_OPENERS
            .iter()
            .find(|phrase| context.matches(at, phrase))
        {
            let last = at + phrase.len() - 1;
            let trailing = words[last].trailing;
            let next = words.get(last + 1);
            let followed_by_so = next.is_some_and(|next| next.norm == "so");
            let acknowledgement = trailing.ends_sentence()
                && matches!(words[last].norm.as_str(), "okay" | "ok" | "alright")
                && next.is_some();
            let doubled = next.is_some_and(|next| next.norm == words[last].norm)
                || at
                    .checked_sub(1)
                    .is_some_and(|previous| words[previous].norm == words[at].norm);
            if doubled {
                continue;
            }
            if matches!(trailing, Trailing::Comma | Trailing::Break)
                || (followed_by_so && trailing == Trailing::None)
                || acknowledgement
            {
                out.push((DisfluencyKind::Discourse, at, last + 1));
            }
        }
    }
}

/// Finds hesitations, repeated words, false starts and discourse fillers in a
/// timed transcript. Each token belongs to at most one result; where two
/// readings overlap, hesitation wins over repetition, then false start, then
/// discourse. Results are sorted by position.
///
/// Discourse fillers are only proposed with punctuation or pause evidence
/// that the word is set off from the sentence ("it was, like, huge"), so "I
/// like pizza" and "you know how" are left alone.
pub fn detect_disfluencies(tokens: &[DisfluencyToken<'_>]) -> Vec<Disfluency> {
    let words = words_of(tokens);
    let mut candidates = Vec::new();
    detect_hesitations(&words, &mut candidates);
    detect_repetitions(&words, &mut candidates);
    detect_false_starts(&words, &mut candidates);
    detect_discourse(&words, &mut candidates);
    candidates.sort_by_key(|(kind, start, end)| (kind.priority(), *start, *end));

    let mut taken = vec![false; words.len()];
    let mut kept = Vec::new();
    for (kind, start, end) in candidates {
        if taken[start..end].iter().any(|taken| *taken) {
            continue;
        }
        taken[start..end].iter_mut().for_each(|taken| *taken = true);
        kept.push((kind, start, end));
    }
    kept.sort_by_key(|(_, start, _)| *start);

    let mut merged: Vec<(DisfluencyKind, usize, usize)> = Vec::with_capacity(kept.len());
    for (kind, start, end) in kept {
        match merged.last_mut() {
            Some((previous, _, previous_end))
                if *previous == DisfluencyKind::FalseStart
                    && kind == DisfluencyKind::FalseStart
                    && *previous_end == start =>
            {
                *previous_end = end;
            }
            _ => merged.push((kind, start, end)),
        }
    }

    merged
        .into_iter()
        .map(|(kind, start, end)| Disfluency {
            kind,
            words: words[start].index..words[end - 1].index + 1,
            phrase: words[start..end]
                .iter()
                .map(|word| word.norm.as_str())
                .collect::<Vec<_>>()
                .join(" "),
        })
        .collect()
}
