use std::ops::Range;

const FRAMES_PER_SECOND: u32 = 100;
const LEVEL_FLOOR_DB: f32 = -90.0;
const NOISE_PERCENTILE: f32 = 0.1;
const SPEECH_PERCENTILE: f32 = 0.9;
const MIN_SPEECH_ABOVE_NOISE_DB: f32 = 20.0;
const QUIET_ABOVE_NOISE_DB: f32 = 6.0;
const QUIET_BELOW_SPEECH_DB: f32 = 40.0;
const MAX_QUIET_DB: f32 = -45.0;
const SPEECH_BELOW_PEAK_DB: f32 = 20.0;
const MIN_PAUSE_SECS: f32 = 0.2;
const MIN_SPEECH_SECS: f32 = 0.05;
const SPEECH_RELEASE_SECS: f32 = 0.1;
const MIN_WORD_SECS: f32 = 0.1;
const NEXT_ONSET_SECS: f32 = 0.25;

#[derive(Debug, Clone, PartialEq)]
pub struct SpeechPauses {
    frame_secs: f32,
    pauses: Vec<Range<f32>>,
    speech_frames: Vec<u32>,
}

impl SpeechPauses {
    pub fn detect(samples: &[f32], sample_rate: u32) -> Option<Self> {
        let hop = (sample_rate / FRAMES_PER_SECOND) as usize;
        if hop == 0 || samples.is_empty() {
            return None;
        }

        let energies = samples
            .chunks(hop)
            .map(|frame| {
                frame.iter().map(|sample| sample * sample).sum::<f32>() / frame.len() as f32
            })
            .collect::<Vec<_>>();
        let levels = (0..energies.len())
            .map(|index| {
                let window = &energies[index.saturating_sub(1)..(index + 2).min(energies.len())];
                let energy = window.iter().sum::<f32>() / window.len() as f32;
                (10.0 * energy.log10()).max(LEVEL_FLOOR_DB)
            })
            .collect::<Vec<_>>();

        let mut sorted = levels.clone();
        sorted.sort_by(f32::total_cmp);
        let audible = &sorted[sorted.partition_point(|level| *level <= LEVEL_FLOOR_DB)..];
        let noise = percentile(&sorted, NOISE_PERCENTILE)?;
        let speech = percentile(audible, SPEECH_PERCENTILE)?;
        if speech - noise < MIN_SPEECH_ABOVE_NOISE_DB {
            return None;
        }

        // Noise-gated mics leave digital silence in pauses, which pins the
        // noise floor at the bottom of the scale while the gate's tail after
        // each word still sits far above it; following the speech level too
        // keeps that tail out of the word.
        let quiet = (noise + QUIET_ABOVE_NOISE_DB)
            .max(speech - QUIET_BELOW_SPEECH_DB)
            .min(MAX_QUIET_DB);
        let loud = speech - SPEECH_BELOW_PEAK_DB;

        let frame_secs = hop as f32 / sample_rate as f32;
        let min_pause_frames = (MIN_PAUSE_SECS / frame_secs).round() as usize;
        let mut pauses = Vec::new();
        let mut quiet_from = None;
        for (index, level) in levels.iter().chain([&f32::INFINITY]).enumerate() {
            match (*level < quiet, quiet_from) {
                (true, None) => quiet_from = Some(index),
                (false, Some(from)) => {
                    if index - from >= min_pause_frames {
                        pauses.push(from as f32 * frame_secs..index as f32 * frame_secs);
                    }
                    quiet_from = None;
                }
                _ => {}
            }
        }

        let speech_frames = std::iter::once(0)
            .chain(levels.iter().scan(0, |count, level| {
                *count += u32::from(*level > loud);
                Some(*count)
            }))
            .collect();

        Some(Self {
            frame_secs,
            pauses,
            speech_frames,
        })
    }

