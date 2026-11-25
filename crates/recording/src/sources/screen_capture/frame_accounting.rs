use std::{
    collections::VecDeque,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::Duration,
};

pub const LOSS_WINDOW: Duration = Duration::from_secs(5);
pub const LOSS_WARN_PCT: f64 = 5.0;
pub const LOSS_WARN_MIN_FRAMES: u64 = 10;

pub fn capture_slot_ns(fps: u32, refresh_hz: f64) -> u64 {
    let refresh_ns = if refresh_hz.is_finite() && refresh_hz > 0.0 {
        1e9 / refresh_hz
    } else {
        1e9 / fps.max(1) as f64
    };
    let min_interval_ns = (1000 / fps.max(1)) as f64 * 1e6;
    let refreshes = (min_interval_ns / refresh_ns).ceil().max(1.0);
    (refreshes * refresh_ns).round() as u64
}

const CADENCE_WINDOW: usize = 16;
const CADENCE_MIN_STEPS: usize = 8;
const SHORT_GAP_CADENCES: u64 = 4;
const STEADY_STEPS: u32 = 4;
const STREAM_STARTUP_NS: u64 = 1_000_000_000;

/// Counts display frames ScreenCaptureKit skipped, from the display time on
/// each complete frame. ScreenCaptureKit never marks a skipped frame; measured
/// against a frame-coded stimulus:
/// - It sends idle samples (screen unchanged) for many, but not all, unchanged
///   refreshes, and none at all while every refresh brings new content. So
///   when the last window of frames had no idle sample, the screen changed at
///   every refresh and every missing capture slot was lost, however few frames
///   came through (an encoder holding its buffers starves it this way).
/// - Otherwise a gap only counts after a steady run at the content's own
///   period (the most common recent step), in units of that period. Content
///   that changes slower than the capture rate or in bursts is then a lower
///   bound.
/// - For about the first second of a stream it delivers a frame at every
///   refresh even when nothing changed, so gaps there are not counted.
#[derive(Debug)]
pub struct CaptureGapCounter {
    slot_ns: u64,
    startup_ns: u64,
    first_complete_ns: Option<u64>,
    last_complete_ns: Option<u64>,
    idles_since_complete: u32,
    steps: [u64; CADENCE_WINDOW],
    step_idles: [u32; CADENCE_WINDOW],
    step_count: usize,
    cadence: u64,
    steady_run: u32,
}

impl CaptureGapCounter {
    pub fn new(slot_ns: u64) -> Self {
        Self::with_startup(slot_ns, STREAM_STARTUP_NS)
    }

    fn with_startup(slot_ns: u64, startup_ns: u64) -> Self {
        Self {
            slot_ns: slot_ns.max(1),
            startup_ns,
            first_complete_ns: None,
            last_complete_ns: None,
            idles_since_complete: 0,
            steps: [0; CADENCE_WINDOW],
            step_idles: [0; CADENCE_WINDOW],
            step_count: 0,
            cadence: 1,
            steady_run: 0,
        }
    }

    pub fn idle(&mut self) {
        self.idles_since_complete = self.idles_since_complete.saturating_add(1);
    }

    pub fn interrupted(&mut self) {
        self.last_complete_ns = None;
        self.idles_since_complete = 0;
        self.step_count = 0;
        self.cadence = 1;
        self.steady_run = 0;
    }

    pub fn complete(&mut self, display_ns: u64) -> u64 {
        let first = *self.first_complete_ns.get_or_insert(display_ns);
        let previous = self.last_complete_ns.replace(display_ns);
        let idles = std::mem::take(&mut self.idles_since_complete);
        let Some(previous) = previous.filter(|previous| display_ns > *previous) else {
            return 0;
        };
        let slots = ((display_ns - previous + self.slot_ns / 2) / self.slot_ns).max(1);
        self.push_step(slots, idles);
        let continuous =
            self.step_count >= CADENCE_WINDOW && self.step_idles.iter().all(|idles| *idles == 0);
        let lost = if continuous {
            slots - 1
        } else if self.step_count < CADENCE_MIN_STEPS || self.steady_run < STEADY_STEPS {
            0
        } else if self.cadence == 1 {
            if idles > 0 { 0 } else { slots - 1 }
        } else if idles == 0 || slots <= SHORT_GAP_CADENCES * self.cadence {
            (slots / self.cadence).saturating_sub(1)
        } else {
            0
        };
        if slots == self.cadence && !(self.cadence == 1 && idles > 0) {
            self.steady_run = self.steady_run.saturating_add(1);
        } else {
            self.steady_run = 0;
        }
        if display_ns.saturating_sub(first) < self.startup_ns {
            0
        } else {
            lost
        }
    }

