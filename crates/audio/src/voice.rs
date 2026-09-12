use crate::AudioSampleSource;
use nnnoiseless::DenoiseState;
use std::ops::Range;

const FRAME: usize = DenoiseState::FRAME_SIZE;
pub const VOICE_PREROLL_SAMPLES: usize = 9_600;
pub const VOICE_WINDOW_PADDING_SAMPLES: usize = FRAME * 3;

pub struct VoiceEnhancer {
    states: Vec<Box<DenoiseState<'static>>>,
    next_input: usize,
    expected_start: Option<usize>,
    frame_start: Option<usize>,
    frame: Vec<f32>,
    previous: Vec<f32>,
}

impl VoiceEnhancer {
    pub fn new(channels: u16) -> Self {
        let channels = usize::from(channels.clamp(1, 2));
        Self {
            states: (0..channels).map(|_| DenoiseState::new()).collect(),
            next_input: 0,
            expected_start: None,
            frame_start: None,
            frame: vec![0.0; FRAME * channels],
            previous: vec![0.0; FRAME * channels],
        }
    }

    pub fn is_contiguous(&self, start: usize) -> bool {
        self.expected_start == Some(start)
            || self
                .frame_start
                .is_some_and(|first| (first..first + FRAME).contains(&start))
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
        let end = start
            .saturating_add(count)
            .div_ceil(FRAME)
            .saturating_add(1)
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
        if count > 0 && !self.is_contiguous(start) {
            self.next_input = self.source_range(start, count).start;
            self.states = (0..channels).map(|_| DenoiseState::new()).collect();
            self.frame_start = None;
            self.previous.fill(0.0);
        }
        let mut samples = vec![0.0; count * channels];
        let mut written = 0;
        while written < count {
            let cursor = start + written;
            while !self
                .frame_start
                .is_some_and(|first| (first..first + FRAME).contains(&cursor))
            {
                self.process_frame(source);
            }
            let offset = cursor - self.frame_start.unwrap();
            let take = (FRAME - offset).min(count - written);
            samples[written * channels..(written + take) * channels]
                .copy_from_slice(&self.frame[offset * channels..(offset + take) * channels]);
            written += take;
        }
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
            state.process_frame(&mut output, &input);
            for (index, (&clean, &raw)) in output.iter().zip(&input).enumerate() {
                let index = index * channels + channel;
                self.frame[index] =
                    (clean / 32_768.0 * 0.9 + self.previous[index] * 0.1).clamp(-1.0, 1.0);
                self.previous[index] = raw / 32_768.0;
            }
        }
        // RNNoise emits the preceding 10 ms frame. Reading ahead keeps source timestamps intact.
        self.frame_start = self.next_input.checked_sub(FRAME);
        self.next_input += FRAME;
    }
}

pub struct VoiceAudio {
    samples: Vec<f32>,
    channels: u16,
    start: usize,
    total_samples: usize,
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
        assert_eq!(enhancer.previous.len(), FRAME);
    }
}
