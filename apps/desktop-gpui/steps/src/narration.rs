use crate::{Guide, Step, Word};

const SENTENCE_PAUSE: f64 = 1.0;
const SENTENCE_ENDS: [char; 6] = ['.', '!', '?', '。', '！', '？'];
const EARLIER_STEP_WEIGHT: f64 = 1.5;
const INTRO_LEAD: f64 = 4.0;

struct Sentence {
    start: f64,
    end: f64,
    text: String,
}

/// People mostly announce what they are about to do, so a step that has
/// already happened counts as further away than one still to come.
pub(crate) fn attach(words: &[Word], mut steps: Vec<Step>) -> Guide {
    let first_step = steps.first().map(|step| step.time);
    let mut intro: Vec<String> = Vec::new();
    for sentence in sentences(words) {
        let introduces = first_step.is_none_or(|first| sentence.end < first - INTRO_LEAD);
        match nearest(&steps, &sentence) {
            Some(index) if !introduces => {
                let narration = &mut steps[index].narration;
                if !narration.is_empty() {
                    narration.push(' ');
                }
                narration.push_str(&sentence.text);
            }
            _ => intro.push(sentence.text),
        }
    }
    Guide {
        intro: intro.join(" "),
        steps,
    }
}

fn sentences(words: &[Word]) -> Vec<Sentence> {
    let mut words: Vec<&Word> = words
        .iter()
        .filter(|word| {
            word.start.is_finite() && word.end.is_finite() && !word.text.trim().is_empty()
        })
        .collect();
    words.sort_by(|a, b| a.start.total_cmp(&b.start));

    let mut found: Vec<Sentence> = Vec::new();
    let mut open = false;
    for word in words {
        let text = word.text.trim();
        match found.last_mut() {
            Some(sentence) if open && word.start - sentence.end <= SENTENCE_PAUSE => {
                sentence.text.push(' ');
                sentence.text.push_str(text);
                sentence.end = sentence.end.max(word.end);
            }
            _ => found.push(Sentence {
                start: word.start,
                end: word.end.max(word.start),
                text: text.to_string(),
            }),
        }
        open = !text.ends_with(SENTENCE_ENDS);
    }
    found
}

fn nearest(steps: &[Step], sentence: &Sentence) -> Option<usize> {
    let mut best: Option<(usize, f64)> = None;
    for (index, step) in steps.iter().enumerate() {
        let distance = if step.time > sentence.end {
            step.time - sentence.end
        } else if step.time < sentence.start {
            (sentence.start - step.time) * EARLIER_STEP_WEIGHT
        } else {
            0.0
        };
        if best.is_none_or(|(_, closest)| distance <= closest) {
            best = Some((index, distance));
        }
    }
    best.map(|(index, _)| index)
}
