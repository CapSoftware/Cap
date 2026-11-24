use std::collections::VecDeque;

use cpal::SampleFormat;

pub const RATE: u32 = 16_000;
const RATE_I64: i64 = RATE as i64;

pub fn ms_to_samples(ms: u64) -> u64 {
    ms.saturating_mul(u64::from(RATE)) / 1000
}

pub fn samples_to_ms(samples: u64) -> u64 {
    samples.saturating_mul(1000) / u64::from(RATE)
}

pub fn seconds_to_samples(seconds: f64) -> i64 {
    (seconds * f64::from(RATE)).round() as i64
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Placement {
    pub pad: u64,
    pub skip: usize,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct AlignStats {
    pub padded_samples: u64,
    pub skipped_samples: u64,
    pub gaps: u64,
    pub drift_corrections: u64,
    pub offset_samples: i64,
}

#[derive(Debug)]
pub struct Aligner {
    written: u64,
    started: bool,
    window: VecDeque<(u64, i64)>,
    window_samples: u64,
    settle_samples: u64,
    tolerance: i64,
    gap: i64,
    stats: AlignStats,
}

impl Default for Aligner {
    fn default() -> Self {
        Self::new(5_000, 1_000, 20, 250)
    }
}

impl Aligner {
    pub fn new(window_ms: u64, settle_ms: u64, tolerance_ms: i64, gap_ms: i64) -> Self {
        Self {
            written: 0,
            started: false,
            window: VecDeque::new(),
            window_samples: ms_to_samples(window_ms),
            settle_samples: ms_to_samples(settle_ms),
            tolerance: tolerance_ms * RATE_I64 / 1000,
            gap: gap_ms * RATE_I64 / 1000,
            stats: AlignStats::default(),
        }
    }

    pub fn written(&self) -> u64 {
        self.written
    }

    pub fn stats(&self) -> AlignStats {
        self.stats
    }

    pub fn place(&mut self, observed_start: i64, len: usize) -> Placement {
        let mut placement = Placement::default();
        if !self.started {
            self.started = true;
            placement.pad = observed_start.max(0) as u64;
            self.advance(placement, len);
            return placement;
        }
        let offset = observed_start - self.written as i64;
        self.stats.offset_samples = offset;
        if offset > self.gap {
            placement.pad = offset as u64;
            self.stats.gaps += 1;
            self.window.clear();
            self.advance(placement, len);
            return placement;
        }
        self.window.push_back((self.written, offset));
        while self
            .window
            .front()
            .is_some_and(|(at, _)| self.written.saturating_sub(*at) > self.window_samples)
        {
            self.window.pop_front();
        }
        let spanned = self
            .window
            .front()
            .map_or(0, |(at, _)| self.written.saturating_sub(*at));
        let floor = self.window.iter().map(|(_, o)| *o).min().unwrap_or(0);
        if spanned >= self.settle_samples || offset < -self.gap {
            let floor = if offset < -self.gap {
                floor.min(offset)
            } else {
                floor
            };
            if floor > self.tolerance {
                placement.pad = floor as u64;
            } else if floor < -self.tolerance {
                placement.skip = ((-floor) as u64).min(len as u64) as usize;
            }
            let shift = placement.pad as i64 - placement.skip as i64;
            if shift != 0 {
                self.stats.drift_corrections += 1;
                for entry in &mut self.window {
                    entry.1 -= shift;
                }
            }
        }
        self.advance(placement, len);
        placement
    }

    fn advance(&mut self, placement: Placement, len: usize) {
        self.stats.padded_samples += placement.pad;
        self.stats.skipped_samples += placement.skip as u64;
        self.written += placement.pad + (len - placement.skip.min(len)) as u64;
    }
}

pub fn decode_interleaved(data: &[u8], format: SampleFormat, out: &mut Vec<f32>) -> bool {
    fn each<const N: usize>(data: &[u8], out: &mut Vec<f32>, f: impl Fn([u8; N]) -> f32) {
        out.extend(data.as_chunks::<N>().0.iter().map(|chunk| f(*chunk)));
    }
    match format {
        SampleFormat::F32 => each::<4>(data, out, f32::from_ne_bytes),
        SampleFormat::F64 => each::<8>(data, out, |b| f64::from_ne_bytes(b) as f32),
        SampleFormat::I8 => each::<1>(data, out, |b| f32::from(b[0] as i8) / 128.0),
        SampleFormat::U8 => each::<1>(data, out, |b| (f32::from(b[0]) - 128.0) / 128.0),
        SampleFormat::I16 => each::<2>(data, out, |b| f32::from(i16::from_ne_bytes(b)) / 32_768.0),
        SampleFormat::U16 => each::<2>(data, out, |b| {
            (f32::from(u16::from_ne_bytes(b)) - 32_768.0) / 32_768.0
        }),
        SampleFormat::I32 => each::<4>(data, out, |b| {
            (f64::from(i32::from_ne_bytes(b)) / 2_147_483_648.0) as f32
        }),
        SampleFormat::U32 => each::<4>(data, out, |b| {
            ((f64::from(u32::from_ne_bytes(b)) - 2_147_483_648.0) / 2_147_483_648.0) as f32
        }),
        SampleFormat::I64 => each::<8>(data, out, |b| {
            (i64::from_ne_bytes(b) as f64 / 9_223_372_036_854_775_808.0) as f32
        }),
        SampleFormat::U64 => each::<8>(data, out, |b| {
            ((u64::from_ne_bytes(b) as f64 - 9_223_372_036_854_775_808.0)
                / 9_223_372_036_854_775_808.0) as f32
        }),
        _ => return false,
    }
    true
}

#[derive(Debug, Default)]
pub struct Level {
    smoothed: f32,
}

impl Level {
    pub fn push(&mut self, samples: &[f32]) -> f32 {
        if samples.is_empty() {
            return self.smoothed;
        }
        let peak = samples.iter().fold(0.0f32, |m, s| m.max(s.abs()));
        let db = 20.0 * peak.max(1e-6).log10();
        let target = ((db + 60.0) / 60.0).clamp(0.0, 1.0);
        self.smoothed = if target > self.smoothed {
            target
        } else {
            self.smoothed * 0.85 + target * 0.15
        };
        self.smoothed
    }

    pub fn value(&self) -> f32 {
        self.smoothed
    }
}
