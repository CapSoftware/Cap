#![allow(dead_code)]

use std::{
    collections::BTreeMap,
    path::PathBuf,
    sync::mpsc,
    time::{Duration, Instant},
};
use tokio::sync::oneshot;
use tracing::{info, warn};

use super::{DecodedFrame, DecoderInitResult, DecoderType, FRAME_CACHE_SIZE, VideoDecoderMessage};

const MAX_FRAME_CACHE_BYTES: usize = 128 * 1024 * 1024;

struct DecoderHealthMonitor {
    consecutive_errors: u32,
    total_frames_decoded: u64,
    total_errors: u64,
    last_successful_decode: Instant,
    last_request_time: Instant,
    last_unhealthy_warning: Option<Instant>,
    frame_decode_times: [Duration; 32],
    frame_decode_index: usize,
    slow_frame_count: u32,
}

impl DecoderHealthMonitor {
    fn new() -> Self {
        Self {
            consecutive_errors: 0,
            total_frames_decoded: 0,
            total_errors: 0,
            last_successful_decode: Instant::now(),
            last_request_time: Instant::now(),
            last_unhealthy_warning: None,
            frame_decode_times: [Duration::ZERO; 32],
            frame_decode_index: 0,
            slow_frame_count: 0,
        }
    }

    fn record_request(&mut self) {
        self.last_request_time = Instant::now();
    }

    fn record_success(&mut self, decode_time: Duration) {
        self.consecutive_errors = 0;
        self.total_frames_decoded += 1;
        self.last_successful_decode = Instant::now();

        self.frame_decode_times[self.frame_decode_index] = decode_time;
        self.frame_decode_index = (self.frame_decode_index + 1) % 32;

        const SLOW_FRAME_THRESHOLD: Duration = Duration::from_millis(100);
        if decode_time > SLOW_FRAME_THRESHOLD {
            self.slow_frame_count += 1;
        }
    }

    fn record_error(&mut self) {
        self.consecutive_errors += 1;
        self.total_errors += 1;
    }

    fn is_healthy(&self) -> bool {
        const MAX_CONSECUTIVE_ERRORS: u32 = 10;
        const MAX_TIME_SINCE_SUCCESS: Duration = Duration::from_secs(5);

        if self.consecutive_errors >= MAX_CONSECUTIVE_ERRORS {
            return false;
        }

        let idle_duration = self.last_request_time.elapsed();
        if idle_duration > Duration::from_secs(2) {
            return true;
        }

        self.last_successful_decode.elapsed() < MAX_TIME_SINCE_SUCCESS
    }

    fn should_warn_unhealthy(&mut self) -> bool {
        if self.is_healthy() {
            return false;
        }

        let should_warn = self
            .last_unhealthy_warning
            .is_none_or(|last| last.elapsed() > Duration::from_secs(5));

        if should_warn {
            self.last_unhealthy_warning = Some(Instant::now());
        }

        should_warn
    }

    #[allow(dead_code)]
    fn average_decode_time(&self) -> Duration {
        let sum: Duration = self.frame_decode_times.iter().sum();
        sum / 32
    }

    #[allow(dead_code)]
    fn get_health_summary(&self) -> (u64, u64, u32) {
        (
            self.total_frames_decoded,
            self.total_errors,
            self.slow_frame_count,
        )
    }
}

pub struct MFDecoder;

