use std::{
    collections::HashMap,
    f32::consts::PI,
    sync::{Arc, PoisonError, RwLock},
};

pub const AUDIO_LEVEL_FRAME_RATE: f64 = 60.0;
pub const AUDIO_LEVEL_BANDS: usize = 32;

const ANALYSIS_RATE: u32 = 16_000;
const WINDOW_SECONDS: f64 = 0.032;
const LOWEST_BAND_HZ: f64 = 60.0;
const HIGHEST_BAND_HZ: f64 = 8_000.0;
const TILT_DB_PER_OCTAVE: f64 = 3.0;
const FLOOR_DB: f64 = -75.0;
const CEILING_DB: f64 = -15.0;
const MAX_SMOOTHING_FRAMES: f64 = 6.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum AudioLevelSource {
    Display,
    Mic,
    System,
}

impl AudioLevelSource {
    pub fn from_name(name: &str) -> Option<Self> {
        match name {
            "display" => Some(Self::Display),
            "mic" => Some(Self::Mic),
            "system" => Some(Self::System),
            _ => None,
        }
    }
}

/// Per-band loudness at `AUDIO_LEVEL_FRAME_RATE` frames per second of the
/// source file's own clock: `AUDIO_LEVEL_BANDS` bytes per frame, log-spaced
/// from low to high frequency, 0 silent and 255 loud.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AudioLevels {
    bands: Vec<u8>,
}

impl AudioLevels {
    pub fn from_bytes(bytes: Vec<u8>) -> Option<Self> {
        bytes
            .len()
            .is_multiple_of(AUDIO_LEVEL_BANDS)
            .then_some(Self { bands: bytes })
    }

    pub fn as_bytes(&self) -> &[u8] {
        &self.bands
    }

    pub fn into_bytes(self) -> Vec<u8> {
        self.bands
    }

    pub fn frame_count(&self) -> usize {
        self.bands.len() / AUDIO_LEVEL_BANDS
    }

    /// Re-times levels for a track the mixer plays `seconds` later in its
    /// file than the clip offset alone says (audio timing repair).
    pub fn advanced(mut self, seconds: f64) -> Self {
        if !seconds.is_finite() {
            return self;
        }
        let frames = (seconds * AUDIO_LEVEL_FRAME_RATE).round();
        let bytes = (frames.abs() as usize).saturating_mul(AUDIO_LEVEL_BANDS);
        if frames > 0.0 {
            self.bands.drain(..bytes.min(self.bands.len()));
        } else if frames < 0.0 {
            self.bands.splice(0..0, std::iter::repeat_n(0, bytes));
        }
        self
    }

    fn frame(&self, index: i64) -> Option<&[u8]> {
        let index = usize::try_from(index).ok()?;
        self.bands
            .get(index * AUDIO_LEVEL_BANDS..(index + 1) * AUDIO_LEVEL_BANDS)
    }

    /// Raises `out` to this source's levels at `time`, averaged over nearby
    /// frames with a triangular window that widens with `smoothing` (0-1).
    pub fn accumulate(&self, time: f64, smoothing: f32, out: &mut [f32; AUDIO_LEVEL_BANDS]) {
        if !time.is_finite() || self.bands.is_empty() {
            return;
        }
        let position = time * AUDIO_LEVEL_FRAME_RATE;
        let radius = f64::from(smoothing.clamp(0.0, 1.0)) * MAX_SMOOTHING_FRAMES + 1.0;
        let first = (position - radius).ceil() as i64;
        let last = (position + radius).floor() as i64;
        let mut sums = [0.0_f64; AUDIO_LEVEL_BANDS];
        let mut total_weight = 0.0;
        for index in first..=last {
            let weight = 1.0 - (index as f64 - position).abs() / radius;
            if weight <= 0.0 {
                continue;
            }
            total_weight += weight;
            if let Some(frame) = self.frame(index) {
                for (sum, value) in sums.iter_mut().zip(frame) {
                    *sum += weight * f64::from(*value);
                }
            }
        }
        if total_weight <= 0.0 {
            return;
        }
        for (level, sum) in out.iter_mut().zip(sums) {
            *level = level.max((sum / total_weight / 255.0) as f32);
        }
    }
}

