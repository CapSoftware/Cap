//! Two outputs mixed into one recording: when both play the same sound (one
//! app sending it to the speakers and the headset), the sum holds it twice,
//! a few tens of milliseconds apart, which blurs speech. The gate compares
//! the two outputs' loudness over the last couple of seconds and, while they
//! carry the same sound, keeps only the louder one. Different sounds (a call
//! on the headset, a video on the speakers) are summed as before.

/// Samples per loudness frame: 10 ms at 48 kHz.
const FRAME: usize = 480;
/// Frames compared: 2 s.
const WINDOW: usize = 200;
/// How far apart the two copies can be: 250 ms either way.
const MAX_LAG: usize = 25;
const RING: usize = WINDOW + 2 * MAX_LAG;
/// A decision every 100 ms.
const EVERY: usize = 10;
/// Loudness this alike (correlation, best lag) is the same sound; below
/// [`DIFFERENT`] it is not; in between nothing changes.
const SAME: f32 = 0.9;
const DIFFERENT: f32 = 0.7;
/// Decisions that must agree before the output changes: 500 ms, so it
/// cannot flip inside a word.
const HOLD: u32 = 5;
/// Mean loudness below this (about -60 dBFS) is silence: nothing to judge.
const ACTIVE: f32 = 1e-3;
/// The kept output changes only for one this much louder (6 dB).
const LOUDER: f32 = 2.0;
/// Gains move to a new setting over 20 ms.
const FADE: usize = 960;

pub struct MixGate {
    rings: [[f32; RING]; 2],
    head: usize,
    filled: usize,
    sums: [f32; 2],
    counted: usize,
    frames: usize,
    /// `None`: both summed; `Some(leg)`: only that one.
    keep: Option<usize>,
    proposal: Option<Option<usize>>,
    agreed: u32,
    gains: [f32; 2],
    target: [f32; 2],
    fade_left: usize,
    switches: u64,
}

impl Default for MixGate {
    fn default() -> Self {
        Self {
            rings: [[0.0; RING]; 2],
            head: 0,
            filled: 0,
            sums: [0.0; 2],
            counted: 0,
            frames: 0,
            keep: None,
            proposal: None,
            agreed: 0,
            gains: [1.0, 1.0],
            target: [1.0, 1.0],
            fade_left: 0,
            switches: 0,
        }
    }
}

impl MixGate {
    /// How many times the output changed between both and one.
    pub fn switches(&self) -> u64 {
        self.switches
    }

    /// `Some(leg)` while only that output is kept.
    pub fn keeps(&self) -> Option<usize> {
        self.keep
    }

    /// Mixes two aligned stretches of the outputs into `out` (cleared
    /// first). Allocates nothing once `out` has grown to the usual size.
    pub fn mix(&mut self, a: &[f32], b: &[f32], out: &mut Vec<f32>) {
        out.clear();
        for (&x, &y) in a.iter().zip(b) {
            self.sums[0] += x * x;
            self.sums[1] += y * y;
            self.counted += 1;
            if self.counted == FRAME {
                self.end_frame();
            }
            if self.fade_left > 0 {
                for leg in 0..2 {
                    self.gains[leg] += (self.target[leg] - self.gains[leg]) / self.fade_left as f32;
                }
                self.fade_left -= 1;
            }
            out.push((x * self.gains[0] + y * self.gains[1]).clamp(-1.0, 1.0));
        }
    }

    fn end_frame(&mut self) {
        for leg in 0..2 {
            self.rings[leg][self.head] = (self.sums[leg] / FRAME as f32).sqrt();
            self.sums[leg] = 0.0;
        }
        self.counted = 0;
        self.head = (self.head + 1) % RING;
        self.filled = (self.filled + 1).min(RING);
        self.frames += 1;
        if self.frames % EVERY == 0 && self.filled == RING {
            self.decide();
        }
    }

    /// Loudness of `leg`, `ago` frames back (0: the newest).
    fn at(&self, leg: usize, ago: usize) -> f32 {
        self.rings[leg][(self.head + RING - 1 - ago) % RING]
    }

