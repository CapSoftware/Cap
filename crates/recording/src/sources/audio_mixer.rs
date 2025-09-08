use cap_media_info::AudioInfo;
use ffmpeg::sys::AV_TIME_BASE_Q;
use flume::{Receiver, Sender};
use std::collections::VecDeque;
use std::time::{Duration, SystemTime};
use tracing::{debug, trace, warn};

use crate::{
    capture_pipeline::{SourceTimestamp, SourceTimestamps},
    pipeline::task::PipelineSourceTask,
};

struct BufferedAudioSource {
    rx: Receiver<(ffmpeg::frame::Audio, SourceTimestamp)>,
    info: AudioInfo,
    buffer: VecDeque<(ffmpeg::frame::Audio, SourceTimestamp)>,
    last_processed_timestamp: Option<SourceTimestamp>,
    last_output_pts: i64,
    expected_frame_duration_ms: f64,
    total_samples_processed: u64,
    timeline_position: Duration, // Track our position in the timeline directly
}

impl BufferedAudioSource {
    fn new(rx: Receiver<(ffmpeg::frame::Audio, SourceTimestamp)>, info: AudioInfo) -> Self {
        let expected_frame_duration_ms = 1024.0 / info.rate() as f64 * 1000.0;

        Self {
            rx,
            info,
            buffer: VecDeque::new(),
            last_processed_timestamp: None,
            last_output_pts: 0,
            expected_frame_duration_ms,
            total_samples_processed: 0,
            timeline_position: Duration::ZERO,
        }
    }

    fn fill_buffer(&mut self) {
        let initial_size = self.buffer.len();
        let mut frames_received = 0;
        let is_disconnected = self.rx.is_disconnected();

        while let Ok((frame, timestamp)) = self.rx.try_recv() {
            trace!(
                "Received audio frame: {} samples, timestamp: {:?}",
                frame.samples(),
                timestamp
            );
            self.buffer.push_back((frame, timestamp));
            frames_received += 1;
        }

        if frames_received > 0 {
            trace!(
                "Buffer filled: {} new frames, total buffer size: {} -> {}",
                frames_received,
                initial_size,
                self.buffer.len()
            );
        } else if is_disconnected {
            trace!("Receiver disconnected, no more frames will be received");
        }
    }

    fn has_sufficient_buffer(&self) -> bool {
        self.buffer.len() >= 2 || self.rx.is_disconnected()
    }

    fn generate_silent_frame(&self, samples: usize) -> ffmpeg::frame::Audio {
        let mut frame =
            ffmpeg::frame::Audio::new(self.info.sample_format, samples, self.info.channel_layout());

        unsafe {
            let data = frame.data_mut(0);
            let bytes_per_sample = self.info.sample_format.bytes() as usize;
            let total_bytes =
                samples * self.info.channel_layout().channels() as usize * bytes_per_sample;
            std::ptr::write_bytes(data.as_mut_ptr(), 0, total_bytes);
        }

        frame
    }

    fn generate_initial_silence_if_needed(
        &mut self,
        _target_time: Duration,
        _start_timestamps: SourceTimestamps,
    ) -> Vec<ffmpeg::frame::Audio> {
        // No longer generate initial silence - let the mixer handle silence generation
        Vec::new()
    }