#[derive(Default)]
pub struct AudioLevelStore {
    levels: RwLock<HashMap<(u32, AudioLevelSource), Arc<AudioLevels>>>,
}

impl AudioLevelStore {
    pub fn set(&self, recording_clip: u32, source: AudioLevelSource, levels: AudioLevels) {
        self.levels
            .write()
            .unwrap_or_else(PoisonError::into_inner)
            .insert((recording_clip, source), Arc::new(levels));
    }

    pub fn get(&self, recording_clip: u32, source: AudioLevelSource) -> Option<Arc<AudioLevels>> {
        self.levels
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .get(&(recording_clip, source))
            .cloned()
    }

    pub fn is_empty(&self) -> bool {
        self.levels
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .is_empty()
    }
}

struct Band {
    start_bin: f64,
    end_bin: f64,
    tilt_db: f64,
}

/// Streams mono PCM into `AudioLevels`: box-downsamples to about 16 kHz, then
/// takes a Hann-windowed FFT centred on every level frame and folds its power
/// into log-spaced bands, tilted up with frequency so speech fills the range.
pub struct AudioLevelAnalyzer {
    decimation: usize,
    rate: f64,
    pending_sum: f32,
    pending_count: usize,
    samples: Vec<f32>,
    offset: usize,
    total: usize,
    next_frame: usize,
    window: Vec<f32>,
    fft: Fft,
    bands: Vec<Band>,
    levels: Vec<u8>,
}

impl AudioLevelAnalyzer {
    pub fn new(sample_rate: u32) -> Self {
        let sample_rate = sample_rate.max(1);
        let decimation = (sample_rate / ANALYSIS_RATE).max(1) as usize;
        let rate = f64::from(sample_rate) / decimation as f64;
        let size = ((rate * WINDOW_SECONDS).ceil() as usize)
            .next_power_of_two()
            .clamp(256, 2048);
        let window = (0..size)
            .map(|index| 0.5 - 0.5 * (2.0 * PI * index as f32 / size as f32).cos())
            .collect();
        let bin_hz = rate / size as f64;
        let highest = HIGHEST_BAND_HZ.min(rate * 0.45).max(LOWEST_BAND_HZ * 2.0);
        let ratio = (highest / LOWEST_BAND_HZ).powf(1.0 / AUDIO_LEVEL_BANDS as f64);
        let bands = (0..AUDIO_LEVEL_BANDS)
            .map(|band| {
                let low = LOWEST_BAND_HZ * ratio.powi(band as i32);
                let high = low * ratio;
                Band {
                    start_bin: low / bin_hz,
                    end_bin: high / bin_hz,
                    tilt_db: TILT_DB_PER_OCTAVE * ((low * high).sqrt() / 1_000.0).log2(),
                }
            })
            .collect();
        Self {
            decimation,
            rate,
            pending_sum: 0.0,
            pending_count: 0,
            samples: Vec::new(),
            offset: 0,
            total: 0,
            next_frame: 0,
            window,
            fft: Fft::new(size),
            bands,
            levels: Vec::new(),
        }
    }

    pub fn push(&mut self, samples: &[f32]) {
        for sample in samples {
            self.pending_sum += if sample.is_finite() { *sample } else { 0.0 };
            self.pending_count += 1;
            if self.pending_count == self.decimation {
                self.push_decimated();
            }
        }
        self.analyze_ready();
    }

    pub fn push_interleaved(&mut self, samples: &[f32], channels: usize) {
        let channels = channels.max(1);
        let mono: Vec<f32> = samples
            .chunks_exact(channels)
            .map(|frame| frame.iter().sum::<f32>() / channels as f32)
            .collect();
        self.push(&mono);
    }

