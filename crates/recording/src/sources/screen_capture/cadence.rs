//! Caps a capture source's delivered frame rate at the pipeline's nominal
//! rate.
//!
//! Windows Graphics Capture delivers a frame for every screen update — up to
//! the monitor's refresh rate — and `MinUpdateInterval` is only honoured on
//! newer Windows builds. On a 165Hz monitor a nominally-60fps recording
//! otherwise encodes ~2.75x the frames it needs: the timestamps are real (so
//! timing stays correct), but file size, encode load, and editor decode load
//! all scale with the excess.
//!
//! The gate has two modes chosen by an estimate of the source's own cadence:
//!
//! - **Pass-through** while the source runs at or below the nominal rate.
//!   No frame is ever dropped in this mode, so ordinary monitors — including
//!   59.94Hz ones and sources with timestamp jitter — are untouched by
//!   construction. This is deliberate: a per-frame spacing threshold either
//!   drops frames on slightly-slow sources (accumulated drift) or lets
//!   near-nominal multiples through (a 120Hz source quantizes to 120fps),
//!   so rate limiting only ever engages when the source is measurably fast.
//! - **Decimation** once the source is clearly faster than nominal: frames
//!   are admitted against a deadline ladder that advances one nominal
//!   interval per admitted frame, which converges on exactly the nominal
//!   rate for any source rate above it.

/// Smoothing factor for the source-cadence estimate.
const EMA_ALPHA: f64 = 0.1;
/// Enter decimation when the estimated source interval falls below this
/// fraction of nominal (i.e. the source is >~14% fast). Gap to the exit
/// ratio provides hysteresis so refresh-rate jitter cannot flap the mode.
const ENTER_DECIMATION_RATIO: f64 = 0.88;
/// Leave decimation when the source slows back to within ~5% of nominal.
const EXIT_DECIMATION_RATIO: f64 = 0.95;

pub struct FrameCadenceGate {
    /// Nominal frame interval in whatever tick unit `admit` is fed
    /// (the Windows capture path uses QPC hundred-nanosecond units).
    nominal_interval: i64,
    /// EMA of inter-frame deltas; `None` until the second frame.
    ema_delta: Option<f64>,
    last_ts: Option<i64>,
    decimating: bool,
    next_due: i64,
}

impl FrameCadenceGate {
    pub fn new(nominal_interval: i64) -> Self {
        Self {
            nominal_interval: nominal_interval.max(1),
            ema_delta: None,
            last_ts: None,
            decimating: false,
            next_due: 0,
        }
    }