    fn process_with_gap_filling(
        &mut self,
        target_time: Duration,
        start_timestamps: SourceTimestamps,
    ) -> Vec<ffmpeg::frame::Audio> {
        let mut output_frames = Vec::new();

        // Always process ALL available frames - don't leave them in buffer
        while !self.buffer.is_empty() {
            let (mut frame, timestamp) = self.buffer.pop_front().unwrap();
            let frame_time = timestamp.duration_since(start_timestamps);
            let frame_samples = frame.samples() as u64;

            // Check for gap if we've processed frames before
            if let Some(last_ts) = &self.last_processed_timestamp {
                let last_time = last_ts.duration_since(start_timestamps);
                let expected_next = last_time
                    + Duration::from_secs_f64(frame_samples as f64 / self.info.rate() as f64);

                // If there's a gap larger than 1.5 frames, fill it with silence
                if frame_time > expected_next + Duration::from_millis(30) {
                    let gap = frame_time - expected_next;
                    let silent_samples = ((gap.as_secs_f64()) * self.info.rate() as f64) as usize;

                    let mut remaining = silent_samples;
                    while remaining > 0 {
                        let chunk_size = remaining.min(1024);
                        let mut silent_frame = self.generate_silent_frame(chunk_size);

                        let pts = (self.total_samples_processed as f64 / self.info.rate() as f64
                            * AV_TIME_BASE_Q.den as f64) as i64;
                        silent_frame.set_pts(Some(pts));

                        output_frames.push(silent_frame);
                        self.total_samples_processed += chunk_size as u64;
                        self.last_output_pts = pts;
                        remaining -= chunk_size;
                    }
                }
            }

            // Process the actual frame
            let pts = (self.total_samples_processed as f64 / self.info.rate() as f64
                * AV_TIME_BASE_Q.den as f64) as i64;
            frame.set_pts(Some(pts));

            self.last_output_pts = pts;
            self.total_samples_processed += frame_samples;
            self.last_processed_timestamp = Some(timestamp);
            self.timeline_position = frame_time
                + Duration::from_secs_f64(frame_samples as f64 / self.info.rate() as f64);

            output_frames.push(frame);
        }

        // If buffer is empty but we've processed frames before, generate silence to maintain continuity
        if output_frames.is_empty() && self.last_processed_timestamp.is_some() {
            // Calculate how much silence we need based on the time gap
            let last_time = self.timeline_position;
            if target_time > last_time {
                let gap = target_time - last_time;
                let silent_samples = ((gap.as_secs_f64()) * self.info.rate() as f64) as usize;

                if silent_samples > 0 {
                    let mut remaining = silent_samples;
                    while remaining > 0 {
                        let chunk_size = remaining.min(1024);
                        let mut silent_frame = self.generate_silent_frame(chunk_size);

                        let pts = (self.total_samples_processed as f64 / self.info.rate() as f64
                            * AV_TIME_BASE_Q.den as f64) as i64;
                        silent_frame.set_pts(Some(pts));

                        output_frames.push(silent_frame);
                        self.total_samples_processed += chunk_size as u64;
                        self.last_output_pts = pts;
                        self.timeline_position +=
                            Duration::from_secs_f64(chunk_size as f64 / self.info.rate() as f64);
                        remaining -= chunk_size;
                    }
                }
            }
        }

        output_frames
    }
}

pub struct AudioMixer {
    sources: Vec<BufferedAudioSource>,
    output: Sender<(ffmpeg::frame::Audio, Duration, SourceTimestamps)>,
    start_timestamps: SourceTimestamps,
    output_sample_count: u64,
    output_sample_rate: u32,
}

impl AudioMixer {
    pub fn new(output: Sender<(ffmpeg::frame::Audio, Duration, SourceTimestamps)>) -> Self {
        Self {
            sources: Vec::new(),
            output,
            start_timestamps: SourceTimestamps::now(),
            output_sample_count: 0,
            output_sample_rate: 48000,
        }
    }

    pub fn sink(&mut self, info: AudioInfo) -> AudioMixerSink {
        let (tx, rx) = flume::bounded(32);

        self.sources.push(BufferedAudioSource::new(rx, info));

        AudioMixerSink { tx }
    }

    pub fn add_source(
        &mut self,
        info: AudioInfo,
        rx: Receiver<(ffmpeg::frame::Audio, SourceTimestamp)>,
    ) {
        self.sources.push(BufferedAudioSource::new(rx, info));
    }

    pub fn has_sources(&self) -> bool {
        !self.sources.is_empty()
    }

    pub fn info() -> AudioInfo {
        AudioInfo::new(
            ffmpeg::format::Sample::F32(ffmpeg::format::sample::Type::Packed),
            48000,
            2,
        )
        .unwrap()
    }

