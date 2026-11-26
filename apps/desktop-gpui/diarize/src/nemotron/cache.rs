//! Arrival-Order Speaker Cache and FIFO queue of Nemotron 3 Diarization
//! (port of transformers' `Nemotron3DiarizationSpeakerCache`, batch size 1).
//!
//! Every chunk attends to the cached encoder frames before it. When the FIFO
//! overflows its oldest frames move to the speaker cache; when that is full
//! it keeps, per speaker, the frames that speak most clearly for that
//! speaker. Ties in the selection go to the earliest frame.

pub const HIDDEN: usize = 512;
pub const SPEAKERS: usize = 8;
pub const SUB: usize = 8;
pub const CACHE: usize = 264;
const SILENCE_FRAMES: usize = 1;
const SCORE_THRESHOLD: f32 = 0.25;
const LATEST_BOOST: f32 = 0.05;
const BUDGET: usize = CACHE / SPEAKERS - SILENCE_FRAMES;
const LN_HALF: f32 = -std::f32::consts::LN_2;

fn floor_rate(rate: f64) -> usize {
    (BUDGET as f64 * rate).floor() as usize
}

#[derive(Clone, Debug)]
pub struct SpeakerCache {
    fifo_length: usize,
    update_period: usize,
    /// Cached frames, `HIDDEN` values each, and their speaker probabilities.
    embeds: Vec<f32>,
    probs: Vec<f32>,
    fifo: Vec<f32>,
    compressed: bool,
}

impl SpeakerCache {
    /// The offline preset Cap uses: a 40-frame FIFO moved 300 frames at a time.
    pub fn offline() -> Self {
        Self::new(40, 300)
    }

    pub fn new(fifo_length: usize, update_period: usize) -> Self {
        Self {
            fifo_length,
            update_period,
            embeds: Vec::new(),
            probs: Vec::new(),
            fifo: Vec::new(),
            compressed: false,
        }
    }

    pub fn frames(&self) -> usize {
        (self.embeds.len() + self.fifo.len()) / HIDDEN
    }

    /// The frames the next chunk attends to: cache then FIFO.
    pub fn embeds(&self) -> Vec<f32> {
        let mut out = Vec::with_capacity(self.embeds.len() + self.fifo.len());
        out.extend_from_slice(&self.embeds);
        out.extend_from_slice(&self.fifo);
        out
    }

    /// Pushes a processed chunk.
    ///
    /// `input_embeds`: the step's encoder input (cached frames, then the
    /// chunk's frames including look-ahead); `logits`: its speaker logits at
    /// the spectrogram rate (`SUB` per encoder frame); `mask`: valid encoder
    /// frames of the step; `n_chunk`: chunk frames that join the FIFO.
    pub fn update(&mut self, input_embeds: &[f32], logits: &[f32], silence: &[f32], n_chunk: usize, mask: &[f32]) {
        let n_cache = self.embeds.len() / HIDDEN;
        let n_fifo = self.fifo.len() / HIDDEN;
        let n_frames = input_embeds.len() / HIDDEN;
        // probabilities pooled to the encoder rate, zero on padding frames
        let mut probs = vec![0f32; n_frames * SPEAKERS];
        for e in 0..n_frames {
            for s in 0..SPEAKERS {
                let mut acc = 0f32;
                for k in 0..SUB {
                    let l = logits[(e * SUB + k) * SPEAKERS + s];
                    acc += 1.0 / (1.0 + (-l).exp());
                }
                probs[e * SPEAKERS + s] = acc / SUB as f32 * mask[e];
            }
        }
        let start = n_cache + n_fifo;
        let mut fifo_embeds = self.fifo.clone();
        fifo_embeds.extend_from_slice(&input_embeds[start * HIDDEN..(start + n_chunk) * HIDDEN]);
        let n = fifo_embeds.len() / HIDDEN;
        let popped = if n <= self.fifo_length {
            0
        } else {
            self.update_period.max(n - self.fifo_length).min(n)
        };
        if popped > 0 {
            let mut fifo_probs = probs[n_cache * SPEAKERS..(n_cache + n_fifo) * SPEAKERS].to_vec();
            fifo_probs.extend_from_slice(&probs[start * SPEAKERS..(start + n_chunk) * SPEAKERS]);
            let stored: Vec<f32> = if self.compressed {
                self.probs.clone()
            } else {
                probs[..n_cache * SPEAKERS].to_vec()
            };
            let mut cache_embeds = self.embeds.clone();
            cache_embeds.extend_from_slice(&fifo_embeds[..popped * HIDDEN]);
            let mut cache_probs = stored;
            cache_probs.extend_from_slice(&fifo_probs[..popped * SPEAKERS]);
            fifo_embeds.drain(..popped * HIDDEN);
            if cache_embeds.len() / HIDDEN > CACHE {
                let (e, p) = compress(&cache_embeds, &cache_probs, silence);
                cache_embeds = e;
                cache_probs = p;
                self.compressed = true;
            }
            self.embeds = cache_embeds;
            self.probs = cache_probs;
        }
        self.fifo = fifo_embeds;
    }
}

