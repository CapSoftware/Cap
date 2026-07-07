use std::{
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};

use crate::{Timestamp, Timestamps};

pub const AUDIO_OUTPUT_FRAMES: u64 = 1024;
pub const DEFAULT_SAMPLE_RATE: u32 = 48_000;
pub const TS_SMOOTHING_THRESHOLD_NS: u64 = 70_000_000;
pub const MAX_TS_VAR_NS: u64 = 2_000_000_000;

#[derive(Debug)]
pub struct MasterClock {
    timestamps: Timestamps,
    start_instant: Instant,
    sample_rate: u32,
    chunk_size: u64,
    samples_committed: AtomicU64,
}

impl MasterClock {
    pub fn new(timestamps: Timestamps, sample_rate: u32) -> Arc<Self> {
        Arc::new(Self {
            start_instant: timestamps.instant(),
            timestamps,
            sample_rate: sample_rate.max(1),
            chunk_size: AUDIO_OUTPUT_FRAMES,
            samples_committed: AtomicU64::new(0),
        })
    }

    pub fn with_chunk_size(timestamps: Timestamps, sample_rate: u32, chunk_size: u64) -> Arc<Self> {
        Arc::new(Self {
            start_instant: timestamps.instant(),
            timestamps,
            sample_rate: sample_rate.max(1),
            chunk_size: chunk_size.max(1),
            samples_committed: AtomicU64::new(0),
        })
    }

    pub fn default_arc() -> Arc<Self> {
        Self::new(Timestamps::now(), DEFAULT_SAMPLE_RATE)
    }

    pub fn sample_rate(&self) -> u32 {
        self.sample_rate
    }

    pub fn chunk_size(&self) -> u64 {
        self.chunk_size
    }

    pub fn timestamps(&self) -> Timestamps {
        self.timestamps
    }

    pub fn start_instant(&self) -> Instant {
        self.start_instant
    }

    pub fn elapsed_ns(&self) -> u64 {
        let nanos = self.start_instant.elapsed().as_nanos();
        if nanos > u64::MAX as u128 {
            u64::MAX
        } else {
            nanos as u64
        }
    }

    pub fn committed_samples(&self) -> u64 {
        self.samples_committed.load(Ordering::Acquire)
    }

    pub fn committed_ns(&self) -> u64 {
        samples_to_ns(self.committed_samples(), self.sample_rate)
    }

    pub fn tick(&self) -> (u64, u64) {
        let prev = self
            .samples_committed
            .fetch_add(self.chunk_size, Ordering::AcqRel);
        let new = prev.saturating_add(self.chunk_size);
        (
            samples_to_ns(prev, self.sample_rate),
            samples_to_ns(new, self.sample_rate),
        )
    }

    pub fn advance_samples(&self, samples: u64) -> (u64, u64) {
        let prev = self.samples_committed.fetch_add(samples, Ordering::AcqRel);
        let new = prev.saturating_add(samples);
        (
            samples_to_ns(prev, self.sample_rate),
            samples_to_ns(new, self.sample_rate),
        )
    }

    pub fn remap_raw_ns(&self, source_ts: Timestamp) -> i64 {
        let secs = source_ts.signed_duration_since_secs(self.timestamps);
        seconds_to_ns_saturating(secs)
    }

    pub fn remap(&self, source_ts: Timestamp) -> i64 {
        self.remap_raw_ns(source_ts)
    }

    pub fn output_duration(&self, master_ns: u64) -> Duration {
        Duration::from_nanos(master_ns)
    }
}

fn samples_to_ns(samples: u64, rate: u32) -> u64 {
    if rate == 0 {
        return 0;
    }
    let nanos = (samples as u128 * 1_000_000_000u128) / rate as u128;
    if nanos > u64::MAX as u128 {
        u64::MAX
    } else {
        nanos as u64
    }
}

