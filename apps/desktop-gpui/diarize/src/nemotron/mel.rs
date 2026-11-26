//! Log-mel features of Nemotron 3 Diarization, computed as audio arrives.
//!
//! Matches the model's own feature extractor (a centred pass over the whole
//! stream): pre-emphasis 0.97, a 400-sample symmetric Hann window inside a
//! 512-point FFT every 160 samples, the zero padding of a centred STFT, the
//! power spectrum, 128 Slaney mel filters and `ln(x + 2^-24)`, no
//! normalisation. A centred pass yields `samples / 160 + 1` frames; the
//! extractor zeroes the last one and marks it as padding, and so does
//! [`StreamingMel::finish`].

use std::sync::Arc;

use realfft::{RealFftPlanner, RealToComplex};

pub const SAMPLE_RATE: usize = 16_000;
pub const HOP: usize = 160;
pub const N_FFT: usize = 512;
pub const WIN: usize = 400;
pub const N_MELS: usize = 128;
const PREEMPH: f32 = 0.97;
const LOG_GUARD: f32 = 5.960_464_5e-8; // 2^-24
const BINS: usize = N_FFT / 2 + 1;

/// Slaney-scale mel filters with Slaney normalisation, `N_MELS` rows of `BINS`.
fn mel_filters() -> Vec<f32> {
    fn hz_to_mel(f: f64) -> f64 {
        if f >= 1000.0 {
            15.0 + (f / 1000.0).ln() / (6.4f64.ln() / 27.0)
        } else {
            f / (200.0 / 3.0)
        }
    }
    fn mel_to_hz(m: f64) -> f64 {
        if m >= 15.0 {
            1000.0 * ((6.4f64.ln() / 27.0) * (m - 15.0)).exp()
        } else {
            m * (200.0 / 3.0)
        }
    }
    let top = hz_to_mel(SAMPLE_RATE as f64 / 2.0);
    let points: Vec<f64> = (0..N_MELS + 2)
        .map(|i| mel_to_hz(top * i as f64 / (N_MELS + 1) as f64))
        .collect();
    let mut fb = vec![0f32; N_MELS * BINS];
    for m in 0..N_MELS {
        let (lo, mid, hi) = (points[m], points[m + 1], points[m + 2]);
        let norm = 2.0 / (hi - lo);
        for b in 0..BINS {
            let f = b as f64 * (SAMPLE_RATE as f64 / 2.0) / (BINS - 1) as f64;
            let up = (f - lo) / (mid - lo);
            let down = (hi - f) / (hi - mid);
            let w = up.min(down).max(0.0) * norm;
            fb[m * BINS + b] = w as f32;
        }
    }
    fb
}

/// Symmetric Hann window of `WIN` samples, centred in `N_FFT`.
fn window() -> Vec<f32> {
    let mut w = vec![0f32; N_FFT];
    let off = (N_FFT - WIN) / 2;
    for i in 0..WIN {
        let v = 0.5 - 0.5 * (2.0 * std::f64::consts::PI * i as f64 / (WIN - 1) as f64).cos();
        w[off + i] = v as f32;
    }
    w
}

pub struct StreamingMel {
    fft: Arc<dyn RealToComplex<f32>>,
    filters: Vec<f32>,
    window: Vec<f32>,
    /// Pre-emphasised samples of the centred stream (its `N_FFT / 2` leading
    /// zeros included) from absolute sample `buf_start` on.
    buf: Vec<f32>,
    buf_start: usize,
    prev: f32,
    received: usize,
    next_frame: usize,
    finished: bool,
    scratch_in: Vec<f32>,
    scratch_out: Vec<realfft::num_complex::Complex<f32>>,
}

impl Default for StreamingMel {
    fn default() -> Self {
        Self::new()
    }
}

impl StreamingMel {
    pub fn new() -> Self {
        let fft = RealFftPlanner::<f32>::new().plan_fft_forward(N_FFT);
        let scratch_in = fft.make_input_vec();
        let scratch_out = fft.make_output_vec();
        Self {
            fft,
            filters: mel_filters(),
            window: window(),
            buf: vec![0.0; N_FFT / 2],
            buf_start: 0,
            prev: 0.0,
            received: 0,
            next_frame: 0,
            finished: false,
            scratch_in,
            scratch_out,
        }
    }

