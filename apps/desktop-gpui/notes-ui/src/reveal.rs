//! Text that someone else is writing into the page: each new word fades in
//! where it lands; before the first word the empty page shows calm motion
//! (`writing.rs`), with no caret at any point. Nothing is laid out twice for
//! it: a word fades in under a veil of the page's own colour that clears, so
//! the shaped lines are reused as they are, and frames are only asked for
//! while a veil is clearing or the waiting motion shows.

use std::time::{Duration, Instant};

use cap_notes::Document;

/// How long one word takes to clear.
pub(crate) const FADE: Duration = Duration::from_millis(180);
/// The gap between two words of one chunk, so a chunk reads in rather than
/// popping in whole.
pub(crate) const STAGGER: Duration = Duration::from_millis(18);
/// Words never queue further behind than this; a fast writer is shown at
/// its own pace.
const MAX_LAG: Duration = Duration::from_millis(320);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Word {
    pub block: usize,
    pub start: usize,
    pub end: usize,
    pub born: Instant,
}

#[derive(Debug)]
pub(crate) struct Reveal {
    /// The writer is still going.
    pub writing: bool,
    pub ended: Option<Instant>,
    /// Each block's text the last time words were counted.
    seen: Vec<String>,
    pub words: Vec<Word>,
    last_born: Option<Instant>,
    /// When the first words landed: the waiting motion fades out from here.
    pub first_text: Option<Instant>,
}

impl Reveal {
    pub fn new(doc: &Document) -> Self {
        Self {
            writing: true,
            ended: None,
            seen: doc.blocks.iter().map(|b| b.text.clone()).collect(),
            words: Vec::new(),
            last_born: None,
            first_text: doc
                .blocks
                .iter()
                .any(|b| !b.text.is_empty())
                .then(Instant::now),
        }
    }

    /// Queue every word that is new since the last call to fade in, in
    /// reading order.
    pub fn grew(&mut self, doc: &Document, now: Instant) {
        let mut at = match self.last_born {
            Some(last) if last + STAGGER > now => (last + STAGGER).min(now + MAX_LAG),
            _ => now,
        };
        for (index, block) in doc.blocks.iter().enumerate() {
            let text = block.text.as_str();
            // Text that only grew keeps its shown part; a block the stream
            // re-read into something else ("- [" became a task) fades in whole.
            let old = match self.seen.get(index) {
                Some(seen) if text.starts_with(seen.as_str()) => seen.len(),
                _ => 0,
            };
            let old = floor_boundary(text, old);
            for (start, end) in words(text, old) {
                self.words.push(Word {
                    block: index,
                    start,
                    end,
                    born: at,
                });
                self.last_born = Some(at);
                at = (at + STAGGER).min(now + MAX_LAG);
            }
        }
        self.seen = doc.blocks.iter().map(|b| b.text.clone()).collect();
        if self.first_text.is_none() && !self.words.is_empty() {
            self.first_text = Some(now);
        }
    }

    pub fn end(&mut self, now: Instant) {
        if self.writing {
            self.writing = false;
            self.ended = Some(now);
        }
    }

    /// How much of the page colour still covers a word, 1 (hidden) to 0.
    pub fn veil(word: &Word, now: Instant) -> f32 {
        if word.born > now {
            return 1.;
        }
        let t = now.duration_since(word.born).as_secs_f32() / FADE.as_secs_f32();
        let t = t.clamp(0., 1.);
        // Ease out: most of the word is there quickly, the last of the veil
        // lifts softly.
        (1. - t).powi(2)
    }

    /// Drop the words that are fully shown. True while any veil remains.
    pub fn prune(&mut self, now: Instant) -> bool {
        self.words.retain(|w| w.born + FADE > now);
        !self.words.is_empty()
    }

    /// How present the waiting motion is, 0 to 1: it fades in when writing
    /// starts and out once the first words land or the writer stops.
    pub fn waiting(&self, now: Instant, epoch: Instant) -> f32 {
        use crate::writing::{FADE_IN, FADE_OUT};
        let since = |at: Instant| now.saturating_duration_since(at).as_secs_f32();
        let fade_in = (since(epoch) / FADE_IN).clamp(0., 1.);
        let gone_at = match (self.first_text, self.ended) {
            (Some(a), Some(b)) => Some(a.min(b)),
            (a, b) => a.or(b),
        };
        let fade_out = gone_at.map_or(1., |at| 1. - (since(at) / FADE_OUT).clamp(0., 1.));
        fade_in * fade_out
    }

    /// Nothing left to draw: no veil and no waiting motion.
    pub fn finished(&self, now: Instant, epoch: Instant) -> bool {
        !self.writing
            && self.words.iter().all(|w| w.born + FADE <= now)
            && self.waiting(now, epoch) <= 0.
    }
}

