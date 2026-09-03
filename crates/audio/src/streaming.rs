use ffmpeg::{ChannelLayout, Error, codec, format, frame::Audio, software::resampling};
use std::{
    ffi::{CString, c_int, c_void},
    fmt,
    path::Path,
    ptr,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

const MAX_CHUNK_FRAMES: usize = 48_000;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AudioStreamError {
    pub stage: &'static str,
    pub detail: String,
    pub next_sample: u64,
}

impl AudioStreamError {
    pub fn is_cancelled(&self) -> bool {
        self.stage == "cancelled"
    }
}

impl fmt::Display for AudioStreamError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "{} / {} / next={}",
            self.stage, self.detail, self.next_sample
        )
    }
}

impl std::error::Error for AudioStreamError {}

#[derive(Clone, Debug)]
struct Failure {
    stage: &'static str,
    detail: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Phase {
    NeedPacket,
    Receiving,
    Draining,
    Flushing,
    Complete,
}

#[derive(Debug)]
pub struct AudioChunk {
    pub source_start_sample: u64,
    pub channels: u16,
    pub samples: Vec<f32>,
}

#[derive(Debug)]
pub enum ChunkRead {
    Chunk(AudioChunk),
    Eof { next_sample: u64 },
}

pub struct AudioStream {
    input: format::context::Input,
    decoder: codec::decoder::Audio,
    resampler: resampling::Context,
    decoded_frame: Audio,
    stream_index: usize,
    channels: u16,
    phase: Phase,
    failure: Option<Failure>,
    pending: Vec<f32>,
    pending_offset: usize,
    position: u64,
    flush_iterations: usize,
    cancellation: Arc<StreamCancellation>,
}

struct StreamCancellation {
    user: Arc<AtomicBool>,
    abort: Option<Arc<AtomicBool>>,
}

impl StreamCancellation {
    fn is_cancelled(&self) -> bool {
        self.user.load(Ordering::Relaxed)
            || self
                .abort
                .as_ref()
                .is_some_and(|abort| abort.load(Ordering::Relaxed))
    }
}

impl AudioStream {
    pub fn open(path: &Path, cancellation: Arc<AtomicBool>) -> Result<Self, AudioStreamError> {
        Self::open_controlled(
            path,
            StreamCancellation {
                user: cancellation,
                abort: None,
            },
        )
    }

    pub fn open_with_abort(
        path: &Path,
        user: Arc<AtomicBool>,
        abort: Arc<AtomicBool>,
    ) -> Result<Self, AudioStreamError> {
        Self::open_controlled(
            path,
            StreamCancellation {
                user,
                abort: Some(abort),
            },
        )
    }

    fn open_controlled(
        path: &Path,
        cancellation: StreamCancellation,
    ) -> Result<Self, AudioStreamError> {
        let cancellation = Arc::new(cancellation);
        let at_open = |stage, detail: String| {
            if cancellation.is_cancelled() {
                cancelled_error(0)
            } else {
                AudioStreamError {
                    stage,
                    detail,
                    next_sample: 0,
                }
            }
        };
        if cancellation.is_cancelled() {
            return Err(cancelled_error(0));
        }
        let input =
            open_input(path, &cancellation).map_err(|detail| at_open("input-open", detail))?;
        let stream = input
            .streams()
            .best(ffmpeg::media::Type::Audio)
            .ok_or_else(|| at_open("stream", "No Stream".to_string()))?;
        let stream_index = stream.index();
        let mut decoder = codec::Context::from_parameters(stream.parameters())
            .map_err(|e| at_open("decoder-parameters", e.to_string()))?
            .decoder()
            .audio()
            .map_err(|e| at_open("decoder-open", e.to_string()))?;
        let source_channels = decoder.channels().max(1);
        if decoder.channel_layout().is_empty() {
            decoder.set_channel_layout(ChannelLayout::default(source_channels as i32));
        }
        decoder.set_packet_time_base(stream.time_base());
        let channels = if source_channels <= 1 { 1 } else { 2 };
        let mut options = ffmpeg::Dictionary::new();
        options.set("filter_size", "128");
        options.set("cutoff", "0.97");
        let resampler = resampling::Context::get_with(
            decoder.format(),
            decoder.channel_layout(),
            decoder.rate(),
            crate::AudioData::SAMPLE_FORMAT,
            ChannelLayout::default(channels as i32),
            crate::AudioData::SAMPLE_RATE,
            options,
        )
        .map_err(|e| at_open("resampler-open", e.to_string()))?;
        if cancellation.is_cancelled() {
            return Err(cancelled_error(0));
        }
        Ok(Self {
            input,
            decoder,
            resampler,
            decoded_frame: Audio::empty(),
            stream_index,
            channels,
            phase: Phase::NeedPacket,
            failure: None,
            pending: Vec::new(),
            pending_offset: 0,
            position: 0,
            flush_iterations: 0,
            cancellation,
        })
    }

