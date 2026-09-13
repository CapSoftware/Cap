use crate::{AudioSampleSource, VoiceProfile, voice_level::VoiceFilter};
use cap_rnnoise::{DELAY_SAMPLES, DenoiseState, FRAME_SIZE};
use std::{collections::VecDeque, ops::Range};

const FRAME: usize = FRAME_SIZE;
pub const VOICE_PREROLL_SAMPLES: usize = 24_000;
pub const VOICE_WINDOW_PADDING_SAMPLES: usize = FRAME * 9;

pub struct VoiceEnhancer {
    states: Vec<DenoiseState>,
    next_input: usize,
    expected_start: Option<usize>,
    warm_start: usize,
    pending_start: usize,
    pending: VecDeque<f32>,
    previous: Vec<f32>,
    frame: Vec<f32>,
    wet: f32,
    profile: Option<VoiceProfile>,
    leveler: Option<VoiceFilter>,
    speech_frames: usize,
}

impl VoiceEnhancer {
    pub fn new(channels: u16) -> Self {
        let channels = usize::from(channels.clamp(1, 2));
        Self {
            states: (0..channels).map(|_| DenoiseState::new()).collect(),
            next_input: 0,
            expected_start: None,
            warm_start: 0,
            pending_start: 0,
            pending: VecDeque::new(),
            previous: vec![0.0; DELAY_SAMPLES * channels],
            frame: vec![0.0; FRAME * channels],
            wet: 0.9,
            profile: None,
            leveler: None,
            speech_frames: 0,
        }
    }

    pub fn with_settings(channels: u16, wet: f32, profile: VoiceProfile) -> Self {
        let mut enhancer = Self::new(channels);
        enhancer.wet = if wet.is_finite() {
            wet.clamp(0.0, 1.0)
        } else {
            0.9
        };
        enhancer.profile = Some(profile);
        enhancer
    }

    pub fn speech_frames(&self) -> usize {
        self.speech_frames
    }

    pub fn is_contiguous(&self, start: usize) -> bool {
        self.expected_start == Some(start)
            || (self.pending_start..self.pending_start + self.pending.len() / self.states.len())
                .contains(&start)
    }

    pub fn source_range(&self, start: usize, count: usize) -> Range<usize> {
        if count == 0 {
            return start..start;
        }
        let first = if self.is_contiguous(start) {
            self.next_input
        } else {
            (start / FRAME * FRAME).saturating_sub(VOICE_PREROLL_SAMPLES)
        };
        let padding = if self.profile.is_some() { 7 } else { 3 };
        let end = start
            .saturating_add(count)
            .div_ceil(FRAME)
            .saturating_add(padding)
            .saturating_mul(FRAME);
        first..end.max(first)
    }

    pub fn initial_source_range(start: usize, count: usize) -> Range<usize> {
        let first = (start / FRAME * FRAME).saturating_sub(VOICE_PREROLL_SAMPLES);
        let end = start
            .saturating_add(count)
            .div_ceil(FRAME)
            .saturating_add(7)
            .saturating_mul(FRAME);
        first..end.max(first)
    }