    // parakeet-rs ends each word where the next one starts, so a word's end
    // runs through the pause after it; only the audio shows where speech
    // stopped. Its word starts drift ~0.2s either way (sometimes more), so the
    // next word may already be audible in the last moments before the stored
    // end, and a word's own speech may only begin after a pause inside its
    // span. Breaths and clicks in a pause stay below speech level.
    pub fn audible_end(&self, start: f32, end: f32) -> f32 {
        let first = self.pauses.partition_point(|pause| pause.start <= start);
        for pause in self.pauses[first..]
            .iter()
            .take_while(|pause| pause.start < end)
        {
            let next_onset = (end - NEXT_ONSET_SECS).max(pause.end);
            if self.speech_secs(pause.end..next_onset) >= MIN_SPEECH_SECS {
                continue;
            }
            let late = self.speech_secs(next_onset..end);
            if late >= MIN_SPEECH_SECS && late > self.speech_secs(start..pause.start) {
                continue;
            }
            return end.min((pause.start + SPEECH_RELEASE_SECS).max(start + MIN_WORD_SECS));
        }

        if first
            .checked_sub(1)
            .is_some_and(|index| self.pauses[index].end >= end)
        {
            return end.min(start + MIN_WORD_SECS);
        }

        end
    }

    fn speech_secs(&self, range: Range<f32>) -> f32 {
        let last_frame = self.speech_frames.len() - 1;
        let frame =
            |time: f32| ((time / self.frame_secs).round().max(0.0) as usize).min(last_frame);
        let (first, last) = (frame(range.start), frame(range.end));
        if last <= first {
            return 0.0;
        }
        (self.speech_frames[last] - self.speech_frames[first]) as f32 * self.frame_secs
    }
}

fn percentile(sorted: &[f32], fraction: f32) -> Option<f32> {
    let last = sorted.len().checked_sub(1)?;
    Some(sorted[((sorted.len() as f32 * fraction) as usize).min(last)])
}

#[cfg(test)]
mod tests {
    use super::SpeechPauses;
    use std::ops::Range;

    const RATE: u32 = 16_000;

    fn silence(secs: f32) -> Vec<f32> {
        vec![0.0; (secs * RATE as f32) as usize]
    }

    fn sample_range(samples: &[f32], range: Range<f32>) -> Range<usize> {
        let index = |time: f32| ((time * RATE as f32) as usize).min(samples.len());
        index(range.start)..index(range.end)
    }

    fn hiss(samples: &mut [f32], range: Range<f32>, db: f32) {
        let amplitude = 10f32.powf(db / 20.0) * 3f32.sqrt();
        let mut state = 0x2545_f491_u32 ^ range.start.to_bits();
        for index in sample_range(samples, range) {
            state ^= state << 13;
            state ^= state >> 17;
            state ^= state << 5;
            samples[index] += (state as f32 / u32::MAX as f32 * 2.0 - 1.0) * amplitude;
        }
    }

    fn tone(samples: &mut [f32], range: Range<f32>, db: f32) {
        let amplitude = 10f32.powf(db / 20.0) * 2f32.sqrt();
        for index in sample_range(samples, range) {
            let time = index as f32 / RATE as f32;
            samples[index] += amplitude * (std::f32::consts::TAU * 220.0 * time).sin();
        }
    }

    fn speech(noise_db: f32, speech_db: f32, words: &[Range<f32>]) -> Vec<f32> {
        let mut samples = silence(5.0);
        hiss(&mut samples, 0.0..5.0, noise_db);
        for word in words {
            tone(&mut samples, word.clone(), speech_db);
        }
        samples
    }

    fn pauses(samples: &[f32]) -> SpeechPauses {
        SpeechPauses::detect(samples, RATE).expect("speech stands above the noise")
    }

    fn assert_close(actual: f32, expected: f32) {
        assert!(
            (actual - expected).abs() <= 0.02,
            "{actual} is not within 20ms of {expected}"
        );
    }

    #[test]
    fn stretched_word_ends_where_its_speech_stops() {
        let pauses = pauses(&speech(-60.0, -20.0, &[1.0..1.6, 3.0..3.5]));

        assert_close(pauses.audible_end(1.0, 3.0), 1.7);
        assert_eq!(pauses.audible_end(3.0, 3.5), 3.5);
    }