    pub fn channels(&self) -> u16 {
        self.channels
    }
    pub fn position(&self) -> u64 {
        self.position
    }

    pub fn read_chunk(&mut self, max_frames: usize) -> Result<ChunkRead, AudioStreamError> {
        if !(1..=MAX_CHUNK_FRAMES).contains(&max_frames) {
            return Err(AudioStreamError {
                stage: "request",
                detail: "Chunk size must be 1..=48000 frames".to_string(),
                next_sample: self.position,
            });
        }
        let max_samples = max_frames * self.channels as usize;
        let mut output = Vec::with_capacity(max_samples);
        while output.len() < max_samples {
            if self.failure.is_none() && self.cancellation.is_cancelled() {
                self.failure = Some(Failure {
                    stage: "cancelled",
                    detail: "Audio decoding cancelled".to_string(),
                });
            }
            if let Some(error) = self.failure.as_ref().filter(|e| e.stage == "cancelled") {
                return Err(AudioStreamError {
                    stage: error.stage,
                    detail: error.detail.clone(),
                    next_sample: self.position,
                });
            }
            if self.pending_offset < self.pending.len() {
                let count =
                    (max_samples - output.len()).min(self.pending.len() - self.pending_offset);
                output.extend_from_slice(
                    &self.pending[self.pending_offset..self.pending_offset + count],
                );
                self.pending_offset += count;
                continue;
            }
            self.pending.clear();
            self.pending_offset = 0;
            if self.failure.is_some() || self.phase == Phase::Complete {
                break;
            }
            if let Err(error) = self.produce_pcm() {
                self.failure = Some(error);
            }
        }
        if !output.is_empty() {
            let source_start_sample = self.position;
            self.position += (output.len() / self.channels as usize) as u64;
            return Ok(ChunkRead::Chunk(AudioChunk {
                source_start_sample,
                channels: self.channels,
                samples: output,
            }));
        }
        if let Some(error) = &self.failure {
            return Err(AudioStreamError {
                stage: error.stage,
                detail: error.detail.clone(),
                next_sample: self.position,
            });
        }
        Ok(ChunkRead::Eof {
            next_sample: self.position,
        })
    }

    pub fn validate_to_end(&mut self) -> Result<u64, AudioStreamError> {
        loop {
            match self.read_chunk(MAX_CHUNK_FRAMES)? {
                ChunkRead::Chunk(_) => {}
                ChunkRead::Eof { next_sample } => return Ok(next_sample),
            }
        }
    }