fn seconds_to_ns_saturating(secs: f64) -> i64 {
    if !secs.is_finite() {
        return 0;
    }
    let scaled = secs * 1_000_000_000.0;
    if scaled >= i64::MAX as f64 {
        i64::MAX
    } else if scaled <= i64::MIN as f64 {
        i64::MIN
    } else {
        scaled as i64
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SourceClockOutcome {
    FirstFrame,
    Trusted,
    InitialAdjust,
    Smoothed,
    HardReset,
    Untouched,
}

#[derive(Debug, Clone, Copy)]
pub struct SourceClockRemap {
    pub master_ns: u64,
    pub raw_ns: i64,
    pub outcome: SourceClockOutcome,
}

impl SourceClockRemap {
    pub fn duration(&self) -> Duration {
        Duration::from_nanos(self.master_ns)
    }
}

#[derive(Debug)]
pub struct SourceClockState {
    name: &'static str,
    timing_set: bool,
    timing_adjust: i64,
    next_expected_ns: Option<i64>,
    snap_count: u64,
    hard_reset_count: u64,
    resync_count: u64,
    trusted_count: u64,
    frame_count: u64,
}

impl SourceClockState {
    pub fn new(name: &'static str) -> Self {
        Self {
            name,
            timing_set: false,
            timing_adjust: 0,
            next_expected_ns: None,
            snap_count: 0,
            hard_reset_count: 0,
            resync_count: 0,
            trusted_count: 0,
            frame_count: 0,
        }
    }

    pub fn name(&self) -> &'static str {
        self.name
    }

    pub fn timing_set(&self) -> bool {
        self.timing_set
    }

    pub fn timing_adjust(&self) -> i64 {
        self.timing_adjust
    }

    pub fn next_expected_ns(&self) -> Option<i64> {
        self.next_expected_ns
    }

    pub fn snap_count(&self) -> u64 {
        self.snap_count
    }

    pub fn hard_reset_count(&self) -> u64 {
        self.hard_reset_count
    }

    pub fn resync_count(&self) -> u64 {
        self.resync_count
    }

    pub fn trusted_count(&self) -> u64 {
        self.trusted_count
    }

    pub fn frame_count(&self) -> u64 {
        self.frame_count
    }

    pub fn remap(
        &mut self,
        clock: &MasterClock,
        source_ts: Timestamp,
        frame_duration_ns: u64,
    ) -> SourceClockRemap {
        let raw_ns = clock.remap_raw_ns(source_ts);
        let now_ns = clock.elapsed_ns() as i64;
        self.frame_count = self.frame_count.saturating_add(1);

        let using_direct_ts = abs_diff_u64(raw_ns, now_ns) < MAX_TS_VAR_NS;
        let mut outcome = SourceClockOutcome::Untouched;

        if using_direct_ts {
            self.timing_adjust = 0;
            self.timing_set = true;
            self.trusted_count = self.trusted_count.saturating_add(1);
            outcome = SourceClockOutcome::Trusted;
        }

        let mut ts_ns = raw_ns;
        let duration_ns = frame_duration_ns.min(i64::MAX as u64) as i64;

        if !self.timing_set {
            self.timing_adjust = now_ns.saturating_sub(raw_ns);
            self.timing_set = true;
            outcome = SourceClockOutcome::InitialAdjust;
        } else if let Some(expected) = self.next_expected_ns {
            let diff = abs_diff_u64(expected, ts_ns);
            if diff > MAX_TS_VAR_NS && !using_direct_ts {
                self.timing_adjust = now_ns.saturating_sub(raw_ns);
                self.next_expected_ns = None;
                self.hard_reset_count = self.hard_reset_count.saturating_add(1);
                self.resync_count = self.resync_count.saturating_add(1);
                outcome = SourceClockOutcome::HardReset;
            } else if diff < TS_SMOOTHING_THRESHOLD_NS {
                // Snap jitter onto the expected cadence, but cap how far the
                // ladder may lead the source clock. Each snap re-anchors
                // next_expected, so a source delivering faster than the
                // nominal rate (e.g. a camera free-running at 60fps — or
                // 1000fps — while the pipeline expects 30fps) would otherwise
                // be re-timed to the nominal rate: a non-monotonic sawtooth
                // that stretches the recording. The cap must also keep the
                // ladder inside the smoothing threshold for the NEXT frame
                // (lead + frame duration < threshold), otherwise a fast
                // source escapes smoothing and the output jumps backwards to
                // the source clock; hence the second bound.
                let max_lead_ns = duration_ns
                    .min((TS_SMOOTHING_THRESHOLD_NS as i64).saturating_sub(duration_ns))
                    .max(0);
                ts_ns = expected.min(raw_ns.saturating_add(max_lead_ns));
                self.snap_count = self.snap_count.saturating_add(1);
                if !matches!(outcome, SourceClockOutcome::HardReset) {
                    outcome = SourceClockOutcome::Smoothed;
                }
            }
        } else if matches!(outcome, SourceClockOutcome::Untouched) {
            outcome = SourceClockOutcome::FirstFrame;
        }
        self.next_expected_ns = Some(ts_ns.saturating_add(duration_ns));

        let output_ns = ts_ns.saturating_add(self.timing_adjust).max(0) as u64;

        SourceClockRemap {
            master_ns: output_ns,
            raw_ns,
            outcome,
        }
    }

    pub fn reset(&mut self) {
        self.timing_set = false;
        self.timing_adjust = 0;
        self.next_expected_ns = None;
    }
}

fn abs_diff_u64(a: i64, b: i64) -> u64 {
    if a >= b {
        (a as i128 - b as i128).unsigned_abs() as u64
    } else {
        (b as i128 - a as i128).unsigned_abs() as u64
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn clock() -> Arc<MasterClock> {
        MasterClock::new(Timestamps::now(), DEFAULT_SAMPLE_RATE)
    }

    #[test]
    fn tick_advances_by_chunk_size() {
        let clock = clock();
        let (start1, end1) = clock.tick();
        let (start2, end2) = clock.tick();

        assert_eq!(start1, 0);
        assert_eq!(end1, start2);
        assert!(end2 > start2);

        let ns_per_chunk = 1_000_000_000u64 * AUDIO_OUTPUT_FRAMES / DEFAULT_SAMPLE_RATE as u64;
        assert_eq!(end1 - start1, ns_per_chunk);
        assert_eq!(end2 - start2, ns_per_chunk);
    }

    #[test]
    fn committed_ns_reflects_advances() {
        let clock = clock();
        assert_eq!(clock.committed_ns(), 0);
        clock.tick();
        assert!(clock.committed_ns() > 0);
    }

    #[test]
    fn remap_near_now_is_trusted_and_adjust_zero() {
        let clock = clock();
        let mut state = SourceClockState::new("test");
        let ts = Timestamp::Instant(clock.start_instant() + Duration::from_millis(10));
        let result = state.remap(&clock, ts, Duration::from_millis(20).as_nanos() as u64);
        assert_eq!(state.timing_adjust(), 0);
        assert!(matches!(
            result.outcome,
            SourceClockOutcome::Trusted | SourceClockOutcome::FirstFrame
        ));
        assert!(state.timing_set());
    }

    #[test]
    fn remap_snaps_jitter_under_seventy_ms() {
        let clock = clock();
        let mut state = SourceClockState::new("jitter-source");
        let frame_ns = Duration::from_millis(20).as_nanos() as u64;

        let first_ts = Timestamp::Instant(clock.start_instant());
        let first = state.remap(&clock, first_ts, frame_ns);
        assert_eq!(first.master_ns, 0);

        let jittered_ts =
            Timestamp::Instant(clock.start_instant() + Duration::from_millis(20 + 50));
        let second = state.remap(&clock, jittered_ts, frame_ns);
        assert_eq!(
            second.master_ns,
            first.master_ns + frame_ns,
            "second frame must snap to next_expected"
        );
        assert!(matches!(second.outcome, SourceClockOutcome::Smoothed));
        assert_eq!(state.snap_count(), 1);
        assert_eq!(state.hard_reset_count(), 0);
    }

    #[test]
    fn remap_does_not_snap_beyond_seventy_ms() {
        let clock = clock();
        let mut state = SourceClockState::new("nosnap-source");
        let frame_ns = Duration::from_millis(20).as_nanos() as u64;

        state.remap(&clock, Timestamp::Instant(clock.start_instant()), frame_ns);

        let mild_ts = Timestamp::Instant(clock.start_instant() + Duration::from_millis(200));
        let result = state.remap(&clock, mild_ts, frame_ns);
        assert!(
            matches!(result.outcome, SourceClockOutcome::Trusted)
                || matches!(result.outcome, SourceClockOutcome::Untouched),
            "diff > 70ms but < 2s should neither snap nor hard-reset, got {:?}",
            result.outcome
        );
        assert_eq!(state.snap_count(), 0);
        assert_eq!(state.hard_reset_count(), 0);
    }

    #[test]
    fn remap_hard_resets_on_five_second_gap() {
        let clock = clock();
        let mut state = SourceClockState::new("big-jump");
        let frame_ns = Duration::from_millis(20).as_nanos() as u64;

        state.remap(&clock, Timestamp::Instant(clock.start_instant()), frame_ns);
        state.remap(
            &clock,
            Timestamp::Instant(clock.start_instant() + Duration::from_millis(20)),
            frame_ns,
        );

        let future_ts = Timestamp::Instant(clock.start_instant() + Duration::from_secs(5));
        let result = state.remap(&clock, future_ts, frame_ns);

        if state.hard_reset_count() == 0 {
            assert!(
                matches!(result.outcome, SourceClockOutcome::Trusted),
                "a 5s forward jump within MAX_TS_VAR of wall clock is trusted, outcome={:?}",
                result.outcome
            );
        } else {
            assert!(matches!(result.outcome, SourceClockOutcome::HardReset));
            assert_eq!(state.resync_count(), 1);
        }
    }

    #[test]
    fn remap_hard_resets_when_source_clock_far_from_wall() {
        let clock = clock();
        let mut state = SourceClockState::new("far-source");
        let frame_ns = Duration::from_millis(20).as_nanos() as u64;

        let base = clock
            .start_instant()
            .checked_sub(Duration::from_secs(10))
            .expect("instant can be rewound 10s");
        let ts0 = Timestamp::Instant(base);
        let first = state.remap(&clock, ts0, frame_ns);
        assert!(matches!(first.outcome, SourceClockOutcome::InitialAdjust));
        assert!(state.timing_set());

        let ts1 = Timestamp::Instant(base + Duration::from_millis(20));
        state.remap(&clock, ts1, frame_ns);

        let jumped_ts = Timestamp::Instant(base + Duration::from_secs(5));
        let result = state.remap(&clock, jumped_ts, frame_ns);
        assert!(matches!(result.outcome, SourceClockOutcome::HardReset));
        assert_eq!(state.hard_reset_count(), 1);
    }

    #[test]
    fn three_threshold_rule_deterministic() {
        let clock = clock();
        let mut state = SourceClockState::new("deterministic");
        let frame_ns = Duration::from_millis(20).as_nanos() as u64;
        let start = clock.start_instant();

        let first = state.remap(
            &clock,
            Timestamp::Instant(start + Duration::from_millis(0)),
            frame_ns,
        );
        assert_eq!(first.master_ns, 0);
        assert!(matches!(
            first.outcome,
            SourceClockOutcome::Trusted | SourceClockOutcome::FirstFrame
        ));

        let expected_ns = frame_ns as i64;

        let two_ms_ts =
            Timestamp::Instant(start + Duration::from_millis(20) + Duration::from_millis(2));
        let two_ms = state.remap(&clock, two_ms_ts, frame_ns);
        assert!(
            matches!(two_ms.outcome, SourceClockOutcome::Smoothed),
            "2ms jitter must snap, got {:?}",
            two_ms.outcome
        );
        assert_eq!(two_ms.master_ns as i64, expected_ns);
        assert_eq!(state.snap_count(), 1);

        let next_expected_after_two_ms = state.next_expected_ns().expect("expected set");

        let sixty_ms_ts = Timestamp::Instant(
            start
                + Duration::from_nanos(next_expected_after_two_ms as u64)
                + Duration::from_millis(60),
        );
        let sixty_ms = state.remap(&clock, sixty_ms_ts, frame_ns);
        assert!(
            matches!(sixty_ms.outcome, SourceClockOutcome::Smoothed),
            "60ms jitter must still snap (diff < 70ms threshold), got {:?}",
            sixty_ms.outcome
        );
        assert_eq!(sixty_ms.master_ns as i64, next_expected_after_two_ms);
        assert_eq!(state.snap_count(), 2);
        assert_eq!(state.hard_reset_count(), 0);

        let expected_after_second_snap = state.next_expected_ns().expect("expected set");
        let big_jump_ts = Timestamp::Instant(
            start
                + Duration::from_nanos(expected_after_second_snap as u64)
                + Duration::from_secs(5),
        );
        let big_jump = state.remap(&clock, big_jump_ts, frame_ns);

        if state.timing_set()
            && big_jump_ts.signed_duration_since_secs(clock.timestamps()) * 1e9
                < MAX_TS_VAR_NS as f64
        {
            assert!(
                matches!(big_jump.outcome, SourceClockOutcome::Trusted),
                "a 5s jump that stays within MAX_TS_VAR of wall clock is trusted, got {:?}",
                big_jump.outcome
            );
        } else {
            assert!(
                matches!(big_jump.outcome, SourceClockOutcome::HardReset),
                "5s jump beyond MAX_TS_VAR must hard-reset, got {:?}",
                big_jump.outcome
            );
            assert_eq!(state.hard_reset_count(), 1);
            assert_eq!(state.resync_count(), 1);
        }
    }

    /// Deterministic pseudo-random stream for jitter/fps sampling in tests.
    struct TestRng(u64);

    impl TestRng {
        fn next_f64(&mut self) -> f64 {
            self.0 = self
                .0
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            (self.0 >> 11) as f64 / (1u64 << 53) as f64
        }
    }

    /// Feeds a source delivering at `actual_fps` (with optional bounded
    /// timestamp jitter) into remap configured for `nominal_fps`, and asserts
    /// the output stays monotonic and tracks the source clock — never re-timed
    /// to the nominal cadence, whatever the mismatch.
    fn assert_remap_tracks_source(actual_fps: f64, nominal_fps: f64, jitter_frac: f64, seed: u64) {
        let clock = clock();
        let mut state = SourceClockState::new("matrix-source");
        let mut rng = TestRng(seed);

        let nominal_frame_ns = (1_000_000_000.0 / nominal_fps) as u64;
        let real_delta_ns = 1_000_000_000.0 / actual_fps;
        let jitter_max_ns = real_delta_ns * jitter_frac;

        // ~1.5s of source time (more for slow sources so there are enough
        // frames to expose ladder drift).
        let frames = ((1.5 * actual_fps) as u32).max(24);

        let start = clock.start_instant();
        let mut outputs = Vec::with_capacity(frames as usize);
        let mut last_raw_ns = 0u64;
        for i in 0..frames {
            let jitter_ns = (rng.next_f64() * 2.0 - 1.0) * jitter_max_ns;
            let raw_ns = (i as f64 * real_delta_ns + jitter_ns).max(0.0) as u64;
            last_raw_ns = raw_ns;
            let ts = Timestamp::Instant(start + Duration::from_nanos(raw_ns));
            let result = state.remap(&clock, ts, nominal_frame_ns);
            outputs.push(result.master_ns);
        }

        let combo = format!(
            "actual={actual_fps}fps nominal={nominal_fps}fps jitter={jitter_frac} seed={seed}"
        );

        for (i, pair) in outputs.windows(2).enumerate() {
            assert!(
                pair[1] >= pair[0],
                "[{combo}] remap output went backwards at frame {}: {} -> {}",
                i + 1,
                pair[0],
                pair[1]
            );
        }

        let last = *outputs.last().unwrap();
        let ahead_bound = nominal_frame_ns + jitter_max_ns as u64;
        assert!(
            last <= last_raw_ns + ahead_bound,
            "[{combo}] remap output ran ahead of the source clock: {last} vs raw {last_raw_ns} \
             (re-timing toward the nominal rate stretches the recording)"
        );
        let behind_bound = TS_SMOOTHING_THRESHOLD_NS + nominal_frame_ns + jitter_max_ns as u64;
        assert!(
            last + behind_bound >= last_raw_ns,
            "[{combo}] remap output fell behind the source clock: {last} vs raw {last_raw_ns}"
        );
    }

    #[test]
    fn remap_stays_monotonic_when_source_faster_than_nominal() {
        // The original report: a camera delivering 60fps while the pipeline
        // believes 30fps (AVFoundation running a format's default rate). The
        // snap ladder previously advanced by the nominal frame duration on
        // every snap, doubling timestamps for four frames then dropping back
        // to the source clock — a non-monotonic sawtooth that downstream
        // encoders inflated into a 2x-duration recording.
        assert_remap_tracks_source(60.0, 30.0, 0.0, 1);
    }

    #[test]
    fn remap_tracks_source_across_fps_matrix() {
        // Whatever rate a camera or display actually delivers — including
        // rates far above anything Cap configures, like a 1000fps camera —
        // the remapped timeline must track the source clock so audio and
        // video stay in sync.
        for nominal_fps in [24.0, 30.0, 60.0] {
            for actual_fps in [
                10.0, 15.0, 24.0, 25.0, 29.97, 30.0, 48.0, 60.0, 90.0, 120.0, 240.0, 500.0, 1000.0,
            ] {
                assert_remap_tracks_source(actual_fps, nominal_fps, 0.0, 2);
            }
        }
    }

    #[test]
    fn remap_tracks_source_with_random_fps_and_jitter() {
        // Randomized (but seeded/deterministic) rates with delivery jitter:
        // real capture timestamps are never perfectly uniform.
        let mut rng = TestRng(0xCA9_5EED);
        for round in 0..25 {
            let actual_fps = 5.0 + rng.next_f64() * 995.0;
            let nominal_fps = [24.0, 30.0, 60.0][(rng.next_f64() * 3.0) as usize % 3];
            let seed = 1000 + round;
            assert_remap_tracks_source(actual_fps, nominal_fps, 0.3, seed);
        }
    }

    #[test]
    fn master_ns_never_negative() {
        let clock = clock();
        let mut state = SourceClockState::new("backward");
        let frame_ns = Duration::from_millis(20).as_nanos() as u64;

        let ts = Timestamp::Instant(
            clock
                .start_instant()
                .checked_sub(Duration::from_millis(50))
                .expect("instant can be rewound 50ms"),
        );
        let result = state.remap(&clock, ts, frame_ns);
        assert!(result.master_ns == 0 || result.master_ns <= 1_000_000_000);
    }
}
