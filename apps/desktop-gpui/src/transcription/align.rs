use cap_project::CaptionWord;

pub(super) const FRAME_SECONDS: f64 = 0.02;

/// Per-frame CTC log probabilities for a window of 16 kHz audio that starts
/// `start_seconds` into the recording, as `(frames x classes, classes)`.
pub(super) trait Emissions {
    fn log_probs(
        &mut self,
        samples: &[f32],
        start_seconds: f64,
    ) -> Result<(Vec<f32>, usize), String>;

    /// Several windows at once; implementations may run them in parallel.
    fn log_probs_many(
        &mut self,
        windows: &[(&[f32], f64)],
    ) -> Result<Vec<(Vec<f32>, usize)>, String> {
        windows
            .iter()
            .map(|(samples, start)| self.log_probs(samples, *start))
            .collect()
    }
}
impl<T: Emissions + ?Sized> Emissions for &mut T {
    fn log_probs(
        &mut self,
        samples: &[f32],
        start_seconds: f64,
    ) -> Result<(Vec<f32>, usize), String> {
        (**self).log_probs(samples, start_seconds)
    }

    fn log_probs_many(
        &mut self,
        windows: &[(&[f32], f64)],
    ) -> Result<Vec<(Vec<f32>, usize)>, String> {
        (**self).log_probs_many(windows)
    }
}

const BLANK: usize = 0;
const WORD_SEPARATOR: usize = 4;

const LETTERS: &[u8] = b"ETAONIHSRDLUMWCFGYPBVK'XJQZ";

pub(super) fn character_tokens(text: &str) -> Vec<usize> {
    text.chars()
        .flat_map(char::to_uppercase)
        .filter_map(|c| match c {
            '\'' | '’' => Some(27),
            'A'..='Z' => Some(
                LETTERS
                    .iter()
                    .position(|&letter| letter == c as u8)
                    .map_or(BLANK, |index| index + 5),
            ),
            _ => None,
        })
        .collect()
}

/// Per frame, what speech the transcript does not account for costs over the
/// best letter: enough that real letters win where they fit, little enough
/// that a word the engine missed (most often a filler) is absorbed here instead
/// of stretching the words on either side over it.
const UNHEARD_PENALTY: f32 = 2.0;

#[derive(Clone, Copy, PartialEq)]
enum Label {
    Blank,
    Letter(usize),
    Unheard,
}

struct State {
    label: Label,
    owner: Option<usize>,
    preds: [u8; 4],
}

/// Each word's first and last frame on the best CTC path, or `None` for a
/// word with no letters to align (digits, symbols).
pub(super) fn align_words(
    log_probs: &[f32],
    classes: usize,
    words: &[Vec<usize>],
) -> Vec<Option<(usize, usize)>> {
    let frames = log_probs.len() / classes.max(1);
    let mut spans = vec![None; words.len()];
    let letters: usize = words.iter().map(Vec::len).sum();
    if letters == 0 || frames < letters || classes <= WORD_SEPARATOR {
        return spans;
    }
    let states = build_states(words);
    let Some(path) = viterbi(log_probs, classes, frames, &states) else {
        return spans;
    };
    for (frame, state) in path.into_iter().enumerate() {
        if let (Label::Letter(_), Some(word)) = (states[state].label, states[state].owner) {
            let span: &mut Option<(usize, usize)> = &mut spans[word];
            *span = Some(span.map_or((frame, frame), |(first, _)| (first, frame)));
        }
    }
    spans
}

fn state(label: Label, owner: Option<usize>, preds: &[u8]) -> State {
    let mut all = [0u8; 4];
    all[..preds.len()].copy_from_slice(preds);
    State {
        label,
        owner,
        preds: all,
    }
}