impl MFDecoder {
    pub fn spawn(
        name: &'static str,
        path: PathBuf,
        fps: u32,
        rx: mpsc::Receiver<VideoDecoderMessage>,
        ready_tx: oneshot::Sender<Result<DecoderInitResult, String>>,
    ) -> Result<(), String> {
        std::thread::spawn(move || {
            let mut decoder = match cap_video_decode::MediaFoundationDecoder::new(&path) {
                Err(e) => {
                    let _ = ready_tx.send(Err(e));
                    return;
                }
                Ok(v) => {
                    let width = v.width();
                    let height = v.height();
                    let caps = v.capabilities();

                    let exceeds_hw_limits = width > caps.max_width || height > caps.max_height;

                    if exceeds_hw_limits {
                        warn!(
                            "Video '{}' dimensions {}x{} exceed hardware decoder limits ({}x{})",
                            name, width, height, caps.max_width, caps.max_height
                        );
                        let _ = ready_tx.send(Err(format!(
                            "Video dimensions {}x{} exceed hardware decoder limits {}x{}",
                            width, height, caps.max_width, caps.max_height
                        )));
                        return;
                    }

                    info!(
                        "MediaFoundation decoder created for '{}': {}x{} @ {:?}fps (hw max: {}x{})",
                        name,
                        width,
                        height,
                        v.frame_rate(),
                        caps.max_width,
                        caps.max_height
                    );
                    v
                }
            };

            let video_width = decoder.width();
            let video_height = decoder.height();
            let matrix = super::probe_yuv_matrix(&path);

            let mut health = DecoderHealthMonitor::new();

            let init_result = DecoderInitResult {
                width: video_width,
                height: video_height,
                decoder_type: DecoderType::MediaFoundation,
            };
            let _ = ready_tx.send(Ok(init_result));

            let pixel_count = (video_width as u64) * (video_height as u64);
            let readahead_frames = if pixel_count > 4_000_000 {
                8
            } else if pixel_count > 2_000_000 {
                15
            } else {
                30
            };
            let mut requests = FrameRequests::new(readahead_frames);
            let answer = |sender: oneshot::Sender<DecodedFrame>,
                          frame: Option<cap_video_decode::NV12Data>| {
                let _ = sender.send(frame.map_or_else(
                    || {
                        DecodedFrame::new(
                            vec![0u8; (video_width * video_height * 4) as usize],
                            video_width,
                            video_height,
                        )
                    },
                    |data| {
                        DecodedFrame::new_nv12_with_arc(
                            data.data,
                            video_width,
                            video_height,
                            data.y_stride,
                            data.uv_stride,
                        )
                        .with_matrix(matrix)
                    },
                ));
            };

            loop {
                loop {
                    let message = match requests.next_step() {
                        Step::Wait => rx.recv().ok(),
                        _ => match rx.try_recv() {
                            Err(mpsc::TryRecvError::Empty) => break,
                            message => message.ok(),
                        },
                    };
                    // Each request borrows a decoder handle, which owns the sender, so once the
                    // channel is gone nobody is waiting for an answer.
                    let Some(message) = message else {
                        return;
                    };
                    let VideoDecoderMessage::GetFrame(time, _, sender) = message else {
                        continue;
                    };
                    if sender.is_closed() {
                        continue;
                    }

                    let frame = super::request_frame(time, fps);
                    match requests.request(frame, sender) {
                        Some((sender, cached)) => answer(sender, cached),
                        None => {
                            health.record_request();
                            if health.should_warn_unhealthy() {
                                warn!(
                                    name = name,
                                    consecutive_errors = health.consecutive_errors,
                                    total_decoded = health.total_frames_decoded,
                                    "MediaFoundation decoder unhealthy, performance may degrade"
                                );
                            }
                        }
                    }
                }
                requests.waiting.retain(|(_, sender)| !sender.is_closed());

                let answers = match requests.next_step() {
                    Step::Wait => Vec::new(),
                    Step::Seek(frame) => match decoder.seek(frame_to_100ns(frame, fps)) {
                        Ok(()) => {
                            requests.seeked(frame);
                            Vec::new()
                        }
                        Err(e) => {
                            warn!("MediaFoundation seek failed: {e}");
                            requests.stopped()
                        }
                    },
                    Step::Decode => {
                        let decode_start = Instant::now();
                        match decoder.read_nv12() {
                            Ok(Some(sample)) => {
                                health.record_success(decode_start.elapsed());
                                let bytes = sample.data.data.len();
                                requests.decoded(
                                    pts_100ns_to_frame(sample.pts, fps),
                                    sample.data,
                                    bytes,
                                )
                            }
                            Ok(None) => requests.stopped(),
                            Err(e) => {
                                health.record_error();
                                warn!(
                                    consecutive_errors = health.consecutive_errors,
                                    "MediaFoundation read error: {e}"
                                );
                                requests.stopped()
                            }
                        }
                    }
                };
                for (sender, cached) in answers {
                    answer(sender, cached);
                }
            }
        });

        Ok(())
    }
}

fn frame_to_100ns(frame: u32, fps: u32) -> i64 {
    ((frame as i64) * 10_000_000) / (fps as i64)
}

// Rounds like the FFmpeg decoder's `pts_to_frame`: sample times are 100 ns
// ticks, so 1/30 s is stored as 333_333 and truncating it lands on frame 0,
// colliding with the real frame 0 and losing one of them from the cache.
fn pts_100ns_to_frame(pts_100ns: i64, fps: u32) -> u32 {
    super::pts_to_frame(pts_100ns, ::ffmpeg::Rational::new(1, 10_000_000), fps)
}

enum Step {
    Seek(u32),
    Decode,
    Wait,
}

type Answer<T, R> = (R, Option<T>);

