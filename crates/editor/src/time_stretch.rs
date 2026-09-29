use std::collections::VecDeque;

const GRAIN_FRAMES: usize = 1536;
const HOP_FRAMES: usize = GRAIN_FRAMES / 2;
const SEARCH_FRAMES: usize = 384;
const COARSE_STEP: usize = 8;
const FINE_STEP: usize = 2;

/// Streaming WSOLA time-stretcher for interleaved f32 audio: consumes source
/// audio `rate` times faster than it produces output while keeping pitch.
/// Each grain is placed where it best matches the natural continuation of
/// the previous one, which avoids the phasiness of plain overlap-add.
pub struct TimeStretch {
    channels: usize,
    rate: f64,
    window: Vec<f32>,
    input: Vec<f32>,
    input_offset: usize,
    analysis_frame: f64,
    previous_frame: Option<usize>,
    accumulator: Vec<f32>,
    ready: VecDeque<f32>,
}

impl TimeStretch {
    pub fn new(channels: usize, rate: f64) -> Self {
        let channels = channels.max(1);
        let window = (0..GRAIN_FRAMES)
            .map(|i| {
                let x = i as f32 / GRAIN_FRAMES as f32;
                0.5 - 0.5 * (std::f32::consts::TAU * x).cos()
            })
            .collect();
        Self {
            channels,
            rate: rate.clamp(0.25, 4.0),
            window,
            input: Vec::new(),
            input_offset: 0,
            analysis_frame: SEARCH_FRAMES as f64,
            previous_frame: None,
            accumulator: vec![0.0; GRAIN_FRAMES * channels],
            ready: VecDeque::new(),
        }
    }

    pub fn channels(&self) -> usize {
        self.channels
    }

    pub fn reset(&mut self) {
        let (channels, rate) = (self.channels, self.rate);
        *self = Self::new(channels, rate);
    }

    fn input_frames(&self) -> usize {
        self.input_offset + self.input.len() / self.channels
    }

    /// Absolute source frame the next hop needs available.
    pub fn frames_needed(&self) -> usize {
        let target = self.analysis_frame as usize + SEARCH_FRAMES;
        let natural = self.previous_frame.map_or(0, |frame| frame + HOP_FRAMES);
        target.max(natural) + GRAIN_FRAMES
    }

    pub fn input_shortfall(&self) -> usize {
        self.frames_needed().saturating_sub(self.input_frames())
    }

    pub fn push_input(&mut self, samples: &[f32]) {
        self.input.extend_from_slice(samples);
    }

    pub fn ready_samples(&self) -> usize {
        self.ready.len()
    }

    pub fn pop_ready(&mut self) -> Option<f32> {
        self.ready.pop_front()
    }

    /// Source seconds already pulled from the buffer but not yet heard.
    pub fn pending_source_secs(&self, sample_rate: u32) -> f64 {
        let unconsumed = self.input_frames() as f64 - self.analysis_frame;
        let queued = (self.ready.len() / self.channels) as f64 * self.rate;
        (unconsumed + queued).max(0.0) / f64::from(sample_rate.max(1))
    }

    fn frame(&self, absolute: usize, channel: usize) -> f32 {
        let local = absolute.saturating_sub(self.input_offset);
        self.input
            .get(local * self.channels + channel)
            .copied()
            .unwrap_or(0.0)
    }

    fn correlation(&self, candidate: usize, natural: usize, step: usize) -> f32 {
        let mut score = 0.0;
        let mut i = 0;
        while i < HOP_FRAMES {
            for c in 0..self.channels {
                score += self.frame(candidate + i, c) * self.frame(natural + i, c);
            }
            i += step;
        }
        score
    }

    fn best_in(
        &self,
        natural: usize,
        lowest: usize,
        highest: usize,
        candidate_step: usize,
        compare_step: usize,
    ) -> usize {
        let mut best = lowest;
        let mut best_score = f32::MIN;
        let mut candidate = lowest;
        while candidate <= highest {
            let score = self.correlation(candidate, natural, compare_step);
            if score > best_score {
                best_score = score;
                best = candidate;
            }
            candidate += candidate_step;
        }
        best
    }

