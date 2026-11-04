//! Transcription accuracy harness. Datasets are directories with a
//! `manifest.json` and 16 kHz mono WAVs, built by `scripts/transcription-eval`
//! (AMI and LibriSpeech, both CC BY 4.0; spliced Kokoro speech, Apache-2.0),
//! and kept out of the repo. One configuration per process, so peak RSS is
//! that configuration's:
//!
//! ```text
//! CAP_EVAL_DATA=<dir>[,<dir>...] CAP_EVAL_ENGINE=whisper:<model.bin>|parakeet:<dir>|hyp:<out dir>
//! CAP_EVAL_CONFIG=baseline|default|<flag>,... CAP_EVAL_ALIGNER=<word aligner .onnx> CAP_EVAL_OUT=<dir>
//! cargo test --bin cap-gpui transcription_eval -- --ignored --nocapture
//! ```
//!
//! `hyp:` re-scores the raw engine words a previous run wrote, so the
//! finishing steps can be tuned without running a model again. The aligner
//! hears each clip while the engine runs, as in the app;
//! `CAP_EVAL_ALIGNER_SESSIONS` and `CAP_EVAL_ALIGNER_THREADS` override how
//! many ONNX sessions it uses and their threads. `bench_word_aligner` times
//! hearing alone on `CAP_BENCH_WAV`.

use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};

