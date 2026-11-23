use std::sync::Arc;

use realfft::{RealFftPlanner, RealToComplex, num_complex::Complex32};

pub const SAMPLE_RATE: usize = 16_000;
pub const NUM_BINS: usize = 80;
const FRAME_LEN: usize = 400;
const FRAME_SHIFT: usize = 160;
const FFT_LEN: usize = 512;
const PREEMPHASIS: f32 = 0.97;
const LOW_HZ: f32 = 20.0;

#[cfg(test)]
mod tests;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Window {
    #[default]
    Povey,
    Hamming,
}

/// Log mel filterbank features computed the way the speaker models were
/// trained: 25 ms windows every 10 ms, DC removal, pre-emphasis, a 512-point
/// power spectrum and 80 triangular mel bins from 20 Hz to Nyquist, with
/// frames snipped to the edges and no dither.
pub struct Fbank {
    window: Vec<f32>,
    banks: Vec<(usize, Vec<f32>)>,
    fft: Arc<dyn RealToComplex<f32>>,
    frame: Vec<f32>,
    spectrum: Vec<Complex32>,
    scratch: Vec<Complex32>,
    power: Vec<f32>,
}

impl Default for Fbank {
    fn default() -> Self {
        Self::new(Window::Povey)
    }
}

impl Fbank {
    pub fn new(window: Window) -> Self {
        let window = (0..FRAME_LEN)
            .map(|i| {
                let a = 2.0 * std::f64::consts::PI * i as f64 / (FRAME_LEN - 1) as f64;
                match window {
                    Window::Povey => (0.5 - 0.5 * a.cos()).powf(0.85) as f32,
                    Window::Hamming => (0.54 - 0.46 * a.cos()) as f32,
                }
            })
            .collect();
        let fft = RealFftPlanner::<f32>::new().plan_fft_forward(FFT_LEN);
        let spectrum = fft.make_output_vec();
        let scratch = fft.make_scratch_vec();
        Self {
            window,
            banks: mel_banks(),
            fft,
            frame: vec![0.0; FFT_LEN],
            spectrum,
            scratch,
            power: vec![0.0; FFT_LEN / 2 + 1],
        }
    }

    pub fn frames(samples: usize) -> usize {
        if samples < FRAME_LEN {
            0
        } else {
            1 + (samples - FRAME_LEN) / FRAME_SHIFT
        }
    }

    /// Appends `frames(samples.len()) * NUM_BINS` values to `out`, scaling the
    /// samples by `scale` first, and subtracts the per-bin mean over the
    /// frames when `mean_normalize` is set.
    pub fn compute(
        &mut self,
        samples: &[f32],
        scale: f32,
        mean_normalize: bool,
        out: &mut Vec<f32>,
    ) {
        let frames = Self::frames(samples.len());
        let base = out.len();
        out.reserve(frames * NUM_BINS);
        for f in 0..frames {
            let chunk = &samples[f * FRAME_SHIFT..f * FRAME_SHIFT + FRAME_LEN];
            let mean = chunk.iter().sum::<f32>() * scale / FRAME_LEN as f32;
            for (dst, &s) in self.frame.iter_mut().zip(chunk) {
                *dst = s * scale - mean;
            }
            for i in (1..FRAME_LEN).rev() {
                self.frame[i] -= PREEMPHASIS * self.frame[i - 1];
            }
            self.frame[0] -= PREEMPHASIS * self.frame[0];
            for (x, w) in self.frame.iter_mut().zip(&self.window) {
                *x *= w;
            }
            self.frame[FRAME_LEN..].fill(0.0);
            if self
                .fft
                .process_with_scratch(&mut self.frame, &mut self.spectrum, &mut self.scratch)
                .is_err()
            {
                out.extend(std::iter::repeat_n(f32::EPSILON.ln(), NUM_BINS));
                continue;
            }
            for (p, c) in self.power.iter_mut().zip(&self.spectrum) {
                *p = c.norm_sqr();
            }
            for (first, weights) in &self.banks {
                let energy: f32 = weights
                    .iter()
                    .zip(&self.power[*first..])
                    .map(|(w, p)| w * p)
                    .sum();
                out.push(energy.max(f32::EPSILON).ln());
            }
        }
        if mean_normalize && frames > 0 {
            let mut mean = [0f32; NUM_BINS];
            for row in out[base..].as_chunks::<NUM_BINS>().0 {
                for (m, v) in mean.iter_mut().zip(row) {
                    *m += v;
                }
            }
            for m in &mut mean {
                *m /= frames as f32;
            }
            for row in out[base..].as_chunks_mut::<NUM_BINS>().0 {
                for (v, m) in row.iter_mut().zip(&mean) {
                    *v -= m;
                }
            }
        }
    }
}

fn mel(hz: f32) -> f32 {
    1127.0 * (1.0 + hz / 700.0).ln()
}

fn mel_banks() -> Vec<(usize, Vec<f32>)> {
    let bin_hz = SAMPLE_RATE as f32 / FFT_LEN as f32;
    let low = mel(LOW_HZ);
    let high = mel(SAMPLE_RATE as f32 / 2.0);
    let delta = (high - low) / (NUM_BINS + 1) as f32;
    (0..NUM_BINS)
        .map(|m| {
            let left = low + m as f32 * delta;
            let center = left + delta;
            let right = center + delta;
            let mut first = None;
            let mut weights = Vec::new();
            for i in 0..FFT_LEN / 2 {
                let x = mel(bin_hz * i as f32);
                let w = if x > left && x < right {
                    if x <= center {
                        (x - left) / (center - left)
                    } else {
                        (right - x) / (right - center)
                    }
                } else {
                    0.0
                };
                if w > 0.0 {
                    first.get_or_insert(i);
                    weights.push(w);
                } else if first.is_some() {
                    break;
                }
            }
            (first.unwrap_or(0), weights)
        })
        .collect()
}