    #[test]
    fn word_followed_immediately_by_speech_keeps_its_end() {
        let pauses = pauses(&speech(-60.0, -20.0, &[1.0..1.47, 1.53..2.0, 3.5..4.0]));

        assert_eq!(pauses.audible_end(1.0, 1.5), 1.5);
        assert_eq!(pauses.audible_end(1.5, 2.0), 2.0);
    }

    #[test]
    fn next_word_heard_just_before_its_start_still_ends_at_the_pause() {
        let pauses = pauses(&speech(-60.0, -20.0, &[1.0..1.6, 2.8..3.3]));

        assert_close(pauses.audible_end(1.0, 3.0), 1.7);
        assert_eq!(pauses.audible_end(1.0, 3.2), 3.2);
    }

    #[test]
    fn speech_after_a_pause_inside_the_word_keeps_its_end() {
        let pauses = pauses(&speech(-60.0, -20.0, &[1.0..1.3, 1.6..2.4]));

        assert_eq!(pauses.audible_end(1.0, 2.0), 2.0);
    }

    #[test]
    fn short_word_heard_after_a_pause_keeps_its_end() {
        let pauses = pauses(&speech(-60.0, -20.0, &[1.0..2.05, 2.3..2.45, 2.5..3.0]));

        assert_eq!(pauses.audible_end(2.0, 2.5), 2.5);
    }

    #[test]
    fn clicks_and_breaths_in_a_pause_do_not_hold_the_word() {
        let mut samples = speech(-60.0, -20.0, &[1.0..1.5, 4.0..4.5]);
        tone(&mut samples, 2.0..2.02, -30.0);
        hiss(&mut samples, 2.5..2.8, -50.0);
        let pauses = pauses(&samples);

        assert_close(pauses.audible_end(1.0, 3.5), 1.6);
    }

    #[test]
    fn noise_gate_tail_after_a_word_counts_as_quiet() {
        let mut samples = silence(5.0);
        tone(&mut samples, 1.0..1.6, -20.0);
        hiss(&mut samples, 1.6..1.9, -65.0);
        tone(&mut samples, 3.0..3.5, -20.0);
        let pauses = pauses(&samples);

        assert_close(pauses.audible_end(1.0, 3.0), 1.7);
    }

    #[test]
    fn word_inside_a_pause_keeps_a_sliver_from_its_start() {
        let pauses = pauses(&speech(-60.0, -20.0, &[1.0..1.5, 4.0..4.5]));

        assert_close(pauses.audible_end(2.0, 3.0), 2.1);
    }

    #[test]
    fn pause_before_the_words_own_speech_keeps_its_end() {
        let pauses = pauses(&speech(-60.0, -20.0, &[1.0..1.5, 2.2..2.6]));

        assert_eq!(pauses.audible_end(2.0, 2.4), 2.4);
    }

    #[test]
    fn threshold_follows_the_clips_noise_floor() {
        let quiet = pauses(&speech(-85.0, -45.0, &[1.0..1.6, 3.0..3.5]));
        let noisy = pauses(&speech(-50.0, -15.0, &[1.0..1.6, 3.0..3.5]));

        assert_close(quiet.audible_end(1.0, 3.0), 1.7);
        assert_close(noisy.audible_end(1.0, 3.0), 1.7);
    }

    #[test]
    fn noisy_or_quiet_clips_are_left_alone() {
        let words = [1.0..1.6, 3.0..3.5];

        assert!(SpeechPauses::detect(&speech(-30.0, -20.0, &words), RATE).is_none());
        assert!(SpeechPauses::detect(&speech(-40.0, -30.0, &words), RATE).is_none());
        assert!(SpeechPauses::detect(&speech(-70.0, -70.0, &[]), RATE).is_none());
        assert!(SpeechPauses::detect(&silence(5.0), RATE).is_none());
        assert!(SpeechPauses::detect(&[], RATE).is_none());
    }
}
