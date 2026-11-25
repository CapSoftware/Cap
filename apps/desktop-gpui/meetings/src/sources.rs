//! Which transcript line a point in the notes came from.
//!
//! Notes are written from the transcript, so a decision or an action item
//! usually repeats a few of the rarer words someone said. A point links to a
//! line only when that line (or it and the next one) carries most of the
//! point's distinctive words and no line elsewhere in the meeting comes close:
//! a missing link costs little, a wrong one costs trust.

use std::collections::{HashMap, HashSet};

use unicode_segmentation::UnicodeSegmentation;

use crate::text::fold;

#[derive(Clone, Copy, Debug)]
pub struct SourceTurn<'a> {
    pub text: &'a str,
    pub speaker: &'a str,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Link {
    /// First transcript turn of the source.
    pub turn: usize,
    /// How many turns, from `turn`, the point draws on (1 or 2).
    pub span: usize,
    pub score: f32,
}

#[derive(Clone, Copy, Debug)]
pub struct Tuning {
    /// Share of the point's word weight the source must carry.
    pub min_coverage: f32,
    /// How far the best source must lead the best one elsewhere.
    pub min_margin: f32,
    /// Distinctive words the point and the source must share.
    pub min_shared: usize,
    /// Turns either side that count as the same place in the meeting.
    pub neighbourhood: usize,
}

impl Default for Tuning {
    fn default() -> Self {
        Self {
            min_coverage: 0.5,
            min_margin: 0.15,
            min_shared: 3,
            neighbourhood: 3,
        }
    }
}

const SPEAKER_WEIGHT: f32 = 0.6;
const PAIR_GAIN: f32 = 0.1;
const MIN_POINT_WORDS: usize = 3;
const MIN_PAIR_WORDS: usize = 6;
const STEM_CHARS: usize = 6;

const STOPWORDS: &[&str] = &[
    // English
    "the", "and", "for", "are", "but", "not", "you", "all", "any", "can", "had", "her", "was",
    "one", "our", "out", "has", "have", "him", "his", "how", "its", "may", "new", "now", "old",
    "see", "two", "way", "who", "did", "get", "got", "let", "say", "she", "too", "use", "that",
    "with", "this", "they", "them", "then", "than", "there", "their", "what", "when", "where",
    "which", "will", "would", "could", "should", "about", "into", "from", "just", "like", "also",
    "been", "being", "were", "some", "more", "most", "very", "much", "such", "only", "over",
    "after", "before", "because", "these", "those", "your", "yours", "here", "yeah", "okay",
    "right", "think", "going", "know", "want", "need", "make", "made", "said", "says", "well",
    "really", "thing", "things", "something", "maybe", "sure", "still", "even", "each", "other",
    "does", "doing", "done", "back", "both", "same", "next", "first", "last", "time", "week",
    "team", "agreed", "agree", "decided", "decide", "discussed", "discuss", "noted", "mentioned",
    "asked", "suggested", "confirmed", "follow", "while", "until", "since", "though", "through",
    "per", "via", "yes", "yep", "um", "uh", "mean", "kind", "lot", "bit", "gonna", "wanna",
    // Spanish
    "que", "los", "las", "del", "con", "por", "para", "una", "uno", "como", "pero", "mas", "este",
    "esta", "esto", "eso", "esa", "ese", "son", "sus", "les", "nos", "ya", "muy", "hay", "fue",
    "ser", "sin", "sobre", "entre", "cuando", "donde", "porque", "tambien", "todo", "toda",
    "todos", "todas", "bueno", "vale", "entonces", "pues", "se", "lo", "le", "al",
    // German
    "der", "die", "das", "und", "ist", "nicht", "ein", "eine", "einen", "dem", "den", "des",
    "mit", "auf", "fur", "von", "zum", "zur", "wir", "ihr", "sie", "auch", "noch", "aber", "oder",
    "wenn", "dann", "dass", "sich", "wird", "werden", "haben", "hat", "sind", "war", "ja", "also",
    // French
    "les", "des", "une", "est", "pas", "pour", "dans", "avec", "sur", "qui", "que", "par", "mais",
    "nous", "vous", "ils", "elle", "aux", "ont", "sont", "cette", "tout", "plus", "fait",
];