/// `preds` are how many states back a state may be entered from (it may
/// always stay). Around each word: `blank, unheard, blank, letters...`, every
/// letter followed by a blank; a letter can skip the blank before it unless it
/// repeats the letter before, and a word's first letter can skip the unheard
/// state, or both it and its blanks.
fn build_states(words: &[Vec<usize>]) -> Vec<State> {
    let mut states = vec![
        state(Label::Blank, None, &[]),
        state(Label::Unheard, None, &[1]),
        state(Label::Blank, None, &[1]),
    ];
    let mut previous_letter: Option<usize> = None;
    for (owner, word) in words.iter().enumerate() {
        if word.is_empty() {
            continue;
        }
        if previous_letter.is_some() {
            states.push(state(Label::Unheard, None, &[1, 2]));
            states.push(state(Label::Blank, None, &[1]));
        }
        for (position, &letter) in word.iter().enumerate() {
            let preds: &[u8] = if position == 0 {
                match previous_letter {
                    Some(previous) if previous != letter => &[1, 2, 3, 4],
                    _ => &[1, 2, 3],
                }
            } else if word[position - 1] == letter {
                &[1]
            } else {
                &[1, 2]
            };
            states.push(state(Label::Letter(letter), Some(owner), preds));
            states.push(state(Label::Blank, None, &[1]));
            previous_letter = Some(letter);
        }
    }
    states.push(state(Label::Unheard, None, &[1, 2]));
    states.push(state(Label::Blank, None, &[1]));
    states
}

fn viterbi(
    log_probs: &[f32],
    classes: usize,
    frames: usize,
    states: &[State],
) -> Option<Vec<usize>> {
    let count = states.len();
    let emission = |row: &[f32], label: Label| match label {
        Label::Blank => row[BLANK],
        Label::Letter(letter) => row[letter],
        Label::Unheard => {
            let best_letter = row
                .iter()
                .enumerate()
                .filter(|(class, _)| *class != BLANK && *class != WORD_SEPARATOR)
                .map(|(_, value)| *value)
                .fold(f32::NEG_INFINITY, f32::max);
            row[WORD_SEPARATOR].max(best_letter - UNHEARD_PENALTY)
        }
    };
    let first_letter = states
        .iter()
        .position(|state| matches!(state.label, Label::Letter(_)))
        .unwrap_or(0);
    let last_letter = states
        .iter()
        .rposition(|state| matches!(state.label, Label::Letter(_)))
        .unwrap_or(0);
    let mut score = vec![f32::NEG_INFINITY; count];
    let mut next = vec![f32::NEG_INFINITY; count];
    let mut back = vec![0u8; frames * count];
    let row = &log_probs[..classes];
    for (index, state) in states.iter().enumerate().take(first_letter + 1) {
        score[index] = emission(row, state.label);
    }
    for frame in 1..frames {
        let row = &log_probs[frame * classes..(frame + 1) * classes];
        next.fill(f32::NEG_INFINITY);
        for (index, state) in states.iter().enumerate() {
            let mut best = score[index];
            let mut step = 0u8;
            for &pred in state.preds.iter().filter(|pred| **pred != 0) {
                if let Some(from) = index.checked_sub(usize::from(pred))
                    && score[from] > best
                {
                    best = score[from];
                    step = pred;
                }
            }
            if best > f32::NEG_INFINITY {
                next[index] = best + emission(row, state.label);
                back[frame * count + index] = step;
            }
        }
        std::mem::swap(&mut score, &mut next);
    }
    let mut state = (last_letter..count).max_by(|a, b| score[*a].total_cmp(&score[*b]))?;
    if score[state] == f32::NEG_INFINITY {
        return None;
    }
    let mut path = vec![0; frames];
    for frame in (0..frames).rev() {
        path[frame] = state;
        state -= usize::from(back[frame * count + state]);
    }
    Some(path)
}

/// A word spans only its own letters' frames, so its edges never reach into a
/// neighbour; pause snapping then moves them onto the silence around it.
pub(super) fn apply_spans(
    words: &mut [CaptionWord],
    spans: &[Option<(usize, usize)>],
    offset_seconds: f64,
) {
    for (word, span) in words.iter_mut().zip(spans) {
        if let Some((first, last)) = span {
            word.start = (offset_seconds + *first as f64 * FRAME_SECONDS) as f32;
            word.end = (offset_seconds + (*last + 1) as f64 * FRAME_SECONDS) as f32;
        }
    }
}

