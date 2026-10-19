//! Audio markers.
//!
//! A marker is a 20 ms linear chirp (the sync symbol, located to a fraction
//! of a sample by cross-correlation) followed by 20 FSK bits of 5 ms each: a
//! 12-bit marker index and a CRC-8. Each source (microphone, system audio,
//! media track) has its own chirp direction/band and its own pair of bit
//! tones, so markers from different sources can be located independently in
//! a mix. The chirp start is the marker's reference position.

use rustfft::{FftPlanner, num_complex::Complex32};
use serde::{Deserialize, Serialize};

pub const CHIRP_SECS: f64 = 0.020;
pub const BIT_SECS: f64 = 0.005;
pub const INDEX_BITS: u32 = 12;
const CRC_BITS: u32 = 8;
const PAYLOAD_BITS: u32 = INDEX_BITS + CRC_BITS;
pub const MARKER_SECS: f64 = CHIRP_SECS + PAYLOAD_BITS as f64 * BIT_SECS;
pub const MAX_AUDIO_INDEX: u32 = (1 << INDEX_BITS) - 1;
pub const DEFAULT_AMPLITUDE: f32 = 0.3;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AudioSource {
    Mic,
    System,
    Media,
}

struct SourceParams {
    chirp_from: f64,
    chirp_to: f64,
    bit_zero: f64,
    bit_one: f64,
}

impl AudioSource {
    pub const ALL: [AudioSource; 3] = [AudioSource::Mic, AudioSource::System, AudioSource::Media];

    fn params(self) -> SourceParams {
        match self {
            AudioSource::Mic => SourceParams {
                chirp_from: 600.0,
                chirp_to: 3600.0,
                bit_zero: 1000.0,
                bit_one: 1600.0,
            },
            AudioSource::System => SourceParams {
                chirp_from: 3600.0,
                chirp_to: 600.0,
                bit_zero: 2200.0,
                bit_one: 2800.0,
            },
            AudioSource::Media => SourceParams {
                chirp_from: 1200.0,
                chirp_to: 4800.0,
                bit_zero: 3400.0,
                bit_one: 4000.0,
            },
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            AudioSource::Mic => "mic",
            AudioSource::System => "system",
            AudioSource::Media => "media",
        }
    }

    /// Phase of this source's markers as a fraction of the schedule period,
    /// so sources recorded together never overlap.
    fn schedule_phase_secs(self) -> f64 {
        match self {
            AudioSource::Mic => 0.0,
            AudioSource::System => 1.0 / 3.0,
            AudioSource::Media => 2.0 / 3.0,
        }
    }
}

fn crc8(value: u32) -> u8 {
    let mut crc: u8 = 0;
    for byte in value.to_le_bytes().iter().take(2) {
        crc ^= byte;
        for _ in 0..8 {
            crc = if crc & 0x80 != 0 {
                (crc << 1) ^ 0x07
            } else {
                crc << 1
            };
        }
    }
    crc
}

fn payload_bits(index: u32) -> u32 {
    index | (u32::from(crc8(index)) << INDEX_BITS)
}

fn hann(i: usize, n: usize) -> f64 {
    if n <= 1 {
        return 1.0;
    }
    0.5 - 0.5 * (2.0 * std::f64::consts::PI * i as f64 / (n - 1) as f64).cos()
}

/// Short raised-cosine fade at both ends of a symbol to avoid clicks.
fn edge_taper(i: usize, n: usize, ramp: usize) -> f64 {
    let ramp = ramp.min(n / 2).max(1);
    if i < ramp {
        0.5 - 0.5 * (std::f64::consts::PI * i as f64 / ramp as f64).cos()
    } else if i >= n - ramp {
        let k = n - 1 - i;
        0.5 - 0.5 * (std::f64::consts::PI * k as f64 / ramp as f64).cos()
    } else {
        1.0
    }
}

fn chirp(source: AudioSource, sample_rate: u32) -> Vec<f32> {
    let p = source.params();
    let n = (CHIRP_SECS * f64::from(sample_rate)).round() as usize;
    let rate = f64::from(sample_rate);
    let k = (p.chirp_to - p.chirp_from) / CHIRP_SECS;
    let ramp = (0.002 * rate) as usize;
    (0..n)
        .map(|i| {
            let t = i as f64 / rate;
            let phase = 2.0 * std::f64::consts::PI * (p.chirp_from * t + 0.5 * k * t * t);
            (phase.sin() * edge_taper(i, n, ramp)) as f32
        })
        .collect()
}