    fn produce_pcm(&mut self) -> Result<(), Failure> {
        loop {
            if self.cancellation.is_cancelled() {
                return Err(Failure {
                    stage: "cancelled",
                    detail: "Audio decoding cancelled".to_string(),
                });
            }
            match self.phase {
                Phase::NeedPacket => {
                    let mut packet = ffmpeg::Packet::empty();
                    match packet.read(&mut self.input) {
                        Ok(()) => {
                            if packet.stream() != self.stream_index {
                                continue;
                            }
                            self.decoder.send_packet(&packet).map_err(|e| Failure {
                                stage: "send-packet",
                                detail: e.to_string(),
                            })?;
                            self.phase = Phase::Receiving;
                        }
                        Err(Error::Eof) => {
                            self.decoder.send_eof().map_err(|e| Failure {
                                stage: "send-eof",
                                detail: e.to_string(),
                            })?;
                            self.phase = Phase::Draining;
                        }
                        Err(_) => continue,
                    }
                }
                Phase::Receiving | Phase::Draining => {
                    match self.decoder.receive_frame(&mut self.decoded_frame) {
                        Ok(()) => {
                            run_resampler(
                                &mut self.resampler,
                                &self.decoded_frame,
                                &mut self.pending,
                            )
                            .map_err(|e| Failure {
                                stage: "resample",
                                detail: e,
                            })?;
                            if !self.pending.is_empty() {
                                return Ok(());
                            }
                        }
                        Err(_) => {
                            self.phase = if self.phase == Phase::Draining {
                                Phase::Flushing
                            } else {
                                Phase::NeedPacket
                            };
                        }
                    }
                }
                Phase::Flushing => {
                    if self.flush_iterations == 64 {
                        self.phase = Phase::Complete;
                        return Ok(());
                    }
                    let Some(delay) = self.resampler.delay() else {
                        self.phase = Phase::Complete;
                        return Ok(());
                    };
                    let target = *self.resampler.output();
                    let capacity = delay
                        .output
                        .max(1)
                        .saturating_add(16)
                        .min(i64::from(i32::MAX)) as usize;
                    let mut frame = Audio::new(target.format, capacity, target.channel_layout);
                    let remaining = self.resampler.flush(&mut frame).map_err(|error| Failure {
                        stage: "flush",
                        detail: format!("Flush Resampler / {error}"),
                    })?;
                    let output_samples = frame.samples();
                    if output_samples > 0 {
                        let byte_len = output_samples
                            .saturating_mul(frame.channels() as usize)
                            .saturating_mul(std::mem::size_of::<f32>());
                        let bytes = frame.data(0).get(..byte_len).ok_or_else(|| Failure {
                            stage: "flush",
                            detail: "Resampled frame data shorter than expected".to_string(),
                        })?;
                        self.pending
                            .extend(unsafe { crate::cast_bytes_to_f32_slice(bytes) });
                    }
                    self.flush_iterations += 1;
                    if remaining.is_none() || output_samples == 0 {
                        self.phase = Phase::Complete;
                    }
                    if !self.pending.is_empty() || self.phase == Phase::Complete {
                        return Ok(());
                    }
                }
                Phase::Complete => return Ok(()),
            }
        }
    }
}

fn cancelled_error(next_sample: u64) -> AudioStreamError {
    AudioStreamError {
        stage: "cancelled",
        detail: "Audio decoding cancelled".to_string(),
        next_sample,
    }
}

extern "C" fn interrupt_callback(opaque: *mut c_void) -> c_int {
    let cancellation = unsafe { &*opaque.cast::<StreamCancellation>() };
    c_int::from(cancellation.is_cancelled())
}

fn open_input(
    path: &Path,
    cancellation: &Arc<StreamCancellation>,
) -> Result<format::context::Input, String> {
    let path = path
        .to_str()
        .ok_or_else(|| "Input path is not UTF-8".to_string())?;
    let path = CString::new(path).map_err(|error| error.to_string())?;
    unsafe {
        let mut context = ffmpeg::ffi::avformat_alloc_context();
        if context.is_null() {
            return Err("Failed to allocate input context".to_string());
        }
        // The pinned input_with_interrupt leaks its boxed closure. This callback borrows
        // the stable Arc allocation, retained until after the input context is dropped.
        (*context).interrupt_callback = ffmpeg::ffi::AVIOInterruptCB {
            callback: Some(interrupt_callback),
            opaque: Arc::as_ptr(cancellation).cast_mut().cast(),
        };
        let opened = ffmpeg::ffi::avformat_open_input(
            &mut context,
            path.as_ptr(),
            ptr::null_mut(),
            ptr::null_mut(),
        );
        if opened < 0 {
            if !context.is_null() {
                ffmpeg::ffi::avformat_close_input(&mut context);
            }
            return Err(Error::from(opened).to_string());
        }
        let probed = ffmpeg::ffi::avformat_find_stream_info(context, ptr::null_mut());
        if probed < 0 {
            ffmpeg::ffi::avformat_close_input(&mut context);
            return Err(Error::from(probed).to_string());
        }
        Ok(format::context::Input::wrap(context))
    }
}

fn run_resampler(
    resampler: &mut resampling::Context,
    decoded_frame: &Audio,
    samples: &mut Vec<f32>,
) -> Result<(), String> {
    let target = *resampler.output();
    let capacity = resample_capacity(resampler, decoded_frame.samples());
    let mut frame = Audio::new(target.format, capacity, target.channel_layout);
    resampler
        .run(decoded_frame, &mut frame)
        .map_err(|error| format!("Run Resampler / {error}"))?;
    if frame.samples() == 0 {
        return Ok(());
    }
    let byte_len = frame
        .samples()
        .saturating_mul(frame.channels() as usize)
        .saturating_mul(std::mem::size_of::<f32>());
    let data = frame
        .data(0)
        .get(..byte_len)
        .ok_or_else(|| "Resampled frame data shorter than expected".to_string())?;
    samples.extend(unsafe { crate::cast_bytes_to_f32_slice(data) });
    Ok(())
}

fn resample_capacity(resampler: &resampling::Context, input_samples: usize) -> usize {
    let src_rate = resampler.input().rate.max(1) as u64;
    let dst_rate = resampler.output().rate.max(1) as u64;
    let pending_output_samples = resampler
        .delay()
        .map(|delay| delay.output.max(0) as u64)
        .unwrap_or(0);
    let resampled_from_input = (input_samples as u64)
        .saturating_mul(dst_rate)
        .div_ceil(src_rate);
    pending_output_samples
        .saturating_add(resampled_from_input)
        .saturating_add(16)
        .min(i32::MAX as u64) as usize
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn pcm_wav(rate: u32, channels: u16, frames: usize) -> tempfile::NamedTempFile {
        let data_size = (frames * usize::from(channels) * 2) as u32;
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"RIFF");
        bytes.extend_from_slice(&(36 + data_size).to_le_bytes());
        bytes.extend_from_slice(b"WAVEfmt ");
        bytes.extend_from_slice(&16u32.to_le_bytes());
        bytes.extend_from_slice(&1u16.to_le_bytes());
        bytes.extend_from_slice(&channels.to_le_bytes());
        bytes.extend_from_slice(&rate.to_le_bytes());
        bytes.extend_from_slice(&(rate * u32::from(channels) * 2).to_le_bytes());
        bytes.extend_from_slice(&(channels * 2).to_le_bytes());
        bytes.extend_from_slice(&16u16.to_le_bytes());
        bytes.extend_from_slice(b"data");
        bytes.extend_from_slice(&data_size.to_le_bytes());
        for index in 0..frames * usize::from(channels) {
            bytes.extend_from_slice(&((index % 20_001) as i16 - 10_000).to_le_bytes());
        }
        let mut file = tempfile::NamedTempFile::new().unwrap();
        file.write_all(&bytes).unwrap();
        file
    }