    pub fn run(&mut self, mut get_is_stopped: impl FnMut() -> bool, on_ready: impl FnOnce()) {
        let mut filter_graph = ffmpeg::filter::Graph::new();

        let mut abuffers = self
            .sources
            .iter()
            .enumerate()
            .map(|(i, source)| {
                let info = &source.info;
                let args = format!(
                    "time_base={}:sample_rate={}:sample_fmt={}:channel_layout=0x{:x}",
                    info.time_base,
                    info.rate(),
                    info.sample_format.name(),
                    info.channel_layout().bits()
                );

                debug!("audio mixer input {i}: {args}");

                filter_graph
                    .add(
                        &ffmpeg::filter::find("abuffer").expect("Failed to find abuffer filter"),
                        &format!("src{i}"),
                        &args,
                    )
                    .unwrap()
            })
            .collect::<Vec<_>>();

        let mut amix = filter_graph
            .add(
                &ffmpeg::filter::find("amix").expect("Failed to find amix filter"),
                "amix",
                &format!(
                    "inputs={}:duration=first:dropout_transition=0",
                    abuffers.len()
                ),
            )
            .unwrap();

        let aformat_args = "sample_fmts=flt:sample_rates=48000:channel_layouts=stereo";
        debug!("aformat args: {aformat_args}");

        let mut aformat = filter_graph
            .add(
                &ffmpeg::filter::find("aformat").expect("Failed to find aformat filter"),
                "aformat",
                aformat_args,
            )
            .expect("Failed to add aformat filter");

        let mut abuffersink = filter_graph
            .add(
                &ffmpeg::filter::find("abuffersink").expect("Failed to find abuffersink filter"),
                "sink",
                "",
            )
            .expect("Failed to add abuffersink filter");

        for (i, abuffer) in abuffers.iter_mut().enumerate() {
            abuffer.link(0, &mut amix, i as u32);
        }

        amix.link(0, &mut aformat, 0);
        aformat.link(0, &mut abuffersink, 0);

        filter_graph
            .validate()
            .expect("Failed to validate filter graph");

        on_ready();

        let frame_size = 1024usize;
        let frame_duration =
            Duration::from_secs_f64(frame_size as f64 / self.output_sample_rate as f64);
        let mut next_output_time = std::time::Instant::now() + Duration::from_millis(50);
        let mut filtered = ffmpeg::frame::Audio::empty();
        let mut startup_phase = true;
        let mut processing_time = Duration::ZERO;
        let mut first_frame_time: Option<Duration> = None;

        loop {
            if get_is_stopped() {
                return;
            }

            // Fill all source buffers
            for (i, source) in self.sources.iter_mut().enumerate() {
                let buffer_size_before = source.buffer.len();
                source.fill_buffer();
                let buffer_size_after = source.buffer.len();

                if buffer_size_after > buffer_size_before {
                    trace!(
                        "Source {}: buffer grew from {} to {} frames",
                        i, buffer_size_before, buffer_size_after
                    );
                    // Log timing of first frame in buffer
                    if let Some((_, timestamp)) = source.buffer.front() {
                        let frame_time = timestamp.duration_since(self.start_timestamps);
                        trace!(
                            "Source {}: first buffered frame time: {:.2}ms vs processing_time: {:.2}ms (delta: {:.2}ms)",
                            i,
                            frame_time.as_secs_f64() * 1000.0,
                            processing_time.as_secs_f64() * 1000.0,
                            (frame_time.as_secs_f64() - processing_time.as_secs_f64()) * 1000.0
                        );
                    }
                } else if source.rx.is_disconnected() {
                    trace!("Source {}: receiver disconnected", i);
                }
            }

            // During startup, wait for sufficient initial data
            if startup_phase {
                let sources_with_data =
                    self.sources.iter().filter(|s| !s.buffer.is_empty()).count();
                let sources_with_sufficient_buffer =
                    self.sources.iter().filter(|s| s.buffer.len() >= 2).count();

                // Wait until we have some buffering to avoid underruns
                if sources_with_data == 0 {
                    std::thread::sleep(Duration::from_millis(5));
                    continue;
                } else if sources_with_sufficient_buffer < sources_with_data {
                    // We have some data but not enough buffering yet
                    trace!(
                        "Startup: waiting for buffer (sources with data: {}, with sufficient buffer: {})",
                        sources_with_data, sources_with_sufficient_buffer
                    );
                    std::thread::sleep(Duration::from_millis(5));
                    continue;
                }

                startup_phase = false;
                debug!(
                    "Startup complete: {} sources ready with sufficient buffering",
                    sources_with_data
                );
                // Reset next output time after receiving sufficient data
                next_output_time = std::time::Instant::now() + Duration::from_millis(20);
            }

            let now = std::time::Instant::now();

            // Check if it's time to produce output
            if now >= next_output_time {
                // Feed frames to each source's filter input
                for (i, source) in self.sources.iter_mut().enumerate() {
                    // Process ALL frames from buffer (including silence generation)
                    let frames =
                        source.process_with_gap_filling(processing_time, self.start_timestamps);

                    // Add all frames (real or silence) to the filter
                    for frame in frames {
                        if let Err(e) = abuffers[i].source().add(&frame) {
                            warn!("Source {}: Failed to add frame to filter: {:?}", i, e);
                        }
                    }
                }

                // Update timing for next iteration
                processing_time += frame_duration;
                next_output_time += frame_duration;
            }

            // Try to get output from the filter graph
            let mut frames_output = 0;
            while abuffersink.sink().frame(&mut filtered).is_ok() {
                let output_duration = Duration::from_secs_f64(
                    self.output_sample_count as f64 / self.output_sample_rate as f64,
                );

                let pts = (output_duration.as_secs_f64() * AV_TIME_BASE_Q.den as f64) as i64;
                filtered.set_pts(Some(pts));

                let sample_count = filtered.samples() as u64;

                trace!(
                    "Output frame: {} samples, pts: {}, duration: {:?}",
                    sample_count, pts, output_duration
                );

                if self
                    .output
                    .send((filtered, output_duration, self.start_timestamps))
                    .is_err()
                {
                    warn!("Mixer unable to send output");
                    return;
                }

                self.output_sample_count += sample_count;
                frames_output += 1;
                filtered = ffmpeg::frame::Audio::empty();
            }

            if frames_output > 0 {
                debug!(
                    "Filter graph produced {} output frames, total samples: {}",
                    frames_output, self.output_sample_count
                );
            } else {
                trace!("Filter graph produced no output this cycle");
            }

            // Sleep until next output time, but check frequently for new data
            let time_until_next =
                next_output_time.saturating_duration_since(std::time::Instant::now());
            if time_until_next > Duration::from_millis(2) {
                std::thread::sleep(Duration::from_millis(2));
            }
        }
    }
}

