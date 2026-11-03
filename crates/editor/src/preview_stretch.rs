//! Pitch-preserving time stretch for the editor preview (WSOLA).
//!
//! Each output hop overlap-adds one Hann window of input. The window's input
//! position advances by `hop * speed`, nudged within a small search radius to
//! wherever the input best continues the previous window, so periodic sounds
//! (voices, tones) keep their phase and pitch while the tempo changes.
//!
//! The stretcher pulls input sequentially and keeps no allocation on the
//! audio thread. At 1x it steps aside entirely: when the speed returns to 1x
//! it drains the remainder of its window exactly (a Hann window's falling half
//! plus the next window's rising half sum to the input) and then hands the
//! source back to the caller untouched, so 1x output stays the source itself.

pub(crate) trait StretchSource {
    fn read_frame(&self) -> usize;
    fn read(&mut self, out: &mut [f32]);
}

const HOP_SECS: f64 = 0.015;
const SEARCH_SECS: f64 = 0.012;
const COARSE: usize = 4;
const MIN_SPEED: f64 = 0.25;
const MAX_SPEED: f64 = 4.0;
const SILENT_ENERGY: f64 = 1e-10;

#[derive(Clone, Copy, Debug, PartialEq)]
enum Mode {
    Idle,
    Stretching,
    Passthrough(usize),
}

pub(crate) struct PreviewStretcher {
    channels: usize,
    hop: usize,
    frame_len: usize,
    radius: usize,
    window: Box<[f32]>,
    input: Box<[f32]>,
    capacity: usize,
    head: usize,
    input_start: usize,
    input_frames: usize,
    accumulator: Box<[f32]>,
    output: Box<[f32]>,
    output_read: usize,
    output_frames: usize,
    chunk_position: f64,
    chunk_speed: f64,
    nominal: f64,
    template: Option<usize>,
    prime: bool,
    chunk_before_seek: bool,
    mode: Mode,
    mono: Box<[f32]>,
    template_mono: Box<[f32]>,
    coarse: Box<[f32]>,
    coarse_template: Box<[f32]>,
}

impl PreviewStretcher {
    pub(crate) fn new(sample_rate: u32, channels: usize) -> Self {
        let channels = channels.max(1);
        let rate = f64::from(sample_rate.max(1));
        let hop = ((rate * HOP_SECS).round() as usize).max(16);
        let frame_len = hop * 2;
        let radius = ((rate * SEARCH_SECS).round() as usize).max(COARSE);
        let capacity = 3 * frame_len + 2 * radius + 64;
        let window = (0..frame_len)
            .map(|n| {
                let phase = std::f64::consts::TAU * n as f64 / frame_len as f64;
                (0.5 - 0.5 * phase.cos()) as f32
            })
            .collect();
        let search_len = 2 * radius + frame_len;
        Self {
            channels,
            hop,
            frame_len,
            radius,
            window,
            input: vec![0.0; capacity * channels].into_boxed_slice(),
            capacity,
            head: 0,
            input_start: 0,
            input_frames: 0,
            accumulator: vec![0.0; frame_len * channels].into_boxed_slice(),
            output: vec![0.0; hop * channels].into_boxed_slice(),
            output_read: 0,
            output_frames: 0,
            chunk_position: 0.0,
            chunk_speed: 1.0,
            nominal: 0.0,
            template: None,
            prime: false,
            chunk_before_seek: false,
            mode: Mode::Idle,
            mono: vec![0.0; search_len].into_boxed_slice(),
            template_mono: vec![0.0; frame_len].into_boxed_slice(),
            coarse: vec![0.0; search_len / COARSE + 1].into_boxed_slice(),
            coarse_template: vec![0.0; frame_len / COARSE].into_boxed_slice(),
        }
    }

    pub(crate) fn is_active(&self) -> bool {
        self.mode != Mode::Idle
    }