    pub fn render<T: AudioSampleSource>(
        &mut self,
        source: &T,
        start: usize,
        count: usize,
    ) -> VoiceAudio {
        let channels = self.states.len();
        let count = count.min(source.sample_count().saturating_sub(start));
        if count == 0 {
            return VoiceAudio {
                samples: Vec::new(),
                channels: channels as u16,
                start,
                total_samples: source.sample_count(),
            };
        }
        if count > 0 && !self.is_contiguous(start) {
            self.next_input = self.source_range(start, count).start;
            self.warm_start = self.next_input;
            self.pending_start = self.next_input;
            self.pending.clear();
            self.previous.fill(0.0);
            self.states = (0..channels).map(|_| DenoiseState::new()).collect();
            self.speech_frames = 0;
            self.leveler = self.profile.and_then(|profile| {
                VoiceFilter::new(channels as u16, &profile.filter(channels as u16))
                    .map_err(|error| {
                        tracing::warn!(%error, "Studio Sound leveling is unavailable");
                    })
                    .ok()
            });
        }
        while count > 0 && self.pending_start + self.pending.len() / channels < start + count {
            self.process_frame(source);
        }
        let first = (start - self.pending_start) * channels;
        let samples = self
            .pending
            .iter()
            .skip(first)
            .take(count * channels)
            .copied()
            .collect();
        // Fractional timeline mappings can repeat a source sample without rewinding the decoder.
        let history_start = (start + count - 1) / FRAME * FRAME;
        let discard = history_start
            .saturating_sub(self.pending_start)
            .min(self.pending.len() / channels);
        drop(self.pending.drain(..discard * channels));
        self.pending_start += discard;
        self.expected_start = Some(start + count);
        VoiceAudio {
            samples,
            channels: channels as u16,
            start,
            total_samples: source.sample_count(),
        }
    }

    fn process_frame<T: AudioSampleSource>(&mut self, source: &T) {
        let channels = self.states.len();
        let mut input = [0.0; FRAME];
        let mut output = [0.0; FRAME];
        let delayed = (self.next_input / FRAME % 2) * FRAME * channels;
        let mut speech = false;
        for (channel, state) in self.states.iter_mut().enumerate() {
            for (index, sample) in input.iter_mut().enumerate() {
                let value = source
                    .sample((self.next_input + index) * channels + channel)
                    .copied()
                    .unwrap_or(0.0);
                *sample = if value.is_finite() {
                    value.clamp(-1.0, 1.0) * 32_768.0
                } else {
                    0.0
                };
            }
            speech |= state.process_frame(&mut output, &input) > 0.6;
            for (index, (&clean, &raw)) in output.iter().zip(&input).enumerate() {
                let index = index * channels + channel;
                self.frame[index] =
                    clean / 32_768.0 * self.wet + self.previous[delayed + index] * (1.0 - self.wet);
                self.previous[delayed + index] = raw / 32_768.0;
            }
        }
        self.speech_frames += usize::from(speech);
        if self.next_input >= self.warm_start + DELAY_SAMPLES {
            if let Some(leveler) = &mut self.leveler {
                if let Err(error) = leveler.process(&self.frame, &mut self.pending) {
                    tracing::warn!(%error, "Studio Sound leveling failed");
                    self.leveler = None;
                    self.pending.extend(&self.frame);
                }
            } else {
                self.pending.extend(&self.frame);
            }
        }
        self.next_input += FRAME;
    }
}

pub struct VoiceAudio {
    samples: Vec<f32>,
    channels: u16,
    start: usize,
    total_samples: usize,
}

impl VoiceAudio {
    pub fn samples(&self) -> &[f32] {
        &self.samples
    }
}

impl AudioSampleSource for VoiceAudio {
    fn channels(&self) -> u16 {
        self.channels
    }
    fn sample_count(&self) -> usize {
        self.total_samples
    }
    fn sample(&self, index: usize) -> Option<&f32> {
        index
            .checked_sub(self.start * usize::from(self.channels))
            .and_then(|index| self.samples.get(index))
    }
    fn sample_slice(&self, range: Range<usize>) -> Option<&[f32]> {
        let offset = self.start * usize::from(self.channels);
        self.samples
            .get(range.start.checked_sub(offset)?..range.end.checked_sub(offset)?)
    }
}