pub struct AudioMixerSink {
    pub tx: flume::Sender<(ffmpeg::frame::Audio, SourceTimestamp)>,
}

pub struct AudioMixerSource {
    rx: flume::Receiver<(ffmpeg::frame::Audio, SourceTimestamp)>,
    info: AudioInfo,
}

impl PipelineSourceTask for AudioMixer {
    fn run(
        &mut self,
        ready_signal: crate::pipeline::task::PipelineReadySignal,
        mut control_signal: crate::pipeline::control::PipelineControlSignal,
    ) -> Result<(), String> {
        self.run(
            || {
                control_signal
                    .last()
                    .map(|v| matches!(v, crate::pipeline::control::Control::Shutdown))
                    .unwrap_or(false)
            },
            || {
                let _ = ready_signal.send(Ok(()));
            },
        );

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant, SystemTime};

    fn create_test_audio_info() -> AudioInfo {
        AudioInfo::new(
            ffmpeg::format::Sample::F32(ffmpeg::format::sample::Type::Packed),
            48000,
            2,
        )
        .unwrap()
    }

    fn create_test_frame(samples: usize, info: &AudioInfo) -> ffmpeg::frame::Audio {
        let mut frame =
            ffmpeg::frame::Audio::new(info.sample_format, samples, info.channel_layout());

        unsafe {
            let data = frame.data_mut(0);
            let bytes_per_sample = info.sample_format.bytes() as usize;
            let channels = info.channel_layout().channels() as usize;
            let total_bytes = samples * channels * bytes_per_sample;

            // Fill with test pattern (non-zero to distinguish from silence)
            for i in 0..total_bytes {
                data.as_mut_ptr().add(i).write((i % 256) as u8);
            }
        }

        frame.set_pts(Some(0));
        frame
    }

    fn is_silent_frame(frame: &ffmpeg::frame::Audio) -> bool {
        unsafe {
            let data = frame.data(0);
            let bytes_per_sample = frame.format().bytes() as usize;
            let channels = frame.channels() as usize;
            let total_bytes = frame.samples() as usize * channels * bytes_per_sample;

            for i in 0..total_bytes {
                if *data.as_ptr().add(i) != 0 {
                    return false;
                }
            }
        }

        true
    }

    #[test]
    fn test_buffered_source_initialization() {
        let info = create_test_audio_info();
        let (_tx, rx) = flume::bounded(32);
        let source = BufferedAudioSource::new(rx, info);

        assert!(source.buffer.is_empty());
        assert!(source.last_processed_timestamp.is_none());
        assert_eq!(source.total_samples_processed, 0);
        assert_eq!(source.last_output_pts, 0);
        assert_eq!(source.timeline_position, Duration::ZERO);

        // Expected frame duration for 1024 samples at 48kHz
        let expected_duration = 1024.0 / 48000.0 * 1000.0;
        assert!((source.expected_frame_duration_ms - expected_duration).abs() < 0.001);
    }

    #[test]
    fn test_fill_buffer() {
        let info = create_test_audio_info();
        let (tx, rx) = flume::bounded(32);
        let mut source = BufferedAudioSource::new(rx, info.clone());

        // Send some frames
        let timestamp1 = SourceTimestamp::Instant(Instant::now());
        let timestamp2 = SourceTimestamp::Instant(Instant::now() + Duration::from_millis(21));
        let timestamp3 = SourceTimestamp::Instant(Instant::now() + Duration::from_millis(42));

        tx.send((create_test_frame(1024, &info), timestamp1))
            .unwrap();
        tx.send((create_test_frame(1024, &info), timestamp2))
            .unwrap();
        tx.send((create_test_frame(1024, &info), timestamp3))
            .unwrap();

        assert_eq!(source.buffer.len(), 0);

        source.fill_buffer();

        assert_eq!(source.buffer.len(), 3);
    }

