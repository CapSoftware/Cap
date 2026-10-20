use cap_video_decode::scripted::{Script, ScriptFrame};

use super::{Mode, Request};

/// SplitMix64: small, fast and stable across platforms and Rust versions.
pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Self {
        Self(seed)
    }

    pub fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    pub fn below(&mut self, n: usize) -> usize {
        (self.next_u64() % n.max(1) as u64) as usize
    }

    pub fn unit(&mut self) -> f64 {
        (self.next_u64() >> 11) as f64 / (1u64 << 53) as f64
    }

    pub fn range(&mut self, low: f64, high: f64) -> f64 {
        low + (high - low) * self.unit()
    }

    pub fn chance(&mut self, p: f64) -> bool {
        self.unit() < p
    }

    pub fn pick<T: Copy>(&mut self, items: &[T]) -> T {
        items[self.below(items.len())]
    }
}

pub fn family_seed(family: &str, index: u64) -> u64 {
    let mut hash = 0xCBF2_9CE4_8422_2325u64;
    for byte in family.bytes() {
        hash = (hash ^ byte as u64).wrapping_mul(0x0100_0000_01B3);
    }
    hash ^ index.wrapping_mul(0x9E37_79B9_7F4A_7C15)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SourceKind {
    /// Constant rate with optional jitter, at or below the decoder rate.
    Cfr,
    /// Source faster than the decoder grid: several samples share a label.
    Dense,
    /// Low-light webcam: nominal 30 fps, delivers about 15 with jitter, long.
    Camera,
    /// Like `Camera` with many 3 and 4 frame gaps and a shorter duration.
    CameraFast,
    /// Screen recording with static holds of random length.
    Vfr,
    /// 30 fps screen read on a 60 fps grid (every gap is a pts hole) with long
    /// holds early in the file.
    HalfGrid,
    /// The first sample starts well after zero.
    LateStart,
    /// The synthetic screen behind the #2595 backward-jump report: 60 fps
    /// grid, gaps of 1 to 20 grid frames, a 10 s hold at 30 s and a 2.5 s
    /// hold at 95 s, 120 s long.
    Syn,
}

impl SourceKind {
    pub fn name(self) -> &'static str {
        match self {
            Self::Cfr => "cfr",
            Self::Dense => "dense",
            Self::Camera => "camera",
            Self::CameraFast => "camera-fast",
            Self::Vfr => "vfr",
            Self::HalfGrid => "halfgrid",
            Self::LateStart => "late-start",
            Self::Syn => "syn",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PatternKind {
    Sequential,
    Timeline,
    Transition,
    RandomSeeks,
    KeyframeSeeks,
    Scrub,
    BackIntoOldGap,
    Tail,
    /// The editor list from the #2595 report: play 5 to 35 s, jump to 100 to
    /// 110 s, jump back to 28 to 45 s, at 60 fps.
    Edlist,
}

impl PatternKind {
    pub fn name(self) -> &'static str {
        match self {
            Self::Sequential => "sequential",
            Self::Timeline => "timeline",
            Self::Transition => "transition",
            Self::RandomSeeks => "random-seeks",
            Self::KeyframeSeeks => "keyframe-seeks",
            Self::Scrub => "scrub",
            Self::BackIntoOldGap => "back-into-old-gap",
            Self::Tail => "tail",
            Self::Edlist => "edlist",
        }
    }
}

pub struct Source {
    pub script: Script,
    /// Decoder grid rate (the recording metadata fps).
    pub fps: u32,
    pub max_fallback_distance: u32,
}

const TIME_BASES: [i32; 6] = [600, 1000, 15360, 30000, 90000, 1_000_000];
const GOPS: [usize; 7] = [1, 10, 30, 60, 120, 240, 600];

fn script_from_times(rng: &mut Rng, times: &[f64], nominal_interval: f64) -> Script {
    let den = rng.pick(&TIME_BASES);
    let gop = rng.pick(&GOPS);
    let key_after_gap = rng.chance(0.5);
    script_with(rng, times, nominal_interval, den, gop, key_after_gap)
}

fn script_with(
    rng: &mut Rng,
    times: &[f64],
    nominal_interval: f64,
    den: i32,
    gop: usize,
    key_after_gap: bool,
) -> Script {
    let mut frames: Vec<ScriptFrame> = Vec::with_capacity(times.len());
    let mut since_key = 0usize;
    for (index, &time) in times.iter().enumerate() {
        let mut pts = (time * den as f64).round() as i64;
        if let Some(previous) = frames.last() {
            pts = pts.max(previous.pts + 1);
        }
        let gap = index
            .checked_sub(1)
            .map_or(0.0, |previous| time - times[previous]);
        let keyframe =
            index == 0 || since_key + 1 >= gop || (key_after_gap && gap > 0.5 && rng.chance(0.7));
        since_key = if keyframe { 0 } else { since_key + 1 };
        frames.push(ScriptFrame { pts, keyframe });
    }
    Script {
        time_base: (1, den),
        frames,
        last_duration: ((nominal_interval * den as f64).round() as i64).max(1),
    }
}

fn steady_times(
    rng: &mut Rng,
    start: f64,
    duration: f64,
    interval: impl Fn(&mut Rng) -> f64,
) -> Vec<f64> {
    let mut times = Vec::new();
    let mut time = start;
    while time < start + duration {
        times.push(time);
        time += interval(rng).max(0.001);
    }
    times
}

pub fn source(rng: &mut Rng, kind: SourceKind) -> Source {
    let screen = 4;
    let camera = 2;
    match kind {
        SourceKind::Cfr => {
            let (source_fps, fps) = rng.pick(&[(30.0, 30), (60.0, 60), (24.0, 30), (25.0, 30)]);
            let jitter = rng.pick(&[0.0, 0.0, 0.1, 0.3]);
            let duration = rng.range(2.0, 20.0);
            let interval = 1.0 / source_fps;
            let times = steady_times(rng, 0.0, duration, |rng| {
                interval * (1.0 + jitter * rng.range(-1.0, 1.0))
            });
            Source {
                script: script_from_times(rng, &times, interval),
                fps,
                max_fallback_distance: screen,
            }
        }
        SourceKind::Dense => {
            let source_fps = rng.pick(&[50.0, 60.0]);
            let duration = rng.range(2.0, 15.0);
            let interval = 1.0 / source_fps;
            let times = steady_times(rng, 0.0, duration, |rng| {
                interval * (1.0 + 0.1 * rng.range(-1.0, 1.0))
            });
            Source {
                script: script_from_times(rng, &times, interval),
                fps: 30,
                max_fallback_distance: screen,
            }
        }
        SourceKind::Camera | SourceKind::CameraFast => {
            let (p1, p3, p4, duration) = if kind == SourceKind::Camera {
                (
                    rng.range(0.0, 0.05),
                    rng.range(0.05, 0.15),
                    rng.range(0.0, 0.02),
                    rng.range(120.0, 200.0),
                )
            } else {
                (
                    rng.range(0.0, 0.05),
                    rng.range(0.25, 0.45),
                    rng.range(0.02, 0.1),
                    rng.range(40.0, 80.0),
                )
            };
            let times = steady_times(rng, 0.0, duration, |rng| {
                let roll = rng.unit();
                let frames = if roll < p1 {
                    1.0
                } else if roll < p1 + p3 {
                    3.0
                } else if roll < p1 + p3 + p4 {
                    4.0
                } else {
                    2.0
                };
                (frames + rng.range(-0.15, 0.15)) / 30.0
            });
            Source {
                script: script_from_times(rng, &times, 2.0 / 30.0),
                fps: 30,
                max_fallback_distance: camera,
            }
        }
        SourceKind::Vfr => {
            let fps = rng.pick(&[30, 60]);
            let interval = if fps == 60 && rng.chance(0.5) {
                1.0 / 30.0
            } else {
                1.0 / fps as f64
            };
            let hold_chance = rng.range(0.002, 0.02);
            let duration = rng.range(10.0, 90.0);
            let times = steady_times(rng, 0.0, duration, |rng| {
                if rng.chance(hold_chance) {
                    let hold = rng.pick(&[0.1, 0.4, 1.0, 2.5, 5.0, 12.0]);
                    hold * rng.range(0.5, 1.5)
                } else {
                    interval * (1.0 + 0.05 * rng.range(-1.0, 1.0))
                }
            });
            Source {
                script: script_from_times(rng, &times, interval),
                fps,
                max_fallback_distance: screen,
            }
        }
        SourceKind::HalfGrid => {
            let duration = rng.range(40.0, 120.0);
            let hold_count = 1 + rng.below(3);
            let mut holds: Vec<(f64, f64)> = (0..hold_count)
                .map(|_| (rng.range(1.0, duration * 0.3), rng.range(2.0, 12.0)))
                .collect();
            holds.sort_by(|a, b| a.0.total_cmp(&b.0));
            let mut times = Vec::new();
            let mut time = 0.0;
            let mut next_hold = 0;
            while time < duration {
                times.push(time);
                if next_hold < holds.len() && time >= holds[next_hold].0 {
                    time += holds[next_hold].1;
                    next_hold += 1;
                } else {
                    time += (1.0 + 0.05 * rng.range(-1.0, 1.0)) / 30.0;
                }
            }
            Source {
                script: script_from_times(rng, &times, 1.0 / 30.0),
                fps: 60,
                max_fallback_distance: screen,
            }
        }
        SourceKind::Syn => {
            let mut times = Vec::new();
            let mut time = 0.0;
            let holds = [(29.95, 10.08), (94.98, 2.53)];
            let mut next_hold = 0;
            while time < 120.0 {
                times.push(time);
                if next_hold < holds.len() && time >= holds[next_hold].0 {
                    time += holds[next_hold].1;
                    next_hold += 1;
                    continue;
                }
                let mut grid_frames = 1.0;
                while grid_frames < 20.0 && rng.chance(0.64) {
                    grid_frames += 1.0;
                }
                time += grid_frames / 60.0;
            }
            let gop = 20 + rng.below(20);
            Source {
                script: script_with(rng, &times, 1.0 / 60.0, 600, gop, false),
                fps: 60,
                max_fallback_distance: screen,
            }
        }
        SourceKind::LateStart => {
            let start = rng.range(0.3, 4.0);
            let interval = rng.pick(&[1.0 / 30.0, 2.0 / 30.0]);
            let duration = rng.range(3.0, 15.0);
            let times = steady_times(rng, start, duration, |rng| {
                interval * (1.0 + 0.1 * rng.range(-1.0, 1.0))
            });
            Source {
                script: script_from_times(rng, &times, interval),
                fps: 30,
                max_fallback_distance: camera,
            }
        }
    }
}

fn secs(script: &Script, ticks: i64) -> f64 {
    script.secs(ticks)
}

fn at(time: f64) -> f32 {
    time as f32
}

struct Builder {
    requests: Vec<Request>,
    playback: bool,
}

impl Builder {
    fn seek(&mut self, time: f64) {
        self.requests.push(Request {
            time: at(time.max(0.0)),
            initial: self.playback,
        });
    }

    fn play(&mut self, from: f64, frames: usize, out_fps: f64) {
        for index in 0..frames {
            self.requests.push(Request {
                time: at((from + index as f64 / out_fps).max(0.0)),
                initial: false,
            });
        }
    }

    fn seek_and_play(&mut self, from: f64, frames: usize, out_fps: f64) {
        self.seek(from);
        self.play(from + 1.0 / out_fps, frames, out_fps);
    }
}

/// Source time requests for one sequence. Times stay inside the stream except
/// for `Tail`, which plays past the last sample.
pub fn requests(rng: &mut Rng, source: &Source, kind: PatternKind, mode: Mode) -> Vec<Request> {
    let script = &source.script;
    let end = secs(script, script.end_pts());
    let first = secs(script, script.frames[0].pts);
    let fps = source.fps as f64;
    let out_fps = rng.pick(&[30.0, 60.0, 60.0]);
    let mut builder = Builder {
        requests: Vec::new(),
        playback: mode == Mode::Playback,
    };
    let frames_until =
        |from: f64, to: f64, out_fps: f64| ((to - from) * out_fps).floor().max(0.0) as usize;

    match kind {
        PatternKind::Sequential => {
            let from = if mode == Mode::Playback && rng.chance(0.5) {
                rng.range(0.0, end * 0.5)
            } else {
                0.0
            };
            builder.seek(from);
            builder.play(
                from + 1.0 / out_fps,
                frames_until(from + 1.0 / out_fps, end, out_fps),
                out_fps,
            );
        }
        PatternKind::Tail => {
            let from = (end - rng.range(0.5, 3.0)).max(0.0);
            builder.seek(from);
            builder.play(
                from,
                frames_until(from, end + rng.range(0.2, 1.0), out_fps),
                out_fps,
            );
        }
        PatternKind::Timeline => {
            for _ in 0..2 + rng.below(7) {
                let start = rng.range(0.0, end);
                let length = rng.range(0.2, 6.0).min(end - start);
                let speed = rng.pick(&[0.5, 1.0, 1.0, 1.0, 1.5, 2.0]);
                let count = (length / speed * out_fps).floor() as usize;
                for index in 0..count {
                    builder.requests.push(Request {
                        time: at(start + index as f64 * speed / out_fps),
                        initial: false,
                    });
                }
            }
        }
        PatternKind::Transition => {
            for _ in 0..1 + rng.below(3) {
                let a = rng.range(0.0, end * 0.9);
                let b = rng.range(0.0, end * 0.9);
                let overlap = 10 + rng.below(50);
                for index in 0..overlap {
                    let step = index as f64 / out_fps;
                    if a + step < end {
                        builder.requests.push(Request {
                            time: at(a + step),
                            initial: false,
                        });
                    }
                    if b + step < end {
                        builder.requests.push(Request {
                            time: at(b + step),
                            initial: false,
                        });
                    }
                }
                let after = b + overlap as f64 / out_fps;
                if after < end {
                    builder.play(
                        after,
                        frames_until(after, end, out_fps).min(rng.below(60)),
                        out_fps,
                    );
                }
            }
        }
        PatternKind::RandomSeeks => {
            for _ in 0..5 + rng.below(36) {
                let from = rng.range(0.0, end);
                let frames = frames_until(from, end, out_fps).min(rng.below(41));
                builder.seek_and_play(from, frames, out_fps);
            }
        }
        PatternKind::KeyframeSeeks => {
            let keyframes: Vec<f64> = script
                .frames
                .iter()
                .filter(|frame| frame.keyframe)
                .map(|frame| secs(script, frame.pts))
                .collect();
            for _ in 0..10 + rng.below(51) {
                let keyframe = rng.pick(&keyframes);
                let from = match rng.below(4) {
                    0 => keyframe,
                    1 => (keyframe * fps).round() / fps,
                    2 => ((keyframe * fps).round() + rng.pick(&[-1.0, 1.0])) / fps,
                    _ => keyframe + rng.range(-0.5, 0.5) / fps,
                }
                .clamp(0.0, end - 0.001);
                let frames = frames_until(from, end, out_fps).min(rng.below(6));
                builder.seek_and_play(from, frames, out_fps);
            }
        }
        PatternKind::Scrub => {
            let mut time = rng.range(0.0, end);
            builder.seek(time);
            for _ in 0..50 + rng.below(251) {
                let magnitude = if rng.chance(0.6) {
                    rng.range(1.0, 6.0)
                } else {
                    rng.range(6.0, 90.0)
                };
                let step = magnitude.round() / fps * if rng.chance(0.5) { 1.0 } else { -1.0 };
                time = (time + step).clamp(0.0, end - 0.001);
                if step.abs() * fps > 1.5 {
                    builder.seek(time);
                } else {
                    builder.requests.push(Request {
                        time: at(time),
                        initial: false,
                    });
                }
            }
        }
        PatternKind::Edlist => {
            for (from, to) in [(300, 2100), (6000, 6600), (1680, 2700)] {
                for frame in from..to {
                    let time = frame as f64 / 60.0;
                    if time < end {
                        builder.requests.push(Request {
                            time: at(time),
                            initial: frame == from && mode == Mode::Playback,
                        });
                    }
                }
            }
        }
        PatternKind::BackIntoOldGap => {
            let holds: Vec<(f64, f64)> = script
                .frames
                .windows(2)
                .map(|pair| (secs(script, pair[0].pts), secs(script, pair[1].pts)))
                .filter(|(start, next)| next - start > 1.5)
                .collect();
            let (hold_start, hold_end) =
                holds.first().copied().unwrap_or((first, first + 1.0 / fps));
            let mut position = 0.0;
            for _ in 0..1 + rng.below(3) {
                let target = (hold_end + rng.range(3.0, 30.0)).min(end - 0.01);
                if target > position {
                    builder.seek(position);
                    builder.play(
                        position + 1.0 / out_fps,
                        frames_until(position + 1.0 / out_fps, target, out_fps),
                        out_fps,
                    );
                    position = target;
                }
                let inside = rng.range(hold_start, hold_end);
                let frames = frames_until(inside, end, out_fps).min(30 + rng.below(90));
                builder.seek_and_play(inside, frames, out_fps);
                if rng.chance(0.5) {
                    position = inside + rng.range(0.0, 2.0);
                }
            }
        }
    }

    if mode == Mode::Export {
        for request in &mut builder.requests {
            request.initial = false;
        }
    }
    builder.requests
}
