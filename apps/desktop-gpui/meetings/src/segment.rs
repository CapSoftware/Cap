use std::collections::VecDeque;

#[cfg(test)]
mod tests;

pub const SAMPLE_RATE: u32 = 16_000;

#[derive(Clone, Debug, PartialEq)]
pub struct SegmenterConfig {
    pub frame_ms: u32,
    pub enter_db: f32,
    pub exit_db: f32,
    pub min_level_db: f32,
    pub min_zero_crossing_rate: f32,
    pub floor_window_ms: u32,
    pub floor_rise: f32,
    pub pre_roll_ms: u32,
    pub post_roll_ms: u32,
    pub close_silence_ms: u32,
    pub min_speech_ms: u32,
    pub max_segment_ms: u32,
    pub cut_search_ms: u32,
    pub cut_window_ms: u32,
}

impl Default for SegmenterConfig {
    fn default() -> Self {
        Self {
            frame_ms: 20,
            enter_db: 9.0,
            exit_db: 5.0,
            min_level_db: -60.0,
            min_zero_crossing_rate: 0.015,
            floor_window_ms: 3_000,
            floor_rise: 0.05,
            pre_roll_ms: 240,
            post_roll_ms: 240,
            close_silence_ms: 700,
            min_speech_ms: 200,
            max_segment_ms: 25_000,
            cut_search_ms: 4_000,
            cut_window_ms: 100,
        }
    }
}