    /// The source frame the next output frame plays, while active.
    pub(crate) fn position(&self) -> Option<f64> {
        match self.mode {
            Mode::Idle => None,
            Mode::Passthrough(position) => Some(position as f64),
            Mode::Stretching
                if self.output_read < self.output_frames && !self.chunk_before_seek =>
            {
                Some(self.chunk_position + self.output_read as f64 * self.chunk_speed)
            }
            Mode::Stretching => Some(self.nominal),
        }
    }

    /// Jumps to `position`, where the caller has already moved the source.
    /// While stretching, the hop already playing finishes and the window
    /// behind it fades out over the next hop as the first window at the new
    /// position fades in.
    pub(crate) fn seek(&mut self, position: usize) {
        match self.mode {
            Mode::Idle => {}
            Mode::Passthrough(_) => {
                self.clear_input(position);
                self.mode = Mode::Idle;
            }
            Mode::Stretching => {
                self.clear_input(position);
                self.template = None;
                self.prime = false;
                self.nominal = position as f64;
                self.chunk_before_seek = self.output_read < self.output_frames;
            }
        }
    }

    pub(crate) fn render(&mut self, out: &mut [f32], speed: f64, source: &mut impl StretchSource) {
        let channels = self.channels;
        let frames = out.len() / channels;
        let normal = speed == 1.0;
        let mut written = 0;
        while written < frames {
            match self.mode {
                Mode::Idle => {
                    if normal {
                        source.read(&mut out[written * channels..frames * channels]);
                        return;
                    }
                    let position = source.read_frame();
                    self.clear_input(position);
                    self.start(position);
                }
                Mode::Passthrough(position) => {
                    if !normal {
                        self.start(position);
                        continue;
                    }
                    let offset = position.saturating_sub(self.input_start);
                    let available = self.input_frames.saturating_sub(offset);
                    if available == 0 {
                        self.clear_input(source.read_frame());
                        self.mode = Mode::Idle;
                        continue;
                    }
                    let count = available.min(frames - written);
                    let from = (self.head + offset) * channels;
                    out[written * channels..(written + count) * channels]
                        .copy_from_slice(&self.input[from..from + count * channels]);
                    written += count;
                    self.mode = Mode::Passthrough(position + count);
                }
                Mode::Stretching => {
                    if self.output_read == self.output_frames {
                        if normal
                            && self.chunk_speed == 1.0
                            && let Some(position) = self.template
                        {
                            self.accumulator.fill(0.0);
                            self.mode = Mode::Passthrough(position);
                            continue;
                        }
                        self.step(speed, source);
                    }
                    let count = (self.output_frames - self.output_read).min(frames - written);
                    let from = self.output_read * channels;
                    out[written * channels..(written + count) * channels]
                        .copy_from_slice(&self.output[from..from + count * channels]);
                    written += count;
                    self.output_read += count;
                }
            }
        }
    }

    fn start(&mut self, position: usize) {
        self.discard_before(position);
        if self.input_start != position {
            self.clear_input(position);
        }
        self.accumulator.fill(0.0);
        self.output_read = 0;
        self.output_frames = 0;
        self.chunk_before_seek = false;
        self.chunk_speed = 1.0;
        self.template = Some(position);
        self.prime = true;
        self.nominal = position as f64;
        self.mode = Mode::Stretching;
    }

    fn clear_input(&mut self, position: usize) {
        self.head = 0;
        self.input_start = position;
        self.input_frames = 0;
    }

    fn discard_before(&mut self, position: usize) {
        let drop = position
            .saturating_sub(self.input_start)
            .min(self.input_frames);
        self.head += drop;
        self.input_start += drop;
        self.input_frames -= drop;
        if self.input_frames == 0 {
            self.head = 0;
        }
    }

    fn input_end(&self) -> usize {
        self.input_start + self.input_frames
    }

    fn fill_input(&mut self, end: usize, source: &mut impl StretchSource) {
        let channels = self.channels;
        while self.input_end() < end {
            if self.input_frames == self.capacity {
                self.discard_before(self.input_start + self.hop.min(self.input_frames));
            }
            if self.head + self.input_frames == self.capacity {
                self.input.copy_within(
                    self.head * channels..(self.head + self.input_frames) * channels,
                    0,
                );
                self.head = 0;
            }
            let room = self.capacity - self.head - self.input_frames;
            let count = (end - self.input_end()).min(room);
            let from = (self.head + self.input_frames) * channels;
            source.read(&mut self.input[from..from + count * channels]);
            self.input_frames += count;
        }
    }