    #[test]
    fn chunks_preserve_full_decode_samples_and_repeated_eof() {
        fn assert_send<T: Send>() {}
        assert_send::<AudioStream>();
        for (rate, channels, frames) in [
            (8_000, 1, 1_201),
            (44_100, 2, 1_201),
            (96_000, 6, 1_201),
            (192_000, 2, 64),
            (48_000, 1, 0),
        ] {
            let file = pcm_wav(rate, channels, frames);
            let reference = crate::AudioData::from_file(file.path()).unwrap();
            for pattern in [
                &[1][..],
                &[7][..],
                &[997][..],
                &[12_000][..],
                &[48_000][..],
                &[1, 509, 12_000, 3, 47, 48_000][..],
            ] {
                let mut stream =
                    AudioStream::open(file.path(), Arc::new(AtomicBool::new(false))).unwrap();
                let mut samples = Vec::new();
                let mut read_index = 0;
                loop {
                    let max_frames = pattern[read_index % pattern.len()];
                    read_index += 1;
                    match stream.read_chunk(max_frames).unwrap() {
                        ChunkRead::Chunk(chunk) => {
                            assert_eq!(chunk.channels, reference.channels());
                            assert_eq!(
                                chunk.source_start_sample,
                                (samples.len() / usize::from(chunk.channels)) as u64
                            );
                            assert!(
                                chunk.samples.len() <= max_frames * usize::from(chunk.channels)
                            );
                            samples.extend(chunk.samples);
                            assert_eq!(
                                stream.position(),
                                (samples.len() / usize::from(chunk.channels)) as u64
                            );
                        }
                        ChunkRead::Eof { next_sample } => {
                            assert_eq!(next_sample, reference.sample_count() as u64);
                            assert_eq!(stream.validate_to_end().unwrap(), next_sample);
                            assert!(
                                matches!(stream.read_chunk(7).unwrap(), ChunkRead::Eof { next_sample: next } if next == next_sample)
                            );
                            break;
                        }
                    }
                }
                assert_eq!(samples.len(), reference.samples().len());
                assert!(
                    samples
                        .iter()
                        .zip(reference.samples())
                        .all(|(a, b)| a.to_bits() == b.to_bits())
                );
            }
        }
    }