impl SegmenterConfig {
    /// The microphone: a quiet room's speech (someone across the table, the
    /// user speaking softly) sits around -70 dBFS, below the default -60 dBFS
    /// gate, and was never transcribed. The floor-relative rule still decides;
    /// only the absolute minimum is lower. The computer's audio keeps the
    /// default: codec noise on a call would pass a lower gate.
    ///
    /// Hearing those quiet stretches means fewer pauses close a segment, and
    /// live captions transcribe an open segment again as it grows, so their
    /// cost rises with its length: segments are cut at 18 s (at the quietest
    /// moment of their last 4 s, as at 25 s), which keeps recording CPU at
    /// what the -60 dBFS gate cost (at 20 s it was 3 points of a core more).
    /// At 15 s the speaker model merged two people it keeps apart at 18 s.
    pub fn microphone() -> Self {
        Self {
            min_level_db: -72.0,
            max_segment_ms: 18_000,
            ..Self::default()
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct SpeechSegment {
    pub start_sample: u64,
    pub samples: Vec<f32>,
    pub speech_ms: u64,
}

impl SpeechSegment {
    pub fn end_sample(&self) -> u64 {
        self.start_sample.saturating_add(self.samples.len() as u64)
    }
}

#[derive(Clone, Copy, Debug)]
struct Frame {
    db: f32,
    speech: bool,
}

#[derive(Debug)]
struct Open {
    start_sample: u64,
    samples: Vec<f32>,
    frames: Vec<Frame>,
}

impl Open {
    fn last_speech(&self) -> Option<usize> {
        self.frames.iter().rposition(|f| f.speech)
    }

    fn speech_frames(&self) -> usize {
        self.frames.iter().filter(|f| f.speech).count()
    }

    fn trailing_silence(&self) -> usize {
        match self.last_speech() {
            Some(i) => self.frames.len() - 1 - i,
            None => self.frames.len(),
        }
    }
}

#[derive(Clone, Copy, Debug)]
struct Frames {
    len: usize,
    pre_roll: usize,
    post_roll: usize,
    close: usize,
    min_speech: usize,
    max_segment: usize,
    cut_search: usize,
    cut_window: usize,
    floor_window: u64,
}

impl Frames {
    fn from(config: &SegmenterConfig) -> Self {
        let frame_ms = config.frame_ms.clamp(5, 100);
        let len = (SAMPLE_RATE * frame_ms / 1000) as usize;
        let frames = |ms: u32| (ms / frame_ms) as usize;
        let max_segment = frames(config.max_segment_ms).max(10);
        let cut_window = frames(config.cut_window_ms).max(1);
        let cut_search = frames(config.cut_search_ms).clamp(cut_window, max_segment / 2);
        Self {
            len,
            pre_roll: frames(config.pre_roll_ms),
            post_roll: frames(config.post_roll_ms),
            close: frames(config.close_silence_ms).max(1),
            min_speech: frames(config.min_speech_ms),
            max_segment,
            cut_search,
            cut_window,
            floor_window: frames(config.floor_window_ms).max(1) as u64,
        }
    }
}

#[derive(Debug)]
pub struct Segmenter {
    config: SegmenterConfig,
    frames: Frames,
    expected: Option<u64>,
    pending: Vec<f32>,
    pending_start: u64,
    history: VecDeque<f32>,
    floor: Option<f32>,
    minima: VecDeque<(u64, f32)>,
    frame_index: u64,
    in_speech: bool,
    open: Option<Open>,
    speech_ms_total: u64,
}

impl Segmenter {
    pub fn new(config: SegmenterConfig) -> Self {
        let frames = Frames::from(&config);
        Self {
            config,
            frames,
            expected: None,
            pending: Vec::with_capacity(frames.len),
            pending_start: 0,
            history: VecDeque::new(),
            floor: None,
            minima: VecDeque::new(),
            frame_index: 0,
            in_speech: false,
            open: None,
            speech_ms_total: 0,
        }
    }

    pub fn speech_ms_total(&self) -> u64 {
        self.speech_ms_total
    }

    pub fn noise_floor_db(&self) -> Option<f32> {
        self.floor
    }

    pub fn open_snapshot(&self) -> Option<(u64, &[f32])> {
        self.open
            .as_ref()
            .filter(|o| o.speech_frames() > 0)
            .map(|o| (o.start_sample, o.samples.as_slice()))
    }

    pub fn push(&mut self, start_sample: u64, samples: &[f32]) -> Vec<SpeechSegment> {
        let mut out = Vec::new();
        let mut start = start_sample;
        let mut samples = samples;
        if let Some(expected) = self.expected {
            if start > expected {
                out.extend(self.flush());
            } else if start < expected {
                let skip = usize::try_from(expected - start).unwrap_or(usize::MAX);
                if skip >= samples.len() {
                    return out;
                }
                samples = &samples[skip..];
                start = expected;
            }
        }
        if samples.is_empty() {
            return out;
        }
        if self.pending.is_empty() {
            self.pending_start = start;
        }
        self.expected = Some(start.saturating_add(samples.len() as u64));
        let mut frame = std::mem::take(&mut self.pending);
        for &sample in samples {
            frame.push(if sample.is_finite() { sample } else { 0.0 });
            if frame.len() == self.frames.len {
                let frame_start = self.pending_start;
                self.pending_start = frame_start.saturating_add(frame.len() as u64);
                self.process(frame_start, &frame, &mut out);
                frame.clear();
            }
        }
        self.pending = frame;
        out
    }

    pub fn flush(&mut self) -> Option<SpeechSegment> {
        let pending = std::mem::take(&mut self.pending);
        self.pending_start = self.pending_start.saturating_add(pending.len() as u64);
        let segment = match self.open.as_mut() {
            Some(open) => {
                open.samples.extend_from_slice(&pending);
                self.close()
            }
            None => None,
        };
        self.history.clear();
        self.in_speech = false;
        segment
    }

    fn process(&mut self, frame_start: u64, frame: &[f32], out: &mut Vec<SpeechSegment>) {
        let (db, zcr) = analyse(frame);
        let floor = self.floor.unwrap_or(db);
        let loud = db > self.config.min_level_db;
        let speech = if self.in_speech {
            loud && db > floor + self.config.exit_db
        } else {
            loud && db > floor + self.config.enter_db && zcr >= self.config.min_zero_crossing_rate
        };
        self.in_speech = speech;
        self.update_floor(db);

        let info = Frame { db, speech };
        let Some(open) = self.open.as_mut() else {
            if speech {
                let pre_roll = self.history.len();
                let mut samples: Vec<f32> = self.history.drain(..).collect();
                samples.extend_from_slice(frame);
                let mut frames = vec![
                    Frame {
                        db: self.config.min_level_db,
                        speech: false,
                    };
                    pre_roll / self.frames.len
                ];
                frames.push(info);
                self.open = Some(Open {
                    start_sample: frame_start.saturating_sub(pre_roll as u64),
                    samples,
                    frames,
                });
            } else {
                self.remember(frame);
            }
            return;
        };
        open.samples.extend_from_slice(frame);
        open.frames.push(info);
        if open.trailing_silence() >= self.frames.close {
            out.extend(self.close());
        } else if open.frames.len() >= self.frames.max_segment {
            self.cut(out);
        }
    }

    fn remember(&mut self, samples: &[f32]) {
        self.history.extend(samples.iter().copied());
        let cap = self.frames.pre_roll * self.frames.len;
        let excess = self.history.len().saturating_sub(cap);
        let excess = excess.div_ceil(self.frames.len) * self.frames.len;
        self.history.drain(..excess.min(self.history.len()));
    }

    fn update_floor(&mut self, db: f32) {
        let index = self.frame_index;
        self.frame_index += 1;
        while self.minima.back().is_some_and(|(_, d)| *d >= db) {
            self.minima.pop_back();
        }
        self.minima.push_back((index, db));
        while self
            .minima
            .front()
            .is_some_and(|(i, _)| i + self.frames.floor_window <= index)
        {
            self.minima.pop_front();
        }
        let window_min = self.minima.front().map(|(_, d)| *d).unwrap_or(db);
        self.floor = Some(match self.floor {
            Some(floor) if window_min >= floor => {
                floor + (window_min - floor) * self.config.floor_rise.clamp(0.0, 1.0)
            }
            _ => window_min,
        });
    }

    fn emit(
        &mut self,
        start_sample: u64,
        samples: Vec<f32>,
        speech_frames: usize,
    ) -> Option<SpeechSegment> {
        if speech_frames == 0 || speech_frames < self.frames.min_speech {
            return None;
        }
        let speech_ms = speech_frames as u64 * u64::from(self.config.frame_ms.clamp(5, 100));
        self.speech_ms_total = self.speech_ms_total.saturating_add(speech_ms);
        Some(SpeechSegment {
            start_sample,
            samples,
            speech_ms,
        })
    }

    fn close(&mut self) -> Option<SpeechSegment> {
        let mut open = self.open.take()?;
        let end_frame = open
            .last_speech()
            .map(|i| i + 1 + self.frames.post_roll)
            .unwrap_or(0);
        let end = (end_frame * self.frames.len).min(open.samples.len());
        let tail = open.samples.split_off(end);
        let speech_frames = open.speech_frames();
        self.history.clear();
        self.remember(&tail);
        self.emit(open.start_sample, open.samples, speech_frames)
    }

    fn cut(&mut self, out: &mut Vec<SpeechSegment>) {
        let Some(open) = self.open.take() else {
            return;
        };
        let total = open.frames.len();
        let window = self.frames.cut_window;
        let search_from = total.saturating_sub(self.frames.cut_search).max(1);
        let search_to = total.saturating_sub(window).max(search_from);
        let power: Vec<f64> = open
            .frames
            .iter()
            .map(|f| 10f64.powf(f64::from(f.db) / 10.0))
            .collect();
        let window_power = |s: usize| {
            power[s.min(total)..(s + window).min(total)]
                .iter()
                .sum::<f64>()
        };
        let best = (search_from..=search_to)
            .min_by(|a, b| window_power(*a).total_cmp(&window_power(*b)))
            .unwrap_or(search_from);
        let cut_frame = (best + window / 2).clamp(1, total.saturating_sub(1).max(1));
        let cut = (cut_frame * self.frames.len).min(open.samples.len());

        let Open {
            start_sample,
            mut samples,
            mut frames,
        } = open;
        let rest_samples = samples.split_off(cut);
        let rest_frames = frames.split_off(cut_frame.min(frames.len()));
        let speech_frames = frames.iter().filter(|f| f.speech).count();
        out.extend(self.emit(start_sample, samples, speech_frames));
        let remainder = Open {
            start_sample: start_sample.saturating_add(cut as u64),
            samples: rest_samples,
            frames: rest_frames,
        };
        if remainder.frames.is_empty() {
            return;
        }
        let silent = remainder.trailing_silence() >= self.frames.close;
        self.open = Some(remainder);
        if silent {
            out.extend(self.close());
        }
    }
}

fn analyse(frame: &[f32]) -> (f32, f32) {
    if frame.is_empty() {
        return (-120.0, 0.0);
    }
    let n = frame.len() as f64;
    let mean = frame.iter().map(|&s| f64::from(s)).sum::<f64>() / n;
    let mut energy = 0.0f64;
    let mut crossings = 0usize;
    let mut previous: Option<bool> = None;
    for &sample in frame {
        let centred = f64::from(sample) - mean;
        energy += centred * centred;
        if centred != 0.0 {
            let positive = centred > 0.0;
            if previous.is_some_and(|p| p != positive) {
                crossings += 1;
            }
            previous = Some(positive);
        }
    }
    let db = (10.0 * (energy / n + 1e-12).log10()).max(-120.0) as f32;
    let zcr = crossings as f32 / frame.len() as f32;
    (db, zcr)
}