#[cfg(not(all(target_os = "macos", target_arch = "x86_64")))]
pub(super) struct Acoustic {
    session: ort::session::Session,
}

#[cfg(all(target_os = "macos", target_arch = "x86_64"))]
pub(super) enum Acoustic {}

#[cfg(all(target_os = "macos", target_arch = "x86_64"))]
pub(super) type AcousticPool = Acoustic;

#[cfg(all(target_os = "macos", target_arch = "x86_64"))]
impl Acoustic {
    pub fn load(_path: &std::path::Path) -> Result<Self, String> {
        Err("The word aligner is not available on Intel macOS".to_string())
    }

    pub fn load_alone(path: &std::path::Path) -> Result<Self, String> {
        Self::load(path)
    }
}

#[cfg(all(target_os = "macos", target_arch = "x86_64"))]
impl Emissions for Acoustic {
    fn log_probs(
        &mut self,
        _samples: &[f32],
        _start_seconds: f64,
    ) -> Result<(Vec<f32>, usize), String> {
        match *self {}
    }
}

#[cfg(not(all(target_os = "macos", target_arch = "x86_64")))]
impl Acoustic {
    fn load_with(
        path: &std::path::Path,
        threads: usize,
        shared: &ort::session::builder::PrepackedWeights,
    ) -> Result<Self, String> {
        let failed =
            |error: &dyn std::fmt::Display| format!("Failed to load the word aligner: {error}");
        let session = ort::session::Session::builder()
            .map_err(|error| failed(&error))?
            .with_intra_op_spinning(false)
            .map_err(|error| failed(&error))?
            .with_inter_op_spinning(false)
            .map_err(|error| failed(&error))?
            .with_intra_threads(threads)
            .map_err(|error| failed(&error))?
            .with_prepacked_weights(shared)
            .map_err(|error| failed(&error))?
            .commit_from_file(path)
            .map_err(|error| failed(&error))?;
        Ok(Self { session })
    }
}

fn normalize_into(samples: &[f32], target: &mut [f32]) {
    let count = samples.len().max(1) as f32;
    let mean = samples.iter().sum::<f32>() / count;
    let variance = samples.iter().map(|s| (s - mean).powi(2)).sum::<f32>() / count;
    let scale = 1.0 / (variance + 1e-7).sqrt();
    for (out, sample) in target.iter_mut().zip(samples) {
        *out = (sample - mean) * scale;
    }
}

fn log_softmax(log_probs: &mut [f32], classes: usize) {
    for frame in log_probs.chunks_mut(classes.max(1)) {
        let max = frame.iter().copied().fold(f32::NEG_INFINITY, f32::max);
        let sum = frame.iter().map(|value| (value - max).exp()).sum::<f32>();
        let log_sum = max + sum.ln();
        for value in frame {
            *value -= log_sum;
        }
    }
}

pub(super) fn output_frames(samples: usize) -> usize {
    [(10, 5), (3, 2), (3, 2), (3, 2), (3, 2), (2, 2), (2, 2)]
        .iter()
        .fold(samples, |length, (kernel, stride)| {
            length.saturating_sub(*kernel) / stride + usize::from(length >= *kernel)
        })
}

/// Separate sessions run separate windows at the same time: one session's
/// own threads barely speed up a window, but windows are independent.
#[cfg(not(all(target_os = "macos", target_arch = "x86_64")))]
pub(super) struct AcousticPool {
    sessions: Vec<Acoustic>,
}

#[cfg(not(all(target_os = "macos", target_arch = "x86_64")))]
impl AcousticPool {
    /// Sized for the cores speech recognition leaves free, since the two
    /// run at the same time. More sessions cost memory more than they save
    /// time.
    pub fn load(path: &std::path::Path) -> Result<Self, String> {
        let cores = std::thread::available_parallelism().map_or(4, usize::from);
        let spare = cores.saturating_sub(RECOGNIZER_THREADS).max(2);
        let count = (spare / 3).clamp(1, MAX_POOL_SESSIONS);
        Self::load_sized(path, count, spare / count)
    }