    #[test]
    fn test_sufficient_buffer_detection() {
        let info = create_test_audio_info();
        let (tx, rx) = flume::bounded(32);
        let mut source = BufferedAudioSource::new(rx, info.clone());

        // Initially insufficient
        assert!(!source.has_sufficient_buffer());

        // Add one frame - still insufficient
        let timestamp = SourceTimestamp::Instant(Instant::now());
        source
            .buffer
            .push_back((create_test_frame(1024, &info), timestamp));
        assert!(!source.has_sufficient_buffer());

        // Add second frame - now sufficient
        let timestamp2 = SourceTimestamp::Instant(Instant::now() + Duration::from_millis(21));
        source
            .buffer
            .push_back((create_test_frame(1024, &info), timestamp2));
        assert!(source.has_sufficient_buffer());

        // Disconnect channel - always sufficient
        drop(tx);
        source.buffer.clear();
        assert!(source.has_sufficient_buffer());
    }

    #[test]
    fn test_silent_frame_generation() {
        let info = create_test_audio_info();
        let (_tx, rx) = flume::bounded::<(ffmpeg::frame::Audio, SourceTimestamp)>(32);
        let source = BufferedAudioSource::new(rx, info.clone());

        // Test various sizes
        for size in [512, 1024, 2048, 4096] {
            let frame = source.generate_silent_frame(size);
            assert_eq!(frame.samples(), size);
            assert!(is_silent_frame(&frame));
        }
    }

    #[test]
    fn test_gap_detection_and_filling() {
        let info = create_test_audio_info();
        let (_tx, rx) = flume::bounded(32);
        let mut source = BufferedAudioSource::new(rx, info.clone());
        let start_timestamps = SourceTimestamps::now();

        // Process first frame
        let timestamp1 = SourceTimestamp::Instant(Instant::now());
        source
            .buffer
            .push_back((create_test_frame(1024, &info), timestamp1));

        let frames = source.process_with_gap_filling(Duration::from_secs(1), start_timestamps);
        assert_eq!(frames.len(), 1);
        assert!(!is_silent_frame(&frames[0]));
        assert!(source.last_processed_timestamp.is_some());

        // Create a gap - add frame 100ms later than expected
        let timestamp2 = SourceTimestamp::Instant(Instant::now() + Duration::from_millis(121));
        source
            .buffer
            .push_back((create_test_frame(1024, &info), timestamp2));

        let frames = source.process_with_gap_filling(Duration::from_secs(2), start_timestamps);

        // Should have silent frames followed by the real frame
        assert!(frames.len() > 1);

        // Check that we got silent frames for the gap
        for i in 0..frames.len() - 1 {
            assert!(is_silent_frame(&frames[i]));
        }

        // Last frame should be the real one
        assert!(!is_silent_frame(&frames[frames.len() - 1]));
    }

    #[test]
    fn test_no_gap_when_continuous() {
        let info = create_test_audio_info();
        let (_tx, rx) = flume::bounded(32);
        let mut source = BufferedAudioSource::new(rx, info.clone());
        let start_timestamps = SourceTimestamps::now();

        // Process frames with correct timing (21.33ms apart for 1024 samples at 48kHz)
        let base_time = Instant::now();
        let frame_duration = Duration::from_micros(21333); // 1024/48000 * 1000000

        for i in 0..5 {
            let timestamp = SourceTimestamp::Instant(base_time + frame_duration * i);
            source
                .buffer
                .push_back((create_test_frame(1024, &info), timestamp));

            let frames = source.process_with_gap_filling(Duration::from_secs(10), start_timestamps);

            // Should only get one frame (no gaps)
            assert_eq!(frames.len(), 1);
            assert!(!is_silent_frame(&frames[0]));
        }
    }