    fn sample(&self, frame: usize, channel: usize) -> f32 {
        self.input[(self.head + frame - self.input_start) * self.channels + channel]
    }

    fn step(&mut self, speed: f64, source: &mut impl StretchSource) {
        let speed = if speed.is_finite() {
            speed.clamp(MIN_SPEED, MAX_SPEED)
        } else {
            1.0
        };
        let nominal = (self.nominal.max(0.0).floor() as usize).max(self.input_start);
        let end = (nominal + self.radius + self.frame_len).max(
            self.template
                .filter(|template| *template >= self.input_start)
                .map_or(0, |template| template + self.frame_len),
        );
        self.fill_input(end, source);
        let lo = nominal.saturating_sub(self.radius).max(self.input_start);
        let hi = (nominal + self.radius).max(lo);
        self.fill_input(hi + self.frame_len, source);
        let template = self
            .template
            .filter(|template| *template >= self.input_start && template + self.frame_len <= end);
        let start = match template {
            Some(template) => self.best_start(lo, hi, nominal, template),
            None => nominal.clamp(lo, hi),
        };

        let channels = self.channels;
        if std::mem::take(&mut self.prime)
            && let Some(template) = template
        {
            for n in 0..self.hop {
                let weight = self.window[self.hop + n];
                for channel in 0..channels {
                    self.accumulator[n * channels + channel] +=
                        weight * self.sample(template + n, channel);
                }
            }
        }
        for n in 0..self.frame_len {
            let weight = self.window[n];
            for channel in 0..channels {
                self.accumulator[n * channels + channel] +=
                    weight * self.sample(start + n, channel);
            }
        }

        let hop_samples = self.hop * channels;
        self.output[..hop_samples].copy_from_slice(&self.accumulator[..hop_samples]);
        self.accumulator.copy_within(hop_samples.., 0);
        let tail = self.accumulator.len() - hop_samples;
        self.accumulator[tail..].fill(0.0);
        self.output_frames = self.hop;
        self.output_read = 0;
        self.chunk_before_seek = false;
        self.chunk_position = self.nominal;
        self.chunk_speed = speed;

        self.template = Some(start + self.hop);
        self.nominal += self.hop as f64 * speed;
        let next = (self.nominal.floor() as usize).saturating_sub(self.radius);
        self.discard_before((start + self.hop).min(next));
    }