    /// One session on every core, for when nothing else is running.
    pub fn load_alone(path: &std::path::Path) -> Result<Self, String> {
        Self::load_sized(path, 1, 0)
    }

    /// The sessions share one copy of the prepacked weights. Zero `threads`
    /// leaves the count to ONNX Runtime.
    pub fn load_sized(
        path: &std::path::Path,
        count: usize,
        threads: usize,
    ) -> Result<Self, String> {
        cap_camera_effects::initialize_onnx_runtime().map_err(|error| format!("{error:#}"))?;
        let shared = ort::session::builder::PrepackedWeights::new();
        let sessions = (0..count.max(1))
            .map(|_| Acoustic::load_with(path, threads, &shared))
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Self { sessions })
    }
}

#[cfg(not(all(target_os = "macos", target_arch = "x86_64")))]
type WindowEmissions = Result<(Vec<f32>, usize), String>;

#[cfg(not(all(target_os = "macos", target_arch = "x86_64")))]
const RECOGNIZER_THREADS: usize = 4;
#[cfg(not(all(target_os = "macos", target_arch = "x86_64")))]
const MAX_POOL_SESSIONS: usize = 2;

#[cfg(not(all(target_os = "macos", target_arch = "x86_64")))]
impl Emissions for AcousticPool {
    fn log_probs(
        &mut self,
        samples: &[f32],
        start_seconds: f64,
    ) -> Result<(Vec<f32>, usize), String> {
        self.sessions[0].log_probs(samples, start_seconds)
    }

    fn log_probs_many(
        &mut self,
        windows: &[(&[f32], f64)],
    ) -> Result<Vec<(Vec<f32>, usize)>, String> {
        let count = self.sessions.len();
        let mut results: Vec<Option<WindowEmissions>> = (0..windows.len()).map(|_| None).collect();
        std::thread::scope(|scope| {
            let handles: Vec<_> = self
                .sessions
                .iter_mut()
                .enumerate()
                .map(|(worker, session)| {
                    scope.spawn(move || {
                        windows
                            .iter()
                            .enumerate()
                            .skip(worker)
                            .step_by(count)
                            .map(|(index, (samples, start))| {
                                (index, session.log_probs(samples, *start))
                            })
                            .collect::<Vec<_>>()
                    })
                })
                .collect();
            for handle in handles {
                match handle.join() {
                    Ok(done) => {
                        for (index, result) in done {
                            results[index] = Some(result);
                        }
                    }
                    Err(_) => return,
                }
            }
        });
        results
            .into_iter()
            .map(|result| result.unwrap_or_else(|| Err("Word aligner worker panicked".into())))
            .collect()
    }
}

#[cfg(not(all(target_os = "macos", target_arch = "x86_64")))]
impl Emissions for Acoustic {
    fn log_probs(
        &mut self,
        samples: &[f32],
        _start_seconds: f64,
    ) -> Result<(Vec<f32>, usize), String> {
        let mut input = vec![0.0f32; samples.len()];
        normalize_into(samples, &mut input);
        let tensor = ort::value::Tensor::from_array(([1usize, input.len()], input))
            .map_err(|error| format!("Failed to build aligner input: {error}"))?;
        let outputs = self
            .session
            .run(ort::inputs!["input_values" => tensor])
            .map_err(|error| format!("Word aligner failed: {error}"))?;
        let (shape, logits) = outputs[0]
            .try_extract_tensor::<f32>()
            .map_err(|error| format!("Failed to read aligner output: {error}"))?;
        let classes = shape.last().copied().unwrap_or(0).max(0) as usize;
        if classes == 0 {
            return Err("Word aligner returned no classes".to_string());
        }
        let mut log_probs = logits.to_vec();
        log_softmax(&mut log_probs, classes);
        Ok((log_probs, classes))
    }
}

/// Emissions for a whole recording, heard in fixed chunks before the words
/// are known, so hearing can run while speech recognition is still going.
pub(super) struct Heard {
    log_probs: Vec<f32>,
    classes: usize,
}

