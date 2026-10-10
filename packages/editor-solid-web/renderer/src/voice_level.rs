//! Browser port of `cap-audio`'s Studio Sound leveling (`voice_level.rs`),
//! which runs FFmpeg filters natively: `ebur128` loudness, `acompressor`, and
//! `alimiter`. The compressor follows FFmpeg's algorithm exactly; loudness
//! follows ITU-R BS.1770; the limiter is a lookahead peak limiter with the
//! same ceiling, attack and release, detecting 4x-oversampled peaks where the
//! native chain limits at 192 kHz.

use std::collections::VecDeque;

use crate::{AudioSampleSource, VoiceEnhancer};

pub const VOICE_PROFILE_SAMPLES: usize = 16 * 48_000;
const SAMPLE_RATE: f64 = 48_000.0;

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct VoiceProfile {
    pub gain_db: f32,
    pub makeup_db: f32,
}

struct ProfileSource<'a, T> {
    source: &'a T,
    frames: usize,
    channels: u16,
}

impl<T: AudioSampleSource> AudioSampleSource for ProfileSource<'_, T> {
    fn channels(&self) -> u16 {
        self.channels
    }
    fn sample_count(&self) -> usize {
        self.frames
    }
    fn sample(&self, index: usize) -> Option<&f32> {
        if index / usize::from(self.channels) < self.frames {
            self.source.sample(index)
        } else {
            None
        }
    }
}

fn threshold(channels: u16) -> f64 {
    if channels == 1 {
        0.125 * std::f64::consts::SQRT_2
    } else {
        0.125
    }
}

impl VoiceProfile {
    pub fn analyze(source: &impl AudioSampleSource) -> Self {
        let channels = source.channels().clamp(1, 2);
        let frames = source.sample_count().min(VOICE_PROFILE_SAMPLES);
        let source = ProfileSource {
            source,
            frames,
            channels,
        };
        let window = frames.min(24_000);
        if window < 480 {
            return Self::default();
        }
        let windows = (frames / window).clamp(1, 8);
        let mut samples = Vec::with_capacity(windows * window * usize::from(channels));
        let mut speech_frames = 0;
        for index in 0..windows {
            let start = if windows == 1 {
                0
            } else {
                (frames - window) * index / (windows - 1)
            };
            let mut enhancer = VoiceEnhancer::new(channels);
            let audio = enhancer.render(&source, start, window);
            speech_frames += enhancer.speech_frames();
            samples.extend_from_slice(audio.samples());
        }
        if speech_frames < 20 {
            return Self::default();
        }
        let Some(level) = integrated_loudness(&samples, channels) else {
            return Self::default();
        };
        if level < -60.0 {
            return Self::default();
        }
        let gain_db = (-16.0 - level).clamp(-12.0, 24.0);
        let mut compressed = samples;
        let gain = db_to_gain(f64::from(gain_db));
        for sample in &mut compressed {
            *sample = (f64::from(*sample) * gain) as f32;
        }
        Compressor::new(channels).process(&mut compressed);
        let compressed = integrated_loudness(&compressed, channels).unwrap_or(-16.0);
        Self {
            gain_db,
            makeup_db: (-16.0 - compressed).clamp(-6.0, 6.0),
        }
    }

    /// The native profile builds an FFmpeg filter string here; the browser
    /// filter reads the two gains back from it.
    pub(crate) fn filter(self, _channels: u16) -> String {
        format!("{} {}", self.gain_db, self.makeup_db)
    }
}

fn db_to_gain(db: f64) -> f64 {
    10f64.powf(db / 20.0)
}

