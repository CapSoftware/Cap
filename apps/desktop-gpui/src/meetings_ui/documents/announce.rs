//! What a screen reader hears from a live transcript: each finished line
//! once, after the speaker's name, never the words still being heard, and
//! at most one announcement every few seconds (lines that finish in between
//! are read together). Opening a note mid-meeting reads nothing that was
//! already there.

use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

use gpui::SharedString;

use super::transcript::TRow;

pub const SPACING: Duration = Duration::from_secs(3);

#[derive(Default)]
pub struct Announcer {
    doc: Option<String>,
    spoken: HashSet<String>,
    /// Waiting turns (speaker, what they said), in order.
    queue: Vec<(String, String)>,
    last: Option<Instant>,
    /// Paused: the next `observe` takes what is there as already read.
    paused: bool,
    /// The latest announcement; the live region reads it when it changes.
    pub text: SharedString,
}

impl Announcer {
    pub fn reset(&mut self) {
        *self = Self::default();
    }

    /// Stops reading: what the transcript holds when it is next taken is
    /// never read. The latest announcement stays, so the live region keeps
    /// still (and says nothing) meanwhile.
    pub fn pause(&mut self) {
        self.queue.clear();
        self.paused = true;
    }

    /// Takes the transcript as it is now: `finals` are its finished
    /// utterances (id, text) in order, `rows` what the page shows (lines
    /// hidden from it are never read). True when something new is waiting.
    pub fn observe(&mut self, doc: &str, rows: &[TRow], finals: &[(String, String)]) -> bool {
        if self.doc.as_deref() != Some(doc) {
            self.reset();
            self.doc = Some(doc.to_string());
            self.spoken = finals.iter().map(|(id, _)| id.clone()).collect();
            return false;
        }
        if self.paused {
            self.paused = false;
            self.spoken.extend(finals.iter().map(|(id, _)| id.clone()));
            return false;
        }
        let labels: HashMap<&str, &str> = rows
            .iter()
            .filter_map(|row| match row {
                TRow::Turn(turn) => Some(turn),
                TRow::Minute { .. } => None,
            })
            .flat_map(|turn| turn.ids.iter().map(|id| (id.as_str(), turn.label.as_str())))
            .collect();
        let mut added = false;
        for (id, text) in finals {
            if self.spoken.contains(id) {
                continue;
            }
            let Some(label) = labels.get(id.as_str()).copied() else {
                continue;
            };
            self.spoken.insert(id.clone());
            let text = text.trim();
            if text.is_empty() {
                continue;
            }
            // One turn per speaker run, also across separate updates.
            match self.queue.last_mut() {
                Some((who, line)) if who.as_str() == label => {
                    line.push(' ');
                    line.push_str(text);
                }
                _ => self.queue.push((label.to_string(), text.to_string())),
            }
            added = true;
        }
        added
    }

    /// How long until the waiting lines may be read, if any wait.
    pub fn due(&self, now: Instant) -> Option<Duration> {
        if self.queue.is_empty() {
            return None;
        }
        Some(self.last.map_or(Duration::ZERO, |last| {
            SPACING.saturating_sub(now.duration_since(last))
        }))
    }

    /// Reads the waiting lines when their turn has come. True when the
    /// announcement changed.
    pub fn flush(&mut self, now: Instant) -> bool {
        if self.due(now) != Some(Duration::ZERO) {
            return false;
        }
        self.text = std::mem::take(&mut self.queue)
            .into_iter()
            .map(|(who, line)| format!("{who}: {line}"))
            .collect::<Vec<_>>()
            .join(" ")
            .into();
        self.last = Some(now);
        true
    }
}

#[cfg(test)]
mod tests {
    use super::super::transcript::TurnRow;
    use super::*;
    use cap_meetings::transcript::Source;

    fn turn(label: &str, ids: &[&str], partial: bool) -> TRow {
        TRow::Turn(TurnRow {
            source: Source::System,
            speaker: None,
            speaker_id: None,
            label: label.into(),
            placeholder: false,
            color: None,
            start_ms: 0,
            text: String::new(),
            partial,
            ids: ids.iter().map(|s| s.to_string()).collect(),
            you: false,
            disowned: false,
            left_out: false,
        })
    }

    fn finals(items: &[(&str, &str)]) -> Vec<(String, String)> {
        items
            .iter()
            .map(|(a, b)| (a.to_string(), b.to_string()))
            .collect()
    }