const SAMPLES_PER_FRAME: usize = 320;
const RECEPTIVE_SAMPLES: usize = 400;
const HEARD_CHUNK_FRAMES: usize = 500;
const HEARD_CONTEXT_FRAMES: usize = 50;
const HEARD_CHUNKS_PER_BATCH: usize = 16;

impl Heard {
    #[cfg(test)]
    pub fn new(log_probs: Vec<f32>, classes: usize) -> Self {
        Self { log_probs, classes }
    }

    #[cfg(test)]
    pub fn into_parts(self) -> (Vec<f32>, usize) {
        (self.log_probs, self.classes)
    }

    /// Hears 16 kHz `samples` in 10 s chunks, each run with a second of
    /// audio either side as context and contributing only its own frames, so
    /// every frame sits on one global 20 ms grid. Returns `None` once `stop`
    /// is set.
    pub fn hear(
        samples: &[f32],
        acoustic: &mut dyn Emissions,
        stop: &std::sync::atomic::AtomicBool,
    ) -> Result<Option<Self>, String> {
        let total = output_frames(samples.len());
        let window = HEARD_CHUNK_FRAMES + 2 * HEARD_CONTEXT_FRAMES;
        let window_start = |chunk_start: usize| {
            chunk_start
                .saturating_sub(HEARD_CONTEXT_FRAMES)
                .min(total.saturating_sub(window))
        };
        let chunks: Vec<std::ops::Range<usize>> = (0..total)
            .step_by(HEARD_CHUNK_FRAMES)
            .map(|first| first..(first + HEARD_CHUNK_FRAMES).min(total))
            .collect();
        let mut log_probs = Vec::new();
        let mut classes = 0;
        for batch in chunks.chunks(HEARD_CHUNKS_PER_BATCH) {
            if stop.load(std::sync::atomic::Ordering::Relaxed) {
                return Ok(None);
            }
            let audio: Vec<(&[f32], f64)> = batch
                .iter()
                .map(|chunk| {
                    let from = window_start(chunk.start);
                    let to = (from + window).min(total);
                    let end = ((to - 1) * SAMPLES_PER_FRAME + RECEPTIVE_SAMPLES).min(samples.len());
                    (
                        &samples[from * SAMPLES_PER_FRAME..end],
                        from as f64 * FRAME_SECONDS,
                    )
                })
                .collect();
            for (chunk, (probs, count)) in batch.iter().zip(acoustic.log_probs_many(&audio)?) {
                let skip = chunk.start - window_start(chunk.start);
                let wanted = (skip + chunk.len()) * count;
                if count == 0 || probs.len() < wanted {
                    return Err("The word aligner heard fewer frames than expected".to_string());
                }
                classes = count;
                log_probs.extend_from_slice(&probs[skip * count..wanted]);
            }
        }
        Ok(Some(Self { log_probs, classes }))
    }
}

impl Emissions for Heard {
    fn log_probs(
        &mut self,
        samples: &[f32],
        start_seconds: f64,
    ) -> Result<(Vec<f32>, usize), String> {
        if self.classes == 0 {
            return Err("The word aligner heard nothing".to_string());
        }
        let frames = self.log_probs.len() / self.classes;
        let first = ((start_seconds / FRAME_SECONDS).round() as usize).min(frames);
        let last = (first + output_frames(samples.len())).min(frames);
        Ok((
            self.log_probs[first * self.classes..last * self.classes].to_vec(),
            self.classes,
        ))
    }
}

const WINDOW_SECONDS: f64 = 20.0;
const WINDOW_MARGIN_SECONDS: f64 = 0.6;
pub(super) fn windows(words: &[CaptionWord]) -> Vec<std::ops::Range<usize>> {
    let mut ranges = Vec::new();
    let mut start = 0;
    while start < words.len() {
        let origin = f64::from(words[start].start);
        let mut end = start + 1;
        while end < words.len() && f64::from(words[end].end) - origin <= WINDOW_SECONDS {
            end += 1;
        }
        if end < words.len() {
            let earliest = (start + 1).max(end.saturating_sub((end - start) / 3));
            end = (earliest..=end)
                .max_by(|&a, &b| {
                    let gap = |i: usize| words[i].start - words[i - 1].end;
                    gap(a).total_cmp(&gap(b)).then(a.cmp(&b))
                })
                .unwrap_or(end);
        }
        ranges.push(start..end);
        start = end;
    }
    ranges
}