fn scores(probs: &[f32], n: usize) -> Vec<f32> {
    let min_positive = floor_rate(0.5);
    let mut s = vec![f32::NEG_INFINITY; n * SPEAKERS];
    for f in 0..n {
        let row = &probs[f * SPEAKERS..(f + 1) * SPEAKERS];
        let lc_sum: f32 = row.iter().map(|p| (1.0 - p).max(SCORE_THRESHOLD).ln()).sum();
        for k in 0..SPEAKERS {
            let p = row[k];
            if p > 0.5 {
                let lp = p.max(SCORE_THRESHOLD).ln();
                let lc = (1.0 - p).max(SCORE_THRESHOLD).ln();
                s[f * SPEAKERS + k] = lp - lc + lc_sum - LN_HALF;
            }
        }
    }
    for k in 0..SPEAKERS {
        let positive = (0..n).filter(|&f| s[f * SPEAKERS + k] > 0.0).count();
        if positive >= min_positive {
            for f in 0..n {
                let v = &mut s[f * SPEAKERS + k];
                // speech frames with a non-positive score are dropped once the speaker has enough clear frames
                if probs[f * SPEAKERS + k] > 0.5 && *v <= 0.0 {
                    *v = f32::NEG_INFINITY;
                }
            }
        }
    }
    s
}

/// Indices of the `k` largest values (ties: lowest index first).
fn top_k(values: &[f32], k: usize) -> Vec<usize> {
    let mut idx: Vec<usize> = (0..values.len()).collect();
    idx.sort_by(|&a, &b| values[b].partial_cmp(&values[a]).unwrap_or(std::cmp::Ordering::Equal).then(a.cmp(&b)));
    idx.truncate(k);
    idx
}

fn boost(scores: &mut [f32], n: usize, k: usize, amount: f32) {
    for s in 0..SPEAKERS {
        let column: Vec<f32> = (0..n).map(|f| scores[f * SPEAKERS + s]).collect();
        for f in top_k(&column, k.min(n)) {
            scores[f * SPEAKERS + s] += amount;
        }
    }
}

fn compress(embeds: &[f32], probs: &[f32], silence: &[f32]) -> (Vec<f32>, Vec<f32>) {
    let n = probs.len() / SPEAKERS;
    let mut s = scores(probs, n);
    for f in CACHE..n {
        for k in 0..SPEAKERS {
            s[f * SPEAKERS + k] += LATEST_BOOST;
        }
    }
    boost(&mut s, n, floor_rate(0.75), -2.0 * LN_HALF);
    boost(&mut s, n, floor_rate(1.5), -LN_HALF);
    // one silence slot per speaker, always kept
    let scored = n + SILENCE_FRAMES;
    let mut flat = Vec::with_capacity(scored * SPEAKERS);
    for k in 0..SPEAKERS {
        for f in 0..scored {
            flat.push(if f < n { s[f * SPEAKERS + k] } else { f32::INFINITY });
        }
    }
    let sentinel = scored * SPEAKERS;
    let mut picked: Vec<usize> = top_k(&flat, CACHE)
        .into_iter()
        .map(|i| if flat[i] == f32::NEG_INFINITY { sentinel } else { i })
        .collect();
    picked.sort_unstable();
    let mut out_e = Vec::with_capacity(CACHE * HIDDEN);
    let mut out_p = Vec::with_capacity(CACHE * SPEAKERS);
    for i in picked {
        let frame = if i == sentinel { n } else { (i % scored).min(n) };
        if frame == n {
            out_e.extend_from_slice(silence);
            out_p.extend(std::iter::repeat_n(0.0, SPEAKERS));
        } else {
            out_e.extend_from_slice(&embeds[frame * HIDDEN..(frame + 1) * HIDDEN]);
            out_p.extend_from_slice(&probs[frame * SPEAKERS..(frame + 1) * SPEAKERS]);
        }
    }
    (out_e, out_p)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chunk(frames: usize, speaker: usize, seed: f32) -> (Vec<f32>, Vec<f32>) {
        let embeds: Vec<f32> = (0..frames * HIDDEN).map(|i| ((i as f32) * 0.001 + seed).sin()).collect();
        let mut logits = vec![-6.0f32; frames * SUB * SPEAKERS];
        for f in 0..frames * SUB {
            logits[f * SPEAKERS + speaker] = 6.0;
        }
        (embeds, logits)
    }

    #[test]
    fn the_fifo_fills_then_moves_frames_to_the_cache() {
        let mut c = SpeakerCache::offline();
        let silence = vec![0.0; HIDDEN];
        let (e, l) = chunk(30, 0, 0.0);
        c.update(&e, &l, &silence, 30, &vec![1.0; 30]);
        assert_eq!((c.embeds.len() / HIDDEN, c.fifo.len() / HIDDEN), (0, 30));
        let mut input = c.embeds();
        let (e2, l2) = chunk(340, 1, 1.0);
        input.extend_from_slice(&e2);
        let mut logits = vec![-6.0f32; 30 * SUB * SPEAKERS];
        logits.extend_from_slice(&l2);
        c.update(&input, &logits, &silence, 340, &vec![1.0; 370]);
        // 370 frames queued: 330 (more than the 300-frame period) move on, 40 stay; 330 > 264 compresses
        assert_eq!(c.fifo.len() / HIDDEN, 40);
        assert_eq!(c.embeds.len() / HIDDEN, CACHE);
        assert!(c.compressed);
    }

    #[test]
    fn a_compressed_cache_keeps_frames_of_every_speaker_and_their_silence_slots() {
        let mut probs = vec![0f32; 400 * SPEAKERS];
        for f in 0..400 {
            probs[f * SPEAKERS + if f < 300 { 0 } else { 1 }] = 0.95;
        }
        let embeds: Vec<f32> = (0..400 * HIDDEN).map(|i| i as f32).collect();
        let (e, p) = compress(&embeds, &probs, &vec![-1.0; HIDDEN]);
        assert_eq!(e.len() / HIDDEN, CACHE);
        let speaker1 = (0..CACHE).filter(|f| p[f * SPEAKERS + 1] > 0.5).count();
        assert!(speaker1 >= floor_rate(0.5), "speaker 1 kept {speaker1} frames");
        let silence = (0..CACHE).filter(|f| e[f * HIDDEN] == -1.0).count();
        assert!(silence >= 1);
    }
}
