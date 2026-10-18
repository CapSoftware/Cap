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
    Frame(F, Duration),
    Repeat(Duration),
    End,
}

pub(crate) struct FramePacer {
    interval: Duration,
    last: Option<LastFrame>,
    paused_since: Option<Instant>,
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
            paused_since: None,
        }
    }

    /// Blocks until a frame arrives, the source has been silent long enough
    /// to repeat the last one, or the stream ends. Nothing repeats while
    /// `paused`. Frame timestamps exclude paused time, so on resume the last
    /// frame counts as having arrived that much later, and repeats continue
    /// on its grid two intervals behind real time: a source that sends
    /// nothing until the screen changes still gets the resumed span. Waits
    /// are cut to half an interval so a pause is timed to within that.
    pub(crate) fn next<F>(
        &mut self,
        rx: &Receiver<Option<(F, Duration)>>,
        paused: &AtomicBool,
    ) -> Paced<F> {
        let slice = self.interval / 2;
        loop {
            let is_paused = paused.load(Ordering::Acquire);
            match (is_paused, self.paused_since) {
                (true, None) => self.paused_since = Some(Instant::now()),
                (false, Some(since)) => {
                    if let Some(last) = self.last.as_mut() {
                        last.arrived += since.elapsed();
                    }
                    self.paused_since = None;
                }
                _ => {}
            }
            let due = self
                .last
                .as_ref()
                .map(|last| last.arrived + self.interval * (STALL_INTERVALS + last.repeats));
            let received = match due {
                None => rx.recv().map_err(|_| RecvTimeoutError::Disconnected),
                Some(_) if is_paused => rx.recv_timeout(slice),
                Some(due) => {
                    rx.recv_timeout(due.saturating_duration_since(Instant::now()).min(slice))
                }
            };
            match received {
                Ok(Some((frame, timestamp))) => {
                    // The pause so far happened before this frame; if it
                    // continues, the next call times it from now.
                    self.paused_since = None;
                    self.last = Some(LastFrame {
                        timestamp,
                        arrived: Instant::now(),
                        repeats: 0,
                    });
                    return Paced::Frame(frame, timestamp);
                }
                Ok(None) | Err(RecvTimeoutError::Disconnected) => return Paced::End,
                Err(RecvTimeoutError::Timeout) => {
                    if is_paused || due.is_some_and(|due| Instant::now() < due) {
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
    use std::sync::{Arc, mpsc::sync_channel};

    // Long intervals so a loaded runner's oversleep (tens of ms) never
    // reaches the three-interval stall in the jitter test.
    const FPS: u32 = 5;
    const INTERVAL: Duration = Duration::from_millis(200);

    fn at(n: u32) -> Duration {
        INTERVAL * n
    }

    #[test]
    fn jittered_frames_pass_through_without_repeats() {
        let (tx, rx) = sync_channel(64);
        let sender = std::thread::spawn(move || {
            for n in 0..10u32 {
                // Frames arrive up to three quarters of an interval late.
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
        assert_eq!(seen, (0..10).map(|n| (n, at(n))).collect::<Vec<_>>());
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
    fn repeats_resume_after_a_pause_on_the_last_frames_grid() {
        let (tx, rx) = sync_channel(4);
        let mut pacer = FramePacer::new(FPS);
        let paused = Arc::new(AtomicBool::new(false));
        tx.send(Some((1u32, at(5)))).unwrap();
        assert!(matches!(pacer.next(&rx, &paused), Paced::Frame(1, _)));
        let start = Instant::now();
        paused.store(true, Ordering::Release);
        let resumer = {
            let paused = paused.clone();
            std::thread::spawn(move || {
                std::thread::sleep(INTERVAL * 6);
                paused.store(false, Ordering::Release);
            })
        };
        // A static screen: nothing arrives after the resume either.
        let Paced::Repeat(first) = pacer.next(&rx, &paused) else {
            panic!("expected a repeat after the resume");
        };
        assert_eq!(first, at(6));
        assert!(start.elapsed() >= INTERVAL * (6 + STALL_INTERVALS));
        let Paced::Repeat(second) = pacer.next(&rx, &paused) else {
            panic!("expected a repeat");
        };
        assert_eq!(second, at(7));
        resumer.join().unwrap();
        drop(tx);
    }

    #[test]
    fn a_frame_that_arrives_while_paused_ends_the_pause_adjustment() {
        let (tx, rx) = sync_channel(4);
        let mut pacer = FramePacer::new(FPS);
        let paused = AtomicBool::new(false);
        tx.send(Some((1u32, at(0)))).unwrap();
        assert!(matches!(pacer.next(&rx, &paused), Paced::Frame(1, _)));
        paused.store(true, Ordering::Release);
        tx.send(Some((2, at(1)))).unwrap();
        assert!(matches!(pacer.next(&rx, &paused), Paced::Frame(2, _)));
        let arrived = Instant::now();
        paused.store(false, Ordering::Release);
        std::thread::sleep(INTERVAL * 6);
        // Frame 2 has been up for six intervals: its first repeat is overdue.
        let Paced::Repeat(first) = pacer.next(&rx, &paused) else {
            panic!("expected a repeat");
        };
        assert_eq!(first, at(2));
        assert!(arrived.elapsed() < INTERVAL * 8);
        drop(tx);
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