// The decoder thread's request policy, kept apart from Media Foundation so tests can drive
// it. A request is answered with the newest sample at or below its frame once the decoder
// has moved past that frame: a VFR stream can still have a later sample rounding to the same
// frame (which replaces it), so answering earlier would make the choice depend on request
// timing. Once the decoder is past a frame the stream has no sample for, the one before it is
// the hold the video really shows.
struct FrameRequests<T, R> {
    // Every sample since the last seek minus the oldest evicted, so the newest entry at or
    // below a frame is the stream's newest sample there.
    cache: BTreeMap<u32, (T, usize)>,
    cache_bytes: usize,
    waiting: Vec<(u32, R)>,
    seeked_to: Option<u32>,
    readahead_frames: u32,
    latest_request: Option<u32>,
}

impl<T: Clone, R> FrameRequests<T, R> {
    fn new(readahead_frames: u32) -> Self {
        Self {
            cache: BTreeMap::new(),
            cache_bytes: 0,
            waiting: Vec::new(),
            seeked_to: None,
            readahead_frames,
            latest_request: None,
        }
    }

    fn newest(&self) -> Option<u32> {
        self.cache.last_key_value().map(|(&frame, _)| frame)
    }

    fn newest_at(&self, frame: u32) -> Option<&T> {
        self.cache
            .range(..=frame)
            .next_back()
            .map(|(_, (sample, _))| sample)
    }

    // A seek lands on the keyframe before its target, which can be any distance below it.
    fn position(&self) -> Option<u32> {
        self.newest().max(self.seeked_to)
    }

    fn request(&mut self, frame: u32, reply: R) -> Option<Answer<T, R>> {
        self.latest_request = Some(frame);
        if self.newest().is_some_and(|newest| newest > frame)
            && let Some(sample) = self.newest_at(frame)
        {
            return Some((reply, Some(sample.clone())));
        }
        self.waiting.push((frame, reply));
        None
    }

    // The lowest waiting frame goes first, so each request gets its own sample instead of
    // whatever a seek for a later one lands on. Decoding forward only reaches frames from the
    // newest sample on, so one below it seeks back.
    fn next_step(&self) -> Step {
        let Some(target) = self.waiting.iter().map(|(frame, _)| *frame).min() else {
            return if self.wants_readahead() {
                Step::Decode
            } else {
                Step::Wait
            };
        };
        let reachable = self
            .newest()
            .or(self.seeked_to)
            .zip(self.position())
            .is_some_and(|(from, position)| {
                (from..=position.saturating_add(FRAME_CACHE_SIZE as u32)).contains(&target)
            });
        if reachable {
            Step::Decode
        } else {
            Step::Seek(target)
        }
    }

    // Readahead stops before the next sample would evict the one answering the latest
    // request: with frames too big for the cache budget, that would send every request back
    // to a seek.
    fn wants_readahead(&self) -> bool {
        let (Some(position), Some(latest)) = (self.position(), self.latest_request) else {
            return false;
        };
        let full = self.cache.last_key_value().is_some_and(|(_, (_, bytes))| {
            self.cache.len() >= FRAME_CACHE_SIZE || self.cache_bytes + bytes > MAX_FRAME_CACHE_BYTES
        });
        let evicts_shown = full && self.cache.range(..=latest).nth(1).is_none();
        position < latest.saturating_add(self.readahead_frames) && !evicts_shown
    }

    fn seeked(&mut self, frame: u32) {
        self.cache.clear();
        self.cache_bytes = 0;
        self.seeked_to = Some(frame);
    }

    // A waiting frame the decoder jumped past has no sample at or below it since the seek, so
    // it gets the first one after.
    fn decoded(&mut self, frame: u32, sample: T, bytes: usize) -> Vec<Answer<T, R>> {
        let (passed, waiting): (Vec<_>, _) = std::mem::take(&mut self.waiting)
            .into_iter()
            .partition(|(requested, _)| *requested < frame);
        self.waiting = waiting;
        let answers = passed
            .into_iter()
            .map(|(requested, reply)| {
                let held = self.newest_at(requested).unwrap_or(&sample);
                (reply, Some(held.clone()))
            })
            .collect();

        if let Some((_, replaced)) = self.cache.remove(&frame) {
            self.cache_bytes -= replaced;
        }
        while !self.cache.is_empty()
            && (self.cache.len() >= FRAME_CACHE_SIZE
                || self.cache_bytes + bytes > MAX_FRAME_CACHE_BYTES)
        {
            if let Some((_, (_, evicted))) = self.cache.pop_first() {
                self.cache_bytes -= evicted;
            }
        }
        self.cache.insert(frame, (sample, bytes));
        self.cache_bytes += bytes;
        answers
    }