    fn best_frame(&self, target: usize) -> usize {
        let Some(previous) = self.previous_frame else {
            return target;
        };
        let natural = previous + HOP_FRAMES;
        let lowest = target.saturating_sub(SEARCH_FRAMES).max(self.input_offset);
        let highest = target + SEARCH_FRAMES;
        let coarse = self.best_in(natural, lowest, highest, COARSE_STEP, COARSE_STEP);
        self.best_in(
            natural,
            coarse.saturating_sub(COARSE_STEP - 1).max(lowest),
            (coarse + COARSE_STEP - 1).min(highest),
            1,
            FINE_STEP,
        )
    }

    /// Emits one hop of output. Call only when `input_shortfall()` is 0.
    pub fn hop(&mut self) {
        let target = self.analysis_frame as usize;
        let start = self.best_frame(target);
        for i in 0..GRAIN_FRAMES {
            let weight = self.window[i];
            for c in 0..self.channels {
                self.accumulator[i * self.channels + c] += self.frame(start + i, c) * weight;
            }
        }
        let emitted = HOP_FRAMES * self.channels;
        self.ready.extend(self.accumulator.drain(..emitted));
        self.accumulator.resize(GRAIN_FRAMES * self.channels, 0.0);
        self.previous_frame = Some(start);
        self.analysis_frame += HOP_FRAMES as f64 * self.rate;

        let keep_from = start
            .min(target)
            .saturating_sub(SEARCH_FRAMES)
            .max(self.input_offset);
        let drop = keep_from - self.input_offset;
        if drop > GRAIN_FRAMES * 4 {
            self.input.drain(..drop * self.channels);
            self.input_offset += drop;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn zero_crossings(samples: &[f32]) -> usize {
        samples
            .windows(2)
            .filter(|pair| (pair[0] < 0.0) != (pair[1] < 0.0))
            .count()
    }

    #[test]
    fn doubling_speed_keeps_pitch_and_halves_duration() {
        let sample_rate = 48_000.0;
        let tone = 440.0;
        let source: Vec<f32> = (0..sample_rate as usize * 4)
            .map(|i| (std::f32::consts::TAU * tone * i as f32 / sample_rate).sin())
            .collect();
        let mut stretch = TimeStretch::new(1, 2.0);
        let mut output = Vec::new();
        let mut fed = 0;
        while output.len() < sample_rate as usize {
            let need = stretch.input_shortfall();
            if need > 0 {
                let end = (fed + need + 1024).min(source.len());
                stretch.push_input(&source[fed..end]);
                fed = end;
            }
            stretch.hop();
            while let Some(sample) = stretch.pop_ready() {
                output.push(sample);
            }
        }
        let steady = &output[GRAIN_FRAMES..sample_rate as usize];
        let seconds = steady.len() as f32 / sample_rate;
        let frequency = zero_crossings(steady) as f32 / 2.0 / seconds;
        assert!((frequency - tone).abs() < 15.0, "frequency {frequency}");
        assert!(fed as f32 > sample_rate * 1.8, "consumed {fed}");
    }

    #[test]
    fn aligns_opposite_phase_stereo() {
        let sample_rate = 48_000.0;
        let tone = 440.0;
        let frames = GRAIN_FRAMES * 4;
        let mut source = Vec::with_capacity(frames * 2);
        for i in 0..frames {
            let sample = (std::f32::consts::TAU * tone * i as f32 / sample_rate).sin();
            source.push(sample);
            source.push(-sample);
        }
        let mut stretch = TimeStretch::new(2, 1.5);
        stretch.push_input(&source);
        stretch.previous_frame = Some(0);
        let natural = HOP_FRAMES;
        let best = stretch.best_frame(HOP_FRAMES + 150);
        let energy = stretch.correlation(natural, natural, 1);
        let score = stretch.correlation(best, natural, 1);
        assert!(score > energy * 0.95, "score {score} energy {energy}");
    }
}