    #[test]
    fn a_pause_keeps_the_last_announcement_and_reads_only_later_lines() {
        let mut a = Announcer::default();
        let t0 = Instant::now();
        a.observe("d", &[], &[]);
        let rows = [turn("Ana", &["1", "2", "3"], false)];
        assert!(a.observe("d", &rows, &finals(&[("1", "One.")])));
        assert!(a.flush(t0));
        a.pause();
        assert_eq!(a.text.as_ref(), "Ana: One.");
        assert!(!a.observe("d", &rows, &finals(&[("1", "One."), ("2", "Two.")])));
        assert_eq!(a.due(t0), None);
        assert_eq!(a.text.as_ref(), "Ana: One.");
        assert!(a.observe(
            "d",
            &rows,
            &finals(&[("1", "One."), ("2", "Two."), ("3", "Three.")])
        ));
        assert!(a.flush(t0 + SPACING));
        assert_eq!(a.text.as_ref(), "Ana: Three.");
    }

    #[test]
    fn what_was_there_on_open_is_never_read() {
        let mut a = Announcer::default();
        let rows = [turn("Ana", &["1", "2"], false)];
        assert!(!a.observe("d", &rows, &finals(&[("1", "Hi"), ("2", "there")])));
        assert_eq!(a.due(Instant::now()), None);
        assert!(!a.observe("d", &rows, &finals(&[("1", "Hi"), ("2", "there")])));
    }

    #[test]
    fn finished_lines_are_read_once_with_the_speaker() {
        let mut a = Announcer::default();
        let t0 = Instant::now();
        a.observe("d", &[], &[]);
        let rows = [
            turn("Ana", &["1", "2"], false),
            turn("You", &["3", "4"], true),
        ];
        // Only finished utterances arrive in `finals`; the partial one waits.
        assert!(a.observe(
            "d",
            &rows,
            &finals(&[("1", "Hello"), ("2", "all."), ("3", "Hi Ana.")])
        ));
        assert!(a.flush(t0));
        assert_eq!(a.text.as_ref(), "Ana: Hello all. You: Hi Ana.");
        assert!(!a.observe(
            "d",
            &rows,
            &finals(&[("1", "Hello"), ("2", "all."), ("3", "Hi Ana.")])
        ));
        assert!(!a.flush(t0 + SPACING));
    }

    #[test]
    fn one_speakers_lines_queued_apart_are_read_as_one_turn() {
        let mut a = Announcer::default();
        let t0 = Instant::now();
        a.observe("d", &[], &[]);
        let rows = [
            turn("Ana", &["1", "2"], false),
            turn("Ben", &["3"], false),
            turn("Ana", &["4", "5"], false),
        ];
        let all = [
            ("1", "One."),
            ("2", "Two."),
            ("3", "Three."),
            ("4", "Four."),
            ("5", "Five."),
        ];
        for n in 1..=all.len() {
            a.observe("d", &rows, &finals(&all[..n]));
        }
        assert!(a.flush(t0));
        assert_eq!(
            a.text.as_ref(),
            "Ana: One. Two. Ben: Three. Ana: Four. Five."
        );
    }

    #[test]
    fn lines_finishing_close_together_are_read_together() {
        let mut a = Announcer::default();
        let t0 = Instant::now();
        a.observe("d", &[], &[]);
        let rows = [turn("Ana", &["1", "2", "3"], false)];
        a.observe("d", &rows, &finals(&[("1", "One.")]));
        assert!(a.flush(t0));
        a.observe("d", &rows, &finals(&[("1", "One."), ("2", "Two.")]));
        a.observe(
            "d",
            &rows,
            &finals(&[("1", "One."), ("2", "Two."), ("3", "Three.")]),
        );
        assert_eq!(
            a.due(t0 + Duration::from_secs(1)),
            Some(Duration::from_secs(2))
        );
        assert!(!a.flush(t0 + Duration::from_secs(1)));
        assert!(a.flush(t0 + SPACING));
        assert_eq!(a.text.as_ref(), "Ana: Two. Three.");
    }

    #[test]
    fn hidden_lines_and_other_notes_are_not_read() {
        let mut a = Announcer::default();
        a.observe("d", &[], &[]);
        let rows = [turn("Ana", &["1"], false)];
        assert!(!a.observe("d", &rows, &finals(&[("9", "hidden")])));
        assert!(!a.observe("e", &rows, &finals(&[("1", "Other note")])));
        assert_eq!(a.due(Instant::now()), None);
    }
}