    pub fn finish(mut self) -> AudioLevels {
        if self.pending_count > 0 {
            self.push_decimated();
        }
        while self.frame_center(self.next_frame) < self.total {
            self.analyze_frame();
        }
        AudioLevels { bands: self.levels }
    }

    fn push_decimated(&mut self) {
        self.samples
            .push(self.pending_sum / self.pending_count as f32);
        self.total += 1;
        self.pending_sum = 0.0;
        self.pending_count = 0;
    }

    fn frame_center(&self, frame: usize) -> usize {
        (frame as f64 * self.rate / AUDIO_LEVEL_FRAME_RATE).round() as usize
    }

    fn analyze_ready(&mut self) {
        let half = self.window.len() / 2;
        while self.frame_center(self.next_frame) + half <= self.total {
            self.analyze_frame();
        }
        let keep_from = self.frame_center(self.next_frame).saturating_sub(half);
        if keep_from > self.offset {
            self.samples.drain(..keep_from - self.offset);
            self.offset = keep_from;
        }
    }

    fn analyze_frame(&mut self) {
        let size = self.window.len();
        let start = self.frame_center(self.next_frame) as i64 - (size / 2) as i64;
        for (index, weight) in self.window.iter().enumerate() {
            let sample = usize::try_from(start + index as i64)
                .ok()
                .and_then(|position| position.checked_sub(self.offset))
                .and_then(|position| self.samples.get(position))
                .copied()
                .unwrap_or(0.0);
            self.fft.real[index] = sample * weight;
            self.fft.imag[index] = 0.0;
        }
        self.fft.run();
        let scale = (size as f32 / 4.0).powi(2);
        let power: Vec<f64> = self.fft.real[..=size / 2]
            .iter()
            .zip(&self.fft.imag)
            .map(|(real, imag)| f64::from((real * real + imag * imag) / scale))
            .collect();
        for band in &self.bands {
            let db = 10.0 * (band_power(&power, band) + 1.0e-12).log10() + band.tilt_db;
            let level = ((db - FLOOR_DB) / (CEILING_DB - FLOOR_DB)).clamp(0.0, 1.0);
            self.levels.push((level * 255.0).round() as u8);
        }
        self.next_frame += 1;
    }
}

fn band_power(power: &[f64], band: &Band) -> f64 {
    let last = power.len() - 1;
    if band.end_bin - band.start_bin < 1.0 {
        let position = ((band.start_bin + band.end_bin) * 0.5).min(last as f64);
        let low = position.floor() as usize;
        let high = (low + 1).min(last);
        let fraction = position - low as f64;
        return power[low] * (1.0 - fraction) + power[high] * fraction;
    }
    let start = (band.start_bin.round() as usize).min(last);
    let end = (band.end_bin.round() as usize).clamp(start + 1, last + 1);
    power[start..end].iter().sum::<f64>() / (end - start) as f64
}

struct Fft {
    real: Vec<f32>,
    imag: Vec<f32>,
    cos: Vec<f32>,
    sin: Vec<f32>,
    reversed: Vec<usize>,
}

impl Fft {
    fn new(size: usize) -> Self {
        let bits = size.trailing_zeros();
        Self {
            real: vec![0.0; size],
            imag: vec![0.0; size],
            cos: (0..size / 2)
                .map(|index| (2.0 * PI * index as f32 / size as f32).cos())
                .collect(),
            sin: (0..size / 2)
                .map(|index| -(2.0 * PI * index as f32 / size as f32).sin())
                .collect(),
            reversed: (0..size)
                .map(|index| index.reverse_bits() >> (usize::BITS - bits))
                .collect(),
        }
    }