fn fold_accent(c: char) -> char {
    match c {
        'à' | 'á' | 'â' | 'ã' | 'ä' | 'å' | 'ā' | 'ă' | 'ą' => 'a',
        'ç' | 'ć' | 'č' => 'c',
        'ď' => 'd',
        'è' | 'é' | 'ê' | 'ë' | 'ē' | 'ė' | 'ę' | 'ě' => 'e',
        'ì' | 'í' | 'î' | 'ï' | 'ī' | 'į' => 'i',
        'ñ' | 'ń' | 'ň' => 'n',
        'ò' | 'ó' | 'ô' | 'õ' | 'ö' | 'ø' | 'ō' | 'ő' => 'o',
        'ù' | 'ú' | 'û' | 'ü' | 'ū' | 'ů' | 'ű' => 'u',
        'ý' | 'ÿ' => 'y',
        'ś' | 'š' => 's',
        'ź' | 'ż' | 'ž' => 'z',
        'ł' => 'l',
        'ř' => 'r',
        'ť' => 't',
        'ß' => 's',
        other => other,
    }
}

fn stopwords() -> &'static HashSet<&'static str> {
    static SET: std::sync::OnceLock<HashSet<&'static str>> = std::sync::OnceLock::new();
    SET.get_or_init(|| STOPWORDS.iter().copied().collect())
}

/// The distinct word stems of a text: folded, accents dropped, common words
/// out, numbers kept as their digits.
pub fn stems(text: &str) -> Vec<String> {
    let stop = stopwords();
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for word in text.unicode_words() {
        let folded: String = word.chars().map(|c| fold_accent(fold(c))).collect();
        let digits = folded.chars().any(|c| c.is_ascii_digit());
        let stem = if digits {
            let only: String = folded.chars().filter(char::is_ascii_digit).collect();
            if only.is_empty() || (only.len() == 1 && folded.len() == 1) {
                continue;
            }
            only
        } else {
            let trimmed = folded
                .trim_end_matches("'s")
                .trim_end_matches('\u{2019}')
                .to_string();
            if trimmed.chars().count() < 3 || stop.contains(trimmed.as_str()) {
                continue;
            }
            trimmed.chars().take(STEM_CHARS).collect()
        };
        if seen.insert(stem.clone()) {
            out.push(stem);
        }
    }
    out
}

struct Index {
    n: usize,
    vocab: HashMap<String, u32>,
    idf: Vec<f32>,
    /// Turns that said each word, ascending.
    said: Vec<Vec<u32>>,
    /// Turns whose speaker's name holds each word, ascending.
    spoken_by: Vec<Vec<u32>>,
    unseen_idf: f32,
    distinctive_idf: f32,
}