    // No sample came (end of stream or a read error), so nothing reads again until the next
    // request.
    fn stopped(&mut self) -> Vec<Answer<T, R>> {
        self.latest_request = None;
        std::mem::take(&mut self.waiting)
            .into_iter()
            .map(|(frame, reply)| {
                let nearest = self.newest_at(frame).or_else(|| {
                    self.cache
                        .range(frame..)
                        .next()
                        .map(|(_, (sample, _))| sample)
                });
                (reply, nearest.cloned())
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sample_times_round_to_their_frame() {
        assert_eq!(pts_100ns_to_frame(0, 30), 0);
        assert_eq!(pts_100ns_to_frame(333_333, 30), 1);
        assert_eq!(pts_100ns_to_frame(666_666, 30), 2);
        assert_eq!(pts_100ns_to_frame(10_000_000, 30), 30);
    }

    // Samples are their index in `frames`, which holds the frame each one rounds to.
    struct FakeStream {
        frames: Vec<u32>,
        keyframe_every: usize,
        next: usize,
        reads: usize,
        seeks: usize,
        bytes: usize,
        fail_next_read: bool,
    }

    impl FakeStream {
        fn new(frames: impl IntoIterator<Item = u32>, keyframe_every: usize) -> Self {
            Self {
                frames: frames.into_iter().collect(),
                keyframe_every,
                next: 0,
                reads: 0,
                seeks: 0,
                bytes: 1,
                fail_next_read: false,
            }
        }

        fn step(
            &mut self,
            requests: &mut FrameRequests<usize, usize>,
        ) -> Option<Vec<Answer<usize, usize>>> {
            match requests.next_step() {
                Step::Wait => None,
                Step::Seek(frame) => {
                    let at = self.frames.iter().rposition(|&f| f <= frame).unwrap_or(0);
                    self.next = at - at % self.keyframe_every;
                    self.seeks += 1;
                    assert!(self.seeks < 100, "seek loop");
                    requests.seeked(frame);
                    Some(Vec::new())
                }
                Step::Decode => {
                    self.reads += 1;
                    Some(if std::mem::take(&mut self.fail_next_read) {
                        requests.stopped()
                    } else if let Some(&frame) = self.frames.get(self.next) {
                        self.next += 1;
                        requests.decoded(frame, self.next - 1, self.bytes)
                    } else {
                        requests.stopped()
                    })
                }
            }
        }

        fn run(&mut self, requests: &mut FrameRequests<usize, usize>) -> Vec<Answer<usize, usize>> {
            let mut answers = Vec::new();
            while let Some(step) = self.step(requests) {
                answers.extend(step);
            }
            answers
        }
    }

    #[test]
    fn a_frame_is_answered_once_the_decoder_moves_past_it() {
        let mut requests = FrameRequests::new(0);
        let mut stream = FakeStream::new(0..20, 1);
        assert!(requests.request(15, 0).is_none());
        assert_eq!(stream.run(&mut requests), [(0, Some(15))]);
        assert!(requests.request(16, 1).is_none());
        assert_eq!(requests.request(15, 2), Some((2, Some(15))));
        assert_eq!(stream.run(&mut requests), [(1, Some(16))]);
    }

    #[test]
    fn colliding_vfr_samples_answer_the_same_whenever_requested() {
        let frames = [0, 1, 1, 2, 3];

        let mut early = FrameRequests::new(0);
        let mut stream = FakeStream::new(frames, 10);
        early.request(1, 0);
        assert_eq!(stream.run(&mut early), [(0, Some(2))]);

        let mut late = FrameRequests::new(0);
        let mut stream = FakeStream::new(frames, 10);
        late.request(0, 0);
        assert_eq!(stream.run(&mut late), [(0, Some(0))]);
        assert!(late.request(1, 1).is_none());
        assert_eq!(stream.run(&mut late), [(1, Some(2))]);
    }

    #[test]
    fn a_frame_the_stream_skipped_holds_the_previous_one() {
        let mut requests = FrameRequests::new(0);
        let mut stream = FakeStream::new([1, 4, 5], 10);
        requests.request(0, 0);
        requests.request(2, 1);
        requests.request(3, 2);
        assert_eq!(
            stream.run(&mut requests),
            [(0, Some(0)), (1, Some(0)), (2, Some(0))]
        );
    }

    #[test]
    fn readahead_slides_with_every_request() {
        let mut requests = FrameRequests::new(5);
        let mut stream = FakeStream::new(0..100, 30);
        requests.request(0, 0);
        assert_eq!(stream.run(&mut requests), [(0, Some(0))]);
        for frame in 1..40 {
            let sample = frame as usize;
            assert_eq!(
                requests.request(frame, sample),
                Some((sample, Some(sample)))
            );
            assert!(stream.run(&mut requests).is_empty());
            assert_eq!(requests.position(), Some(frame + 5));
        }
        assert_eq!(stream.seeks, 1);
    }

    #[test]
    fn readahead_never_evicts_a_frame_still_being_shown() {
        let frames: Vec<u32> = (0..=10).chain(50..=90).collect();
        let mut requests = FrameRequests::new(8);
        let mut stream = FakeStream::new(frames.clone(), 100);
        stream.bytes = MAX_FRAME_CACHE_BYTES / 2;
        for frame in 0..70 {
            let mut answers: Vec<_> = requests.request(frame, 0).into_iter().collect();
            answers.extend(stream.run(&mut requests));
            assert_eq!(answers, [(0, frames.iter().rposition(|&f| f <= frame))]);
        }
        assert_eq!(stream.seeks, 1);
    }

    #[test]
    fn every_waiting_request_gets_its_own_frame() {
        let mut requests = FrameRequests::new(0);
        let mut stream = FakeStream::new(0..400, 30);
        requests.request(300, 0);
        requests.request(30, 1);
        assert_eq!(stream.run(&mut requests), [(1, Some(30)), (0, Some(300))]);
        assert_eq!(stream.seeks, 2);
    }

    #[test]
    fn a_passed_frame_missing_from_the_cache_seeks_back() {
        let mut requests = FrameRequests::new(30);
        let mut stream = FakeStream::new(0..200, 10);
        requests.request(100, 0);
        assert_eq!(stream.run(&mut requests), [(0, Some(100))]);
        assert!(requests.request(90, 1).is_none());
        assert_eq!(stream.run(&mut requests), [(1, Some(90))]);
        assert_eq!(stream.seeks, 2);
    }

    #[test]
    fn far_requests_seek_and_near_ones_decode_through() {
        let mut requests = FrameRequests::new(0);
        let mut stream = FakeStream::new(0..400, 30);
        requests.request(10, 0);
        stream.run(&mut requests);
        requests.request(90, 1);
        assert_eq!(stream.run(&mut requests), [(1, Some(90))]);
        assert_eq!(stream.seeks, 1);
        requests.request(300, 2);
        assert_eq!(stream.run(&mut requests), [(2, Some(300))]);
        assert_eq!(stream.seeks, 2);
    }

    #[test]
    fn a_seek_decodes_through_a_long_gop_without_seeking_again() {
        let mut requests = FrameRequests::new(0);
        let mut stream = FakeStream::new(0..400, 200);
        requests.request(150, 0);
        assert_eq!(stream.run(&mut requests), [(0, Some(150))]);
        assert_eq!(stream.seeks, 1);
    }

    #[test]
    fn a_request_inside_a_seeks_preroll_decodes_through() {
        let mut requests = FrameRequests::new(0);
        let mut stream = FakeStream::new(0..400, 30);
        requests.request(310, 0);
        stream.step(&mut requests);
        stream.step(&mut requests);
        assert_eq!(requests.newest(), Some(300));
        requests.request(305, 1);
        assert_eq!(stream.run(&mut requests), [(1, Some(305)), (0, Some(310))]);
        assert_eq!(stream.seeks, 1);
    }

    #[test]
    fn the_end_of_the_stream_holds_its_last_frame() {
        let mut requests = FrameRequests::new(30);
        let mut stream = FakeStream::new(0..5, 10);
        requests.request(3, 0);
        assert_eq!(stream.run(&mut requests), [(0, Some(3))]);
        assert!(requests.request(4, 1).is_none());
        assert!(requests.request(60, 2).is_none());
        assert_eq!(stream.run(&mut requests), [(1, Some(4)), (2, Some(4))]);
    }

    #[test]
    fn a_read_error_answers_what_waits_and_the_next_request_retries() {
        let mut requests = FrameRequests::new(0);
        let mut stream = FakeStream::new(0..10, 10);
        requests.request(0, 0);
        stream.run(&mut requests);
        requests.request(5, 1);
        stream.fail_next_read = true;
        assert_eq!(stream.run(&mut requests), [(1, Some(1))]);
        requests.request(5, 2);
        assert_eq!(stream.run(&mut requests), [(2, Some(5))]);
    }
}