    fn run(&mut self) {
        let size = self.real.len();
        for (index, &target) in self.reversed.iter().enumerate() {
            if index < target {
                self.real.swap(index, target);
                self.imag.swap(index, target);
            }
        }
        let mut length = 2;
        while length <= size {
            let step = size / length;
            for start in (0..size).step_by(length) {
                for offset in 0..length / 2 {
                    let (cos, sin) = (self.cos[offset * step], self.sin[offset * step]);
                    let even = start + offset;
                    let odd = even + length / 2;
                    let real = self.real[odd] * cos - self.imag[odd] * sin;
                    let imag = self.real[odd] * sin + self.imag[odd] * cos;
                    self.real[odd] = self.real[even] - real;
                    self.imag[odd] = self.imag[even] - imag;
                    self.real[even] += real;
                    self.imag[even] += imag;
                }
            }
            length *= 2;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tone(frequency: f32, amplitude: f32, seconds: f32, sample_rate: u32) -> Vec<f32> {
        (0..(seconds * sample_rate as f32) as usize)
            .map(|index| {
                amplitude * (2.0 * PI * frequency * index as f32 / sample_rate as f32).sin()
            })
            .collect()
    }

    fn analyze(samples: &[f32], sample_rate: u32, chunk: usize) -> AudioLevels {
        let mut analyzer = AudioLevelAnalyzer::new(sample_rate);
        for part in samples.chunks(chunk) {
            analyzer.push(part);
        }
        analyzer.finish()
    }

    fn loudest_band(levels: &AudioLevels, frame: usize) -> usize {
        let frame = &levels.as_bytes()[frame * AUDIO_LEVEL_BANDS..][..AUDIO_LEVEL_BANDS];
        (0..AUDIO_LEVEL_BANDS)
            .max_by_key(|band| frame[*band])
            .unwrap()
    }

    #[test]
    fn fft_finds_a_pure_bin() {
        let mut fft = Fft::new(64);
        for index in 0..64 {
            fft.real[index] = (2.0 * PI * 5.0 * index as f32 / 64.0).cos();
            fft.imag[index] = 0.0;
        }
        fft.run();
        let magnitudes: Vec<f32> = (0..64)
            .map(|bin| fft.real[bin].hypot(fft.imag[bin]))
            .collect();
        assert!((magnitudes[5] - 32.0).abs() < 1.0e-3);
        assert!((magnitudes[59] - 32.0).abs() < 1.0e-3);
        assert!(magnitudes[4] < 1.0e-3 && magnitudes[6] < 1.0e-3);
    }

    #[test]
    fn levels_track_duration_and_frequency() {
        for sample_rate in [16_000, 44_100, 48_000] {
            let low = analyze(&tone(150.0, 0.5, 1.0, sample_rate), sample_rate, 997);
            let high = analyze(&tone(3_000.0, 0.5, 1.0, sample_rate), sample_rate, 4096);
            assert!((59..=61).contains(&low.frame_count()), "{sample_rate}");
            assert_eq!(low.frame_count(), high.frame_count());
            assert!(loudest_band(&low, 30) < loudest_band(&high, 30));
            assert!(
                low.as_bytes()[30 * AUDIO_LEVEL_BANDS..][..AUDIO_LEVEL_BANDS]
                    .iter()
                    .any(|level| *level > 200)
            );
        }
    }

    #[test]
    fn chunking_does_not_change_levels() {
        let samples = tone(440.0, 0.3, 0.7, 48_000);
        assert_eq!(
            analyze(&samples, 48_000, 1),
            analyze(&samples, 48_000, 100_000)
        );
    }

    #[test]
    fn silence_and_quiet_speech_levels() {
        let silent = analyze(&vec![0.0; 48_000], 48_000, 4800);
        assert!(silent.as_bytes().iter().all(|level| *level == 0));
        let quiet = analyze(&tone(250.0, 0.02, 1.0, 48_000), 48_000, 4800);
        let peak = quiet.as_bytes()[30 * AUDIO_LEVEL_BANDS..][..AUDIO_LEVEL_BANDS]
            .iter()
            .copied()
            .max()
            .unwrap();
        assert!((60..230).contains(&peak), "{peak}");
    }

    #[test]
    fn interleaved_input_downmixes() {
        let mono = tone(500.0, 0.4, 0.5, 48_000);
        let stereo: Vec<f32> = mono.iter().flat_map(|sample| [*sample, *sample]).collect();
        let mut analyzer = AudioLevelAnalyzer::new(48_000);
        analyzer.push_interleaved(&stereo, 2);
        assert_eq!(analyzer.finish(), analyze(&mono, 48_000, 4800));
    }

    #[test]
    fn sampling_interpolates_smooths_and_combines() {
        let mut bytes = vec![0; AUDIO_LEVEL_BANDS * 3];
        bytes[AUDIO_LEVEL_BANDS] = 255;
        let levels = AudioLevels::from_bytes(bytes).unwrap();
        assert!(AudioLevels::from_bytes(vec![0; AUDIO_LEVEL_BANDS + 1]).is_none());

        let mut exact = [0.0; AUDIO_LEVEL_BANDS];
        levels.accumulate(1.0 / 60.0, 0.0, &mut exact);
        assert!((exact[0] - 1.0).abs() < 1.0e-6);

        let mut between = [0.0; AUDIO_LEVEL_BANDS];
        levels.accumulate(1.5 / 60.0, 0.0, &mut between);
        assert!((between[0] - 0.5).abs() < 1.0e-6);

        let mut smoothed = [0.0; AUDIO_LEVEL_BANDS];
        levels.accumulate(1.0 / 60.0, 1.0, &mut smoothed);
        assert!(smoothed[0] > 0.0 && smoothed[0] < 0.5);

        let mut outside = [0.25; AUDIO_LEVEL_BANDS];
        levels.accumulate(10.0, 0.0, &mut outside);
        assert_eq!(outside[0], 0.25);
        levels.accumulate(1.0 / 60.0, 0.0, &mut outside);
        assert_eq!(outside[0], 1.0);
        assert_eq!(outside[1], 0.25);
    }

    #[test]
    fn advancing_levels_shifts_whole_frames() {
        let levels = AudioLevels::from_bytes((0..3 * AUDIO_LEVEL_BANDS as u8).collect()).unwrap();
        let later = levels.clone().advanced(1.0 / 60.0);
        assert_eq!(later.frame_count(), 2);
        assert_eq!(later.as_bytes()[0], AUDIO_LEVEL_BANDS as u8);
        let earlier = levels.clone().advanced(-2.0 / 60.0);
        assert_eq!(earlier.frame_count(), 5);
        assert!(
            earlier.as_bytes()[..2 * AUDIO_LEVEL_BANDS]
                .iter()
                .all(|b| *b == 0)
        );
        assert_eq!(earlier.as_bytes()[2 * AUDIO_LEVEL_BANDS], 0);
        assert_eq!(earlier.as_bytes()[2 * AUDIO_LEVEL_BANDS + 1], 1);
        assert_eq!(levels.clone().advanced(10.0).frame_count(), 0);
        assert_eq!(levels.clone().advanced(f64::NAN), levels);
    }

    #[test]
    fn store_keys_levels_by_clip_and_source() {
        let store = AudioLevelStore::default();
        assert!(store.is_empty());
        store.set(1, AudioLevelSource::Mic, AudioLevels::default());
        assert!(store.get(1, AudioLevelSource::Mic).is_some());
        assert!(store.get(1, AudioLevelSource::System).is_none());
        assert!(store.get(0, AudioLevelSource::Mic).is_none());
        assert_eq!(
            AudioLevelSource::from_name("display"),
            Some(AudioLevelSource::Display)
        );
        assert_eq!(AudioLevelSource::from_name("camera"), None);
    }
}
