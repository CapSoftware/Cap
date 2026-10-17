//! Repeats the last frame while a Windows video source is stalled, so the
//! encoder keeps a steady track, without taking the timestamp of a frame that
//! is only late.
//!
//! The Windows encoder loops used to repeat the last frame as soon as one
//! frame interval passed without a new one, stamped one interval after it:
//! the slot a slightly late real frame is stamped for. The real frame then
//! landed on the same timestamp and the muxer moved it by one tick, so a
//! camera with ordinary arrival jitter recorded duplicated frames followed by
//! frames shown for 11 µs (16 of 262 in real-capture run 39000141528).

use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{Receiver, RecvTimeoutError},
    },
    time::{Duration, Instant},
};

/// Frame intervals of silence before the last frame is repeated. A repeat is
/// stamped one interval after the previous frame and sent once a frame for
/// that slot would be two intervals late.
const STALL_INTERVALS: u32 = 3;

pub(crate) enum Paced<F> {
    /// A frame from the source and its timestamp.
    Frame(F, Duration),
    /// Encode the last frame again at this timestamp.
    Repeat(Duration),
    End,
}

pub(crate) struct FramePacer {
    interval: Duration,
    last: Option<LastFrame>,
}

struct LastFrame {
    timestamp: Duration,
    arrived: Instant,
    repeats: u32,
}

impl FramePacer {
    pub(crate) fn new(frame_rate: u32) -> Self {
        Self {
            interval: Duration::from_secs_f64(1.0 / f64::from(frame_rate.max(1))),
            last: None,
        }
    }

    /// Blocks until a frame arrives, the source has been silent long enough
    /// to repeat the last one, or the stream ends. While `paused`, nothing is
    /// repeated and the next frame starts afresh.
    pub(crate) fn next<F>(
        &mut self,
        rx: &Receiver<Option<(F, Duration)>>,
        paused: &AtomicBool,
    ) -> Paced<F> {
        loop {
            let received = match &self.last {
                None => rx.recv().map_err(|_| RecvTimeoutError::Disconnected),
                Some(last) => {
                    let due = last.arrived + self.interval * (STALL_INTERVALS + last.repeats);
                    rx.recv_timeout(due.saturating_duration_since(Instant::now()))
                }
            };
            match received {
                Ok(Some((frame, timestamp))) => {
                    self.last = Some(LastFrame {
                        timestamp,
                        arrived: Instant::now(),
                        repeats: 0,
                    });
                    return Paced::Frame(frame, timestamp);
                }
                Ok(None) | Err(RecvTimeoutError::Disconnected) => return Paced::End,
                Err(RecvTimeoutError::Timeout) => {
                    if paused.load(Ordering::Acquire) {
                        self.last = None;
                        continue;
                    }
                    let Some(last) = self.last.as_mut() else {
                        continue;
                    };
                    last.repeats += 1;
                    return Paced::Repeat(last.timestamp + self.interval * last.repeats);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc::sync_channel;

    const FPS: u32 = 50;
    const INTERVAL: Duration = Duration::from_millis(20);

    fn at(n: u32) -> Duration {
        INTERVAL * n
    }

    #[test]
    fn jittered_frames_pass_through_without_repeats() {
        let (tx, rx) = sync_channel(64);
        let sender = std::thread::spawn(move || {
            for n in 0..20u32 {
                // Frames arrive up to 15 ms (three quarters of an interval) late.
                std::thread::sleep(if n % 2 == 0 {
                    INTERVAL + INTERVAL * 3 / 4
                } else {
                    INTERVAL / 4
                });
                tx.send(Some((n, at(n)))).unwrap();
            }
            tx.send(None).unwrap();
        });
        let mut pacer = FramePacer::new(FPS);
        let paused = AtomicBool::new(false);
        let mut seen = Vec::new();
        loop {
            match pacer.next(&rx, &paused) {
                Paced::Frame(n, ts) => seen.push((n, ts)),
                Paced::Repeat(ts) => panic!("repeat at {ts:?} for a frame that was only late"),
                Paced::End => break,
            }
        }
        sender.join().unwrap();
        assert_eq!(seen, (0..20).map(|n| (n, at(n))).collect::<Vec<_>>());
    }

    #[test]
    fn a_stall_repeats_the_last_frame_on_its_grid_behind_real_time() {
        let (tx, rx) = sync_channel(4);
        let mut pacer = FramePacer::new(FPS);
        let paused = AtomicBool::new(false);
        tx.send(Some((7u32, at(10)))).unwrap();
        let start = Instant::now();
        assert!(matches!(pacer.next(&rx, &paused), Paced::Frame(7, ts) if ts == at(10)));
        let Paced::Repeat(first) = pacer.next(&rx, &paused) else {
            panic!("expected a repeat");
        };
        assert_eq!(first, at(11));
        assert!(start.elapsed() >= INTERVAL * STALL_INTERVALS);
        let Paced::Repeat(second) = pacer.next(&rx, &paused) else {
            panic!("expected a repeat");
        };
        assert_eq!(second, at(12));
        assert!(start.elapsed() >= INTERVAL * (STALL_INTERVALS + 1));
        // The source resumes with a frame captured after the stall.
        tx.send(Some((8, at(16)))).unwrap();
        assert!(matches!(pacer.next(&rx, &paused), Paced::Frame(8, ts) if ts == at(16)));
    }

    #[test]
    fn nothing_repeats_while_paused() {
        let (tx, rx) = sync_channel(4);
        let mut pacer = FramePacer::new(FPS);
        let paused = AtomicBool::new(false);
        tx.send(Some((1u32, at(0)))).unwrap();
        assert!(matches!(pacer.next(&rx, &paused), Paced::Frame(1, _)));
        paused.store(true, Ordering::Release);
        let sender = std::thread::spawn(move || {
            std::thread::sleep(INTERVAL * 8);
            tx.send(Some((2, at(40)))).unwrap();
            tx.send(None).unwrap();
        });
        assert!(matches!(pacer.next(&rx, &paused), Paced::Frame(2, ts) if ts == at(40)));
        assert!(matches!(pacer.next(&rx, &paused), Paced::End));
        sender.join().unwrap();
    }

    #[test]
    fn the_stream_ends_on_none_or_disconnect() {
        let paused = AtomicBool::new(false);
        let (tx, rx) = sync_channel::<Option<(u32, Duration)>>(1);
        tx.send(None).unwrap();
        assert!(matches!(
            FramePacer::new(FPS).next(&rx, &paused),
            Paced::End
        ));
        drop(tx);
        assert!(matches!(
            FramePacer::new(FPS).next(&rx, &paused),
            Paced::End
        ));
    }
}