    fn decide(&mut self) {
        // The first output's window sits MAX_LAG frames back, so the second
        // can be compared up to MAX_LAG either side of it.
        let n = WINDOW as f32;
        let (mut sum_a, mut sq_a) = (0.0f32, 0.0f32);
        for k in 0..WINDOW {
            let v = self.at(0, k + MAX_LAG);
            sum_a += v;
            sq_a += v * v;
        }
        let mean_a = sum_a / n;
        let var_a = sq_a / n - mean_a * mean_a;
        let mut best = -1.0f32;
        let mut mean_b_at_best = 0.0f32;
        for lag in 0..=2 * MAX_LAG {
            let (mut sum_b, mut sq_b, mut cross) = (0.0f32, 0.0f32, 0.0f32);
            for k in 0..WINDOW {
                let x = self.at(0, k + MAX_LAG);
                let y = self.at(1, k + lag);
                sum_b += y;
                sq_b += y * y;
                cross += x * y;
            }
            let mean_b = sum_b / n;
            let var_b = sq_b / n - mean_b * mean_b;
            let cov = cross / n - mean_a * mean_b;
            let r = if var_a > 1e-12 && var_b > 1e-12 {
                cov / (var_a * var_b).sqrt()
            } else {
                0.0
            };
            if r > best {
                best = r;
                mean_b_at_best = mean_b;
            }
        }
        let means = [mean_a, mean_b_at_best];
        let silent = [means[0] < ACTIVE, means[1] < ACTIVE];
        let want = if silent[0] || silent[1] {
            // A pause says nothing about likeness: stay, unless the output
            // kept is the quiet one while the other has sound, which must
            // not be lost.
            match self.keep {
                Some(kept) if silent[kept] && !silent[1 - kept] => None,
                keep => keep,
            }
        } else if best >= SAME {
            let louder = if means[1] > means[0] { 1 } else { 0 };
            match self.keep {
                Some(kept) if means[1 - kept] < means[kept] * LOUDER => Some(kept),
                _ => Some(louder),
            }
        } else if best < DIFFERENT {
            None
        } else {
            self.keep
        };
        if want == self.keep {
            self.proposal = None;
            self.agreed = 0;
            return;
        }
        if self.proposal == Some(want) {
            self.agreed += 1;
        } else {
            self.proposal = Some(want);
            self.agreed = 1;
        }
        if self.agreed >= HOLD {
            self.keep = want;
            self.target = match want {
                None => [1.0, 1.0],
                Some(0) => [1.0, 0.0],
                Some(_) => [0.0, 1.0],
            };
            self.fade_left = FADE;
            self.switches += 1;
            self.proposal = None;
            self.agreed = 0;
            tracing::info!(
                keep = ?want,
                likeness = best,
                switches = self.switches,
                "meeting computer audio: the two outputs {}",
                if want.is_some() { "carry the same sound; keeping the louder" } else { "differ; mixing both" }
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::alloc::{GlobalAlloc, Layout, System};
    use std::cell::Cell;

    thread_local! {
        static ALLOCATIONS: Cell<u64> = const { Cell::new(0) };
    }

    struct Counting;

    unsafe impl GlobalAlloc for Counting {
        unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
            let _ = ALLOCATIONS.try_with(|n| n.set(n.get() + 1));
            unsafe { System.alloc(layout) }
        }
        unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
            unsafe { System.dealloc(ptr, layout) }
        }
    }

    #[global_allocator]
    static COUNTING: Counting = Counting;

    /// Speech-like test sound: noise in bursts of 80-400 ms with pauses,
    /// from a fixed seed.
    fn voice(seed: u64, seconds: usize) -> Vec<f32> {
        let mut state = seed
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        let mut next = move || {
            state = state
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            (state >> 33) as f32 / (1u64 << 31) as f32
        };
        let total = seconds * 48_000;
        let mut out = Vec::with_capacity(total);
        while out.len() < total {
            let talk = (0.08 + next() * 0.32) * 48_000.0;
            let level = 0.05 + next() * 0.2;
            for _ in 0..talk as usize {
                out.push((next() * 2.0 - 1.0) * level);
            }
            let pause = (0.05 + next() * 0.25) * 48_000.0;
            out.extend(std::iter::repeat_n(0.0, pause as usize));
        }
        out.truncate(total);
        out
    }

    fn delayed(signal: &[f32], ms: usize, gain: f32) -> Vec<f32> {
        let d = ms * 48;
        (0..signal.len())
            .map(|i| if i >= d { signal[i - d] * gain } else { 0.0 })
            .collect()
    }

    /// Runs the gate over the two outputs in 10 ms pieces, as the capture
    /// hands them over.
    fn run(gate: &mut MixGate, a: &[f32], b: &[f32]) -> Vec<f32> {
        let mut all = Vec::with_capacity(a.len());
        let mut out = Vec::new();
        for (x, y) in a.chunks(480).zip(b.chunks(480)) {
            gate.mix(x, y, &mut out);
            all.extend_from_slice(&out);
        }
        all
    }

    #[test]
    fn the_same_sound_on_both_outputs_is_kept_once() {
        let call = voice(7, 20);
        let headset = call.clone();
        let speakers = delayed(&call, 35, 0.11);
        let mut gate = MixGate::default();
        let out = run(&mut gate, &speakers, &headset);
        assert_eq!(gate.keeps(), Some(1), "the louder output");
        assert_eq!(gate.switches(), 1);
        // After it settled (well within 5 s), the recording is the headset's
        // sound alone, with no second copy.
        let tail = 10 * 48_000;
        let diff: f32 = out[tail..]
            .iter()
            .zip(&headset[tail..])
            .map(|(o, h)| (o - h).abs())
            .fold(0.0, f32::max);
        assert!(diff < 1e-6, "{diff}");
    }

    #[test]
    fn different_sounds_on_the_two_outputs_are_both_kept() {
        let call = voice(7, 30);
        let video = voice(99, 30);
        let mut gate = MixGate::default();
        let out = run(&mut gate, &video, &call);
        assert_eq!(gate.keeps(), None);
        assert_eq!(gate.switches(), 0);
        for (i, o) in out.iter().enumerate() {
            assert!((o - (video[i] + call[i]).clamp(-1.0, 1.0)).abs() < 1e-6);
        }
    }

    #[test]
    fn a_silent_output_leaves_the_other_as_captured() {
        let call = voice(3, 10);
        let silent = vec![0.0; call.len()];
        let mut gate = MixGate::default();
        let out = run(&mut gate, &silent, &call);
        assert_eq!(gate.switches(), 0);
        assert_eq!(out, call);
    }

    #[test]
    fn the_gate_lets_go_when_the_outputs_part_and_never_flips_inside_a_word() {
        // 15 s of one sound on both, then 15 s of different sounds.
        let call = voice(11, 30);
        let mut speakers = delayed(&call, 40, 0.5);
        let other = voice(12, 15);
        speakers[15 * 48_000..].copy_from_slice(&other);
        let mut gate = MixGate::default();
        run(&mut gate, &speakers, &call);
        assert_eq!(gate.keeps(), None);
        assert_eq!(gate.switches(), 2, "once to one output, once back");
    }

    #[test]
    fn a_stretch_that_is_only_partly_alike_changes_nothing() {
        // The video repeats part of the call quietly under its own sound:
        // alike enough to be unsure, never enough to drop an output.
        let call = voice(21, 30);
        let echo = delayed(&call, 30, 0.3);
        let own = voice(22, 30);
        let video: Vec<f32> = own.iter().zip(&echo).map(|(a, b)| a + b).collect();
        let mut gate = MixGate::default();
        run(&mut gate, &video, &call);
        assert_eq!(gate.keeps(), None);
        assert_eq!(gate.switches(), 0);
    }

    #[test]
    fn mixing_allocates_nothing_once_running() {
        let call = voice(5, 6);
        let speakers = delayed(&call, 35, 0.3);
        let mut gate = MixGate::default();
        let mut out = Vec::with_capacity(4_800);
        let before = ALLOCATIONS.with(Cell::get);
        for (x, y) in speakers.chunks(480).zip(call.chunks(480)) {
            gate.mix(x, y, &mut out);
        }
        assert_eq!(ALLOCATIONS.with(Cell::get), before);
        assert_eq!(gate.keeps(), Some(1));
    }

    /// `cargo test --release -p cap-meeting-platform gate_cost -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn gate_cost() {
        let call = voice(5, 600);
        let speakers = delayed(&call, 35, 0.3);
        let mut gate = MixGate::default();
        let mut out = Vec::with_capacity(480);
        let started = std::time::Instant::now();
        for (x, y) in speakers.chunks(480).zip(call.chunks(480)) {
            gate.mix(x, y, &mut out);
        }
        let spent = started.elapsed();
        println!(
            "GATE_COST 600 s of two outputs mixed in {:.1} ms = {:.4} % of one core",
            spent.as_secs_f64() * 1000.0,
            spent.as_secs_f64() / 600.0 * 100.0
        );
    }

