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
/// How far from its source time a frame must be stamped to count as moved off
/// it: under the shortest display refresh in use (240 Hz, 4.2 ms), above
/// capture-timestamp jitter.
const OFF_SOURCE_TIME_NS: u64 = 4_000_000;

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
    last_cadence_output_ns: Option<u64>,
    detect_skipped_frames: bool,
    pending_lag_ns: Option<i64>,
    skip_confirmed: bool,
    off_source_time: bool,
    skip_count: u64,
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
            last_cadence_output_ns: None,
            detect_skipped_frames: false,
            pending_lag_ns: None,
            skip_confirmed: false,
            off_source_time: false,
            skip_count: 0,
            snap_count: 0,
            hard_reset_count: 0,
            resync_count: 0,
            trusted_count: 0,
            frame_count: 0,
        }
    }

    /// Frames that arrive a whole cadence slot late because the source skipped
    /// frames are moved onto their real timestamp once the next frame shows the
    /// source kept its cadence (the lag did not shrink), instead of being
    /// snapped back a slot for the rest of the recording. A single late frame,
    /// or a backlog that drains, is still smoothed onto the cadence. Only for
    /// sources stamped at capture time: on sources stamped on callback arrival
    /// (Windows cameras), scheduling jitter can persist for a frame and read as
    /// a skip.
    pub fn detecting_skipped_frames(mut self) -> Self {
        self.detect_skipped_frames = true;
        self
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

    pub fn skip_count(&self) -> u64 {
        self.skip_count
    }

    pub fn lag_pending(&self) -> bool {
        self.pending_lag_ns.is_some()
    }

    /// Whether the last frame was stamped `OFF_SOURCE_TIME_NS` or more away
    /// from its own source time: a pending skip, or a frame the cadence moved
    /// a display refresh early or late. Only tracked with
    /// `detecting_skipped_frames`.
    pub fn off_source_time(&self) -> bool {
        self.off_source_time
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
        self.remap_ns(
            clock.remap_raw_ns(source_ts),
            clock.elapsed_ns() as i64,
            frame_duration_ns,
            true,
        )
    }

    pub fn remap_preserving_cadence(
        &mut self,
        clock: &MasterClock,
        source_ts: Timestamp,
        frame_duration_ns: u64,
    ) -> SourceClockRemap {
        self.remap_ns(
            clock.remap_raw_ns(source_ts),
            clock.elapsed_ns() as i64,
            frame_duration_ns,
            false,
        )
    }

    fn remap_ns(
        &mut self,
        raw_ns: i64,
        now_ns: i64,
        frame_duration_ns: u64,
        smooth: bool,
    ) -> SourceClockRemap {
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
        let pending_lag_ns = self.pending_lag_ns.take();
        let skip_confirmed = std::mem::take(&mut self.skip_confirmed);

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
            } else if smooth
                && diff < TS_SMOOTHING_THRESHOLD_NS
                && self.skipped_frames(
                    raw_ns - expected,
                    duration_ns,
                    pending_lag_ns,
                    skip_confirmed,
                )
            {
                self.skip_confirmed = true;
                self.skip_count = self.skip_count.saturating_add(1);
            } else if smooth && diff < TS_SMOOTHING_THRESHOLD_NS {
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
        self.off_source_time =
            self.detect_skipped_frames && abs_diff_u64(ts_ns, raw_ns) >= OFF_SOURCE_TIME_NS;

        let mut output_ns = ts_ns.saturating_add(self.timing_adjust).max(0) as u64;
        if smooth {
            self.last_cadence_output_ns = None;
        } else {
            if let Some(previous) = self.last_cadence_output_ns
                && !matches!(outcome, SourceClockOutcome::HardReset)
                && output_ns < previous
            {
                output_ns = previous;
                outcome = SourceClockOutcome::Smoothed;
            }
            self.last_cadence_output_ns = Some(output_ns);
        }

        SourceClockRemap {
            master_ns: output_ns,
            raw_ns,
            outcome,
        }
    }

    fn skipped_frames(
        &mut self,
        lag_ns: i64,
        duration_ns: i64,
        pending_lag_ns: Option<i64>,
        skip_confirmed: bool,
    ) -> bool {
        // Half a frame less a 32nd: at 30 fps on a 60 Hz display (or 60 fps
        // at 120 Hz) a delivery that moves one refresh later lags by exactly
        // half a frame, give or take a mach tick of rounding, and an exact
        // half-frame bound left it to that rounding whether the ladder
        // followed the source or kept every later frame a refresh before its
        // capture time.
        let min_lag_ns = duration_ns / 2 - duration_ns / 32;
        if !self.detect_skipped_frames || min_lag_ns <= 0 || lag_ns < min_lag_ns {
            return false;
        }
        if skip_confirmed
            || pending_lag_ns.is_some_and(|previous| lag_ns >= previous - duration_ns / 8)
        {
            return true;
        }
        self.pending_lag_ns = Some(lag_ns);
        false
    }

    pub fn reset(&mut self) {
        self.timing_set = false;
        self.timing_adjust = 0;
        self.next_expected_ns = None;
        self.last_cadence_output_ns = None;
        self.pending_lag_ns = None;
        self.skip_confirmed = false;
        self.off_source_time = false;
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
    #[test]
    fn preserving_cadence_does_not_release_recorded_smoothing_lag() {
        let samples = [
            (46154413, 78690394),
            (65568721, 135377154),
            (110897087, 172279669),
            (132556133, 193694100),
            (194257322, 206714730),
            (210630064, 228600321),
            (295866539, 326602031),
            (331422825, 390005096),
            (358539718, 429724051),
            (391572010, 454430003),
            (419586633, 474622237),
            (463879066, 499774959),
            (472447881, 533644768),
            (513265949, 568866386),
            (553800082, 589048951),
            (612231200, 650842341),
            (659399095, 685934536),
        ];
        let mut legacy = SourceClockState::new("legacy-video");
        let mut preserving = SourceClockState::new("continuous-video");
        let mut legacy_output = Vec::new();
        let mut preserved_output = Vec::new();
        for (raw, now) in samples {
            legacy_output.push(legacy.remap_ns(raw, now, 33_333_333, true).master_ns);
            preserved_output.push(preserving.remap_ns(raw, now, 33_333_333, false).master_ns);
        }
        assert_eq!(legacy_output[16] - legacy_output[15], 113_244_687);
        assert_eq!(preserved_output[16] - preserved_output[15], 47_167_895);
        assert_eq!(legacy_output[0], preserved_output[0]);
        assert_eq!(preserving.snap_count(), 0);
        assert_eq!(preserving.hard_reset_count(), 0);
    }

    #[test]
    fn preserving_cadence_replays_every_recorded_interval() {
        let samples: [i64; 166] = [
            46154413, 65568721, 110897087, 132556133, 194257322, 210630064, 295866539, 331422825,
            358539718, 391572010, 419586633, 463879066, 472447881, 513265949, 553800082, 612231200,
            659399095, 684859793, 703765590, 771137903, 816569916, 829567548, 863610545, 926770792,
            969115079, 983414049, 1040848452, 1050334828, 1099575914, 1159724806, 1175198241,
            1207247075, 1239602166, 1305713087, 1336115915, 1367591857, 1429003927, 1450650105,
            1482563646, 1507565298, 1548602526, 1608592995, 1615701319, 1683213311, 1697719775,
            1742772459, 1775887617, 1801167715, 1858162227, 1910977942, 1955903885, 1977035872,
            2006647063, 2044937201, 2127620053, 2149847594, 2170967171, 2221614788, 2279627404,
            2289253362, 2333763286, 2382028011, 2412563172, 2444953954, 2490800736, 2549402425,
            2584977585, 2615680580, 2650109725, 2665944218, 2745574052, 2781041320, 2820631617,
            2842908220, 2871194752, 2915919941, 2962020029, 2991660101, 3038647128, 3057869964,
            3092459053, 3158726868, 3166722481, 3246562870, 3281329262, 3313973509, 3371634807,
            3398569941, 3461197437, 3499790112, 3509911781, 3588729118, 3626970626, 3632929245,
            3696523572, 3743563090, 3770569195, 3793558443, 3831804481, 3856646119, 3898780811,
            3940568105, 3980226504, 4016559191, 4052128431, 4066657406, 4120152494, 4151270637,
            4184461316, 4206797820, 4275284412, 4307124812, 4323324283, 4350754207, 4400827291,
            4450575108, 4463290634, 4517560479, 4541563458, 4574001281, 4627021529, 4639667832,
            4701963641, 4715851742, 4756979912, 4799046093, 4825566377, 4857078700, 4888566231,
            4915249779, 4957961094, 4987293889, 5048028694, 5071025932, 5112782536, 5148460569,
            5180622435, 5197751016, 5247952933, 5275295305, 5331623674, 5360745415, 5382814833,
            5433875878, 5461561168, 5491354103, 5521647539, 5567574883, 5599380402, 5623347371,
            5664391349, 5692765944, 5731586034, 5753006938, 5774332970, 5848158628, 5884141787,
            5911433118, 5926586376, 5998337740, 6012802883, 6052260307, 6129125352, 6162385302,
            6196413748, 6214714645,
        ];
        let mut state = SourceClockState::new("recorded-video");
        let mut previous = None;
        for raw in samples {
            let mapped = state.remap_ns(raw, raw + 30_000_000, 33_333_333, false);
            assert_eq!(mapped.master_ns, raw as u64);
            if let Some((previous_raw, previous_output)) = previous {
                assert_eq!(
                    mapped.master_ns - previous_output,
                    (raw - previous_raw) as u64
                );
                assert!(mapped.master_ns - previous_output < 100_000_000);
            }
            previous = Some((raw, mapped.master_ns));
        }
    }

    #[test]
    fn preserving_cadence_matches_each_interval_across_rates_and_jitter() {
        for nominal in [24.0, 30.0, 60.0] {
            for actual in [
                10.0, 15.0, 20.0, 24.0, 25.0, 29.97, 30.0, 48.0, 60.0, 90.0, 120.0, 240.0, 500.0,
                1000.0,
            ] {
                for jitter in [0.0, 0.3] {
                    let mut state = SourceClockState::new("cadence-matrix");
                    let mut rng = TestRng(0xCA9_5EED);
                    let mut previous = None;
                    for frame in 0..300 {
                        let raw = ((frame as f64 + (rng.next_f64() * 2.0 - 1.0) * jitter)
                            * 1_000_000_000.0
                            / actual)
                            .max(0.0) as i64;
                        let mapped = state.remap_ns(
                            raw,
                            raw + 25_000_000,
                            (1_000_000_000.0 / nominal) as u64,
                            false,
                        );
                        assert_eq!(mapped.master_ns, raw as u64);
                        if let Some((previous_raw, previous_output)) = previous {
                            assert!(raw >= previous_raw);
                            assert_eq!(
                                mapped.master_ns - previous_output,
                                (raw - previous_raw) as u64
                            );
                        }
                        previous = Some((raw, mapped.master_ns));
                    }
                }
            }
        }
    }

    #[test]
    fn preserving_cadence_floors_backward_and_duplicate_inputs() {
        let mut state = SourceClockState::new("backward-video");
        for (raw, expected) in [
            (100_000_000, 100_000_000),
            (120_000_000, 120_000_000),
            (110_000_000, 120_000_000),
            (120_000_000, 120_000_000),
            (130_000_000, 130_000_000),
        ] {
            assert_eq!(
                state
                    .remap_ns(raw, 200_000_000, 33_333_333, false)
                    .master_ns,
                expected
            );
        }
    }

    #[test]
    fn preserving_cadence_retains_real_gaps() {
        let mut state = SourceClockState::new("gapped-video");
        for raw in [0, 30_000_000, 430_000_000, 460_000_000, 3_460_000_000] {
            let mapped = state.remap_ns(raw, raw + 30_000_000, 33_333_333, false);
            assert_eq!(mapped.master_ns, raw as u64);
            assert_ne!(mapped.outcome, SourceClockOutcome::HardReset);
        }
    }

    #[test]
    fn preserving_cadence_retains_initial_adjust_and_hard_reset_recovery() {
        let mut state = SourceClockState::new("reset-video");
        let first = state.remap_ns(-10_000_000_000, 0, 33_333_333, false);
        assert_eq!(first.outcome, SourceClockOutcome::InitialAdjust);
        assert_eq!(first.master_ns, 0);
        assert_eq!(
            state
                .remap_ns(-9_966_666_667, 33_333_333, 33_333_333, false)
                .master_ns,
            33_333_333
        );
        let reset = state.remap_ns(-4_966_666_667, 66_666_666, 33_333_333, false);
        assert_eq!(reset.outcome, SourceClockOutcome::HardReset);
        assert_eq!(reset.master_ns, 66_666_666);
        assert_eq!(
            state
                .remap_ns(-4_933_333_334, 99_999_999, 33_333_333, false)
                .master_ns,
            99_999_999
        );
        assert_eq!(state.hard_reset_count(), 1);
    }

    #[test]
    fn preserving_cadence_reset_releases_previous_epoch_floor() {
        let mut state = SourceClockState::new("new-epoch");
        assert_eq!(
            state
                .remap_ns(1_000_000_000, 1_000_000_000, 33_333_333, false)
                .master_ns,
            1_000_000_000
        );
        state.reset();
        assert_eq!(
            state
                .remap_ns(10_000_000, 10_000_000, 33_333_333, false)
                .master_ns,
            10_000_000
        );
    }

    #[test]
    fn preserving_cadence_public_method_keeps_source_delta() {
        let clock = clock();
        let mut state = SourceClockState::new("public-video");
        let first = state.remap_preserving_cadence(
            &clock,
            Timestamp::Instant(clock.start_instant() + Duration::from_millis(100)),
            33_333_333,
        );
        let second = state.remap_preserving_cadence(
            &clock,
            Timestamp::Instant(clock.start_instant() + Duration::from_millis(147)),
            33_333_333,
        );
        assert_eq!(second.master_ns - first.master_ns, 47_000_000);
    }

    const FRAME_60_NS: u64 = 16_666_666;

    fn frame_raw_ns(frame: u64) -> i64 {
        (frame * 1_000_000_000 / 60) as i64
    }

    fn replay(state: &mut SourceClockState, raws: &[i64], frame_ns: u64) -> Vec<u64> {
        raws.iter()
            .map(|&raw| {
                state
                    .remap_ns(raw, raw + 20_000_000, frame_ns, true)
                    .master_ns
            })
            .collect()
    }

    fn skip_tracking() -> SourceClockState {
        SourceClockState::new("video").detecting_skipped_frames()
    }

    fn frames_with_skips(total: u64, skips: &[(u64, u64)]) -> Vec<i64> {
        (0..total)
            .filter(|frame| {
                !skips
                    .iter()
                    .any(|&(start, count)| *frame >= start && *frame < start + count)
            })
            .map(frame_raw_ns)
            .collect()
    }

    #[test]
    fn skipped_frames_at_start_return_to_source_time() {
        for dropped in [1, 2, 3, 4] {
            let raws = frames_with_skips(240, &[(1, dropped)]);
            let legacy = replay(&mut SourceClockState::new("legacy"), &raws, FRAME_60_NS);
            let output = replay(&mut skip_tracking(), &raws, FRAME_60_NS);

            let lag =
                (raws[239 - dropped as usize] as u64).abs_diff(legacy[239 - dropped as usize]);
            assert!(
                lag.abs_diff(dropped * FRAME_60_NS) < 1_000_000,
                "legacy smoothing keeps {dropped} skipped frames as lag, got {lag}"
            );
            for (index, (&raw, &mapped)) in raws.iter().zip(&output).enumerate().skip(2) {
                assert!(
                    (raw as u64).abs_diff(mapped) < 1_000,
                    "dropped={dropped} frame {index}: {mapped} vs source {raw}"
                );
            }
        }
    }

    #[test]
    fn skipped_frames_beyond_smoothing_threshold_match_legacy() {
        for dropped in [5, 8] {
            let raws = frames_with_skips(240, &[(1, dropped)]);
            let legacy = replay(&mut SourceClockState::new("legacy"), &raws, FRAME_60_NS);
            assert_eq!(replay(&mut skip_tracking(), &raws, FRAME_60_NS), legacy);
        }
    }

    #[test]
    fn first_frame_after_skip_is_pending_until_lag_persists() {
        let raws = frames_with_skips(10, &[(3, 2)]);
        let mut state = skip_tracking();
        let mut pending = Vec::new();
        let mut output = Vec::new();
        for raw in raws.iter().copied() {
            output.push(state.remap_ns(raw, raw, FRAME_60_NS, true).master_ns);
            pending.push(state.lag_pending());
        }
        assert_eq!(
            pending,
            [false, false, false, true, false, false, false, false]
        );
        assert_eq!(output[3], output[2] + FRAME_60_NS);
        assert_eq!(output[4], raws[4] as u64);
        assert_eq!(state.skip_count(), 1);
    }

    #[test]
    fn repeated_mid_recording_skips_never_accumulate_lag() {
        let raws = frames_with_skips(600, &[(100, 1), (200, 3), (300, 2), (301 + 50, 4)]);
        let output = replay(&mut skip_tracking(), &raws, FRAME_60_NS);
        let last = raws.len() - 1;
        assert!((raws[last] as u64).abs_diff(output[last]) < 1_000);
        for pair in output.windows(2) {
            assert!(pair[1] > pair[0]);
        }
    }

    #[test]
    fn skip_tracking_is_identical_to_legacy_without_skips() {
        for nominal in [24.0, 30.0, 60.0] {
            let frame_ns = (1_000_000_000.0 / nominal) as u64;
            for seed in 0..20 {
                let mut rng = TestRng(0x5EED + seed);
                let raws: Vec<i64> = (0..600)
                    .map(|frame| {
                        let jitter = (rng.next_f64() * 2.0 - 1.0) * 0.24 * frame_ns as f64;
                        (frame as f64 * 1_000_000_000.0 / nominal + jitter).max(0.0) as i64
                    })
                    .collect();
                assert_eq!(
                    replay(&mut skip_tracking(), &raws, frame_ns),
                    replay(&mut SourceClockState::new("legacy"), &raws, frame_ns),
                    "nominal={nominal} seed={seed}"
                );
            }
        }
    }

    #[test]
    fn single_late_frame_is_still_smoothed() {
        let mut raws: Vec<i64> = (0..120).map(frame_raw_ns).collect();
        raws[40] += 12_000_000;
        raws[80] += 60_000_000;
        let output = replay(&mut skip_tracking(), &raws, FRAME_60_NS);
        assert_eq!(
            output,
            replay(&mut SourceClockState::new("legacy"), &raws, FRAME_60_NS)
        );
        assert_eq!(output[40], output[39] + FRAME_60_NS);
    }

    #[test]
    fn delivery_backlog_draining_is_still_smoothed() {
        for (fps, spacings_us) in [
            (60, [100, 5_000, 10_000, 14_000]),
            (30, [100, 10_000, 20_000, 28_000]),
        ] {
            let frame_ns = 1_000_000_000 / fps;
            for stall_ms in [20, 40, 60] {
                for spacing_us in spacings_us {
                    let resume = 30 * frame_ns as i64 + stall_ms * 1_000_000;
                    let raws: Vec<i64> = (0..(4 * fps as i64))
                        .map(|frame| {
                            let raw = frame * frame_ns as i64;
                            if frame >= 30 {
                                raw.max(resume + (frame - 30) * spacing_us * 1_000)
                            } else {
                                raw
                            }
                        })
                        .collect();
                    let mut state = skip_tracking();
                    let output = replay(&mut state, &raws, frame_ns);
                    assert_eq!(
                        output,
                        replay(&mut SourceClockState::new("legacy"), &raws, frame_ns),
                        "fps={fps} stall={stall_ms}ms spacing={spacing_us}us"
                    );
                    assert_eq!(state.skip_count(), 0);
                }
            }
        }
    }

    #[test]
    fn skipped_frames_with_timestamp_jitter_return_to_source_time() {
        let mut rng = TestRng(0xD12);
        let raws: Vec<i64> = frames_with_skips(240, &[(1, 2), (150, 3)])
            .into_iter()
            .map(|raw| raw + ((rng.next_f64() * 2.0 - 1.0) * 500_000.0) as i64)
            .collect();
        let mut state = skip_tracking();
        let output = replay(&mut state, &raws, FRAME_60_NS);
        assert_eq!(state.skip_count(), 2);
        let last = raws.len() - 1;
        assert!((raws[last] as u64).abs_diff(output[last]) < 1_000_000);
    }

    #[test]
    fn frames_moved_a_display_refresh_are_off_source_time() {
        let refresh = |n: i64| n * 1_000_000_000 / 60;
        let frame_ns = 33_333_333;
        for (slip, label) in [(-1, "early"), (1, "late")] {
            let mut state = skip_tracking();
            let mut off = Vec::new();
            for frame in 0..12i64 {
                // A slip one refresh later lags the cadence by a hair under
                // half a frame, as rounded mach ticks do on the runners.
                let slipped = refresh(slip) - i64::from(slip > 0) * 1_000;
                let raw = refresh(2 * frame) + if frame >= 6 { slipped } else { 0 };
                state.remap_ns(raw, raw + 20_000_000, frame_ns, true);
                off.push(state.off_source_time());
            }
            assert!(off[..6].iter().all(|off| !off), "{label}: {off:?}");
            assert!(off[6], "{label}: {off:?}");
            if slip > 0 {
                assert!(off[7..].iter().all(|off| !off), "{label}: {off:?}");
            }
        }

        let mut rng = TestRng(0x0FF);
        let mut state = skip_tracking();
        for frame in 0..300i64 {
            let jitter = ((rng.next_f64() * 2.0 - 1.0) * 3_000_000.0) as i64;
            let raw = frame * frame_ns as i64 + if frame > 0 { jitter } else { 0 };
            state.remap_ns(raw, raw + 20_000_000, frame_ns, true);
            assert!(!state.off_source_time(), "frame {frame}");
        }
    }

    #[test]
    fn jitter_under_half_a_frame_matches_legacy() {
        for nominal in [24u64, 30, 60] {
            let frame_ns = 1_000_000_000 / nominal;
            for seed in 0..20 {
                let mut rng = TestRng(0x7177 + seed);
                let raws: Vec<i64> = (0..600i64)
                    .map(|frame| {
                        let magnitude = 0.25 + 0.2 * rng.next_f64();
                        let sign = if rng.next_f64() < 0.5 { 1.0 } else { -1.0 };
                        let jitter = (sign * magnitude * frame_ns as f64) as i64;
                        frame * frame_ns as i64 + if frame > 0 { jitter } else { 0 }
                    })
                    .collect();
                let mut state = skip_tracking();
                let output = replay(&mut state, &raws, frame_ns);
                assert_eq!(
                    output,
                    replay(&mut SourceClockState::new("legacy"), &raws, frame_ns),
                    "nominal={nominal} seed={seed}"
                );
                assert_eq!(state.skip_count(), 0, "nominal={nominal} seed={seed}");
                assert!(output.windows(2).all(|pair| pair[1] > pair[0]));
            }
        }
    }

    // Frame `index` of a `fps` capture on a `hz` display lands on the first
    // refresh at or after its due time, moved by `slips` refreshes from the
    // given frames on.
    fn refresh_grid(fps: u64, hz: u64, frames: u64, slips: &[(u64, i64)]) -> Vec<i64> {
        (0..frames)
            .map(|index| {
                let refresh = (index * hz).div_ceil(fps) as i64
                    + slips
                        .iter()
                        .filter(|(from, _)| index >= *from)
                        .map(|(_, by)| by)
                        .sum::<i64>();
                refresh * 1_000_000_000 / hz as i64
            })
            .collect()
    }

    #[test]
    fn refresh_ratio_cadences_match_legacy() {
        for (fps, hz, slips) in [
            (24, 60, &[][..]),
            (25, 50, &[][..]),
            (25, 60, &[][..]),
            (30, 50, &[][..]),
            (30, 120, &[(40, 1), (90, -1), (200, -2)][..]),
            (60, 120, &[][..]),
        ] {
            let frame_ns = 1_000_000_000 / fps;
            let raws = refresh_grid(fps, hz, 300, slips);
            let mut state = skip_tracking();
            assert_eq!(
                replay(&mut state, &raws, frame_ns),
                replay(&mut SourceClockState::new("legacy"), &raws, frame_ns),
                "{fps} fps at {hz} Hz"
            );
            assert_eq!(state.skip_count(), 0, "{fps} fps at {hz} Hz");
        }
    }

    #[test]
    fn slow_display_stays_within_half_a_frame_of_source_time() {
        // 60 fps on a 59.94 Hz display: one delivery per refresh, 16.683 ms
        // apart, so the cadence falls behind by 17 us a frame until the lag
        // reads as a skip and the ladder returns to source time.
        let raws: Vec<i64> = (0..1800i64)
            .map(|frame| frame * 1_001_000_000 / 60)
            .collect();
        let mut state = skip_tracking();
        let output = replay(&mut state, &raws, FRAME_60_NS);
        assert!(output.windows(2).all(|pair| pair[1] > pair[0]));
        let worst_early = raws
            .iter()
            .zip(&output)
            .map(|(&raw, &mapped)| raw - mapped as i64)
            .max()
            .unwrap();
        assert!(worst_early < 8_000_000, "worst early {worst_early}ns");
        assert!(
            output
                .iter()
                .zip(&raws)
                .all(|(&mapped, &raw)| mapped as i64 <= raw)
        );
        assert!(
            (2..=4).contains(&state.skip_count()),
            "{}",
            state.skip_count()
        );
    }

    #[test]
    fn slow_source_tracks_source_time_after_first_skip() {
        let raws: Vec<i64> = (0..60).map(|frame| frame * 66_666_666).collect();
        let output = replay(&mut skip_tracking(), &raws, 33_333_333);
        for (index, (&raw, &mapped)) in raws.iter().zip(&output).enumerate().skip(2) {
            assert_eq!(mapped, raw as u64, "frame {index}");
        }
    }

    #[test]
    fn skip_tracking_keeps_fast_source_bounds() {
        for nominal in [24.0, 30.0, 60.0] {
            let frame_ns = (1_000_000_000.0 / nominal) as u64;
            for actual in [60.0, 90.0, 120.0, 240.0, 1000.0] {
                let raws: Vec<i64> = (0..((1.5 * actual) as i64))
                    .map(|frame| (frame as f64 * 1_000_000_000.0 / actual) as i64)
                    .collect();
                assert_eq!(
                    replay(&mut skip_tracking(), &raws, frame_ns),
                    replay(&mut SourceClockState::new("legacy"), &raws, frame_ns),
                    "nominal={nominal} actual={actual}"
                );
            }
        }
    }
}