    /// Decides whether a frame captured at `ts` should be kept. Call with
    /// every delivered frame, in delivery order.
    pub fn admit(&mut self, ts: i64) -> bool {
        let interval = self.nominal_interval;

        if let Some(last) = self.last_ts {
            let delta = ts - last;
            if delta <= 0 {
                // Non-monotonic source clock: never drop on bad data.
                // Re-anchor the ladder and let the pipeline's own anomaly
                // handling deal with the timestamps.
                self.last_ts = Some(ts);
                self.next_due = ts + interval;
                return true;
            }
            // Idle gaps are absence of updates, not cadence; keep them out
            // of the estimate so one static stretch doesn't mask a fast
            // source (and vice versa).
            if delta < interval * 2 {
                let d = delta as f64;
                self.ema_delta = Some(match self.ema_delta {
                    Some(ema) => ema * (1.0 - EMA_ALPHA) + d * EMA_ALPHA,
                    None => d,
                });
            }
        }
        self.last_ts = Some(ts);

        let nominal = interval as f64;
        if let Some(ema) = self.ema_delta {
            if self.decimating {
                if ema > nominal * EXIT_DECIMATION_RATIO {
                    self.decimating = false;
                }
            } else if ema < nominal * ENTER_DECIMATION_RATIO {
                self.decimating = true;
                // Start the ladder at this frame so it is admitted.
                self.next_due = ts;
            }
        }

        if !self.decimating {
            return true;
        }

        if ts >= self.next_due {
            // Advance from the deadline, not the admitted timestamp: dense
            // fast sources always overshoot the deadline a little, and
            // anchoring to the frame would compound that overshoot into an
            // admitted rate below nominal. Only a genuine idle gap (a full
            // interval past due) re-anchors the ladder.
            self.next_due = if ts >= self.next_due + interval {
                ts + interval
            } else {
                self.next_due + interval
            };
            true
        } else {
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Ticks here are microseconds for readability; the gate is
    /// unit-agnostic.
    const NOMINAL_60FPS: i64 = 16_667;

    fn run_source(gate: &mut FrameCadenceGate, timestamps: &[i64]) -> Vec<i64> {
        timestamps
            .iter()
            .copied()
            .filter(|ts| gate.admit(*ts))
            .collect()
    }

    /// Deterministic pseudo-jitter in `-max..=max`.
    fn jitter(i: i64, max: i64) -> i64 {
        ((i * 7919 + 104_729) % (2 * max + 1)) - max
    }

    #[test]
    fn nominal_rate_source_is_never_dropped() {
        let mut gate = FrameCadenceGate::new(NOMINAL_60FPS);
        let timestamps: Vec<i64> = (0..2000)
            .map(|i| i * NOMINAL_60FPS + if i > 0 { jitter(i, 2_000) } else { 0 })
            .collect();
        let admitted = run_source(&mut gate, &timestamps);
        assert_eq!(admitted.len(), timestamps.len());
    }

    #[test]
    fn slightly_slow_source_is_never_dropped() {
        // A 59.94Hz monitor feeding a 60fps nominal pipeline: the classic
        // failure of deadline ladders is accumulating drift against this
        // source and dropping a frame every few seconds.
        let interval_5994 = 16_683;
        let mut gate = FrameCadenceGate::new(NOMINAL_60FPS);
        let timestamps: Vec<i64> = (0..10_000).map(|i| i * interval_5994).collect();
        let admitted = run_source(&mut gate, &timestamps);
        assert_eq!(admitted.len(), timestamps.len());
    }

    #[test]
    fn slower_content_is_never_dropped() {
        // 30fps content updates on any monitor.
        let mut gate = FrameCadenceGate::new(NOMINAL_60FPS);
        let timestamps: Vec<i64> = (0..500).map(|i| i * 33_333).collect();
        let admitted = run_source(&mut gate, &timestamps);
        assert_eq!(admitted.len(), timestamps.len());
    }

    fn assert_decimates_to_nominal(source_interval: i64, label: &str) {
        let mut gate = FrameCadenceGate::new(NOMINAL_60FPS);
        let n = 20_000i64;
        let timestamps: Vec<i64> = (0..n)
            .map(|i| {
                i * source_interval
                    + if i > 0 {
                        jitter(i, source_interval / 20)
                    } else {
                        0
                    }
            })
            .collect();
        let admitted = run_source(&mut gate, &timestamps);

        let span = (timestamps.last().unwrap() - timestamps[0]) as f64;
        let admitted_rate = admitted.len() as f64 / span;
        let nominal_rate = 1.0 / NOMINAL_60FPS as f64;
        let ratio = admitted_rate / nominal_rate;
        assert!(
            (0.9..=1.02).contains(&ratio),
            "{label}: admitted {} of {} → {:.3}x nominal",
            admitted.len(),
            timestamps.len(),
            ratio
        );
    }

    #[test]
    fn fast_sources_decimate_to_the_nominal_rate() {
        assert_decimates_to_nominal(6_061, "165Hz"); // the reported monitor
        assert_decimates_to_nominal(6_944, "144Hz");
        assert_decimates_to_nominal(8_333, "120Hz");
        assert_decimates_to_nominal(13_333, "75Hz"); // per-frame thresholds miss this one
        assert_decimates_to_nominal(4_167, "240Hz");
    }

    #[test]
    fn first_frame_after_idle_is_admitted_immediately() {
        let mut gate = FrameCadenceGate::new(NOMINAL_60FPS);
        // Animate fast enough to enter decimation…
        let mut timestamps: Vec<i64> = (0..200).map(|i| i * 6_061).collect();
        // …then go idle for five seconds and update once.
        let idle_end = timestamps.last().unwrap() + 5_000_000;
        timestamps.push(idle_end);
        let admitted = run_source(&mut gate, &timestamps);
        assert_eq!(
            admitted.last().copied(),
            Some(idle_end),
            "the update ending an idle stretch must not wait out stale deadlines"
        );
    }

    #[test]
    fn mode_follows_content_rate_changes() {
        let mut gate = FrameCadenceGate::new(NOMINAL_60FPS);

        // Static-ish 60Hz content: everything passes.
        let phase1: Vec<i64> = (0..200).map(|i| i * NOMINAL_60FPS).collect();
        let admitted1 = run_source(&mut gate, &phase1);
        assert_eq!(admitted1.len(), phase1.len());

        // Animation at 165Hz: decimation engages within a few frames.
        let start = phase1.last().unwrap() + 6_061;
        let phase2: Vec<i64> = (0..2000).map(|i| start + i * 6_061).collect();
        let admitted2 = run_source(&mut gate, &phase2);
        let ratio = admitted2.len() as f64 / phase2.len() as f64;
        assert!(
            ratio < 0.45,
            "expected heavy decimation at 165Hz, admitted {ratio:.2}"
        );
    }

    #[test]
    fn non_monotonic_timestamps_are_admitted() {
        let mut gate = FrameCadenceGate::new(NOMINAL_60FPS);
        assert!(gate.admit(100_000));
        assert!(gate.admit(50_000), "backwards clock must never drop frames");
        assert!(
            gate.admit(50_000),
            "equal timestamps must never drop frames"
        );
    }
}