    #[test]
    fn test_pts_calculation() {
        let info = create_test_audio_info();
        let (_tx, rx) = flume::bounded(32);
        let mut source = BufferedAudioSource::new(rx, info.clone());
        let start_timestamps = SourceTimestamps::now();

        // Process multiple frames
        for i in 0..3 {
            let timestamp =
                SourceTimestamp::Instant(Instant::now() + Duration::from_millis(i * 21));
            source
                .buffer
                .push_back((create_test_frame(1024, &info), timestamp));

            let frames = source.process_with_gap_filling(Duration::from_secs(10), start_timestamps);

            assert_eq!(frames.len(), 1);

            // Check PTS progression
            let expected_pts = (i as u64 * 1024 * 1_000_000) / 48000; // microseconds
            let actual_pts = frames[0].pts().unwrap() as u64;

            // PTS should progress correctly
            let tolerance = 1000; // 1ms tolerance
            assert!(
                (actual_pts as i64 - expected_pts as i64).abs() < tolerance,
                "PTS mismatch: expected {}, got {}",
                expected_pts,
                actual_pts
            );
        }
    }

    #[test]
    fn test_large_gap_handling() {
        let info = create_test_audio_info();
        let (_tx, rx) = flume::bounded(32);
        let mut source = BufferedAudioSource::new(rx, info.clone());
        let start_timestamps = SourceTimestamps::now();

        // Process first frame
        let timestamp1 = SourceTimestamp::Instant(Instant::now());
        source
            .buffer
            .push_back((create_test_frame(1024, &info), timestamp1));
        source.process_with_gap_filling(Duration::from_secs(1), start_timestamps);

        // Create a 1-second gap
        let timestamp2 = SourceTimestamp::Instant(Instant::now() + Duration::from_secs(1));
        source
            .buffer
            .push_back((create_test_frame(1024, &info), timestamp2));

        let frames = source.process_with_gap_filling(Duration::from_secs(2), start_timestamps);

        // Should have many silent frames (48000 samples for 1 second at 48kHz)
        let total_silent_samples: usize = frames[..frames.len() - 1]
            .iter()
            .map(|f| f.samples() as usize)
            .sum();

        // Should be approximately 48000 samples (1 second)
        assert!(total_silent_samples > 45000 && total_silent_samples < 50000);
    }

    #[test]
    fn test_sample_counting() {
        let info = create_test_audio_info();
        let (_tx, rx) = flume::bounded(32);
        let mut source = BufferedAudioSource::new(rx, info.clone());
        let start_timestamps = SourceTimestamps::now();

        // Process frames with different sizes
        let sizes = vec![512, 1024, 2048, 1024, 512];
        let mut expected_total = 0u64;

        for (i, size) in sizes.iter().enumerate() {
            let timestamp =
                SourceTimestamp::Instant(Instant::now() + Duration::from_millis(i as u64 * 20));
            source
                .buffer
                .push_back((create_test_frame(*size, &info), timestamp));

            source.process_with_gap_filling(Duration::from_secs(10), start_timestamps);

            expected_total += *size as u64;
            assert_eq!(source.total_samples_processed, expected_total);
        }
    }

    #[test]
    fn test_timestamp_types() {
        let info = create_test_audio_info();
        let (_tx, rx) = flume::bounded(32);
        let mut source = BufferedAudioSource::new(rx, info.clone());
        let start_timestamps = SourceTimestamps::now();

        // Test with SystemTime timestamp
        let timestamp1 = SourceTimestamp::SystemTime(SystemTime::now());
        source
            .buffer
            .push_back((create_test_frame(1024, &info), timestamp1));

        let frames = source.process_with_gap_filling(Duration::from_secs(1), start_timestamps);
        assert_eq!(frames.len(), 1);

        // Test with Instant timestamp
        let timestamp2 = SourceTimestamp::Instant(Instant::now());
        source
            .buffer
            .push_back((create_test_frame(1024, &info), timestamp2));

        let frames = source.process_with_gap_filling(Duration::from_secs(2), start_timestamps);
        assert_eq!(frames.len(), 1);
    }

    #[test]
    fn test_mixer_initialization() {
        let (tx, _rx) = flume::bounded(64);
        let mut mixer = AudioMixer::new(tx);

        assert!(!mixer.has_sources());
        assert_eq!(mixer.sources.len(), 0);
        assert_eq!(mixer.output_sample_count, 0);
        assert_eq!(mixer.output_sample_rate, 48000);

        // Add sources
        let info = create_test_audio_info();
        let (_source_tx, source_rx) = flume::bounded(32);
        mixer.add_source(info, source_rx);

        assert!(mixer.has_sources());
        assert_eq!(mixer.sources.len(), 1);
    }

    #[test]
    fn test_mixer_sink_creation() {
        let (tx, _rx) = flume::bounded(64);
        let mut mixer = AudioMixer::new(tx);

        let info = create_test_audio_info();
        let sink = mixer.sink(info);

        assert!(mixer.has_sources());
        assert_eq!(mixer.sources.len(), 1);

        // Test that sink can send data
        let timestamp = SourceTimestamp::Instant(Instant::now());
        let frame = create_test_frame(1024, &info);
        sink.tx.send((frame, timestamp)).unwrap();
    }