pub(super) fn align(
    words: &mut [CaptionWord],
    samples: &[f32],
    rate: u32,
    acoustic: &mut dyn Emissions,
) -> Result<(), String> {
    let rate_f = f64::from(rate);
    let duration = samples.len() as f64 / rate_f;
    let ranges = windows(words);
    let mut aligned = vec![false; words.len()];
    for (index, range) in ranges.iter().enumerate() {
        let previous_end = index
            .checked_sub(1)
            .map(|i| f64::from(words[ranges[i].end - 1].end));
        let next_start = ranges
            .get(index + 1)
            .map(|r| f64::from(words[r.start].start));
        let first = f64::from(words[range.start].start);
        let last = f64::from(words[range.end - 1].end);
        let from = match previous_end {
            Some(end) => ((end + first) / 2.0).max(first - WINDOW_MARGIN_SECONDS),
            None => first - WINDOW_MARGIN_SECONDS,
        }
        .max(0.0);
        let to = match next_start {
            Some(start) => ((last + start) / 2.0).min(last + WINDOW_MARGIN_SECONDS),
            None => last + WINDOW_MARGIN_SECONDS,
        }
        .min(duration);
        let from = (from / FRAME_SECONDS).floor() * FRAME_SECONDS;
        if to <= from {
            continue;
        }
        let start_sample = ((from * rate_f).round() as usize).min(samples.len());
        let audio = &samples[start_sample..((to * rate_f) as usize).min(samples.len())];
        let (log_probs, classes) = acoustic.log_probs(audio, from)?;
        let tokens: Vec<Vec<usize>> = words[range.clone()]
            .iter()
            .map(|word| character_tokens(&word.text))
            .collect();
        let spans = align_words(&log_probs, classes, &tokens);
        apply_spans(&mut words[range.clone()], &spans, from);
        for (flag, span) in aligned[range.clone()].iter_mut().zip(&spans) {
            *flag = span.is_some();
        }
    }
    place_unaligned(words, &aligned);
    keep_order(words);
    Ok(())
}

fn place_unaligned(words: &mut [CaptionWord], aligned: &[bool]) {
    let mut index = 0;
    while index < words.len() {
        if aligned[index] {
            index += 1;
            continue;
        }
        let run_start = index;
        while index < words.len() && !aligned[index] {
            index += 1;
        }
        let from = run_start.checked_sub(1).map(|before| words[before].end);
        let to = words.get(index).map(|after| after.start);
        let run = &mut words[run_start..index];
        match (from, to) {
            (Some(from), Some(to))
                if run
                    .iter()
                    .all(|word| word.start >= from && word.end <= to && word.end > word.start) => {}
            (Some(from), Some(to)) if to > from => {
                let step = (to - from) / run.len() as f32;
                for (offset, word) in run.iter_mut().enumerate() {
                    word.start = from + step * offset as f32;
                    word.end = from + step * (offset + 1) as f32;
                }
            }
            (None, Some(to)) => {
                let overshoot = run.last().map_or(0.0, |last| last.end - to);
                if overshoot > 0.0 {
                    for word in run.iter_mut() {
                        word.start = (word.start - overshoot).max(0.0);
                        word.end = (word.end - overshoot).max(word.start);
                    }
                }
            }
            (Some(from), None) => {
                let overshoot = run.first().map_or(0.0, |first| from - first.start);
                if overshoot > 0.0 {
                    for word in run.iter_mut() {
                        word.start += overshoot;
                        word.end += overshoot;
                    }
                }
            }
            _ => {}
        }
    }
}