use cap_project::{
    CaptionWord,
    disfluency::{is_hesitation_filler, normalize_word},
};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ReferenceWord {
    pub text: String,
    pub start: f64,
    pub end: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub filler: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub truncated: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Clip {
    pub id: String,
    pub audio: String,
    pub duration: f64,
    #[serde(default)]
    pub source: String,
    pub words: Vec<ReferenceWord>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TimingTruth {
    Exact,
    Aligned,
    #[default]
    None,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Manifest {
    pub name: String,
    #[serde(default)]
    pub attribution: String,
    #[serde(default)]
    pub timing: TimingTruth,
    pub clips: Vec<Clip>,
}

impl Manifest {
    pub fn load(dir: &Path) -> Result<Self, String> {
        let text = std::fs::read_to_string(dir.join("manifest.json"))
            .map_err(|e| format!("{}: {e}", dir.display()))?;
        serde_json::from_str(&text).map_err(|e| format!("{}: {e}", dir.display()))
    }
}

pub fn canonical(text: &str) -> String {
    let word = normalize_word(&text.replace('’', "'"));
    match word.as_str() {
        "umm" | "uhm" | "erm" | "mmm-hmm" => "um".to_string(),
        "uhh" | "er" => "uh".to_string(),
        "ahh" | "eh" => "ah".to_string(),
        "hm" | "mm" | "mmm" => "hmm".to_string(),
        _ => word,
    }
}

fn filler_class(text: &str) -> Option<String> {
    let lower = normalize_word(text);
    is_hesitation_filler(&lower).then_some(lower)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Step {
    Match(usize, usize),
    Substitute(usize, usize),
    Delete(usize),
    Insert(usize),
}

pub fn align(reference: &[String], hypothesis: &[String]) -> Vec<Step> {
    let (n, m) = (reference.len(), hypothesis.len());
    let substitution = |r: &str, h: &str| {
        if r == h {
            0
        } else if is_hesitation_filler(r) && is_hesitation_filler(h) {
            1
        } else {
            3
        }
    };
    let mut cost = vec![vec![0u32; m + 1]; n + 1];
    for (i, row) in cost.iter_mut().enumerate() {
        row[0] = 2 * i as u32;
    }
    for j in 0..=m {
        cost[0][j] = 2 * j as u32;
    }
    for i in 1..=n {
        for j in 1..=m {
            let diagonal = cost[i - 1][j - 1] + substitution(&reference[i - 1], &hypothesis[j - 1]);
            cost[i][j] = diagonal.min(cost[i - 1][j] + 2).min(cost[i][j - 1] + 2);
        }
    }
    let mut steps = Vec::with_capacity(n.max(m));
    let (mut i, mut j) = (n, m);
    while i > 0 || j > 0 {
        if i > 0
            && j > 0
            && cost[i][j]
                == cost[i - 1][j - 1] + substitution(&reference[i - 1], &hypothesis[j - 1])
        {
            steps.push(if reference[i - 1] == hypothesis[j - 1] {
                Step::Match(i - 1, j - 1)
            } else {
                Step::Substitute(i - 1, j - 1)
            });
            i -= 1;
            j -= 1;
        } else if i > 0 && cost[i][j] == cost[i - 1][j] + 2 {
            steps.push(Step::Delete(i - 1));
            i -= 1;
        } else {
            steps.push(Step::Insert(j - 1));
            j -= 1;
        }
    }
    steps.reverse();
    steps
}

pub struct Envelope {
    hop: f64,
    levels: Vec<f32>,
    threshold: f32,
}

impl Envelope {
    pub fn new(samples: &[f32], rate: u32) -> Self {
        let hop = (rate as usize / 200).max(1);
        let mut levels = Vec::with_capacity(samples.len() / hop + 1);
        let mut centre = 0;
        while centre < samples.len() {
            let frame = &samples[centre.saturating_sub(hop)..(centre + hop).min(samples.len())];
            let power = frame.iter().map(|s| s * s).sum::<f32>() / frame.len() as f32;
            levels.push(10.0 * (power + 1e-12).log10());
            centre += hop;
        }
        let mut sorted = levels.clone();
        sorted.sort_by(f32::total_cmp);
        let at = |q: f64| {
            sorted
                .get(((sorted.len().saturating_sub(1)) as f64 * q).round() as usize)
                .copied()
                .unwrap_or(-120.0)
        };
        let threshold = (at(0.95) - 40.0).max(at(0.10) + 6.0);
        Self {
            hop: hop as f64 / f64::from(rate),
            levels,
            threshold,
        }
    }

    pub fn voiced_seconds(&self, start: f64, end: f64) -> f64 {
        if end <= start {
            return 0.0;
        }
        let first = (start / self.hop).ceil().max(0.0) as usize;
        let last = (end / self.hop).ceil().max(0.0) as usize;
        self.levels
            .get(first..last.min(self.levels.len()))
            .map_or(0, |frames| {
                frames
                    .iter()
                    .filter(|level| **level > self.threshold)
                    .count()
            }) as f64
            * self.hop
    }
}

pub const CUT_DAMAGE_SECONDS: f64 = 0.010;
pub const PAUSE_SECONDS: f64 = 0.05;
pub const CUT_RESIDUE_SECONDS: f64 = 0.030;

#[derive(Debug, Default, Clone, Serialize)]
pub struct Tally {
    pub clips: usize,
    pub reference_words: usize,
    pub substitutions: usize,
    pub deletions: usize,
    pub insertions: usize,
    pub filler_reference: BTreeMap<String, usize>,
    pub filler_recalled: BTreeMap<String, usize>,
    pub hypothesis_fillers: usize,
    pub hypothesis_fillers_correct: usize,
    pub repetitions: usize,
    pub repetitions_recalled: usize,
    pub false_starts: usize,
    pub false_starts_recalled: usize,
    pub start_errors: Vec<f64>,
    pub end_errors: Vec<f64>,
    pub pause_edge_errors: Vec<f64>,
    pub joined_edge_errors: Vec<f64>,
    pub cuts: usize,
    pub safe_cuts: usize,
    pub clean_cuts: usize,
    pub audio_seconds: f64,
    pub compute_seconds: f64,
}

pub fn percentile(values: &[f64], q: f64) -> f64 {
    if values.is_empty() {
        return f64::NAN;
    }
    let mut sorted: Vec<f64> = values.iter().map(|v| v.abs()).collect();
    sorted.sort_by(f64::total_cmp);
    sorted[((sorted.len() - 1) as f64 * q).round() as usize]
}

fn mean(values: &[f64]) -> f64 {
    if values.is_empty() {
        f64::NAN
    } else {
        values.iter().sum::<f64>() / values.len() as f64
    }
}

impl Tally {
    pub fn score(
        &mut self,
        reference: &[ReferenceWord],
        hypothesis: &[CaptionWord],
        timing: TimingTruth,
        envelope: Option<&Envelope>,
    ) {
        self.clips += 1;
        let reference_tokens: Vec<String> = reference.iter().map(|w| canonical(&w.text)).collect();
        let mut hypothesis_words: Vec<(String, f64, f64, String)> = Vec::new();
        for word in hypothesis {
            for piece in word.text.split_whitespace() {
                let token = canonical(piece);
                if !token.is_empty() {
                    hypothesis_words.push((
                        token,
                        f64::from(word.start),
                        f64::from(word.end),
                        piece.to_string(),
                    ));
                }
            }
        }
        let hypothesis_tokens: Vec<String> = hypothesis_words.iter().map(|w| w.0.clone()).collect();
        let steps = align(&reference_tokens, &hypothesis_tokens);
        self.reference_words += reference.len();

        let mut paired: Vec<Option<(usize, bool)>> = vec![None; reference.len()];
        let mut hypothesis_paired = vec![false; hypothesis_tokens.len()];
        for step in &steps {
            match *step {
                Step::Match(r, h) => {
                    paired[r] = Some((h, true));
                    hypothesis_paired[h] = true;
                }
                Step::Substitute(r, h) => {
                    self.substitutions += 1;
                    paired[r] = Some((h, false));
                    hypothesis_paired[h] = true;
                }
                Step::Delete(_) => self.deletions += 1,
                Step::Insert(_) => self.insertions += 1,
            }
        }

        let mut index = 0;
        while index < reference.len() {
            let word = &reference[index];
            match word.filler.as_deref() {
                Some(label) if is_hesitation_filler(label) => {
                    let class = filler_class(&word.text).unwrap_or_else(|| label.to_string());
                    *self.filler_reference.entry(class.clone()).or_default() += 1;
                    let recalled = paired[index].is_some_and(|(h, _)| {
                        is_hesitation_filler(&hypothesis_words[h].3)
                            || is_hesitation_filler(&hypothesis_words[h].0)
                    });
                    if recalled {
                        *self.filler_recalled.entry(class).or_default() += 1;
                    }
                    index += 1;
                }
                Some(label) => {
                    let length = reference[index..]
                        .iter()
                        .take_while(|w| w.filler.as_deref() == Some(label))
                        .count()
                        .max(1);
                    let key = label.to_lowercase();
                    *self.filler_reference.entry(key.clone()).or_default() += 1;
                    if (index..index + length).all(|i| paired[i].is_some_and(|(_, exact)| exact)) {
                        *self.filler_recalled.entry(key).or_default() += 1;
                    }
                    index += length;
                }
                None => {
                    if !reference_tokens[index].is_empty()
                        && is_hesitation_filler(&reference_tokens[index])
                    {
                        let class = filler_class(&word.text)
                            .unwrap_or_else(|| reference_tokens[index].clone());
                        *self.filler_reference.entry(class.clone()).or_default() += 1;
                        if paired[index]
                            .is_some_and(|(h, _)| is_hesitation_filler(&hypothesis_words[h].0))
                        {
                            *self.filler_recalled.entry(class).or_default() += 1;
                        }
                    }
                    index += 1;
                }
            }
        }

        for (h, word) in hypothesis_words.iter().enumerate() {
            if is_hesitation_filler(&word.0) {
                self.hypothesis_fillers += 1;
                let correct = hypothesis_paired[h]
                    && paired.iter().enumerate().any(|(r, pair)| {
                        pair.is_some_and(|(ph, _)| ph == h)
                            && is_hesitation_filler(&reference_tokens[r])
                    });
                if correct {
                    self.hypothesis_fillers_correct += 1;
                }
            }
        }

        for r in 0..reference.len() {
            if reference[r].truncated {
                self.false_starts += 1;
                if paired[r].is_some() {
                    self.false_starts_recalled += 1;
                }
                continue;
            }
            if is_hesitation_filler(&reference_tokens[r]) || reference_tokens[r].is_empty() {
                continue;
            }
            let next = (r + 1..reference.len()).find(|&i| {
                !is_hesitation_filler(&reference_tokens[i]) && !reference_tokens[i].is_empty()
            });
            if let Some(next) = next
                && reference_tokens[next] == reference_tokens[r]
            {
                self.repetitions += 1;
                if paired[r].is_some_and(|(_, exact)| exact)
                    && paired[next].is_some_and(|(_, exact)| exact)
                {
                    self.repetitions_recalled += 1;
                }
            }
        }

        if timing == TimingTruth::None {
            return;
        }
        for (r, pair) in paired.iter().enumerate() {
            let Some((h, exact)) = *pair else { continue };
            let filler_pair = is_hesitation_filler(&reference_tokens[r])
                && is_hesitation_filler(&hypothesis_words[h].0);
            if !exact && !filler_pair {
                continue;
            }
            let (_, start, end, _) = hypothesis_words[h];
            let truth = &reference[r];
            if exact
                && (h == 0 || hypothesis_words[h - 1].1 != start)
                && (h + 1 >= hypothesis_words.len() || hypothesis_words[h + 1].1 != start)
            {
                self.start_errors.push(start - truth.start);
                self.end_errors.push(end - truth.end);
                let gap_before = r
                    .checked_sub(1)
                    .map_or(f64::INFINITY, |p| truth.start - reference[p].end);
                let gap_after = reference
                    .get(r + 1)
                    .map_or(f64::INFINITY, |n| n.start - truth.end);
                for (gap, error) in [
                    (gap_before, start - truth.start),
                    (gap_after, end - truth.end),
                ] {
                    if gap >= PAUSE_SECONDS {
                        self.pause_edge_errors.push(error);
                    } else {
                        self.joined_edge_errors.push(error);
                    }
                }
            }
            let Some(envelope) = envelope else { continue };
            self.cuts += 1;
            let damage = [r.checked_sub(1), Some(r + 1)]
                .into_iter()
                .flatten()
                .filter_map(|n| reference.get(n))
                .map(|neighbour| {
                    envelope.voiced_seconds(start.max(neighbour.start), end.min(neighbour.end))
                })
                .fold(0.0, f64::max);
            let residue = envelope.voiced_seconds(truth.start, start.min(truth.end))
                + envelope.voiced_seconds(end.max(truth.start), truth.end);
            if damage < CUT_DAMAGE_SECONDS {
                self.safe_cuts += 1;
                if residue < CUT_RESIDUE_SECONDS {
                    self.clean_cuts += 1;
                }
            }
        }
    }

    pub fn wer(&self) -> f64 {
        (self.substitutions + self.deletions + self.insertions) as f64
            / self.reference_words.max(1) as f64
    }

    fn sum_where(map: &BTreeMap<String, usize>, hesitation: bool) -> usize {
        map.iter()
            .filter(|(key, _)| is_hesitation_filler(key) == hesitation)
            .map(|(_, count)| *count)
            .sum()
    }

    pub fn hesitation_recall(&self) -> f64 {
        Self::sum_where(&self.filler_recalled, true) as f64
            / Self::sum_where(&self.filler_reference, true).max(1) as f64
    }

    pub fn hesitation_precision(&self) -> f64 {
        if self.hypothesis_fillers == 0 {
            return f64::NAN;
        }
        self.hypothesis_fillers_correct as f64 / self.hypothesis_fillers as f64
    }

    pub fn summary(&self) -> Summary {
        let ratio = |a: usize, b: usize| {
            if b == 0 {
                f64::NAN
            } else {
                a as f64 / b as f64
            }
        };
        Summary {
            clips: self.clips,
            reference_words: self.reference_words,
            wer: self.wer(),
            hesitation_recall: self.hesitation_recall(),
            hesitation_precision: self.hesitation_precision(),
            filler_recall: self
                .filler_reference
                .iter()
                .map(|(key, total)| {
                    (
                        key.clone(),
                        (self.filler_recalled.get(key).copied().unwrap_or(0), *total),
                    )
                })
                .collect(),
            repetition_recall: ratio(self.repetitions_recalled, self.repetitions),
            false_start_recall: ratio(self.false_starts_recalled, self.false_starts),
            timed_words: self.start_errors.len(),
            start_median_ms: percentile(&self.start_errors, 0.5) * 1000.0,
            start_p95_ms: percentile(&self.start_errors, 0.95) * 1000.0,
            start_bias_ms: mean(&self.start_errors) * 1000.0,
            end_median_ms: percentile(&self.end_errors, 0.5) * 1000.0,
            end_p95_ms: percentile(&self.end_errors, 0.95) * 1000.0,
            end_bias_ms: mean(&self.end_errors) * 1000.0,
            pause_edge_median_ms: percentile(&self.pause_edge_errors, 0.5) * 1000.0,
            pause_edge_p95_ms: percentile(&self.pause_edge_errors, 0.95) * 1000.0,
            joined_edge_median_ms: percentile(&self.joined_edge_errors, 0.5) * 1000.0,
            joined_edge_p95_ms: percentile(&self.joined_edge_errors, 0.95) * 1000.0,
            cut_safety: ratio(self.safe_cuts, self.cuts),
            clean_cuts: ratio(self.clean_cuts, self.cuts),
            rtf: if self.audio_seconds > 0.0 {
                self.compute_seconds / self.audio_seconds
            } else {
                f64::NAN
            },
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct Summary {
    pub clips: usize,
    pub reference_words: usize,
    pub wer: f64,
    pub hesitation_recall: f64,
    pub hesitation_precision: f64,
    pub filler_recall: BTreeMap<String, (usize, usize)>,
    pub repetition_recall: f64,
    pub false_start_recall: f64,
    pub timed_words: usize,
    pub start_median_ms: f64,
    pub start_p95_ms: f64,
    pub start_bias_ms: f64,
    pub end_median_ms: f64,
    pub end_p95_ms: f64,
    pub end_bias_ms: f64,
    pub pause_edge_median_ms: f64,
    pub pause_edge_p95_ms: f64,
    pub joined_edge_median_ms: f64,
    pub joined_edge_p95_ms: f64,
    pub cut_safety: f64,
    pub clean_cuts: f64,
    pub rtf: f64,
}

impl Summary {
    pub fn row(&self, dataset: &str, config: &str) -> String {
        let fillers = self
            .filler_recall
            .iter()
            .map(|(key, (hit, total))| format!("{key} {hit}/{total}"))
            .collect::<Vec<_>>()
            .join(", ");
        format!(
            "| {dataset} | {config} | {} | {:.1}% | {:.1}% | {:.1}% | {:.0}% | {:.0}% | {:.0} / {:.0} | {:.0} / {:.0} | {:+.0} / {:+.0} | {:.1}% | {:.1}% | {:.3} | {fillers} | {:.0} / {:.0} | {:.0} / {:.0} |",
            self.reference_words,
            self.wer * 100.0,
            self.hesitation_recall * 100.0,
            self.hesitation_precision * 100.0,
            self.repetition_recall * 100.0,
            self.false_start_recall * 100.0,
            self.start_median_ms,
            self.start_p95_ms,
            self.end_median_ms,
            self.end_p95_ms,
            self.start_bias_ms,
            self.end_bias_ms,
            self.cut_safety * 100.0,
            self.clean_cuts * 100.0,
            self.rtf,
            self.pause_edge_median_ms,
            self.pause_edge_p95_ms,
            self.joined_edge_median_ms,
            self.joined_edge_p95_ms,
        )
    }
}

pub const TABLE_HEADER: &str = "| data | config | words | WER | filler recall | filler precision | repetition recall | false-start recall | start median / p95 ms | end median / p95 ms | start / end bias ms | cut safety | clean cuts | RTF | per filler | pause edge median / p95 ms | joined edge median / p95 ms |\n|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|";

pub fn read_wav_16k(path: &Path) -> Result<Vec<f32>, String> {
    super::read_wav_16k_mono(path)
}

pub fn write_wav_16k(path: &Path, samples: &[f32]) -> Result<(), String> {
    let data_len = (samples.len() * 2) as u32;
    let mut bytes = Vec::with_capacity(44 + samples.len() * 2);
    bytes.extend_from_slice(b"RIFF");
    bytes.extend_from_slice(&(36 + data_len).to_le_bytes());
    bytes.extend_from_slice(b"WAVEfmt ");
    bytes.extend_from_slice(&16u32.to_le_bytes());
    bytes.extend_from_slice(&1u16.to_le_bytes());
    bytes.extend_from_slice(&1u16.to_le_bytes());
    bytes.extend_from_slice(&16_000u32.to_le_bytes());
    bytes.extend_from_slice(&32_000u32.to_le_bytes());
    bytes.extend_from_slice(&2u16.to_le_bytes());
    bytes.extend_from_slice(&16u16.to_le_bytes());
    bytes.extend_from_slice(b"data");
    bytes.extend_from_slice(&data_len.to_le_bytes());
    for sample in samples {
        let value = (sample.clamp(-1.0, 1.0) * 32767.0).round() as i16;
        bytes.extend_from_slice(&value.to_le_bytes());
    }
    std::fs::write(path, bytes).map_err(|e| format!("{}: {e}", path.display()))
}

pub fn peak_rss_bytes() -> u64 {
    #[cfg(unix)]
    {
        let mut usage = std::mem::MaybeUninit::<libc::rusage>::zeroed();
        // SAFETY: getrusage writes a full rusage into the pointer it is given.
        let usage = unsafe {
            libc::getrusage(libc::RUSAGE_SELF, usage.as_mut_ptr());
            usage.assume_init()
        };
        let max = usage.ru_maxrss as u64;
        if cfg!(target_os = "macos") {
            max
        } else {
            max * 1024
        }
    }
    #[cfg(not(unix))]
    {
        0
    }
}

pub fn data_dirs() -> Vec<PathBuf> {
    std::env::var("CAP_EVAL_DATA")
        .unwrap_or_default()
        .split(',')
        .filter(|part| !part.trim().is_empty())
        .map(|part| PathBuf::from(part.trim()))
        .collect()
}

#[cfg(test)]
mod run {
    use std::time::Instant;

    use super::super::*;
    use super::*;

    enum Engine {
        Whisper(PathBuf),
        Parakeet(PathBuf),
        Hypotheses(PathBuf),
    }

    impl Engine {
        fn from_env() -> Self {
            let spec = std::env::var("CAP_EVAL_ENGINE")
                .expect("CAP_EVAL_ENGINE=whisper:<model.bin>|parakeet:<dir>|hyp:<dir>");
            let (kind, path) = spec.split_once(':').expect("engine kind:path");
            let path = PathBuf::from(path);
            match kind {
                "whisper" => Self::Whisper(path),
                "parakeet" => Self::Parakeet(path),
                "hyp" => Self::Hypotheses(path),
                other => panic!("unknown engine {other}"),
            }
        }

        fn warm_up(&self) {
            match self {
                Self::Whisper(model) => {
                    get_whisper_context(&model.to_string_lossy()).expect("whisper model loads");
                }
                Self::Parakeet(_) => {
                    let silence = vec![0.0f32; 16_000];
                    let _ = self.transcribe(
                        &VerbatimOptions::BASELINE,
                        None,
                        "warm-up",
                        "warm-up",
                        &silence,
                    );
                }
                Self::Hypotheses(_) => {}
            }
        }

        fn transcribe(
            &self,
            options: &VerbatimOptions,
            aligner: Option<&mut align::AcousticPool>,
            dataset: &str,
            clip: &str,
            samples: &[f32],
        ) -> Result<(Vec<Vec<CaptionWord>>, Vec<CaptionWord>), String> {
            let scratch = tempfile::tempdir().map_err(|e| e.to_string())?;
            let wav = scratch.path().join("audio.wav");
            let mut normalized = samples.to_vec();
            normalize_audio_for_transcription(&mut normalized);
            write_wav_16k(&wav, &normalized)?;
            let input = read_wav_16k_mono(&wav)?;
            let mut raw = Vec::new();
            let overlap = !matches!(self, Self::Whisper(_));
            let (ready, fetch) = if overlap {
                (aligner, None)
            } else {
                (None, aligner)
            };
            let finished = recognize_and_finish(
                &input,
                &language(),
                options,
                &tuning(),
                overlap,
                move || ready,
                move || fetch,
                || {
                    let groups = match self {
                        Self::Whisper(model) => {
                            let context = get_whisper_context(&model.to_string_lossy())?;
                            process_with_whisper(
                                &input,
                                context,
                                &language(),
                                &default_transcription_hints(),
                                options,
                            )?
                        }
                        Self::Parakeet(dir) => {
                            process_with_parakeet(&input, &dir.to_string_lossy(), options)?
                        }
                        Self::Hypotheses(dir) => {
                            let path = dir.join(dataset).join(format!("{clip}.raw.json"));
                            let text = std::fs::read_to_string(&path)
                                .map_err(|e| format!("{}: {e}", path.display()))?;
                            serde_json::from_str(&text).map_err(|e| e.to_string())?
                        }
                    };
                    raw.clone_from(&groups);
                    Ok(groups)
                },
            )?
            .into_iter()
            .flatten()
            .collect();
            Ok((raw, finished))
        }
    }

    fn tuning() -> Tuning {
        let read = |name: &str, default: f64| {
            std::env::var(name)
                .ok()
                .and_then(|value| value.parse().ok())
                .unwrap_or(default)
        };
        Tuning {
            snap: verbatim::SnapSettings {
                above_floor_db: read("CAP_EVAL_FLOOR_DB", f64::from(TUNING.snap.above_floor_db))
                    as f32,
                below_peak_db: read("CAP_EVAL_PEAK_DB", f64::from(TUNING.snap.below_peak_db))
                    as f32,
                search: read("CAP_EVAL_SNAP_SEARCH", TUNING.snap.search),
                end_search: read("CAP_EVAL_SNAP_END", TUNING.snap.end_search),
                outer_search: read("CAP_EVAL_SNAP_OUTER", TUNING.snap.outer_search),
                min_pause: read("CAP_EVAL_SNAP_PAUSE", TUNING.snap.min_pause),
                min_word: TUNING.snap.min_word,
            },
        }
    }

    fn language() -> String {
        std::env::var("CAP_EVAL_LANGUAGE").unwrap_or_else(|_| "en".into())
    }

    fn options_from_config(config: &str) -> VerbatimOptions {
        let mut options = VerbatimOptions::BASELINE;
        for flag in config.split(',').map(str::trim) {
            match flag {
                "baseline" => {}
                "default" => options = VerbatimOptions::default(),
                "subwords" => options.parakeet_subword_words = true,
                "-subwords" => options.parakeet_subword_words = false,
                "prompt" => options.whisper_filler_prompt = true,
                "-prompt" => options.whisper_filler_prompt = false,
                "recover" => options.recover_speech = true,
                "-recover" => options.recover_speech = false,
                "stutters" => options.split_stutters = true,
                "-stutters" => options.split_stutters = false,
                "align" => options.align_words = true,
                "-align" => options.align_words = false,
                "snap" => options.snap_to_pauses = true,
                "-snap" => options.snap_to_pauses = false,
                other => panic!("unknown eval flag {other}"),
            }
        }
        options
    }

    #[test]
    #[ignore = "needs CAP_BENCH_WAV and CAP_EVAL_ALIGNER"]
    fn bench_word_aligner() {
        let samples = read_wav_16k(Path::new(
            &std::env::var("CAP_BENCH_WAV").expect("CAP_BENCH_WAV"),
        ))
        .expect("wav");
        let started = Instant::now();
        let mut pool = load_aligner(
            Path::new(&std::env::var("CAP_EVAL_ALIGNER").expect("CAP_EVAL_ALIGNER")),
            false,
        );
        let loaded = started.elapsed().as_secs_f64();
        let heard = align::Heard::hear(&samples, &mut pool, &AtomicBool::new(false))
            .expect("emissions")
            .expect("not stopped");
        let seconds = started.elapsed().as_secs_f64() - loaded;
        let audio = samples.len() as f64 / 16_000.0;
        println!(
            "aligner load={loaded:.2}s rtf={:.4} frames={} peak_rss={} MiB",
            seconds / audio,
            heard.into_parts().0.len() / 32,
            peak_rss_bytes() / (1024 * 1024)
        );
    }

    fn load_aligner(path: &Path, alone: bool) -> align::AcousticPool {
        #[cfg(not(all(target_os = "macos", target_arch = "x86_64")))]
        if let Ok(sessions) = std::env::var("CAP_EVAL_ALIGNER_SESSIONS") {
            let threads = std::env::var("CAP_EVAL_ALIGNER_THREADS")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(2);
            return align::AcousticPool::load_sized(
                path,
                sessions.parse().expect("CAP_EVAL_ALIGNER_SESSIONS"),
                threads,
            )
            .expect("word aligner loads");
        }
        if alone {
            align::AcousticPool::load_alone(path)
        } else {
            align::AcousticPool::load(path)
        }
        .expect("word aligner loads")
    }

    #[test]
    #[ignore = "needs CAP_EVAL_DATA and CAP_EVAL_ENGINE"]
    fn transcription_eval() {
        let engine = Engine::from_env();
        let config = std::env::var("CAP_EVAL_CONFIG").unwrap_or_else(|_| "baseline".into());
        let options = options_from_config(&config);
        let out = std::env::var("CAP_EVAL_OUT").ok().map(PathBuf::from);
        let limit = std::env::var("CAP_EVAL_LIMIT")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(usize::MAX);
        let load_started = Instant::now();
        engine.warm_up();
        let mut aligner = std::env::var("CAP_EVAL_ALIGNER")
            .ok()
            .filter(|_| options.align_words)
            .map(|path| load_aligner(Path::new(&path), matches!(engine, Engine::Whisper(_))));
        let load_seconds = load_started.elapsed().as_secs_f64();
        let mut rows = Vec::new();
        let mut summaries = BTreeMap::new();
        for dir in data_dirs() {
            let manifest = Manifest::load(&dir).expect("manifest");
            let mut tally = Tally::default();
            for clip in manifest.clips.iter().take(limit) {
                let samples = read_wav_16k(&dir.join(&clip.audio)).expect("clip audio");
                let started = Instant::now();
                let (raw, words) = engine
                    .transcribe(
                        &options,
                        aligner.as_mut(),
                        &manifest.name,
                        &clip.id,
                        &samples,
                    )
                    .unwrap_or_else(|error| {
                        eprintln!("{} {}: {error}", manifest.name, clip.id);
                        (Vec::new(), Vec::new())
                    });
                tally.compute_seconds += started.elapsed().as_secs_f64();
                tally.audio_seconds += samples.len() as f64 / 16_000.0;
                let envelope = Envelope::new(&samples, 16_000);
                tally.score(&clip.words, &words, manifest.timing, Some(&envelope));
                if let Some(out) = &out {
                    let dir = out.join(&manifest.name);
                    std::fs::create_dir_all(&dir).expect("output dir");
                    std::fs::write(
                        dir.join(format!("{}.json", clip.id)),
                        serde_json::to_string(&words).expect("words json"),
                    )
                    .expect("write hypothesis");
                    std::fs::write(
                        dir.join(format!("{}.raw.json", clip.id)),
                        serde_json::to_string(&raw).expect("raw json"),
                    )
                    .expect("write raw hypothesis");
                }
            }
            let summary = tally.summary();
            rows.push(summary.row(&manifest.name, &config));
            summaries.insert(manifest.name.clone(), summary);
        }
        let peak = peak_rss_bytes() as f64 / (1024.0 * 1024.0);
        println!("{TABLE_HEADER}");
        for row in &rows {
            println!("{row}");
        }
        println!("config {config}: model load {load_seconds:.2}s, peak RSS {peak:.0} MiB");
        if let Some(out) = out {
            std::fs::create_dir_all(&out).expect("output dir");
            std::fs::write(
                out.join("summary.json"),
                serde_json::to_string_pretty(&serde_json::json!({
                    "config": config,
                    "load_seconds": load_seconds,
                    "peak_rss_mib": peak,
                    "datasets": summaries,
                }))
                .expect("summary json"),
            )
            .expect("write summary");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reference(words: &[(&str, f64, f64)]) -> Vec<ReferenceWord> {
        words
            .iter()
            .map(|(text, start, end)| ReferenceWord {
                text: (*text).to_string(),
                start: *start,
                end: *end,
                filler: is_hesitation_filler(text).then(|| text.to_lowercase()),
                truncated: text.ends_with('-'),
            })
            .collect()
    }

    fn hypothesis(words: &[(&str, f32, f32)]) -> Vec<CaptionWord> {
        words
            .iter()
            .map(|(text, start, end)| CaptionWord {
                text: (*text).to_string(),
                start: *start,
                end: *end,
            })
            .collect()
    }

    fn tokens(text: &str) -> Vec<String> {
        text.split_whitespace().map(canonical).collect()
    }

    #[test]
    fn canonical_tokens_fold_case_punctuation_and_filler_spellings() {
        assert_eq!(canonical("Um,"), "um");
        assert_eq!(canonical("Umm..."), "um");
        assert_eq!(canonical("Er"), "uh");
        assert_eq!(canonical("Mm."), "hmm");
        assert_eq!(canonical("Don’t"), "don't");
        assert_eq!(canonical("Mm-hmm."), "mm-hmm");
        assert_eq!(canonical("..."), "");
    }

    #[test]
    fn alignment_counts_substitutions_deletions_and_insertions() {
        let steps = align(
            &tokens("so um we start now"),
            &tokens("so we started now please"),
        );
        let count = |f: fn(&Step) -> bool| steps.iter().filter(|s| f(s)).count();
        assert_eq!(count(|s| matches!(s, Step::Match(..))), 3);
        assert_eq!(count(|s| matches!(s, Step::Substitute(..))), 1);
        assert_eq!(count(|s| matches!(s, Step::Delete(_))), 1);
        assert_eq!(count(|s| matches!(s, Step::Insert(_))), 1);
        assert!(align(&[], &[]).is_empty());
        assert_eq!(align(&tokens("a b"), &[]).len(), 2);
    }

    #[test]
    fn alignment_pairs_fillers_with_fillers_before_words() {
        let steps = align(&tokens("well uh fine"), &tokens("well um fine"));
        assert_eq!(steps[1], Step::Substitute(1, 1));
        assert_eq!(steps.len(), 3);
    }

    #[test]
    fn tally_scores_fillers_repetitions_false_starts_and_timing() {
        let truth = reference(&[
            ("So", 0.0, 0.2),
            ("um", 0.3, 0.7),
            ("I", 0.8, 0.9),
            ("I", 1.0, 1.1),
            ("cha-", 1.2, 1.3),
            ("change", 1.4, 1.8),
            ("uh", 2.0, 2.3),
            ("it", 2.4, 2.5),
        ]);
        let heard = hypothesis(&[
            ("So,", 0.01, 0.22),
            ("um,", 0.31, 0.6),
            ("I", 0.8, 0.9),
            ("I", 1.0, 1.1),
            ("change", 1.4, 1.8),
            ("it.", 2.38, 2.5),
            ("hmm", 2.6, 2.7),
        ]);
        let mut tally = Tally::default();
        tally.score(&truth, &heard, TimingTruth::Exact, None);
        let summary = tally.summary();
        assert_eq!(tally.reference_words, 8);
        assert_eq!((tally.deletions, tally.insertions), (2, 1));
        assert_eq!(summary.filler_recall.get("um"), Some(&(1, 1)));
        assert_eq!(summary.filler_recall.get("uh"), Some(&(0, 1)));
        assert!((summary.hesitation_recall - 0.5).abs() < 1e-9);
        assert!((summary.hesitation_precision - 0.5).abs() < 1e-9);
        assert_eq!((tally.repetitions, tally.repetitions_recalled), (1, 1));
        assert_eq!((tally.false_starts, tally.false_starts_recalled), (1, 0));
        assert_eq!(tally.start_errors.len(), 6);
        assert!((summary.start_p95_ms - 20.0).abs() < 1e-3);
    }

    #[test]
    fn discourse_fillers_count_only_when_every_word_survives() {
        let mut truth = reference(&[
            ("you", 0.0, 0.1),
            ("know", 0.1, 0.2),
            ("it", 0.3, 0.4),
            ("like", 0.5, 0.6),
            ("works", 0.7, 0.8),
        ]);
        truth[0].filler = Some("you know".into());
        truth[1].filler = Some("you know".into());
        truth[3].filler = Some("like".into());
        let mut tally = Tally::default();
        tally.score(
            &truth,
            &hypothesis(&[
                ("You", 0.0, 0.1),
                ("know,", 0.1, 0.2),
                ("it", 0.3, 0.4),
                ("works", 0.7, 0.8),
            ]),
            TimingTruth::None,
            None,
        );
        let summary = tally.summary();
        assert_eq!(summary.filler_recall.get("you know"), Some(&(1, 1)));
        assert_eq!(summary.filler_recall.get("like"), Some(&(0, 1)));
        assert!(tally.start_errors.is_empty());
    }

    fn tone(rate: u32, seconds: f64, spans: &[(f64, f64)]) -> Vec<f32> {
        (0..(seconds * f64::from(rate)) as usize)
            .map(|i| {
                let t = i as f64 / f64::from(rate);
                if spans.iter().any(|(a, b)| t >= *a && t < *b) {
                    (t * 220.0 * std::f64::consts::TAU).sin() as f32 * 0.5
                } else {
                    0.0
                }
            })
            .collect()
    }

    #[test]
    fn envelope_measures_voiced_time_inside_a_window() {
        let samples = tone(16_000, 2.0, &[(0.5, 1.0)]);
        let envelope = Envelope::new(&samples, 16_000);
        assert!((envelope.voiced_seconds(0.0, 2.0) - 0.5).abs() < 0.011);
        assert!(envelope.voiced_seconds(1.1, 1.9) < 1e-9);
        assert!((envelope.voiced_seconds(0.9, 1.2) - 0.1).abs() < 0.011);
        assert_eq!(envelope.voiced_seconds(1.5, 1.0), 0.0);
        assert_eq!(Envelope::new(&[], 16_000).voiced_seconds(0.0, 1.0), 0.0);
    }

    #[test]
    fn cuts_that_eat_a_neighbours_sound_are_unsafe() {
        let truth = reference(&[("one", 0.2, 0.5), ("um", 0.5, 0.9), ("two", 0.9, 1.2)]);
        let samples = tone(16_000, 1.5, &[(0.2, 0.5), (0.55, 0.85), (0.9, 1.2)]);
        let envelope = Envelope::new(&samples, 16_000);
        let mut tight = Tally::default();
        tight.score(
            &truth,
            &hypothesis(&[("one", 0.2, 0.5), ("um", 0.5, 0.9), ("two", 0.9, 1.2)]),
            TimingTruth::Exact,
            Some(&envelope),
        );
        assert_eq!((tight.cuts, tight.safe_cuts, tight.clean_cuts), (3, 3, 3));
        let mut loose = Tally::default();
        loose.score(
            &truth,
            &hypothesis(&[("one", 0.2, 0.42), ("um", 0.42, 0.95), ("two", 0.95, 1.2)]),
            TimingTruth::Exact,
            Some(&envelope),
        );
        assert_eq!(loose.cuts, 3);
        assert_eq!(loose.safe_cuts, 2);
        assert_eq!(loose.clean_cuts, 0);
    }

    #[test]
    fn wav_round_trip_keeps_samples() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("clip.wav");
        let samples = [0.0, 0.5, -0.5, 0.25];
        write_wav_16k(&path, &samples).unwrap();
        let read = read_wav_16k(&path).unwrap();
        assert_eq!(read.len(), samples.len());
        for (a, b) in read.iter().zip(samples) {
            assert!((a - b).abs() < 1e-4);
        }
    }

    #[test]
    fn percentiles_use_absolute_errors() {
        assert_eq!(percentile(&[-0.03, 0.01, 0.02], 0.5), 0.02);
        assert!(percentile(&[], 0.5).is_nan());
    }
}
