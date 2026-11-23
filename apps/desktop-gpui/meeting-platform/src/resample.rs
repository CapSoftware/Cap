pub const SPEECH_RATE: u32 = 16_000;

const PHASES: usize = 128;
const ZERO_CROSSINGS: f64 = 12.0;
const PASSBAND: f64 = 0.9;
const KAISER_BETA: f64 = 8.0;

pub struct SpeechResampler {
    input_rate: u32,
    half: usize,
    table: Vec<f32>,
    pending: Vec<f32>,
    position: u64,
}

fn bessel_i0(x: f64) -> f64 {
    let mut sum = 1.0;
    let mut term = 1.0;
    let half = x / 2.0;
    for k in 1..32 {
        term *= (half / f64::from(k)).powi(2);
        sum += term;
        if term < sum * 1e-12 {
            break;
        }
    }
    sum
}

impl SpeechResampler {
    pub fn new(input_rate: u32) -> Self {
        let input_rate = input_rate.max(1);
        if input_rate == SPEECH_RATE {
            return Self {
                input_rate,
                half: 0,
                table: Vec::new(),
                pending: Vec::new(),
                position: 0,
            };
        }

        let cutoff = 0.5 * PASSBAND * (f64::from(SPEECH_RATE) / f64::from(input_rate)).min(1.0);
        let half = (ZERO_CROSSINGS / (2.0 * cutoff)).ceil() as usize;
        let taps = 2 * half;
        let window_scale = bessel_i0(KAISER_BETA);
        let mut table = vec![0.0f32; PHASES * taps];
        for phase in 0..PHASES {
            let fraction = phase as f64 / PHASES as f64;
            let row = &mut table[phase * taps..(phase + 1) * taps];
            let mut sum = 0.0;
            let mut coefficients = vec![0.0f64; taps];
            for (tap, coefficient) in coefficients.iter_mut().enumerate() {
                let distance = tap as f64 - (half as f64 - 1.0) - fraction;
                let normalized = distance / half as f64;
                if normalized.abs() >= 1.0 {
                    continue;
                }
                let angle = 2.0 * std::f64::consts::PI * cutoff * distance;
                let sinc = if angle.abs() < 1e-9 {
                    1.0
                } else {
                    angle.sin() / angle
                };
                let window =
                    bessel_i0(KAISER_BETA * (1.0 - normalized * normalized).sqrt()) / window_scale;
                *coefficient = 2.0 * cutoff * sinc * window;
                sum += *coefficient;
            }
            for (slot, coefficient) in row.iter_mut().zip(&coefficients) {
                *slot = (coefficient / sum) as f32;
            }
        }

        Self {
            input_rate,
            half,
            table,
            pending: vec![0.0; half.saturating_sub(1)],
            position: 0,
        }
    }

    pub fn input_rate(&self) -> u32 {
        self.input_rate
    }

    pub fn process(&mut self, input: &[f32], output: &mut Vec<f32>) {
        if self.table.is_empty() {
            output.extend_from_slice(input);
            return;
        }
        self.pending.extend_from_slice(input);

        let taps = 2 * self.half;
        let step = u64::from(self.input_rate);
        let unit = u64::from(SPEECH_RATE);
        loop {
            let index = (self.position / unit) as usize;
            if index + taps > self.pending.len() {
                break;
            }
            let phase = ((self.position % unit) * PHASES as u64 / unit) as usize;
            let row = &self.table[phase * taps..(phase + 1) * taps];
            let window = &self.pending[index..index + taps];
            output.push(row.iter().zip(window).map(|(a, b)| a * b).sum());
            self.position += step;
        }

        let consumed = (self.position / unit) as usize;
        if consumed > 0 {
            let consumed = consumed.min(self.pending.len());
            self.pending.drain(..consumed);
            self.position -= consumed as u64 * unit;
        }
    }

    pub fn flush(&mut self, output: &mut Vec<f32>) {
        if self.table.is_empty() {
            return;
        }
        let tail = vec![0.0; self.half];
        self.process(&tail, output);
    }
}