fn floor_boundary(text: &str, mut at: usize) -> usize {
    while at > 0 && !text.is_char_boundary(at) {
        at -= 1;
    }
    at
}

/// The words of `text` from byte `from`, each with the spaces that follow it,
/// so the veils meet without gaps. A word cut by `from` is counted from there.
pub(crate) fn words(text: &str, from: usize) -> Vec<(usize, usize)> {
    let mut out = Vec::new();
    let mut start: Option<usize> = None;
    let mut in_space = false;
    for (i, ch) in text[from..].char_indices() {
        let i = i + from;
        if ch.is_whitespace() {
            in_space = true;
            if start.is_none() {
                start = Some(i);
            }
        } else if in_space {
            if let Some(s) = start {
                out.push((s, i));
            }
            start = Some(i);
            in_space = false;
        } else if start.is_none() {
            start = Some(i);
        }
    }
    if let Some(s) = start
        && s < text.len()
    {
        out.push((s, text.len()));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn words_keep_their_trailing_space_and_cover_every_byte() {
        assert_eq!(words("Hello big world", 0), vec![(0, 6), (6, 10), (10, 15)]);
        assert_eq!(words("Hello big world", 7), vec![(7, 10), (10, 15)]);
        assert_eq!(words("", 0), Vec::<(usize, usize)>::new());
        let text = "Ana: café time ";
        let ws = words(text, 0);
        assert_eq!(ws.first().unwrap().0, 0);
        assert_eq!(ws.last().unwrap().1, text.len());
        for pair in ws.windows(2) {
            assert_eq!(pair[0].1, pair[1].0);
        }
    }

    #[test]
    fn new_text_queues_words_in_order_and_old_text_never_fades_again() {
        let now = Instant::now();
        let mut doc = Document::from_markdown("### Summary");
        let mut reveal = Reveal::new(&Document::new());
        reveal.grew(&doc, now);
        assert_eq!(reveal.words.len(), 1);
        doc = Document::from_markdown("### Summary\n\nThe team agreed");
        reveal.grew(&doc, now);
        let fresh: Vec<_> = reveal.words.iter().filter(|w| w.block == 1).collect();
        assert_eq!(fresh.len(), 3);
        assert!(fresh.windows(2).all(|p| p[0].born < p[1].born));
        assert_eq!(
            reveal.words.iter().filter(|w| w.block == 0).count(),
            1,
            "the heading is not queued twice"
        );
    }

    #[test]
    fn a_block_the_stream_rereads_fades_in_whole() {
        let now = Instant::now();
        let mut reveal = Reveal::new(&Document::new());
        reveal.grew(&Document::from_markdown("- ["), now);
        reveal.words.clear();
        reveal.grew(&Document::from_markdown("- [ ] Ana: send the deck"), now);
        let first = reveal.words.iter().map(|w| w.start).min().unwrap();
        assert_eq!(first, 0, "{:?}", reveal.words);
    }

    #[test]
    fn a_fast_writer_is_never_shown_far_behind() {
        let now = Instant::now();
        let mut reveal = Reveal::new(&Document::new());
        let long = "word ".repeat(200);
        reveal.grew(&Document::from_markdown(&long), now);
        let last = reveal.words.last().unwrap().born;
        assert!(last <= now + MAX_LAG);
    }

    #[test]
    fn veils_lift_and_then_the_reveal_is_done() {
        let now = Instant::now();
        let mut reveal = Reveal::new(&Document::new());
        reveal.grew(&Document::from_markdown("One two"), now);
        let first = reveal.words[0];
        assert_eq!(Reveal::veil(&first, now - Duration::from_millis(1)), 1.);
        assert!(Reveal::veil(&first, now + FADE / 2) < 0.5);
        assert_eq!(Reveal::veil(&first, now + FADE), 0.);
        assert_eq!(
            reveal.first_text,
            Some(now),
            "the first words end the waiting"
        );
        assert!(reveal.waiting(now + Duration::from_millis(1), now) < 0.1);
        reveal.end(now);
        assert!(!reveal.finished(now, now));
        let later = now + FADE + Duration::from_millis(400);
        assert!(!reveal.prune(later));
        assert_eq!(reveal.waiting(later, now), 0.);
        assert!(reveal.finished(later, now));
    }

    #[test]
    fn an_empty_page_waits_until_the_first_word() {
        let now = Instant::now();
        let mut reveal = Reveal::new(&Document::new());
        assert_eq!(reveal.waiting(now, now), 0., "fades in from nothing");
        assert_eq!(reveal.waiting(now + Duration::from_secs(3), now), 1.);
        reveal.grew(
            &Document::from_markdown("### Summary"),
            now + Duration::from_secs(5),
        );
        let landed = now + Duration::from_secs(5);
        assert!(reveal.waiting(landed + Duration::from_millis(100), now) < 1.);
        assert_eq!(reveal.waiting(landed + Duration::from_millis(400), now), 0.);
    }
}