/// Marker waveform at unit amplitude, starting with the chirp.
pub fn marker_waveform(source: AudioSource, index: u32, sample_rate: u32) -> Vec<f32> {
    assert!(
        index <= MAX_AUDIO_INDEX,
        "audio marker index {index} too large"
    );
    let p = source.params();
    let rate = f64::from(sample_rate);
    let mut out = chirp(source, sample_rate);
    let bits = payload_bits(index);
    let chirp_len = out.len();
    let ramp = (0.0008 * rate) as usize;
    for bit in 0..PAYLOAD_BITS {
        let start = chirp_len + (f64::from(bit) * BIT_SECS * rate).round() as usize;
        let end = chirp_len + (f64::from(bit + 1) * BIT_SECS * rate).round() as usize;
        let freq = if bits >> bit & 1 == 1 {
            p.bit_one
        } else {
            p.bit_zero
        };
        out.resize(end, 0.0);
        let n = end - start;
        for (i, sample) in out[start..end].iter_mut().enumerate() {
            let t = (start + i) as f64 / rate;
            *sample =
                ((2.0 * std::f64::consts::PI * freq * t).sin() * edge_taper(i, n, ramp)) as f32;
        }
    }
    out
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct MarkerPlacement {
    pub index: u32,
    /// Chirp start, in seconds from the start of the source track.
    pub time_secs: f64,
}

/// Deterministic marker schedule: one marker per `period_secs`, offset by a
/// per-source phase and a small per-index jitter so a whole-period shift can
/// never alias to a zero error.
pub fn standard_schedule(
    source: AudioSource,
    start_secs: f64,
    duration_secs: f64,
    period_secs: f64,
) -> Vec<MarkerPlacement> {
    let mut out = Vec::new();
    let mut index = 0u32;
    loop {
        let jitter = (u64::from(index).wrapping_mul(2_654_435_761) % 97) as f64 / 97.0
            * (period_secs / 3.0 - MARKER_SECS).max(0.0);
        let t = start_secs
            + source.schedule_phase_secs() * period_secs
            + f64::from(index) * period_secs
            + jitter;
        if t + MARKER_SECS > start_secs + duration_secs || index > MAX_AUDIO_INDEX {
            break;
        }
        out.push(MarkerPlacement {
            index,
            time_secs: t,
        });
        index += 1;
    }
    out
}

/// Mixes markers into `out` (mono) at `amplitude`. Placement times are in
/// seconds from sample 0 of `out`.
pub fn render_markers(
    out: &mut [f32],
    sample_rate: u32,
    source: AudioSource,
    placements: &[MarkerPlacement],
    amplitude: f32,
) {
    for placement in placements {
        let start = (placement.time_secs * f64::from(sample_rate)).round() as isize;
        let wave = marker_waveform(source, placement.index, sample_rate);
        for (i, v) in wave.iter().enumerate() {
            let at = start + i as isize;
            if at >= 0
                && let Some(sample) = out.get_mut(at as usize)
            {
                *sample += v * amplitude;
            }
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct LocatedMarker {
    pub source: AudioSource,
    /// `None` when the chirp was found but the payload did not decode.
    pub index: Option<u32>,
    /// Chirp start in seconds from the first analysed sample.
    pub time_secs: f64,
    /// Estimated amplitude relative to a unit-amplitude marker.
    pub gain: f64,
    /// Normalised correlation of the chirp (1.0 = exact shape).
    pub correlation: f64,
}

const MIN_CORRELATION: f64 = 0.55;
/// Quieter than this (RMS over a chirp, -80 dBFS) is silence. Correlation is
/// normalised, so without a floor an encoder's rounding noise passes for a
/// chirp: AudioToolbox AAC leaves -141 dBFS between markers, which decoded
/// as a CRC-valid index 0 (Verify recording, recording/studio-screen/gated).
const SILENCE_RMS: f64 = 1e-4;

/// Finds every marker of `source` in a mono signal.
pub fn locate_markers(
    samples: &[f32],
    sample_rate: u32,
    source: AudioSource,
) -> Vec<LocatedMarker> {
    let template = chirp(source, sample_rate);
    let m = template.len();
    if samples.len() < m || m == 0 {
        return Vec::new();
    }
    let corr = cross_correlate(samples, &template);
    let template_energy: f64 = template.iter().map(|v| f64::from(*v).powi(2)).sum();
    let mut prefix = Vec::with_capacity(samples.len() + 1);
    prefix.push(0.0f64);
    for v in samples {
        let last = *prefix.last().unwrap_or(&0.0);
        prefix.push(last + f64::from(*v).powi(2));
    }
    let lags = samples.len() - m + 1;
    let norm = |lag: usize| -> f64 {
        let energy = prefix[lag + m] - prefix[lag];
        if energy <= SILENCE_RMS * SILENCE_RMS * m as f64 {
            0.0
        } else {
            corr[lag] / (energy * template_energy).sqrt()
        }
    };
    let suppress = (MARKER_SECS * 0.8 * f64::from(sample_rate)) as usize;
    let mut out = Vec::new();
    let mut lag = 0;
    while lag < lags {
        let c = norm(lag);
        if c < MIN_CORRELATION {
            lag += 1;
            continue;
        }
        // Take the best peak in the neighbourhood.
        let end = (lag + suppress).min(lags);
        let (best, best_c) = (lag..end)
            .map(|l| (l, norm(l)))
            .fold((lag, c), |acc, x| if x.1 > acc.1 { x } else { acc });
        let refined = refine_peak(&corr, best);
        let gain = corr[best] / template_energy;
        let time_secs = refined / f64::from(sample_rate);
        let index = decode_payload(samples, sample_rate, source, refined);
        out.push(LocatedMarker {
            source,
            index,
            time_secs,
            gain,
            correlation: best_c,
        });
        lag = best + suppress;
    }
    out
}

/// Identifies markers whose chirp was found but whose payload did not
/// decode, by their timing pattern: the schedule's per-index jitter makes
/// the gaps between markers unique, so one constant shift maps the chirps
/// onto the expected times. Returns `(index, chirp time)` pairs, or `None`
/// unless a single shift places at least three chirps within `tolerance`
/// of an expected marker and no other shift places as many.
pub fn identify_by_schedule(
    expected: &[(u32, f64)],
    chirps: &[f64],
    tolerance: f64,
) -> Option<Vec<(u32, f64)>> {
    let pairs = |shift: f64| -> Vec<(u32, f64)> {
        chirps
            .iter()
            .filter_map(|&c| {
                expected
                    .iter()
                    .find(|&&(_, t)| (c - shift - t).abs() <= tolerance)
                    .map(|&(index, _)| (index, c))
            })
            .collect()
    };
    let mut scored: Vec<(usize, f64)> = Vec::new();
    for &c in chirps {
        for &(_, t) in expected {
            let shift = c - t;
            if scored.iter().any(|&(_, s)| (s - shift).abs() <= tolerance) {
                continue;
            }
            scored.push((pairs(shift).len(), shift));
        }
    }
    scored.sort_by(|a, b| b.0.cmp(&a.0));
    let &(best, shift) = scored.first()?;
    let runner_up = scored.get(1).map_or(0, |s| s.0);
    (best >= 3 && runner_up < best).then(|| pairs(shift))
}

fn refine_peak(corr: &[f64], at: usize) -> f64 {
    if at == 0 || at + 1 >= corr.len() {
        return at as f64;
    }
    let (a, b, c) = (corr[at - 1], corr[at], corr[at + 1]);
    let denom = a - 2.0 * b + c;
    if denom.abs() < 1e-12 {
        return at as f64;
    }
    at as f64 + (0.5 * (a - c) / denom).clamp(-0.5, 0.5)
}

fn goertzel_power(samples: &[f32], start: usize, len: usize, rate: f64, freq: f64) -> f64 {
    let w = 2.0 * std::f64::consts::PI * freq / rate;
    let coeff = 2.0 * w.cos();
    let (mut s1, mut s2) = (0.0f64, 0.0f64);
    for i in 0..len {
        let x = f64::from(samples[start + i]) * hann(i, len);
        let s = x + coeff * s1 - s2;
        s2 = s1;
        s1 = s;
    }
    s1 * s1 + s2 * s2 - coeff * s1 * s2
}

fn decode_payload(
    samples: &[f32],
    sample_rate: u32,
    source: AudioSource,
    chirp_start: f64,
) -> Option<u32> {
    let p = source.params();
    let rate = f64::from(sample_rate);
    let chirp_len = (CHIRP_SECS * rate).round();
    let mut bits = 0u32;
    for bit in 0..PAYLOAD_BITS {
        let start = chirp_start + chirp_len + (f64::from(bit) * BIT_SECS * rate);
        let len = (BIT_SECS * rate).round() as usize;
        // Analyse the middle 80% of the bit to skip the transitions.
        let guard = len / 10;
        let start = start.round() as isize + guard as isize;
        let len = len - 2 * guard;
        if start < 0 || start as usize + len > samples.len() {
            return None;
        }
        let zero = goertzel_power(samples, start as usize, len, rate, p.bit_zero);
        let one = goertzel_power(samples, start as usize, len, rate, p.bit_one);
        let (hi, lo) = if one > zero { (one, zero) } else { (zero, one) };
        if hi < lo * 4.0 {
            return None;
        }
        if one > zero {
            bits |= 1 << bit;
        }
    }
    let index = bits & MAX_AUDIO_INDEX;
    (payload_bits(index) == bits).then_some(index)
}

fn cross_correlate(signal: &[f32], template: &[f32]) -> Vec<f64> {
    let n = signal.len() + template.len();
    let size = n.next_power_of_two();
    let mut planner = FftPlanner::<f32>::new();
    let fft = planner.plan_fft_forward(size);
    let ifft = planner.plan_fft_inverse(size);
    let mut a: Vec<Complex32> = signal
        .iter()
        .map(|&v| Complex32::new(v, 0.0))
        .chain(std::iter::repeat(Complex32::new(0.0, 0.0)))
        .take(size)
        .collect();
    let mut b: Vec<Complex32> = template
        .iter()
        .map(|&v| Complex32::new(v, 0.0))
        .chain(std::iter::repeat(Complex32::new(0.0, 0.0)))
        .take(size)
        .collect();
    fft.process(&mut a);
    fft.process(&mut b);
    for (x, y) in a.iter_mut().zip(&b) {
        *x *= y.conj();
    }
    ifft.process(&mut a);
    let scale = 1.0 / size as f64;
    a.iter()
        .take(signal.len())
        .map(|c| f64::from(c.re) * scale)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn markers_at_rounding_noise_level_are_silence() {
        let rate = 48_000;
        let wave = marker_waveform(AudioSource::Mic, 0, rate);
        for (scale, found) in [(1e-7f32, 0), (1e-3, 1)] {
            let mut signal = vec![0.0f32; rate as usize];
            for (i, v) in wave.iter().enumerate() {
                signal[rate as usize / 4 + i] = v * scale;
            }
            assert_eq!(
                locate_markers(&signal, rate, AudioSource::Mic).len(),
                found,
                "marker scaled by {scale}"
            );
        }
    }

    #[test]
    fn locates_markers_of_each_source_in_a_mix() {
        let rate = 48_000;
        let secs = 6.0;
        let mut mix = vec![0.0f32; (secs * f64::from(rate)) as usize];
        let mut expected = Vec::new();
        for source in AudioSource::ALL {
            let schedule = standard_schedule(source, 0.1, secs - 0.2, 0.5);
            render_markers(&mut mix, rate, source, &schedule, 0.2);
            expected.push((source, schedule));
        }
        for (source, schedule) in expected {
            let found = locate_markers(&mix, rate, source);
            assert_eq!(found.len(), schedule.len(), "{source:?}");
            for (f, e) in found.iter().zip(&schedule) {
                assert_eq!(f.index, Some(e.index));
                assert!((f.time_secs - e.time_secs).abs() < 1.0 / f64::from(rate));
                assert!((f.gain - 0.2).abs() < 0.03, "gain {}", f.gain);
            }
        }
    }

    #[test]
    fn schedule_pattern_identifies_undecodable_markers_without_aliasing() {
        let schedule = standard_schedule(AudioSource::Mic, 0.1, 5.9, 0.5);
        let expected: Vec<(u32, f64)> = schedule
            .iter()
            .skip(1)
            .map(|p| (p.index, p.time_secs))
            .collect();
        for shift in [-0.519, 0.0, 0.5, 1.0, 0.0145] {
            let chirps: Vec<f64> = schedule.iter().map(|p| p.time_secs + shift).collect();
            let found = identify_by_schedule(&expected, &chirps, 0.002).expect("identified");
            assert!(
                found.len() >= expected.len() - 2,
                "shift {shift}: {found:?}"
            );
            for (index, time) in found {
                let truth = schedule.iter().find(|p| p.index == index).unwrap();
                assert!(
                    (time - shift - truth.time_secs).abs() < 1e-9,
                    "shift {shift}"
                );
            }
        }
        assert!(identify_by_schedule(&expected, &[1.0, 2.0], 0.002).is_none());
    }

    #[test]
    fn crc_rejects_flipped_payloads() {
        for index in [0, 1, 77, MAX_AUDIO_INDEX] {
            let bits = payload_bits(index);
            for b in 0..PAYLOAD_BITS {
                let flipped = bits ^ (1 << b);
                let i = flipped & MAX_AUDIO_INDEX;
                assert_ne!(payload_bits(i), flipped);
            }
        }
    }
}