    /// A call with long pauses on both outputs (the quieter one carries it
    /// at -14 dB): each pause leaves a window with nothing to compare, which
    /// let the gate go every time. It now stays with one output throughout.
    #[test]
    fn pauses_in_the_call_do_not_flip_the_gate() {
        let talk = voice(31, 60);
        let mut call = talk.clone();
        for second in 0..60 {
            if second % 7 >= 4 {
                call[second * 48_000..(second + 1) * 48_000].fill(0.0);
            }
        }
        let quiet = delayed(&call, 40, 0.2);
        let mut gate = MixGate::default();
        run(&mut gate, &call, &quiet);
        assert_eq!(gate.switches(), 1, "once to the louder output, and stays");
        assert_eq!(gate.keeps(), Some(0));
    }

    /// The output kept goes quiet while the other carries something new:
    /// the gate lets go so that sound is recorded.
    #[test]
    fn new_sound_on_the_dropped_output_is_never_lost() {
        let call = voice(41, 40);
        let mut loud = call.clone();
        let mut quiet = delayed(&call, 40, 0.3);
        // From 20 s the loud output stops and the quiet one plays a video.
        loud[20 * 48_000..].fill(0.0);
        let video = voice(42, 20);
        quiet[20 * 48_000..].copy_from_slice(&video);
        let mut gate = MixGate::default();
        let out = run(&mut gate, &loud, &quiet);
        assert_eq!(gate.keeps(), None);
        // The last 10 s are the video as played.
        let tail = 30 * 48_000;
        let diff = out[tail..]
            .iter()
            .zip(&quiet[tail..])
            .map(|(o, v)| (o - v).abs())
            .fold(0.0f32, f32::max);
        assert!(diff < 1e-6, "{diff}");
    }
}