pub(super) fn keep_order(words: &mut [CaptionWord]) {
    for index in 1..words.len() {
        let previous_end = words[index - 1].end;
        let word = &mut words[index];
        if word.start < previous_end {
            word.start = previous_end;
        }
        if word.end < word.start {
            word.end = word.start;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct FrameClock;

    impl Emissions for FrameClock {
        fn log_probs(
            &mut self,
            samples: &[f32],
            start_seconds: f64,
        ) -> Result<(Vec<f32>, usize), String> {
            let first = (start_seconds / FRAME_SECONDS).round() as usize;
            Ok((
                (0..output_frames(samples.len()))
                    .map(|frame| (first + frame) as f32)
                    .collect(),
                1,
            ))
        }
    }

    #[test]
    fn hearing_in_chunks_keeps_every_frame_on_one_grid() {
        for seconds in [0.5, 9.0, 12.3, 61.7] {
            let samples = vec![0.1f32; (seconds * 16_000.0) as usize];
            let (log_probs, classes) = Heard::hear(
                &samples,
                &mut FrameClock,
                &std::sync::atomic::AtomicBool::new(false),
            )
            .unwrap()
            .unwrap()
            .into_parts();
            assert_eq!(classes, 1);
            let expected: Vec<f32> = (0..output_frames(samples.len()))
                .map(|frame| frame as f32)
                .collect();
            assert_eq!(log_probs, expected, "{seconds} s");
        }
    }

    #[test]
    fn hearing_stops_when_asked() {
        let samples = vec![0.1f32; 16_000 * 30];
        let heard = Heard::hear(
            &samples,
            &mut FrameClock,
            &std::sync::atomic::AtomicBool::new(true),
        )
        .unwrap();
        assert!(heard.is_none());
    }

    fn emissions(frames: &[usize], classes: usize) -> Vec<f32> {
        let mut out = vec![-8.0f32; frames.len() * classes];
        for (frame, class) in frames.iter().enumerate() {
            out[frame * classes + class] = -0.01;
        }
        out
    }

    #[test]
    fn characters_map_to_the_ctc_vocabulary() {
        assert_eq!(character_tokens("Eta"), vec![5, 6, 7]);
        assert_eq!(character_tokens("don’t!"), vec![14, 8, 9, 27, 6]);
        assert!(character_tokens("42%").is_empty());
        assert_eq!(character_tokens("Zq"), vec![31, 30]);
    }

    #[test]
    fn words_take_the_frames_their_characters_win() {
        let hi = character_tokens("hi");
        let yo = character_tokens("yo");
        let frames = [0, 0, hi[0], hi[0], hi[1], 0, 4, 0, yo[0], yo[1], yo[1], 0];
        let log_probs = emissions(&frames, 32);
        let spans = align_words(&log_probs, 32, &[hi, Vec::new(), yo]);
        assert_eq!(spans, vec![Some((2, 4)), None, Some((8, 10))]);
    }

    #[test]
    fn repeated_letters_need_a_blank_between_them() {
        let word = character_tokens("ll");
        let l = word[0];
        let log_probs = emissions(&[l, l, 0, l, l, 0], 32);
        let spans = align_words(&log_probs, 32, &[word]);
        assert_eq!(spans, vec![Some((0, 4))]);
    }

    #[test]
    fn speech_the_transcript_misses_is_not_given_to_its_neighbours() {
        let so = character_tokens("so");
        let we = character_tokens("we");
        let (s, o, w, e) = (so[0], so[1], we[0], we[1]);
        let u = character_tokens("u")[0];
        let m = character_tokens("m")[0];
        let frames = [0, s, o, o, 0, 0, u, u, u, m, m, m, 0, 0, w, e, e, 0];
        let log_probs = emissions(&frames, 32);
        let spans = align_words(&log_probs, 32, &[so, we]);
        assert_eq!(spans, vec![Some((1, 3)), Some((14, 16))]);
    }

    #[test]
    fn too_few_frames_or_no_letters_align_nothing() {
        let log_probs = emissions(&[0, 0], 32);
        assert_eq!(
            align_words(&log_probs, 32, &[character_tokens("hello")]),
            vec![None]
        );
        assert_eq!(align_words(&log_probs, 32, &[Vec::new()]), vec![None]);
        assert!(align_words(&[], 32, &[]).is_empty());
    }

    #[test]
    fn spans_become_times_after_the_window_offset() {
        let mut words = vec![
            CaptionWord {
                text: "a".into(),
                start: 0.0,
                end: 0.0,
            },
            CaptionWord {
                text: "42".into(),
                start: 9.0,
                end: 9.5,
            },
        ];
        apply_spans(&mut words, &[Some((10, 14)), None], 3.0);
        assert!((words[0].start - 3.2).abs() < 1e-6);
        assert!((words[0].end - 3.3).abs() < 1e-6);
        assert_eq!((words[1].start, words[1].end), (9.0, 9.5));
    }

    fn word(text: &str, start: f32, end: f32) -> CaptionWord {
        CaptionWord {
            text: text.into(),
            start,
            end,
        }
    }

    #[test]
    fn windows_stay_short_and_cut_at_the_widest_gap() {
        let mut words = Vec::new();
        let mut t = 0.0f32;
        for i in 0..200 {
            let gap = if i % 37 == 0 { 1.0 } else { 0.1 };
            t += gap;
            words.push(word("w", t, t + 0.3));
            t += 0.3;
        }
        let ranges = windows(&words);
        assert_eq!(ranges.first().unwrap().start, 0);
        assert_eq!(ranges.last().unwrap().end, words.len());
        for pair in ranges.windows(2) {
            assert_eq!(pair[0].end, pair[1].start);
        }
        for range in &ranges {
            assert!(!range.is_empty());
            let length = words[range.end - 1].end - words[range.start].start;
            assert!(f64::from(length) <= WINDOW_SECONDS + 1e-3, "{range:?}");
        }
        assert!(ranges.iter().skip(1).any(|r| r.start % 37 == 0));
        assert!(windows(&[]).is_empty());
        assert_eq!(windows(&words[..1]), vec![0..1]);
    }

    #[test]
    fn order_is_restored_after_alignment() {
        let mut words = vec![
            word("a", 1.0, 1.4),
            word("b", 1.2, 1.1),
            word("c", 2.0, 2.2),
        ];
        keep_order(&mut words);
        assert_eq!((words[1].start, words[1].end), (1.4, 1.4));
        assert_eq!((words[2].start, words[2].end), (2.0, 2.2));
    }

    #[test]
    fn unaligned_words_share_the_gap_between_their_aligned_neighbours() {
        let mut words = vec![
            word("at", 1.0, 1.2),
            word("25", 5.0, 9.0),
            word("%", 5.0, 9.0),
            word("off", 2.0, 2.3),
            word("42", 7.0, 8.0),
        ];
        place_unaligned(&mut words, &[true, false, false, true, false]);
        assert!((words[1].start - 1.2).abs() < 1e-6 && (words[1].end - 1.6).abs() < 1e-6);
        assert!((words[2].start - 1.6).abs() < 1e-6 && (words[2].end - 2.0).abs() < 1e-6);
        assert_eq!((words[4].start, words[4].end), (7.0, 8.0));
    }

    #[test]
    fn an_unaligned_word_keeps_its_own_timing_inside_a_long_pause() {
        let mut words = vec![
            word("exactly", 1.0, 1.5),
            word("42", 9.6, 10.1),
            word("dollars", 10.2, 10.7),
        ];
        place_unaligned(&mut words, &[true, false, true]);
        assert_eq!((words[1].start, words[1].end), (9.6, 10.1));
    }

    #[test]
    fn leading_and_trailing_unaligned_words_move_clear_of_their_neighbour() {
        let mut words = vec![
            word("42", 0.5, 1.5),
            word("people", 0.8, 1.2),
            word("came", 1.3, 1.6),
            word("2024", 1.4, 2.0),
        ];
        place_unaligned(&mut words, &[false, true, true, false]);
        assert!(words[0].start.abs() < 1e-5 && (words[0].end - 0.8).abs() < 1e-5);
        assert!((words[3].start - 1.6).abs() < 1e-5 && (words[3].end - 2.2).abs() < 1e-5);
        keep_order(&mut words);
        assert_eq!((words[1].start, words[1].end), (0.8, 1.2));
    }
}