pub enum VoiceSource<'a, T> {
    Original(&'a T),
    Enhanced(&'a VoiceAudio),
}

impl<T: AudioSampleSource> AudioSampleSource for VoiceSource<'_, T> {
    fn channels(&self) -> u16 {
        match self {
            Self::Original(source) => source.channels(),
            Self::Enhanced(source) => source.channels(),
        }
    }
    fn sample_count(&self) -> usize {
        match self {
            Self::Original(source) => source.sample_count(),
            Self::Enhanced(source) => source.sample_count(),
        }
    }
    fn sample(&self, index: usize) -> Option<&f32> {
        match self {
            Self::Original(source) => source.sample(index),
            Self::Enhanced(source) => source.sample(index),
        }
    }
    fn sample_slice(&self, range: Range<usize>) -> Option<&[f32]> {
        match self {
            Self::Original(source) => source.sample_slice(range),
            Self::Enhanced(source) => source.sample_slice(range),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Samples {
        data: Vec<f32>,
        channels: u16,
    }
    impl AudioSampleSource for Samples {
        fn channels(&self) -> u16 {
            self.channels
        }
        fn sample_count(&self) -> usize {
            self.data.len() / usize::from(self.channels)
        }
        fn sample(&self, index: usize) -> Option<&f32> {
            self.data.get(index)
        }
    }

    fn signal(frames: usize, channels: u16) -> Samples {
        let mut seed = 42_u32;
        Samples {
            channels,
            data: (0..frames * usize::from(channels))
                .map(|_| {
                    seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                    (seed as f64 / u32::MAX as f64 * 0.16 - 0.08) as f32
                })
                .collect(),
        }
    }

    #[test]
    fn leveling_preserves_chunk_boundaries_timing_and_peak_headroom() {
        ffmpeg::init().unwrap();
        for channels in [1, 2] {
            let mut source = signal(96_137, channels);
            for (index, sample) in source.data.iter_mut().enumerate() {
                let position = index / usize::from(channels);
                *sample = if (8_000..80_000).contains(&position) {
                    (position as f32 * 0.037).sin() * 0.05
                } else {
                    0.0
                };
            }
            let profile = VoiceProfile {
                gain_db: 12.0,
                makeup_db: 2.0,
            };
            let expected = VoiceEnhancer::with_settings(channels, 0.9, profile).render(
                &source,
                0,
                source.sample_count(),
            );
            let mut enhancer = VoiceEnhancer::with_settings(channels, 0.9, profile);
            let mut actual = Vec::new();
            let mut cursor = 0;
            while cursor < source.sample_count() {
                let audio = enhancer.render(&source, cursor, cursor % 5_007 + 1);
                cursor += audio.samples.len() / usize::from(channels);
                actual.extend(audio.samples);
                assert!(
                    enhancer.pending.len() < VOICE_WINDOW_PADDING_SAMPLES * usize::from(channels)
                );
            }
            assert_eq!(actual, expected.samples);
            assert!(
                actual
                    .iter()
                    .all(|value| value.is_finite() && value.abs() < 0.86)
            );
            assert!(actual.iter().any(|value| value.abs() > 0.05));
            for remainder in 0..FRAME {
                let range = enhancer.source_range(48_000 + remainder, 4_096);
                assert!(
                    range.len() <= 4_096 + VOICE_PREROLL_SAMPLES + VOICE_WINDOW_PADDING_SAMPLES
                );
            }
            let mut impulse = Samples {
                data: vec![0.0; 12_017 * usize::from(channels)],
                channels,
            };
            impulse.data[5_333 * usize::from(channels)] = 0.8;
            let audio = VoiceEnhancer::with_settings(channels, 0.0, VoiceProfile::default())
                .render(&impulse, 0, impulse.sample_count());
            let peak = audio
                .samples
                .iter()
                .enumerate()
                .max_by(|(_, a), (_, b)| a.abs().total_cmp(&b.abs()))
                .unwrap()
                .0;
            assert_eq!(peak / usize::from(channels), 5_333);
        }
    }

    #[test]
    fn arbitrary_blocks_match_whole_processing_including_stereo_and_tail() {
        for channels in [1, 2] {
            let source = signal(20_137, channels);
            let expected = VoiceEnhancer::new(channels).render(&source, 0, source.sample_count());
            let mut enhancer = VoiceEnhancer::new(channels);
            let mut actual = Vec::new();
            let mut cursor = 0;
            for count in [1, 479, 481, 4_096, 7, 11_999, 3_074] {
                let audio = enhancer.render(&source, cursor, count);
                cursor += audio.samples.len() / usize::from(channels);
                actual.extend(audio.samples);
            }
            assert_eq!(cursor, source.sample_count());
            assert_eq!(actual, expected.samples);
            assert!(enhancer.render(&source, cursor, 512).samples.is_empty());
        }
    }

    #[test]
    fn seeks_prime_from_a_bounded_source_window() {
        let source = signal(120_001, 1);
        let mut enhancer = VoiceEnhancer::new(1);
        enhancer.render(&source, 0, 4_096);
        for start in [96_177, 13, 60_050] {
            let range = enhancer.source_range(start, 4096);
            assert!(range.len() <= 4096 + VOICE_PREROLL_SAMPLES + VOICE_WINDOW_PADDING_SAMPLES);
            let actual = enhancer.render(&source, start, 4096);
            let expected = VoiceEnhancer::new(1).render(&source, start, 4096);
            assert_eq!(actual.samples, expected.samples);
        }
    }

    #[test]
    fn every_frame_alignment_fits_the_bounded_source_window() {
        let enhancer = VoiceEnhancer::new(1);
        for remainder in 0..FRAME {
            let range = enhancer.source_range(48_000 + remainder, 4_096);
            assert!(range.len() <= 4_096 + VOICE_PREROLL_SAMPLES + VOICE_WINDOW_PADDING_SAMPLES);
        }
    }

    #[test]
    fn silence_short_tracks_and_non_finite_samples_stay_safe() {
        for frames in [0, 1, 479, 480, 481, 997] {
            let source = Samples {
                data: vec![0.0; frames],
                channels: 1,
            };
            let output = VoiceEnhancer::new(1).render(&source, 0, frames + 480);
            assert_eq!(output.samples, source.data);
        }
        let source = Samples {
            data: vec![f32::NAN, f32::INFINITY, f32::NEG_INFINITY],
            channels: 1,
        };
        let output = VoiceEnhancer::new(1).render(&source, 0, 3);
        assert_eq!(output.samples, vec![0.0; 3]);
    }

    #[test]
    fn lookahead_compensates_the_filter_delay() {
        let mut source = Samples {
            data: vec![0.0; 12_017],
            channels: 1,
        };
        source.data[5_333] = 0.8;
        let output = VoiceEnhancer::new(1).render(&source, 0, source.sample_count());
        let peak = output
            .samples
            .iter()
            .enumerate()
            .max_by(|(_, a), (_, b)| a.abs().total_cmp(&b.abs()))
            .unwrap()
            .0;
        assert_eq!(peak, 5_333);
        assert_eq!(output.samples.len(), source.data.len());
    }

    #[test]
    fn fan_noise_is_reduced_without_clipping_or_accumulated_buffers() {
        let mut source = signal(96_000, 1);
        let mut previous = 0.0;
        for sample in &mut source.data {
            previous = previous * 0.95 + *sample * 0.05;
            *sample = previous;
        }
        let mut enhancer = VoiceEnhancer::new(1);
        let output = enhancer.render(&source, 0, source.sample_count());
        let power = |samples: &[f32]| samples.iter().map(|sample| sample * sample).sum::<f32>();
        assert!(power(&output.samples[48_000..]) < power(&source.data[48_000..]) * 0.1);
        assert!(
            output
                .samples
                .iter()
                .all(|sample| sample.is_finite() && sample.abs() <= 1.0)
        );
        assert_eq!(enhancer.states.len(), 1);
        assert_eq!(enhancer.frame.len(), FRAME);
        assert_eq!(enhancer.previous.len(), DELAY_SAMPLES);
    }
}