impl Index {
    fn new(turns: &[SourceTurn<'_>]) -> Self {
        let mut vocab: HashMap<String, u32> = HashMap::new();
        let mut said: Vec<Vec<u32>> = Vec::new();
        let mut spoken_by: Vec<Vec<u32>> = Vec::new();
        let mut id_of = |stem: String, said: &mut Vec<Vec<u32>>, spoken_by: &mut Vec<Vec<u32>>| {
            let next = vocab.len() as u32;
            let id = *vocab.entry(stem).or_insert(next);
            if id as usize == said.len() {
                said.push(Vec::new());
                spoken_by.push(Vec::new());
            }
            id as usize
        };
        for (i, turn) in turns.iter().enumerate() {
            for stem in stems(turn.text) {
                let id = id_of(stem, &mut said, &mut spoken_by);
                said[id].push(i as u32);
            }
            for stem in stems(turn.speaker) {
                let id = id_of(stem, &mut said, &mut spoken_by);
                spoken_by[id].push(i as u32);
            }
        }
        let n = turns.len().max(1) as f32;
        let idf_of = |count: f32| ((n + 1.) / (count + 0.5)).ln().max(0.);
        let idf = said
            .iter()
            .map(|turns| {
                if turns.is_empty() {
                    idf_of(1.)
                } else {
                    idf_of(turns.len() as f32)
                }
            })
            .collect();
        Self {
            n: turns.len(),
            vocab,
            idf,
            said,
            spoken_by,
            unseen_idf: idf_of(1.),
            distinctive_idf: idf_of((n * 0.08).max(2.)),
        }
    }
}

/// The source of each point, or `None` when no line is clearly it.
pub fn link(points: &[&str], turns: &[SourceTurn<'_>], tuning: Tuning) -> Vec<Option<Link>> {
    if turns.is_empty() {
        return vec![None; points.len()];
    }
    let index = Index::new(turns);
    let mut scratch = Scratch::new(index.n);
    points
        .iter()
        .map(|point| link_one(&index, &stems(point), tuning, &mut scratch))
        .collect()
}

/// Per-window sums, reused across points so a long meeting allocates once.
struct Scratch {
    single: Vec<f32>,
    single_shared: Vec<u16>,
    pair: Vec<f32>,
    pair_shared: Vec<u16>,
    /// Which point word last touched each single and pair window.
    single_mark: Vec<u32>,
    pair_mark: Vec<u32>,
}

impl Scratch {
    fn new(n: usize) -> Self {
        Self {
            single: vec![0.; n],
            single_shared: vec![0; n],
            pair: vec![0.; n],
            pair_shared: vec![0; n],
            single_mark: vec![u32::MAX; n],
            pair_mark: vec![u32::MAX; n],
        }
    }

    fn clear(&mut self) {
        self.single.fill(0.);
        self.single_shared.fill(0);
        self.pair.fill(0.);
        self.pair_shared.fill(0);
        self.single_mark.fill(u32::MAX);
        self.pair_mark.fill(u32::MAX);
    }
}

fn link_one(index: &Index, point: &[String], tuning: Tuning, s: &mut Scratch) -> Option<Link> {
    if point.len() < MIN_POINT_WORDS {
        return None;
    }
    let n = index.n;
    s.clear();
    let mut mass = 0.;
    for (word, stem) in point.iter().enumerate() {
        let word = word as u32;
        let Some(&id) = index.vocab.get(stem) else {
            mass += index.unseen_idf;
            continue;
        };
        let id = id as usize;
        let weight = index.idf[id];
        mass += weight;
        let distinctive = u16::from(weight >= index.distinctive_idf);
        for &t in &index.said[id] {
            let t = t as usize;
            s.single[t] += weight;
            s.single_shared[t] += distinctive;
            s.single_mark[t] = word;
            for w in [t.wrapping_sub(1), t] {
                if w < n.saturating_sub(1) && s.pair_mark[w] != word {
                    s.pair_mark[w] = word;
                    s.pair[w] += weight;
                    s.pair_shared[w] += distinctive;
                }
            }
        }
        let by_name = weight * SPEAKER_WEIGHT;
        for &t in &index.spoken_by[id] {
            let t = t as usize;
            if s.single_mark[t] != word {
                s.single_mark[t] = word;
                s.single[t] += by_name;
            }
            for w in [t.wrapping_sub(1), t] {
                if w < n.saturating_sub(1) && s.pair_mark[w] != word {
                    s.pair_mark[w] = word;
                    s.pair[w] += by_name;
                }
            }
        }
    }
    if mass <= 0. {
        return None;
    }
    // A pair only for a point long enough to need two lines, and only when
    // both lines carry it, never one line and a bystander.
    let pairs = point.len() >= MIN_PAIR_WORDS;
    let window = |i: usize| -> (usize, f32, u16) {
        let single = s.single[i] / mass;
        if pairs && i + 1 < n {
            let pair = s.pair[i] / mass;
            if pair >= single.max(s.single[i + 1] / mass) + PAIR_GAIN {
                return (2, pair, s.pair_shared[i]);
            }
        }
        (1, single, s.single_shared[i])
    };
    let mut best: Option<(usize, usize, f32, u16)> = None;
    for i in 0..n {
        let (span, coverage, shared) = window(i);
        if best.is_none_or(|b| coverage > b.2) {
            best = Some((i, span, coverage, shared));
        }
    }
    let (turn, span, coverage, shared) = best?;
    if coverage < tuning.min_coverage || usize::from(shared) < tuning.min_shared {
        return None;
    }
    let near = turn.saturating_sub(tuning.neighbourhood)..=turn + span + tuning.neighbourhood;
    let rival = (0..n)
        .filter(|i| !near.contains(i))
        .map(|i| window(i).1)
        .fold(0., f32::max);
    if coverage - rival < tuning.min_margin {
        return None;
    }
    Some(Link {
        turn,
        span,
        score: coverage,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn turns<'a>(lines: &'a [(&'a str, &'a str)]) -> Vec<SourceTurn<'a>> {
        lines
            .iter()
            .map(|(speaker, text)| SourceTurn { text, speaker })
            .collect()
    }

    const MEETING: &[(&str, &str)] = &[
        ("You", "Let's start with the numbers from last week. We came in a little under on almost every line."),
        ("Farah", "Events is the big one. We barely touched it, so I'd move that budget into the launch video."),
        ("Gus", "Works for me. The migration still needs an owner though, and nobody here has six free weeks."),
        ("You", "Then let's bring in a contractor. Gus, can you check the terms with legal?"),
        ("Gus", "Yes. I'll have an answer by Thursday."),
        ("Farah", "I'll send the revised plan by Friday so we can lock it."),
        ("You", "Great, and the hiring plan waits for January."),
    ];

    #[test]
    fn a_decision_links_to_the_line_that_said_it() {
        let t = turns(MEETING);
        let links = link(
            &["Move the events budget to the launch video"],
            &t,
            Tuning::default(),
        );
        assert_eq!(links[0].map(|l| l.turn), Some(1));
    }

    #[test]
    fn an_action_item_links_to_its_owner_line() {
        let t = turns(MEETING);
        let links = link(
            &["Farah: send the revised plan by Friday"],
            &t,
            Tuning::default(),
        );
        assert_eq!(links[0].map(|l| l.turn), Some(5));
    }

    #[test]
    fn a_point_nobody_said_links_nowhere() {
        let t = turns(MEETING);
        let links = link(
            &["Quarterly churn rose sharply among enterprise accounts in Europe"],
            &t,
            Tuning::default(),
        );
        assert_eq!(links[0], None);
    }

    #[test]
    fn a_point_said_in_two_places_far_apart_links_nowhere() {
        let lines: &[(&str, &str)] = &[
            ("A", "We should ship the onboarding checklist redesign this sprint."),
            ("B", "Fine."),
            ("A", "Lunch?"),
            ("B", "Sure."),
            ("A", "Coffee first."),
            ("B", "Okay."),
            ("A", "Back to work."),
            ("B", "Yes, ship the onboarding checklist redesign this sprint."),
        ];
        let t = turns(lines);
        let links = link(
            &["Ship the onboarding checklist redesign this sprint"],
            &t,
            Tuning::default(),
        );
        assert_eq!(links[0], None);
    }

    #[test]
    fn short_points_and_empty_transcripts_link_nowhere() {
        let t = turns(MEETING);
        assert_eq!(link(&["Budget"], &t, Tuning::default())[0], None);
        assert_eq!(link(&["Move the events budget"], &[], Tuning::default())[0], None);
    }

    #[test]
    fn stems_fold_case_accents_and_numbers() {
        assert_eq!(stems("Décisión DÉCISION"), vec!["decisi".to_string()]);
        assert_eq!(stems("15.000 € and 15,000"), vec!["15000".to_string()]);
        assert!(stems("the and with").is_empty());
    }
}