    #[test]
    fn validation_drains_unread_tail() {
        let file = pcm_wav(44_100, 2, 10_001);
        let reference = crate::AudioData::from_file(file.path()).unwrap();
        let mut stream = AudioStream::open(file.path(), Arc::new(AtomicBool::new(false))).unwrap();
        assert!(matches!(stream.read_chunk(7).unwrap(), ChunkRead::Chunk(_)));
        assert_eq!(stream.position(), 7);
        assert_eq!(
            stream.validate_to_end().unwrap(),
            reference.sample_count() as u64
        );
        assert_eq!(stream.position(), reference.sample_count() as u64);
    }

    #[test]
    fn cancellation_is_sticky_without_publishing_pending_samples() {
        let file = pcm_wav(48_000, 2, 10_001);
        let cancellation = Arc::new(AtomicBool::new(false));
        let mut stream = AudioStream::open(file.path(), cancellation.clone()).unwrap();
        assert!(matches!(stream.read_chunk(7).unwrap(), ChunkRead::Chunk(_)));
        cancellation.store(true, Ordering::Relaxed);
        let error = stream.read_chunk(48_000).unwrap_err();
        assert!(error.is_cancelled());
        assert_eq!(error.next_sample, 7);
        assert_eq!(stream.position(), 7);
        cancellation.store(false, Ordering::Relaxed);
        assert_eq!(stream.read_chunk(1).unwrap_err(), error);
        assert_eq!(stream.validate_to_end().unwrap_err(), error);
    }

    #[test]
    fn terminal_failure_preserves_preceding_pcm() {
        let file = pcm_wav(48_000, 2, 10_001);
        let mut stream = AudioStream::open(file.path(), Arc::new(AtomicBool::new(false))).unwrap();
        stream.pending = vec![0.25, -0.25, 0.5, -0.5];
        stream.failure = Some(Failure {
            stage: "send-packet",
            detail: "injected failure".to_string(),
        });
        let ChunkRead::Chunk(chunk) = stream.read_chunk(48_000).unwrap() else {
            panic!("preceding PCM was discarded");
        };
        assert_eq!(chunk.source_start_sample, 0);
        assert_eq!(chunk.samples, [0.25, -0.25, 0.5, -0.5]);
        let error = stream.read_chunk(1).unwrap_err();
        assert_eq!(error.next_sample, 2);
        assert_eq!(stream.read_chunk(48_000).unwrap_err(), error);
        assert_eq!(stream.validate_to_end().unwrap_err(), error);
    }