/// ITU-R BS.1770 integrated loudness with absolute and relative gating, as
/// FFmpeg's `ebur128` reports it (each channel weighted 1.0).
fn integrated_loudness(samples: &[f32], channels: u16) -> Option<f32> {
    let channels = usize::from(channels);
    let frames = samples.len() / channels;
    let block = (0.4 * SAMPLE_RATE) as usize;
    let step = (0.1 * SAMPLE_RATE) as usize;
    if frames < block {
        return None;
    }
    let mut filtered = vec![0.0f64; frames * channels];
    for channel in 0..channels {
        let mut shelf = Biquad::new(
            [
                1.535_124_859_586_97,
                -2.691_696_189_406_38,
                1.198_392_810_852_85,
            ],
            [-1.690_659_293_182_41, 0.732_480_774_215_85],
        );
        let mut high_pass = Biquad::new(
            [1.0, -2.0, 1.0],
            [-1.990_047_454_833_98, 0.990_072_250_366_21],
        );
        for frame in 0..frames {
            let value = f64::from(samples[frame * channels + channel]);
            filtered[frame * channels + channel] = high_pass.process(shelf.process(value));
        }
    }
    let mut blocks = Vec::new();
    let mut start = 0;
    while start + block <= frames {
        let mut power = 0.0;
        for channel in 0..channels {
            let mut sum = 0.0;
            for frame in start..start + block {
                let value = filtered[frame * channels + channel];
                sum += value * value;
            }
            power += sum / block as f64;
        }
        blocks.push(power);
        start += step;
    }
    let loudness = |power: f64| -0.691 + 10.0 * power.log10();
    let absolute: Vec<f64> = blocks
        .into_iter()
        .filter(|&power| power > 0.0 && loudness(power) > -70.0)
        .collect();
    if absolute.is_empty() {
        return None;
    }
    let relative_gate = loudness(absolute.iter().sum::<f64>() / absolute.len() as f64) - 10.0;
    let gated: Vec<f64> = absolute
        .into_iter()
        .filter(|&power| loudness(power) > relative_gate)
        .collect();
    if gated.is_empty() {
        return None;
    }
    Some(loudness(gated.iter().sum::<f64>() / gated.len() as f64) as f32)
}

struct Biquad {
    b: [f64; 3],
    a: [f64; 2],
    x: [f64; 2],
    y: [f64; 2],
}

impl Biquad {
    fn new(b: [f64; 3], a: [f64; 2]) -> Self {
        Self {
            b,
            a,
            x: [0.0; 2],
            y: [0.0; 2],
        }
    }

    fn process(&mut self, input: f64) -> f64 {
        let output = self.b[0] * input + self.b[1] * self.x[0] + self.b[2] * self.x[1]
            - self.a[0] * self.y[0]
            - self.a[1] * self.y[1];
        self.x = [input, self.x[0]];
        self.y = [output, self.y[0]];
        output
    }
}

/// FFmpeg `acompressor` (`af_sidechaincompress.c`) with Studio Sound's
/// settings: RMS detection, averaged channel link, ratio 2, attack 15 ms,
/// release 180 ms, knee 2.828, makeup 1, mix 1.
struct Compressor {
    channels: usize,
    lin_slope: f64,
    thres: f64,
    ratio: f64,
    knee: f64,
    knee_start: f64,
    knee_stop: f64,
    compressed_knee_stop: f64,
    adj_knee_start: f64,
    attack_coeff: f64,
    release_coeff: f64,
}

impl Compressor {
    fn new(channels: u16) -> Self {
        let threshold = threshold(channels);
        let ratio = 2.0;
        let knee: f64 = 2.828;
        let attack = 15.0;
        let release = 180.0;
        let thres = threshold.ln();
        let lin_knee_start = threshold / knee.sqrt();
        let lin_knee_stop = threshold * knee.sqrt();
        let knee_start = lin_knee_start.ln();
        let knee_stop = lin_knee_stop.ln();
        Self {
            channels: usize::from(channels),
            lin_slope: 0.0,
            thres,
            ratio,
            knee,
            knee_start,
            knee_stop,
            compressed_knee_stop: (knee_stop - thres) / ratio + thres,
            adj_knee_start: lin_knee_start * lin_knee_start,
            attack_coeff: (1.0 / (attack * SAMPLE_RATE / 4000.0)).min(1.0),
            release_coeff: (1.0 / (release * SAMPLE_RATE / 4000.0)).min(1.0),
        }
    }

    fn hermite(x: f64, x0: f64, x1: f64, p0: f64, p1: f64, m0: f64, m1: f64) -> f64 {
        let width = x1 - x0;
        let t = (x - x0) / width;
        let (m0, m1) = (m0 * width, m1 * width);
        let (t2, t3) = (t * t, t * t * t);
        let ct0 = p0;
        let ct1 = m0;
        let ct2 = -3.0 * p0 - 2.0 * m0 + 3.0 * p1 - m1;
        let ct3 = 2.0 * p0 + m0 - 2.0 * p1 + m1;
        ct3 * t3 + ct2 * t2 + ct1 * t + ct0
    }

    fn output_gain(&self) -> f64 {
        let slope = self.lin_slope.ln() * 0.5;
        let delta = 1.0 / self.ratio;
        let mut gain = (slope - self.thres) / self.ratio + self.thres;
        if self.knee > 1.0 && slope < self.knee_stop {
            gain = Self::hermite(
                slope,
                self.knee_start,
                self.knee_stop,
                self.knee_start,
                self.compressed_knee_stop,
                1.0,
                delta,
            );
        }
        (gain - slope).exp()
    }