    fn push_step(&mut self, slots: u64, idles: u32) {
        let slot = self.step_count % CADENCE_WINDOW;
        self.steps[slot] = slots;
        self.step_idles[slot] = idles;
        self.step_count += 1;
        let filled = &self.steps[..self.step_count.min(CADENCE_WINDOW)];
        self.cadence = filled
            .iter()
            .map(|step| (filled.iter().filter(|other| *other == step).count(), *step))
            .max()
            .map_or(1, |(_, step)| step);
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenFrameTotals {
    pub displayed: u64,
    pub delivered: u64,
    pub handed_to_encoder: u64,
    pub written: u64,
    pub lost_in_capture: u64,
    pub lost_before_encoder: u64,
    pub lost_in_encoder: u64,
}

impl ScreenFrameTotals {
    pub fn lost(&self) -> u64 {
        self.lost_in_capture + self.lost_before_encoder + self.lost_in_encoder
    }

    pub fn lost_pct(&self) -> f64 {
        if self.displayed == 0 {
            0.0
        } else {
            100.0 * self.lost() as f64 / self.displayed as f64
        }
    }

    pub fn add(&mut self, other: &Self) {
        self.displayed += other.displayed;
        self.delivered += other.delivered;
        self.handed_to_encoder += other.handed_to_encoder;
        self.written += other.written;
        self.lost_in_capture += other.lost_in_capture;
        self.lost_before_encoder += other.lost_before_encoder;
        self.lost_in_encoder += other.lost_in_encoder;
    }

    fn since(&self, earlier: &Self) -> Self {
        Self {
            displayed: self.displayed.saturating_sub(earlier.displayed),
            delivered: self.delivered.saturating_sub(earlier.delivered),
            handed_to_encoder: self
                .handed_to_encoder
                .saturating_sub(earlier.handed_to_encoder),
            written: self.written.saturating_sub(earlier.written),
            lost_in_capture: self.lost_in_capture.saturating_sub(earlier.lost_in_capture),
            lost_before_encoder: self
                .lost_before_encoder
                .saturating_sub(earlier.lost_before_encoder),
            lost_in_encoder: self.lost_in_encoder.saturating_sub(earlier.lost_in_encoder),
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct FrameLossCarry {
    pub capture_skipped: u64,
}

/// Per-segment counts for the screen track. A frame only counts once the
/// muxer accepts it for the recording, so frames before the start, while
/// paused or after stop are neither displayed nor lost. Written frames are
/// the packets the muxer wrote (by the write-behind writer thread when it is
/// on), so frames a failing encoder drops after taking them, and frames the
/// writer discards or fails to write, count as lost in the encoder. Repeats
/// of the last frame are only appended at stop, so a lost tail loses them
/// first: only packets beyond the real frames that encoded count as written
/// repeats.
#[derive(Debug, Default)]
pub struct ScreenFrameAccounting {
    attached: AtomicBool,
    recording: AtomicBool,
    finished: AtomicBool,
    delivered: AtomicU64,
    lost_in_capture: AtomicU64,
    callback_dropped: AtomicU64,
    handed_to_encoder: AtomicU64,
    muxer_dropped: AtomicU64,
    encoder_failed: AtomicU64,
    real_encoded: AtomicU64,
    repeats_encoded: AtomicU64,
    packets_written: AtomicU64,
    repeat_flags: Mutex<VecDeque<bool>>,
}

impl ScreenFrameAccounting {
    pub fn attach(&self) {
        self.attached.store(true, Ordering::Relaxed);
    }

    pub fn is_attached(&self) -> bool {
        self.attached.load(Ordering::Relaxed)
    }

    pub fn record_accepted(&self, carry: FrameLossCarry, first: bool) {
        self.delivered.fetch_add(1, Ordering::Relaxed);
        if !first {
            self.lost_in_capture
                .fetch_add(carry.capture_skipped, Ordering::Relaxed);
        }
        self.recording.store(true, Ordering::Relaxed);
    }

    pub fn record_callback_dropped(&self, carry: FrameLossCarry) {
        if self.recording.load(Ordering::Relaxed) && !self.finished.load(Ordering::Relaxed) {
            self.callback_dropped.fetch_add(1, Ordering::Relaxed);
            self.lost_in_capture
                .fetch_add(carry.capture_skipped, Ordering::Relaxed);
        }
    }

    pub fn before_handing_to_encoder(&self, repeat: bool) {
        self.flags().push_back(repeat);
    }

    pub fn record_handed_to_encoder(&self, repeat: bool) {
        if !repeat {
            self.handed_to_encoder.fetch_add(1, Ordering::Relaxed);
        }
    }

    pub fn record_muxer_dropped(&self, repeat: bool) {
        self.flags().pop_back();
        if !repeat {
            self.muxer_dropped.fetch_add(1, Ordering::Relaxed);
        }
    }

    pub fn next_is_repeat(&self) -> bool {
        self.flags().pop_front().unwrap_or(false)
    }

    pub fn record_encoded(&self, repeat: bool, encoded: bool, packets_written: Option<u64>) {
        match (repeat, encoded) {
            (true, true) => {
                self.repeats_encoded.fetch_add(1, Ordering::Relaxed);
            }
            (false, true) => {
                self.real_encoded.fetch_add(1, Ordering::Relaxed);
            }
            (false, false) => {
                self.encoder_failed.fetch_add(1, Ordering::Relaxed);
            }
            (true, false) => {}
        }
        if let Some(packets_written) = packets_written {
            self.packets_written
                .store(packets_written, Ordering::Relaxed);
        }
    }

    pub fn record_finished(&self, packets_written: Option<u64>) {
        if let Some(packets_written) = packets_written {
            self.packets_written
                .store(packets_written, Ordering::Relaxed);
        }
        self.finished.store(true, Ordering::Relaxed);
    }

    fn flags(&self) -> std::sync::MutexGuard<'_, VecDeque<bool>> {
        self.repeat_flags
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn totals(&self) -> ScreenFrameTotals {
        let delivered = self.delivered.load(Ordering::Relaxed);
        let lost_in_capture = self.lost_in_capture.load(Ordering::Relaxed);
        let callback_dropped = self.callback_dropped.load(Ordering::Relaxed);
        let handed_to_encoder = self.handed_to_encoder.load(Ordering::Relaxed);
        let packets = self.packets_written.load(Ordering::Relaxed);
        let repeats_written = packets
            .saturating_sub(self.real_encoded.load(Ordering::Relaxed))
            .min(self.repeats_encoded.load(Ordering::Relaxed));
        let written = (packets - repeats_written).min(handed_to_encoder);
        let encoder_failed = self.encoder_failed.load(Ordering::Relaxed);
        let lost_in_encoder = if self.finished.load(Ordering::Relaxed) {
            handed_to_encoder.saturating_sub(written)
        } else {
            encoder_failed
        };
        ScreenFrameTotals {
            displayed: delivered + callback_dropped + lost_in_capture,
            delivered: delivered + callback_dropped,
            handed_to_encoder,
            written,
            lost_in_capture,
            lost_before_encoder: callback_dropped + self.muxer_dropped.load(Ordering::Relaxed),
            lost_in_encoder,
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct ScreenFrameLedger(Arc<Mutex<Vec<Arc<ScreenFrameAccounting>>>>);

impl ScreenFrameLedger {
    pub fn register(&self, segment: Arc<ScreenFrameAccounting>) {
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .push(segment);
    }

    pub fn totals(&self) -> Option<ScreenFrameTotals> {
        let segments = self
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        segments
            .iter()
            .filter(|segment| segment.is_attached())
            .map(|segment| segment.totals())
            .reduce(|mut total, segment| {
                total.add(&segment);
                total
            })
    }
}

#[derive(Debug, Default)]
pub struct LossWindow {
    start: Option<std::time::Instant>,
    at_start: ScreenFrameTotals,
}

impl LossWindow {
    pub fn observe(
        &mut self,
        now: std::time::Instant,
        totals: ScreenFrameTotals,
    ) -> Option<ScreenFrameTotals> {
        let Some(start) = self.start else {
            self.start = Some(now);
            self.at_start = totals;
            return None;
        };
        if now.saturating_duration_since(start) < LOSS_WINDOW {
            return None;
        }
        let window = totals.since(&self.at_start);
        self.start = Some(now);
        self.at_start = totals;
        (window.lost() >= LOSS_WARN_MIN_FRAMES && window.lost_pct() >= LOSS_WARN_PCT)
            .then_some(window)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    const VSYNC_120: u64 = 8_333_333;

    fn counter_120() -> CaptureGapCounter {
        CaptureGapCounter::with_startup(capture_slot_ns(120, 120.0), 0)
    }

    #[test]
    fn slot_follows_refresh_and_minimum_interval() {
        assert_eq!(capture_slot_ns(120, 120.0), 8_333_333);
        assert_eq!(capture_slot_ns(60, 120.0), 16_666_667);
        assert_eq!(capture_slot_ns(30, 120.0), 33_333_333);
        assert_eq!(capture_slot_ns(60, 60.0), 16_666_667);
        assert_eq!(capture_slot_ns(50, 120.0), 25_000_000);
        assert_eq!(capture_slot_ns(60, 0.0), 16_666_667);
    }

    struct Feed {
        counter: CaptureGapCounter,
        t: u64,
        lost: u64,
    }

    impl Feed {
        fn new(slot_ns: u64) -> Self {
            Self {
                counter: CaptureGapCounter::with_startup(slot_ns, 0),
                t: 1_000_000_000,
                lost: 0,
            }
        }

        fn frames(&mut self, steps: &[u64]) -> u64 {
            let before = self.lost;
            for step in steps {
                self.t += step * VSYNC_120;
                self.lost += self.counter.complete(self.t);
            }
            self.lost - before
        }

        fn idle_then_frame(&mut self, idles: u64, step: u64) -> u64 {
            for _ in 0..idles {
                self.counter.idle();
            }
            self.t += step * VSYNC_120;
            let lost = self.counter.complete(self.t);
            self.lost += lost;
            lost
        }

        fn content_every(&mut self, step: u64, frames: usize) -> u64 {
            (0..frames).map(|_| self.idle_then_frame(1, step)).sum()
        }
    }

    #[test]
    fn steady_stream_loses_nothing() {
        let mut counter = counter_120();
        let lost: u64 = (0..1200u64)
            .map(|i| counter.complete(1_000_000_000 + i * VSYNC_120 + (i % 3) * 200_000))
            .sum();
        assert_eq!(lost, 0);
    }

    #[test]
    fn dropped_runs_count_each_missing_slot() {
        let mut feed = Feed::new(capture_slot_ns(120, 120.0));
        feed.frames(&[1; 20]);
        assert_eq!(
            feed.frames(&[1, 1, 2, 1, 1, 1, 1, 4, 1, 1, 1, 1, 3, 1]),
            1 + 3 + 2
        );
    }

    #[test]
    fn continuous_change_counts_every_missing_slot_however_few_arrive() {
        let mut feed = Feed::new(capture_slot_ns(120, 120.0));
        feed.frames(&[1; 20]);
        assert_eq!(
            feed.frames(&[2, 3, 2, 3, 3, 2, 4, 2, 2, 3, 2, 2, 3, 2, 2, 2, 3, 2]),
            1 + 2 + 1 + 2 + 2 + 1 + 3 + 1 + 1 + 2 + 1 + 1 + 2 + 1 + 1 + 1 + 2 + 1
        );
        assert_eq!(
            feed.idle_then_frame(1, 3),
            0,
            "an idle sample means the screen did not change every refresh"
        );
    }

    #[test]
    fn nothing_counts_before_the_cadence_is_known() {
        let mut feed = Feed::new(capture_slot_ns(120, 120.0));
        assert_eq!(feed.frames(&[2, 2, 2, 2, 2, 2, 2]), 0);
    }

    #[test]
    fn idle_gaps_are_not_loss() {
        let mut feed = Feed::new(capture_slot_ns(120, 120.0));
        feed.frames(&[1; 20]);
        assert_eq!(feed.idle_then_frame(60, 120), 0);
        assert_eq!(feed.idle_then_frame(1, 2), 0);
        assert_eq!(feed.frames(&[1, 1, 1, 1, 2]), 1);
    }

    #[test]
    fn gaps_inside_bursts_of_change_are_not_counted() {
        let mut feed = Feed::new(capture_slot_ns(120, 120.0));
        feed.frames(&[1; 20]);
        assert_eq!(feed.idle_then_frame(40, 60), 0);
        assert_eq!(
            feed.frames(&[1, 2, 1, 1, 2]),
            0,
            "a short burst after an idle stretch is not steady content"
        );
        assert_eq!(feed.frames(&[1, 1, 1, 1, 2]), 1);
    }

    #[test]
    fn content_slower_than_the_capture_rate_is_not_loss() {
        let mut sixty = Feed::new(capture_slot_ns(120, 120.0));
        assert_eq!(sixty.content_every(2, 120), 0);
        assert_eq!(sixty.frames(&[2, 2, 4]), 1);
        assert_eq!(sixty.content_every(2, 6), 0);
        assert_eq!(sixty.idle_then_frame(1, 4), 1);
        sixty.content_every(2, 6);
        assert_eq!(
            sixty.idle_then_frame(30, 60),
            0,
            "a paused video is not loss"
        );

        let mut forty = Feed::new(capture_slot_ns(120, 120.0));
        assert_eq!(forty.content_every(3, 60), 0);
        assert_eq!(forty.frames(&[3, 2, 4, 3, 3, 1, 5, 3]), 0);
        forty.frames(&[3; 4]);
        assert_eq!(forty.frames(&[6]), 1);
    }

    #[test]
    fn sixty_fps_capture_counts_in_its_own_slots() {
        let mut feed = Feed::new(capture_slot_ns(60, 120.0));
        feed.frames(&[2; 20]);
        assert_eq!(feed.frames(&[2, 2, 4, 2, 2, 2, 2, 6, 2]), 1 + 2);
        assert_eq!(
            feed.frames(&[3, 1, 2]),
            0,
            "one and a half slots is a late frame, not a missed one"
        );
    }

    #[test]
    fn the_first_second_of_a_stream_is_not_counted() {
        let mut counter = CaptureGapCounter::new(capture_slot_ns(120, 120.0));
        let mut t = 1_000_000_000u64;
        let mut lost = 0;
        for i in 0..240u64 {
            t += if i % 30 == 29 { 2 } else { 1 } * VSYNC_120;
            let skipped = counter.complete(t);
            if t - 1_000_000_000 - VSYNC_120 < 1_000_000_000 {
                assert_eq!(skipped, 0, "inside the startup second");
            }
            lost += skipped;
        }
        assert_eq!(lost, 5, "one skip every 30 frames after the first second");
    }

    #[test]
    fn display_time_going_backwards_restarts_the_count() {
        let mut counter = counter_120();
        assert_eq!(counter.complete(2_000_000_000), 0);
        assert_eq!(counter.complete(1_000_000_000), 0);
        assert_eq!(counter.complete(1_000_000_000 + VSYNC_120), 0);
    }

    #[test]
    fn an_interruption_forgets_what_the_screen_was_doing() {
        let mut feed = Feed::new(capture_slot_ns(120, 120.0));
        feed.frames(&[1; 20]);
        feed.counter.interrupted();
        assert_eq!(feed.frames(&[30, 1, 2, 1, 2]), 0);
        feed.frames(&[1; 16]);
        assert_eq!(feed.frames(&[2]), 1);
    }

    fn hand(accounting: &ScreenFrameAccounting, repeat: bool) {
        accounting.before_handing_to_encoder(repeat);
        accounting.record_handed_to_encoder(repeat);
    }

    #[test]
    fn totals_split_losses_by_stage_and_skip_the_first_gap() {
        let accounting = ScreenFrameAccounting::default();
        accounting.record_callback_dropped(FrameLossCarry { capture_skipped: 9 });
        accounting.record_accepted(
            FrameLossCarry {
                capture_skipped: 40,
            },
            true,
        );
        hand(&accounting, false);
        let mut packets = 0;
        let mut encode = |encoded: bool| {
            let repeat = accounting.next_is_repeat();
            packets += u64::from(encoded);
            accounting.record_encoded(repeat, encoded, Some(packets));
        };
        encode(true);
        for i in 0..10u64 {
            if i == 3 {
                accounting.record_callback_dropped(FrameLossCarry { capture_skipped: 1 });
            }
            accounting.record_accepted(
                FrameLossCarry {
                    capture_skipped: i % 2,
                },
                false,
            );
            if i == 7 {
                accounting.before_handing_to_encoder(false);
                accounting.record_muxer_dropped(false);
                continue;
            }
            hand(&accounting, false);
            encode(i != 8);
        }
        hand(&accounting, true);
        encode(true);

        let live = accounting.totals();
        assert_eq!(
            live.lost_in_encoder, 1,
            "a failed encode counts while recording"
        );
        accounting.record_finished(Some(packets - 2));
        let totals = accounting.totals();
        assert_eq!(
            totals,
            ScreenFrameTotals {
                displayed: 12 + 6,
                delivered: 12,
                handed_to_encoder: 10,
                written: 8,
                lost_in_capture: 6,
                lost_before_encoder: 2,
                lost_in_encoder: 2,
            },
            "a lost tail of two takes the repeat and one real frame"
        );
        assert_eq!(
            totals.displayed,
            totals.written + totals.lost(),
            "every displayed frame is either written or lost at one stage"
        );
        accounting.record_callback_dropped(FrameLossCarry { capture_skipped: 5 });
        assert_eq!(
            accounting.totals(),
            totals,
            "drops after stop are not counted"
        );
    }

    #[test]
    fn repeat_flags_follow_the_frames_through_the_encoder_queue() {
        let accounting = ScreenFrameAccounting::default();
        hand(&accounting, false);
        accounting.before_handing_to_encoder(true);
        accounting.record_muxer_dropped(true);
        hand(&accounting, true);
        hand(&accounting, false);
        assert!(!accounting.next_is_repeat());
        assert!(accounting.next_is_repeat());
        assert!(!accounting.next_is_repeat());
        assert!(
            !accounting.next_is_repeat(),
            "an empty queue is a fresh frame"
        );
        assert_eq!(accounting.totals().handed_to_encoder, 2);
        assert_eq!(accounting.totals().lost_before_encoder, 0);
    }

    #[test]
    fn a_repeat_lost_with_the_tail_is_not_a_lost_real_frame() {
        let accounting = ScreenFrameAccounting::default();
        accounting.record_accepted(FrameLossCarry::default(), true);
        for repeat in [false, false, false, false, false, true, true] {
            hand(&accounting, repeat);
            let repeat = accounting.next_is_repeat();
            accounting.record_encoded(repeat, true, None);
        }
        accounting.record_finished(Some(7));
        assert_eq!(accounting.totals().written, 5);
        assert_eq!(accounting.totals().lost_in_encoder, 0);
        accounting.record_finished(Some(6));
        assert_eq!(
            accounting.totals().written,
            5,
            "the packet lost at the end was a repeat"
        );
        assert_eq!(accounting.totals().lost_in_encoder, 0);
        accounting.record_finished(Some(3));
        assert_eq!(accounting.totals().written, 3);
        assert_eq!(accounting.totals().lost_in_encoder, 2);
    }

    #[test]
    fn a_failed_repeat_is_not_a_lost_frame() {
        let accounting = ScreenFrameAccounting::default();
        accounting.record_accepted(FrameLossCarry::default(), true);
        hand(&accounting, false);
        let repeat = accounting.next_is_repeat();
        accounting.record_encoded(repeat, true, Some(1));
        hand(&accounting, true);
        let repeat = accounting.next_is_repeat();
        accounting.record_encoded(repeat, false, None);
        accounting.record_finished(Some(1));
        let totals = accounting.totals();
        assert_eq!(totals.written, 1);
        assert_eq!(totals.lost(), 0);
    }

    #[test]
    fn segments_add_up() {
        let mut total = ScreenFrameTotals::default();
        let segment = ScreenFrameTotals {
            displayed: 100,
            delivered: 90,
            handed_to_encoder: 90,
            written: 90,
            lost_in_capture: 10,
            lost_before_encoder: 0,
            lost_in_encoder: 0,
        };
        total.add(&segment);
        total.add(&segment);
        assert_eq!(total.displayed, 200);
        assert_eq!(total.lost(), 20);
        assert!((total.lost_pct() - 10.0).abs() < 1e-9);
    }

    #[test]
    fn pause_and_resume_do_not_count_the_paused_time() {
        let accounting = ScreenFrameAccounting::default();
        let mut counter = counter_120();
        let mut t = 1_000_000_000u64;
        for i in 0..240u64 {
            t += VSYNC_120;
            let carry = FrameLossCarry {
                capture_skipped: counter.complete(t),
            };
            if !(60..180).contains(&i) {
                accounting.record_accepted(carry, i == 0);
            }
        }
        assert_eq!(accounting.totals().lost_in_capture, 0);
        assert_eq!(accounting.totals().displayed, 120);
    }

    #[test]
    fn ledger_sums_only_segments_a_muxer_counted() {
        let ledger = ScreenFrameLedger::default();
        assert_eq!(ledger.totals(), None);
        let unused = Arc::new(ScreenFrameAccounting::default());
        ledger.register(unused.clone());
        assert_eq!(ledger.totals(), None);
        for skipped in [3, 4] {
            let segment = Arc::new(ScreenFrameAccounting::default());
            segment.attach();
            segment.record_accepted(FrameLossCarry::default(), true);
            segment.record_accepted(
                FrameLossCarry {
                    capture_skipped: skipped,
                },
                false,
            );
            ledger.register(segment);
        }
        let totals = ledger.totals().expect("two counted segments");
        assert_eq!(totals.delivered, 4);
        assert_eq!(totals.lost_in_capture, 7);
        assert_eq!(totals.displayed, 11);
    }

    #[test]
    fn loss_window_warns_only_on_sustained_loss() {
        let start = Instant::now();
        let mut window = LossWindow::default();
        let frames = |displayed: u64, lost: u64| ScreenFrameTotals {
            displayed,
            written: displayed - lost,
            lost_in_capture: lost,
            ..Default::default()
        };
        assert!(window.observe(start, frames(0, 0)).is_none());
        assert!(
            window
                .observe(start + Duration::from_secs(5), frames(600, 12))
                .is_none(),
            "2% over a window is routine"
        );
        let warned = window
            .observe(start + Duration::from_secs(10), frames(1200, 312))
            .expect("half the frames lost");
        assert_eq!(warned.lost(), 300);
        assert!(
            window
                .observe(start + Duration::from_secs(12), frames(1300, 400))
                .is_none(),
            "no verdict before the window has elapsed"
        );
        assert!(
            window
                .observe(start + Duration::from_secs(15), frames(1300, 400))
                .is_some(),
            "loss inside an unfinished window still counts when it ends"
        );
        assert!(
            window
                .observe(start + Duration::from_secs(20), frames(1300, 400))
                .is_none(),
            "an idle window loses nothing"
        );
        let mut small = LossWindow::default();
        small.observe(start, frames(0, 0));
        assert!(
            small
                .observe(start + Duration::from_secs(5), frames(20, 5))
                .is_none(),
            "a handful of frames is below the floor"
        );
    }
}