    #[test]
    fn test_continuous_output_without_input() {
        let info = create_test_audio_info();
        let (_tx, rx) = flume::bounded(32);
        let mut source = BufferedAudioSource::new(rx, info.clone());
        let start_timestamps = SourceTimestamps::now();

        // Test that we get silence when no input has ever been provided
        let processing_time = Duration::from_millis(100);

        // First call should produce no frames (no data, no last timestamp)
        let frames = source.process_with_gap_filling(processing_time, start_timestamps);
        assert_eq!(frames.len(), 0);

        // After processing once, subsequent calls should maintain timing with silence
        // Process first real frame to establish timing
        let timestamp1 = SourceTimestamp::Instant(Instant::now());
        source
            .buffer
            .push_back((create_test_frame(1024, &info), timestamp1));

        let frames = source.process_with_gap_filling(Duration::from_millis(50), start_timestamps);
        assert_eq!(frames.len(), 1);
        assert!(!is_silent_frame(&frames[0]));

        // Now with no more input, but time advancing, we should get silence
        let frames = source.process_with_gap_filling(Duration::from_millis(200), start_timestamps);

        // Should have generated silent frames to fill the gap
        assert!(frames.len() > 0);
        for frame in &frames {
            assert!(is_silent_frame(frame));
        }
    }

    #[test]
    fn test_source_silence_on_empty_buffer() {
        let info = create_test_audio_info();
        let (_tx, rx) = flume::bounded(32);
        let mut source = BufferedAudioSource::new(rx, info.clone());
        let start_timestamps = SourceTimestamps::now();

        // Establish initial timing with a frame
        let timestamp = SourceTimestamp::Instant(Instant::now());
        source
            .buffer
            .push_back((create_test_frame(1024, &info), timestamp));

        // Process the frame
        let frames = source.process_with_gap_filling(Duration::from_millis(50), start_timestamps);
        assert_eq!(frames.len(), 1);
        assert!(!is_silent_frame(&frames[0]));

        // Now buffer is empty, advance time significantly
        let frames = source.process_with_gap_filling(Duration::from_millis(500), start_timestamps);

        // Should produce silent frames for the time gap
        let total_samples: usize = frames.iter().map(|f| f.samples() as usize).sum();

        // ~450ms of silence at 48kHz should be around 21600 samples
        assert!(total_samples > 20000 && total_samples < 23000);

        // All frames should be silent
        for frame in &frames {
            assert!(is_silent_frame(frame));
        }
    }

    #[test]
    fn test_mixer_output_with_silent_sources() {
        // Test that buffered sources produce continuous output when needed
        let info = create_test_audio_info();
        let (_tx, rx) = flume::bounded(32);
        let mut source = BufferedAudioSource::new(rx, info.clone());
        let start_timestamps = SourceTimestamps::now();

        // First, establish timing with an initial frame
        let timestamp1 = SourceTimestamp::Instant(Instant::now());
        source
            .buffer
            .push_back((create_test_frame(1024, &info), timestamp1));

        // Process the initial frame
        let frames = source.process_with_gap_filling(Duration::from_millis(21), start_timestamps);
        assert_eq!(frames.len(), 1);
        assert!(!is_silent_frame(&frames[0]));

        // Now simulate continuous time progression without new input
        // The source should generate silence to maintain output timing
        let mut total_frames = Vec::new();
        let mut current_time = Duration::from_millis(21);

        for _ in 0..10 {
            current_time += Duration::from_millis(21);
            let frames = source.process_with_gap_filling(current_time, start_timestamps);
            total_frames.extend(frames);
        }

        // We should have received silent frames to maintain continuous output
        assert!(
            !total_frames.is_empty(),
            "Should have generated silence frames"
        );

        // All generated frames should be silent
        for frame in &total_frames {
            assert!(is_silent_frame(frame), "Generated frames should be silent");
        }

        // Total samples should roughly match the time progression
        let total_samples: usize = total_frames.iter().map(|f| f.samples() as usize).sum();
        let expected_samples = (210.0 / 1000.0 * 48000.0) as usize; // 210ms at 48kHz
        assert!(
            total_samples > expected_samples * 9 / 10 && total_samples < expected_samples * 11 / 10,
            "Sample count should match time progression: got {}, expected ~{}",
            total_samples,
            expected_samples
        );
    }