pub fn downmix_interleaved(samples: &[f32], channels: usize, output: &mut Vec<f32>) {
    match channels {
        0 => {}
        1 => output.extend_from_slice(samples),
        _ => {
            let scale = 1.0 / channels as f32;
            output.extend(
                samples
                    .chunks_exact(channels)
                    .map(|frame| frame.iter().sum::<f32>() * scale),
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tone(rate: u32, frequency: f64, seconds: f64) -> Vec<f32> {
        (0..(f64::from(rate) * seconds) as usize)
            .map(|n| {
                (2.0 * std::f64::consts::PI * frequency * n as f64 / f64::from(rate)).sin() as f32
            })
            .collect()
    }

    fn rms(samples: &[f32]) -> f64 {
        (samples.iter().map(|s| f64::from(*s).powi(2)).sum::<f64>() / samples.len() as f64).sqrt()
    }

    fn convert(rate: u32, input: &[f32], chunk: usize) -> Vec<f32> {
        let mut resampler = SpeechResampler::new(rate);
        let mut output = Vec::new();
        for piece in input.chunks(chunk.max(1)) {
            resampler.process(piece, &mut output);
        }
        resampler.flush(&mut output);
        output
    }

    #[test]
    fn keeps_speech_band_level_at_every_common_rate() {
        for rate in [
            8_000, 16_000, 22_050, 24_000, 32_000, 44_100, 48_000, 88_200, 96_000,
        ] {
            let frequency = if rate <= 8_000 { 1_000.0 } else { 3_000.0 };
            let output = convert(rate, &tone(rate, frequency, 1.0), 480);
            let steady = &output[1_600..output.len() - 1_600];
            let level = rms(steady) * std::f64::consts::SQRT_2;
            assert!(
                (level - 1.0).abs() < 0.02,
                "rate {rate} changed a {frequency} Hz tone to {level}"
            );
        }
    }

    #[test]
    fn rejects_content_above_the_speech_band() {
        for (rate, frequency) in [(48_000, 12_000.0), (44_100, 15_000.0), (96_000, 20_000.0)] {
            let output = convert(rate, &tone(rate, frequency, 1.0), 512);
            let steady = &output[1_600..output.len() - 1_600];
            let level_db = 20.0 * (rms(steady) * std::f64::consts::SQRT_2).log10();
            assert!(level_db < -55.0, "rate {rate} leaked {level_db} dB");
        }
    }

    #[test]
    fn output_length_tracks_the_rate_ratio() {
        for rate in [8_000, 22_050, 44_100, 48_000, 96_000] {
            let input = tone(rate, 440.0, 2.0);
            let output = convert(rate, &input, 1_000);
            let expected = input.len() as f64 * f64::from(SPEECH_RATE) / f64::from(rate);
            assert!(
                (output.len() as f64 - expected).abs() <= 16.0,
                "rate {rate} produced {} of {expected}",
                output.len()
            );
        }
    }

    #[test]
    fn chunking_never_changes_the_result() {
        let input = tone(44_100, 700.0, 0.5);
        let whole = convert(44_100, &input, input.len());
        for chunk in [1, 7, 64, 441, 4_096] {
            assert_eq!(whole, convert(44_100, &input, chunk), "chunk {chunk}");
        }
    }

    #[test]
    fn stays_aligned_in_time() {
        let mut input = vec![0.0f32; 48_000];
        input[24_000] = 1.0;
        let output = convert(48_000, &input, 480);
        let peak = output
            .iter()
            .enumerate()
            .max_by(|a, b| a.1.abs().total_cmp(&b.1.abs()))
            .map(|(index, _)| index)
            .unwrap();
        assert!((peak as i64 - 8_000).abs() <= 1, "impulse landed at {peak}");
    }

    #[test]
    fn memory_stays_bounded_on_long_streams() {
        let mut resampler = SpeechResampler::new(48_000);
        let block = tone(48_000, 300.0, 0.02);
        let mut output = Vec::new();
        for _ in 0..5_000 {
            output.clear();
            resampler.process(&block, &mut output);
            assert!(resampler.pending.len() < 4 * block.len());
        }
    }

    #[test]
    fn downmix_averages_channels() {
        let mut output = Vec::new();
        downmix_interleaved(&[1.0, 0.0, 0.5, 0.5, -1.0, 1.0], 2, &mut output);
        assert_eq!(output, vec![0.5, 0.5, 0.0]);
    }
}