    #[test]
    fn interrupt_ownership_releases_after_success_and_failure() {
        let file = pcm_wav(48_000, 1, 1_201);
        let cancellation = Arc::new(AtomicBool::new(false));
        for _ in 0..32 {
            let mut stream = AudioStream::open(file.path(), cancellation.clone()).unwrap();
            assert_eq!(Arc::strong_count(&cancellation), 2);
            let callback = unsafe { (*stream.input.as_mut_ptr()).interrupt_callback };
            assert_eq!(
                callback.opaque,
                Arc::as_ptr(&stream.cancellation).cast_mut().cast()
            );
            assert_eq!(unsafe { callback.callback.unwrap()(callback.opaque) }, 0);
            cancellation.store(true, Ordering::Relaxed);
            assert_eq!(unsafe { callback.callback.unwrap()(callback.opaque) }, 1);
            drop(stream);
            assert_eq!(Arc::strong_count(&cancellation), 1);
            cancellation.store(false, Ordering::Relaxed);
            let missing = file.path().with_extension("missing");
            assert!(AudioStream::open(&missing, cancellation.clone()).is_err());
            assert_eq!(Arc::strong_count(&cancellation), 1);
        }
        cancellation.store(true, Ordering::Relaxed);
        let error = AudioStream::open(file.path(), cancellation.clone())
            .err()
            .unwrap();
        assert!(error.is_cancelled());
        assert_eq!(Arc::strong_count(&cancellation), 1);
    }

    #[test]
    fn private_abort_needs_no_async_relay_and_preserves_user_flag() {
        let file = pcm_wav(48_000, 2, 10_001);
        let user = Arc::new(AtomicBool::new(false));
        let abort = Arc::new(AtomicBool::new(false));
        let runtime = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        runtime.block_on(async {
            let mut stream =
                AudioStream::open_with_abort(file.path(), user.clone(), abort.clone()).unwrap();
            assert!(matches!(stream.read_chunk(7).unwrap(), ChunkRead::Chunk(_)));
            let callback = unsafe { (*stream.input.as_mut_ptr()).interrupt_callback };
            assert_eq!(unsafe { callback.callback.unwrap()(callback.opaque) }, 0);
            let worker_abort = abort.clone();
            std::thread::spawn(move || worker_abort.store(true, Ordering::Relaxed))
                .join()
                .unwrap();
            assert_eq!(unsafe { callback.callback.unwrap()(callback.opaque) }, 1);
            let error = stream.read_chunk(48_000).unwrap_err();
            assert!(error.is_cancelled());
            assert_eq!(error.next_sample, 7);
            assert!(!user.load(Ordering::Relaxed));
            abort.store(false, Ordering::Relaxed);
            assert_eq!(stream.read_chunk(1).unwrap_err(), error);
            drop(stream);
            assert_eq!(Arc::strong_count(&user), 1);
            assert_eq!(Arc::strong_count(&abort), 1);
        });
        abort.store(true, Ordering::Relaxed);
        let error = AudioStream::open_with_abort(file.path(), user.clone(), abort.clone())
            .err()
            .unwrap();
        assert!(error.is_cancelled());
        assert!(!user.load(Ordering::Relaxed));
        assert_eq!(Arc::strong_count(&user), 1);
        assert_eq!(Arc::strong_count(&abort), 1);
    }

    #[test]
    fn invalid_chunk_size_does_not_consume_audio() {
        let file = pcm_wav(48_000, 1, 1_201);
        let mut stream = AudioStream::open(file.path(), Arc::new(AtomicBool::new(false))).unwrap();
        for size in [0, 48_001, usize::MAX] {
            assert_eq!(stream.read_chunk(size).unwrap_err().stage, "request");
            assert_eq!(stream.position(), 0);
        }
        assert_eq!(stream.validate_to_end().unwrap(), 1_201);
    }
}