    #[test]
    fn test_initial_silence_generation() {
        // Test that sources only generate silence after they've processed actual data
        let info = create_test_audio_info();
        let (tx, rx) = flume::bounded(32);
        let mut source = BufferedAudioSource::new(rx, info.clone());
        let start_timestamps = SourceTimestamps::now();

        // First, no silence should be generated without any prior data
        let target_time = Duration::from_millis(100);
        let frames = source.process_with_gap_filling(target_time, start_timestamps);
        assert!(
            frames.is_empty(),
            "Should not generate silence without prior data"
        );

        // Send and process one frame to establish timing
        let timestamp = SourceTimestamp::Instant(Instant::now());
        tx.send((create_test_frame(1024, &info), timestamp))
            .unwrap();
        source.fill_buffer();

        let frames = source.process_with_gap_filling(Duration::from_millis(50), start_timestamps);
        assert_eq!(frames.len(), 1, "Should process the buffered frame");
        assert!(
            !is_silent_frame(&frames[0]),
            "First frame should not be silent"
        );

        // Now with no more input but time advancing, we should get silence
        let frames = source.process_with_gap_filling(Duration::from_millis(150), start_timestamps);
        assert!(
            !frames.is_empty(),
            "Should generate silence to fill time gap"
        );

        // All generated frames should be silent
        for frame in &frames {
            assert!(
                is_silent_frame(frame),
                "Gap-filling frames should be silent"
            );
        }

        // After generating initial silence, last_processed_timestamp should be set
        // timeline_position should be updated even without last_processed_timestamp
        assert_eq!(source.timeline_position, target_time);

        // Subsequent calls shouldn't generate more initial silence
        let frames2 = source.generate_initial_silence_if_needed(target_time, start_timestamps);
        assert!(
            frames2.is_empty(),
            "Should not generate initial silence twice"
        );
    }

    #[test]
    fn test_mixer_handles_source_disconnection() {
        // Test that buffered source handles disconnection gracefully
        let info = create_test_audio_info();
        let (source_tx, source_rx) = flume::bounded(32);
        let mut source = BufferedAudioSource::new(source_rx, info.clone());

        // Send one frame
        let timestamp = SourceTimestamp::Instant(Instant::now());
        source_tx
            .send((create_test_frame(1024, &info), timestamp))
            .unwrap();

        // Fill buffer to get the frame
        source.fill_buffer();
        assert_eq!(source.buffer.len(), 1);

        // Disconnect the source
        drop(source_tx);

        // Verify disconnection is detected
        assert!(source.has_sufficient_buffer());

        // Should still be able to process the buffered frame
        let start_timestamps = SourceTimestamps::now();
        let frames = source.process_with_gap_filling(Duration::from_millis(50), start_timestamps);
        assert_eq!(frames.len(), 1);
        assert!(!is_silent_frame(&frames[0]));

        // After processing the buffered frame, should generate silence for continuity
        let frames = source.process_with_gap_filling(Duration::from_millis(100), start_timestamps);
        assert!(!frames.is_empty());
        for frame in &frames {
            assert!(is_silent_frame(frame));
        }
    }

    #[test]
    fn test_continuous_timing_maintenance() {
        // Test that sources maintain consistent timing across gaps and silence
        let info = create_test_audio_info();
        let (_tx, rx) = flume::bounded(32);
        let mut source = BufferedAudioSource::new(rx, info.clone());
        let start_timestamps = SourceTimestamps::now();

        // Process frames with intermittent data
        let base_time = Instant::now();

        // Frame at t=0
        source.buffer.push_back((
            create_test_frame(1024, &info),
            SourceTimestamp::Instant(base_time),
        ));
        let _frames = source.process_with_gap_filling(Duration::from_millis(21), start_timestamps);
        assert_eq!(source.total_samples_processed, 1024);

        // No frame at t=21ms (should generate silence)
        let _frames = source.process_with_gap_filling(Duration::from_millis(42), start_timestamps);
        // Frames may or may not be generated depending on timing thresholds

        // Frame at t=63ms (after gap)
        source.buffer.push_back((
            create_test_frame(1024, &info),
            SourceTimestamp::Instant(base_time + Duration::from_millis(63)),
        ));
        let frames = source.process_with_gap_filling(Duration::from_millis(84), start_timestamps);

        // Should have at least one frame (the real frame, and possibly silence)
        assert!(!frames.is_empty());

        // Verify total samples processed is reasonable
        // We processed at least 2 frames (2048 samples minimum)
        assert!(
            source.total_samples_processed >= 2048,
            "Should have processed at least 2 frames worth of samples: got {}",
            source.total_samples_processed
        );
    }
}