    /// Frames produced so far.
    pub fn frames(&self) -> usize {
        self.next_frame
    }

    /// Appends audio and writes every frame it completes to `out`
    /// (`N_MELS` values per frame).
    pub fn push(&mut self, samples: &[f32], out: &mut Vec<f32>) {
        debug_assert!(!self.finished);
        self.buf.reserve(samples.len());
        for &x in samples {
            let y = if self.received == 0 { x } else { x - PREEMPH * self.prev };
            self.prev = x;
            self.received += 1;
            self.buf.push(y);
        }
        self.drain(out);
    }

    /// Ends the stream: the trailing zero padding, the remaining frames, and
    /// the extra last frame zeroed. Returns the number of real frames
    /// (`samples / HOP`); the total written is one more.
    pub fn finish(&mut self, out: &mut Vec<f32>) -> usize {
        self.finished = true;
        let valid = self.received / HOP;
        self.buf.extend(std::iter::repeat_n(0.0, N_FFT / 2));
        let total = valid + 1;
        while self.next_frame < total {
            if self.next_frame == valid {
                out.extend(std::iter::repeat_n(0.0, N_MELS));
                self.next_frame += 1;
            } else {
                self.frame(out);
            }
        }
        valid
    }

    fn drain(&mut self, out: &mut Vec<f32>) {
        // frame f reads centred samples [HOP f, HOP f + N_FFT)
        while (self.next_frame * HOP + N_FFT) <= self.buf_start + self.buf.len() {
            self.frame(out);
        }
        let keep_from = self.next_frame * HOP;
        if keep_from > self.buf_start + 4 * N_FFT {
            let cut = keep_from - self.buf_start;
            self.buf.drain(..cut);
            self.buf_start = keep_from;
        }
    }

    fn frame(&mut self, out: &mut Vec<f32>) {
        let at = self.next_frame * HOP - self.buf_start;
        for i in 0..N_FFT {
            self.scratch_in[i] = self.buf.get(at + i).copied().unwrap_or(0.0) * self.window[i];
        }
        self.fft
            .process(&mut self.scratch_in, &mut self.scratch_out)
            .expect("fft sizes are fixed");
        let mut power = [0f32; BINS];
        for (p, c) in power.iter_mut().zip(self.scratch_out.iter()) {
            *p = c.re * c.re + c.im * c.im;
        }
        for m in 0..N_MELS {
            let row = &self.filters[m * BINS..(m + 1) * BINS];
            let e: f32 = row.iter().zip(power.iter()).map(|(w, p)| w * p).sum();
            out.push((e + LOG_GUARD).ln());
        }
        self.next_frame += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn whole(samples: &[f32]) -> (Vec<f32>, usize) {
        let mut m = StreamingMel::new();
        let mut out = Vec::new();
        m.push(samples, &mut out);
        let valid = m.finish(&mut out);
        (out, valid)
    }

    #[test]
    fn a_centred_pass_has_one_frame_per_hop_plus_a_zeroed_last_frame() {
        let x: Vec<f32> = (0..16_000).map(|i| ((i as f32) * 0.05).sin() * 0.3).collect();
        let (out, valid) = whole(&x);
        assert_eq!(valid, 100);
        assert_eq!(out.len(), 101 * N_MELS);
        assert!(out[100 * N_MELS..].iter().all(|v| *v == 0.0));
        assert!(out[..N_MELS].iter().all(|v| v.is_finite()));
    }

    #[test]
    fn features_do_not_depend_on_how_the_audio_is_split() {
        let x: Vec<f32> = (0..48_123).map(|i| ((i as f32) * 0.013).sin() * ((i % 97) as f32 / 97.0)).collect();
        let (all, _) = whole(&x);
        let mut m = StreamingMel::new();
        let mut out = Vec::new();
        for chunk in x.chunks(1_777) {
            m.push(chunk, &mut out);
        }
        m.finish(&mut out);
        assert_eq!(all.len(), out.len());
        let max = all.iter().zip(&out).map(|(a, b)| (a - b).abs()).fold(0f32, f32::max);
        assert!(max < 1e-5, "max difference {max}");
    }

    #[test]
    fn silence_is_the_log_guard() {
        let (out, _) = whole(&vec![0.0; 3_200]);
        assert!((out[0] - LOG_GUARD.ln()).abs() < 1e-4);
    }
}