    fn process(&mut self, samples: &mut [f32]) {
        for frame in samples.chunks_exact_mut(self.channels) {
            let mut detected = 0.0;
            for &sample in frame.iter() {
                detected += f64::from(sample).abs();
            }
            detected /= self.channels as f64;
            detected *= detected;
            let coeff = if detected > self.lin_slope {
                self.attack_coeff
            } else {
                self.release_coeff
            };
            self.lin_slope += (detected - self.lin_slope) * coeff;
            let gain = if self.lin_slope > 0.0 && self.lin_slope > self.adj_knee_start {
                self.output_gain()
            } else {
                1.0
            };
            for sample in frame.iter_mut() {
                *sample = (f64::from(*sample) * gain) as f32;
            }
        }
    }
}

/// Lookahead peak limiter (ceiling 0.841395, 5 ms attack, 80 ms release,
/// latency compensated) with 4x-oversampled peak detection.
struct Limiter {
    channels: usize,
    lookahead: usize,
    delay: VecDeque<f32>,
    required: VecDeque<f64>,
    gain: f64,
    release_coeff: f64,
    previous: Vec<f32>,
    skipped: usize,
}

impl Limiter {
    const LIMIT: f64 = 0.841_395;

    fn new(channels: u16) -> Self {
        let lookahead = (0.005 * SAMPLE_RATE) as usize;
        Self {
            channels: usize::from(channels),
            lookahead,
            delay: VecDeque::new(),
            required: VecDeque::new(),
            gain: 1.0,
            release_coeff: (-1.0 / (0.08 * SAMPLE_RATE)).exp(),
            previous: vec![0.0; usize::from(channels)],
            skipped: 0,
        }
    }

    fn peak(&mut self, frame: &[f32]) -> f64 {
        let mut peak = 0.0f64;
        for (channel, &value) in frame.iter().enumerate() {
            let previous = f64::from(self.previous[channel]);
            let current = f64::from(value);
            for step in 0..4 {
                let t = f64::from(step) / 4.0;
                peak = peak.max((previous + (current - previous) * t).abs());
            }
            self.previous[channel] = value;
        }
        peak
    }

    fn process(&mut self, input: &[f32], output: &mut VecDeque<f32>) {
        for frame in input.chunks_exact(self.channels) {
            let peak = self.peak(frame);
            self.required.push_back(if peak > Self::LIMIT {
                Self::LIMIT / peak
            } else {
                1.0
            });
            self.delay.extend(frame.iter().copied());
            if self.required.len() <= self.lookahead {
                continue;
            }
            let target = self.required.iter().copied().fold(1.0, f64::min);
            self.gain = if target < self.gain {
                self.gain + (target - self.gain) / self.lookahead as f64
            } else {
                target + (self.gain - target) * self.release_coeff
            };
            let gain = self.gain.min(*self.required.front().unwrap_or(&1.0));
            self.required.pop_front();
            if self.skipped < self.lookahead {
                self.skipped += 1;
                for _ in 0..self.channels {
                    self.delay.pop_front();
                }
                continue;
            }
            for _ in 0..self.channels {
                let sample = self.delay.pop_front().unwrap_or(0.0);
                output.push_back((f64::from(sample) * gain) as f32);
            }
        }
    }
}

pub(crate) struct VoiceFilter {
    gain: f64,
    makeup: f64,
    compressor: Compressor,
    limiter: Limiter,
    scratch: Vec<f32>,
}

impl VoiceFilter {
    pub(crate) fn new(channels: u16, processing: &str) -> Result<Self, String> {
        let mut values = processing.split(' ').map(str::parse::<f64>);
        let (Some(Ok(gain_db)), Some(Ok(makeup_db))) = (values.next(), values.next()) else {
            return Err("Studio Sound leveling settings are invalid".to_owned());
        };
        Ok(Self {
            gain: db_to_gain(gain_db),
            makeup: db_to_gain(makeup_db),
            compressor: Compressor::new(channels),
            limiter: Limiter::new(channels),
            scratch: Vec::new(),
        })
    }

    pub(crate) fn process(
        &mut self,
        samples: &[f32],
        output: &mut VecDeque<f32>,
    ) -> Result<(), String> {
        self.scratch.clear();
        self.scratch.extend(
            samples
                .iter()
                .map(|&sample| (f64::from(sample) * self.gain) as f32),
        );
        self.compressor.process(&mut self.scratch);
        for sample in &mut self.scratch {
            *sample = (f64::from(*sample) * self.makeup) as f32;
        }
        self.limiter.process(&self.scratch, output);
        Ok(())
    }
}