    fn best_start(&mut self, lo: usize, hi: usize, nominal: usize, template: usize) -> usize {
        let len = self.frame_len;
        let span = hi - lo;
        let channels = self.channels;
        for i in 0..span + len {
            let mut sum = 0.0;
            for channel in 0..channels {
                sum += self.sample(lo + i, channel);
            }
            self.mono[i] = sum;
        }
        let mut template_energy = 0.0f64;
        for i in 0..len {
            let mut sum = 0.0;
            for channel in 0..channels {
                sum += self.sample(template + i, channel);
            }
            self.template_mono[i] = sum;
            template_energy += f64::from(sum) * f64::from(sum);
        }
        let fallback = nominal.clamp(lo, hi);
        if template_energy < SILENT_ENERGY * len as f64 {
            return fallback;
        }

        let coarse_len = len / COARSE;
        let coarse_count = span / COARSE + 1;
        for (i, value) in self.coarse[..coarse_count + coarse_len - 1]
            .iter_mut()
            .enumerate()
        {
            *value = self.mono[i * COARSE..(i + 1) * COARSE].iter().sum::<f32>();
        }
        for (i, value) in self.coarse_template.iter_mut().enumerate() {
            *value = self.template_mono[i * COARSE..(i + 1) * COARSE]
                .iter()
                .sum::<f32>();
        }
        let mut energy: f64 = self.coarse[..coarse_len]
            .iter()
            .map(|v| f64::from(*v) * f64::from(*v))
            .sum();
        let mut best_coarse = (fallback - lo) / COARSE;
        let mut best_score = f64::NEG_INFINITY;
        for k in 0..coarse_count {
            if k > 0 {
                let leaving = f64::from(self.coarse[k - 1]);
                let entering = f64::from(self.coarse[k + coarse_len - 1]);
                energy = (energy - leaving * leaving + entering * entering).max(0.0);
            }
            let dot: f64 = self.coarse[k..k + coarse_len]
                .iter()
                .zip(self.coarse_template.iter())
                .map(|(a, b)| f64::from(a * b))
                .sum();
            let score = dot / energy.max(SILENT_ENERGY).sqrt();
            if score > best_score {
                best_score = score;
                best_coarse = k;
            }
        }

        let center = lo + best_coarse * COARSE;
        let from = center.saturating_sub(COARSE - 1).max(lo);
        let to = (center + COARSE - 1).min(hi);
        let mut best = center.clamp(lo, hi);
        let mut best_score = f64::NEG_INFINITY;
        for candidate in from..=to {
            let offset = candidate - lo;
            let region = &self.mono[offset..offset + len];
            let mut dot = 0.0f64;
            let mut energy = 0.0f64;
            for (a, b) in region.iter().zip(self.template_mono.iter()) {
                dot += f64::from(a * b);
                energy += f64::from(a * a);
            }
            let score = dot / energy.max(SILENT_ENERGY).sqrt();
            if score > best_score {
                best_score = score;
                best = candidate;
            }
        }
        best
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const RATE: u32 = 48_000;

    struct VecSource {
        samples: Vec<f32>,
        channels: usize,
        position: usize,
    }

    impl VecSource {
        fn new(samples: Vec<f32>, channels: usize) -> Self {
            Self {
                samples,
                channels,
                position: 0,
            }
        }
    }

    impl StretchSource for VecSource {
        fn read_frame(&self) -> usize {
            self.position
        }

        fn read(&mut self, out: &mut [f32]) {
            for (i, sample) in out.iter_mut().enumerate() {
                *sample = self
                    .samples
                    .get(self.position * self.channels + i)
                    .copied()
                    .unwrap_or(0.0);
            }
            self.position += out.len() / self.channels;
        }
    }

    fn sine(frequency: f64, seconds: f64) -> Vec<f32> {
        let frames = (seconds * f64::from(RATE)) as usize;
        (0..frames)
            .map(|n| {
                ((std::f64::consts::TAU * frequency * n as f64 / f64::from(RATE)).sin() * 0.5)
                    as f32
            })
            .collect()
    }

    fn voice(seconds: f64) -> Vec<f32> {
        let frames = (seconds * f64::from(RATE)) as usize;
        let mut phase = 0.0f64;
        (0..frames)
            .map(|n| {
                let t = n as f64 / f64::from(RATE);
                let pitch = 140.0 + 25.0 * (std::f64::consts::TAU * 3.0 * t).sin();
                phase += std::f64::consts::TAU * pitch / f64::from(RATE);
                let mut value = 0.0;
                for harmonic in 1..=8 {
                    value += (phase * f64::from(harmonic)).sin() / f64::from(harmonic);
                }
                (value * 0.2) as f32
            })
            .collect()
    }

    fn render_blocks(
        stretcher: &mut PreviewStretcher,
        source: &mut VecSource,
        speed: f64,
        frames: usize,
        block: usize,
    ) -> Vec<f32> {
        let channels = source.channels;
        let mut out = vec![0.0; frames * channels];
        for chunk in out.chunks_mut(block * channels) {
            stretcher.render(chunk, speed, source);
        }
        out
    }

    fn max_step(samples: &[f32]) -> f32 {
        samples
            .windows(2)
            .map(|pair| (pair[1] - pair[0]).abs())
            .fold(0.0, f32::max)
    }

    fn zero_crossing_frequency(samples: &[f32]) -> f64 {
        let crossings = samples
            .windows(2)
            .filter(|pair| pair[0] < 0.0 && pair[1] >= 0.0)
            .count();
        crossings as f64 * f64::from(RATE) / samples.len() as f64
    }

    fn rms(samples: &[f32]) -> f64 {
        (samples
            .iter()
            .map(|v| f64::from(*v) * f64::from(*v))
            .sum::<f64>()
            / samples.len() as f64)
            .sqrt()
    }

    const SPEEDS: [f64; 7] = [0.5, 0.75, 1.25, 1.5, 1.75, 2.0, 3.0];

    #[test]
    fn normal_speed_passes_the_source_through_untouched() {
        let input = voice(1.0);
        let mut source = VecSource::new(input.clone(), 1);
        let mut stretcher = PreviewStretcher::new(RATE, 1);
        let out = render_blocks(&mut stretcher, &mut source, 1.0, 24_000, 512);
        assert_eq!(out, input[..24_000]);
        assert!(!stretcher.is_active());
        assert_eq!(source.read_frame(), 24_000);
    }

    #[test]
    fn every_speed_consumes_exactly_speed_times_the_output() {
        for speed in SPEEDS {
            let mut source = VecSource::new(voice(12.0), 1);
            let mut stretcher = PreviewStretcher::new(RATE, 1);
            let frames = 96_000;
            let out = render_blocks(&mut stretcher, &mut source, speed, frames, 480);
            assert_eq!(out.len(), frames);
            let position = stretcher.position().unwrap();
            let expected = frames as f64 * speed;
            assert!(
                (position - expected).abs() < 1e-6,
                "{speed}x reported {position}, expected {expected}"
            );
            let lookahead = source.read_frame() as f64 - position;
            assert!(
                (0.0..=(4 * stretcher.frame_len) as f64).contains(&lookahead),
                "{speed}x read {lookahead} frames ahead"
            );
        }
    }

    #[test]
    fn a_stretched_tone_keeps_its_pitch_and_level() {
        let sine_step = (std::f64::consts::TAU * 440.0 / f64::from(RATE) * 0.5) as f32;
        for speed in SPEEDS {
            let mut source = VecSource::new(sine(440.0, 10.0), 1);
            let mut stretcher = PreviewStretcher::new(RATE, 1);
            let out = render_blocks(&mut stretcher, &mut source, speed, 96_000, 512);
            let steady = &out[4_800..];
            let frequency = zero_crossing_frequency(steady);
            assert!(
                (frequency - 440.0).abs() < 4.0,
                "{speed}x played {frequency} Hz"
            );
            let level = rms(steady);
            assert!(
                (level - 0.5 / 2f64.sqrt()).abs() < 0.03,
                "{speed}x level {level}"
            );
            let largest_step = max_step(steady);
            assert!(
                largest_step < sine_step * 1.25,
                "{speed}x click of {largest_step} against {sine_step}"
            );
        }
    }

    #[test]
    fn a_stretched_voice_has_no_clicks() {
        let input = voice(10.0);
        let input_step = max_step(&input);
        for speed in SPEEDS {
            let mut source = VecSource::new(input.clone(), 1);
            let mut stretcher = PreviewStretcher::new(RATE, 1);
            let out = render_blocks(&mut stretcher, &mut source, speed, 120_000, 441);
            let step = max_step(&out);
            assert!(
                step < input_step * 1.5,
                "{speed}x step {step} against the source's {input_step}"
            );
        }
    }

    #[test]
    fn switching_from_normal_speed_starts_exactly_where_the_source_was() {
        let input = voice(6.0);
        let mut source = VecSource::new(input.clone(), 1);
        let mut stretcher = PreviewStretcher::new(RATE, 1);
        let mut out = render_blocks(&mut stretcher, &mut source, 1.0, 10_000, 500);
        let switch = out.len();
        let hop = stretcher.hop;
        out.extend(render_blocks(&mut stretcher, &mut source, 2.0, 48_000, 500));
        for (played, original) in out[switch..switch + hop]
            .iter()
            .zip(&input[switch..switch + hop])
        {
            assert!((played - original).abs() < 1e-6);
        }
        assert!(max_step(&out) < max_step(&input) * 1.5);
    }

    #[test]
    fn switching_back_to_normal_speed_returns_the_untouched_source() {
        let input = voice(10.0);
        for speed in SPEEDS {
            let mut source = VecSource::new(input.clone(), 1);
            let mut stretcher = PreviewStretcher::new(RATE, 1);
            let mut out = render_blocks(&mut stretcher, &mut source, speed, 30_000, 512);
            let clock = stretcher.position().unwrap();
            let mut exact_from = None;
            let mut previous: Option<f64> = None;
            for i in 0..48_000 {
                let stretching = stretcher.mode == Mode::Stretching;
                let position = stretcher.position().unwrap_or(source.read_frame() as f64);
                let mut frame = [0.0];
                stretcher.render(&mut frame, 1.0, &mut source);
                out.push(frame[0]);
                if stretching {
                    continue;
                }
                let first = *exact_from.get_or_insert(i);
                if first == i {
                    let expected = clock + i as f64;
                    assert!(
                        (position - expected).abs()
                            <= (stretcher.radius as f64)
                                + stretcher.hop as f64 * (speed - 1.0).abs(),
                        "{speed}x handed back at {position}, the clock read {expected}"
                    );
                }
                assert_eq!(position.fract(), 0.0);
                assert_eq!(frame[0], input[position as usize]);
                if let Some(previous) = previous {
                    assert_eq!(position, previous + 1.0);
                }
                previous = Some(position);
            }
            assert!(exact_from.unwrap() <= 2 * stretcher.hop + 1);
            assert!(!stretcher.is_active(), "{speed}x never handed back");
            assert!(max_step(&out) < max_step(&input) * 1.5);
        }
    }

    #[test]
    fn speed_changes_mid_playback_are_seamless_and_keep_time() {
        let input = voice(30.0);
        let input_step = max_step(&input);
        let mut source = VecSource::new(input, 1);
        let mut stretcher = PreviewStretcher::new(RATE, 1);
        let mut out = Vec::new();
        let mut previous_speed = 1.0;
        for (speed, frames) in [
            (1.0, 9_600),
            (1.25, 9_600),
            (2.0, 9_600),
            (3.0, 9_600),
            (0.5, 9_600),
            (1.75, 9_600),
            (1.0, 9_600),
            (1.5, 9_600),
            (0.75, 9_600),
        ] {
            let before = stretcher.position().unwrap_or(source.read_frame() as f64);
            out.extend(render_blocks(
                &mut stretcher,
                &mut source,
                speed,
                frames,
                480,
            ));
            let after = stretcher.position().unwrap_or(source.read_frame() as f64);
            let advanced = after - before;
            let allowed =
                stretcher.hop as f64 * (speed - previous_speed).abs() + stretcher.radius as f64;
            assert!(
                (advanced - frames as f64 * speed).abs() <= allowed,
                "{speed}x advanced {advanced} for {frames} frames"
            );
            previous_speed = speed;
        }
        let step = max_step(&out);
        assert!(step < input_step * 1.5, "step {step} vs {input_step}");
    }

    #[test]
    fn a_seek_crossfades_and_lands_on_the_new_position() {
        let mut source = VecSource::new(sine(330.0, 20.0), 1);
        let mut stretcher = PreviewStretcher::new(RATE, 1);
        let mut out = render_blocks(&mut stretcher, &mut source, 2.0, 20_000, 480);
        source.position = 400_123;
        stretcher.seek(400_123);
        assert_eq!(stretcher.position(), Some(400_123.0));
        out.extend(render_blocks(&mut stretcher, &mut source, 2.0, 20_000, 480));
        let position = stretcher.position().unwrap();
        assert!((position - (400_123.0 + 40_000.0)).abs() <= 2.0 * stretcher.hop as f64);
        let sine_step = (std::f64::consts::TAU * 330.0 / f64::from(RATE) * 0.5) as f32;
        assert!(max_step(&out) < sine_step * 1.25);
    }

    #[test]
    fn a_seek_while_stretching_at_normal_speed_still_hands_back_the_source() {
        let input = voice(10.0);
        let mut source = VecSource::new(input.clone(), 1);
        let mut stretcher = PreviewStretcher::new(RATE, 1);
        render_blocks(&mut stretcher, &mut source, 1.5, 10_000, 480);
        render_blocks(&mut stretcher, &mut source, 1.0, 100, 100);
        source.position = 200_000;
        stretcher.seek(200_000);
        let hop = stretcher.hop;
        let unfinished = stretcher.output_frames - stretcher.output_read;
        let out = render_blocks(&mut stretcher, &mut source, 1.0, 9_600, 480);
        assert!(!stretcher.is_active());
        assert_eq!(
            out[unfinished + hop..],
            input[200_000 + hop..200_000 + 9_600 - unfinished]
        );
    }

    #[test]
    fn a_seek_while_idle_leaves_the_source_alone() {
        let input = voice(4.0);
        let mut source = VecSource::new(input.clone(), 1);
        let mut stretcher = PreviewStretcher::new(RATE, 1);
        render_blocks(&mut stretcher, &mut source, 1.0, 1_000, 100);
        source.position = 50_000;
        stretcher.seek(50_000);
        let out = render_blocks(&mut stretcher, &mut source, 1.0, 1_000, 100);
        assert_eq!(out, input[50_000..51_000]);
    }

    #[test]
    fn silence_stays_silent_and_finite() {
        let mut source = VecSource::new(vec![0.0; 96_000], 2);
        let mut stretcher = PreviewStretcher::new(RATE, 2);
        let out = render_blocks(&mut stretcher, &mut source, 3.0, 20_000, 512);
        assert!(out.iter().all(|v| *v == 0.0));
        let mut source = VecSource::new(Vec::new(), 2);
        let mut stretcher = PreviewStretcher::new(RATE, 2);
        let out = render_blocks(&mut stretcher, &mut source, 0.5, 20_000, 512);
        assert!(out.iter().all(|v| *v == 0.0));
    }

    #[test]
    fn channels_stay_separate_and_aligned() {
        let left = sine(440.0, 8.0);
        let mut interleaved = Vec::with_capacity(left.len() * 6);
        for value in &left {
            interleaved.extend([*value, 0.0, *value, 0.0, 0.0, -*value]);
        }
        let mut source = VecSource::new(interleaved, 6);
        let mut stretcher = PreviewStretcher::new(RATE, 6);
        let out = render_blocks(&mut stretcher, &mut source, 1.5, 48_000, 512);
        for frame in out.chunks(6) {
            assert_eq!(frame[1], 0.0);
            assert_eq!(frame[3], 0.0);
            assert_eq!(frame[4], 0.0);
            assert_eq!(frame[0], frame[2]);
            assert_eq!(frame[0], -frame[5]);
        }
        let first: Vec<f32> = out.iter().step_by(6).copied().collect();
        assert!(rms(&first[4_800..]) > 0.3);
    }

    #[test]
    fn block_size_does_not_change_the_audio() {
        for rate in [44_100, 48_000, 96_000] {
            let input = voice(4.0);
            let mut a = PreviewStretcher::new(rate, 1);
            let mut b = PreviewStretcher::new(rate, 1);
            let mut source_a = VecSource::new(input.clone(), 1);
            let mut source_b = VecSource::new(input, 1);
            let one = render_blocks(&mut a, &mut source_a, 1.75, 30_000, 1);
            let many = render_blocks(&mut b, &mut source_b, 1.75, 30_000, 997);
            assert_eq!(one, many);
        }
    }

    #[test]
    fn long_runs_keep_exact_time_at_two_hours() {
        let mut source = VecSource::new(Vec::new(), 1);
        source.position = 2 * 3_600 * RATE as usize;
        let mut stretcher = PreviewStretcher::new(RATE, 1);
        let start = source.position as f64;
        render_blocks(&mut stretcher, &mut source, 3.0, 480_000, 512);
        let position = stretcher.position().unwrap();
        assert!((position - (start + 1_440_000.0)).abs() < 1e-6);
    }
}
