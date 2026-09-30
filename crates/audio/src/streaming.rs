use crate::audio_data::ResamplerOutput;
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
    input: StreamInput,
    decoder: codec::decoder::Audio,
    resampler: resampling::Context,
    decoded_frame: Audio,
    resampler_output: ResamplerOutput,
    stream_index: usize,
    channels: u16,
    phase: Phase,
    failure: Option<Failure>,
    pending: Vec<f32>,
    pending_offset: usize,
    pending_frame: bool,
    position: u64,
    flush_iterations: usize,
    cancellation: Arc<StreamCancellation>,
}

enum StreamInput {
    File(format::context::Input),
    Relocatable(cap_enc_ffmpeg::SegmentedInput),
}

impl StreamInput {
    fn input(&self) -> &format::context::Input {
        match self {
            Self::File(input) => input,
            Self::Relocatable(input) => input.input(),
        }
    }

    fn read_packet(&mut self, packet: &mut ffmpeg::Packet) -> Result<(), Error> {
        match self {
            Self::File(input) => packet.read(input),
            Self::Relocatable(input) => input.read_packet(packet),
        }
    }

    fn io_error(&self) -> Option<&std::io::Error> {
        match self {
            Self::File(_) => None,
            Self::Relocatable(input) => input.io_error(),
        }
    }
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
        Self::open_from(cancellation, |cancellation| {
            open_input(path, cancellation).map(StreamInput::File)
        })
    }

    pub fn open_relocatable<'a>(
        source: &cap_enc_ffmpeg::RelocatableSource,
        paths: impl IntoIterator<Item = &'a Path>,
        user: Arc<AtomicBool>,
    ) -> Result<Self, AudioStreamError> {
        Self::open_relocatable_controlled(source, paths, StreamCancellation { user, abort: None })
    }

    pub fn open_relocatable_with_abort<'a>(
        source: &cap_enc_ffmpeg::RelocatableSource,
        paths: impl IntoIterator<Item = &'a Path>,
        user: Arc<AtomicBool>,
        abort: Arc<AtomicBool>,
    ) -> Result<Self, AudioStreamError> {
        Self::open_relocatable_controlled(
            source,
            paths,
            StreamCancellation {
                user,
                abort: Some(abort),
            },
        )
    }

    fn open_relocatable_controlled<'a>(
        source: &cap_enc_ffmpeg::RelocatableSource,
        paths: impl IntoIterator<Item = &'a Path>,
        cancellation: StreamCancellation,
    ) -> Result<Self, AudioStreamError> {
        Self::open_from(cancellation, |cancellation| {
            let cancellation = cancellation.clone();
            cap_enc_ffmpeg::SegmentedInput::open_relocatable_interruptible(
                source,
                paths,
                Arc::new(move || cancellation.is_cancelled()),
            )
            .map(StreamInput::Relocatable)
            .map_err(|error| error.to_string())
        })
    }

    fn open_from(
        cancellation: StreamCancellation,
        open: impl FnOnce(&Arc<StreamCancellation>) -> Result<StreamInput, String>,
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
        let input = open(&cancellation).map_err(|detail| at_open("input-open", detail))?;
        let stream = input
            .input()
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
            resampler_output: ResamplerOutput::new(),
            stream_index,
            channels,
            phase: Phase::NeedPacket,
            failure: None,
            pending: Vec::new(),
            pending_offset: 0,
            pending_frame: false,
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

    fn pending_samples(&self) -> Result<&[f32], String> {
        if self.pending_frame {
            self.resampler_output.samples()
        } else {
            Ok(&self.pending)
        }
    }

    pub fn read_chunk(&mut self, max_frames: usize) -> Result<ChunkRead, AudioStreamError> {
        if !(1..=MAX_CHUNK_FRAMES).contains(&max_frames) {
            return Err(AudioStreamError {
                stage: "request",
                detail: "Chunk size must be 1..=48000 frames".to_string(),
                next_sample: self.position,
            });
        }
        let max_samples = max_frames * usize::from(self.channels);
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
            let pending = self.pending_samples().map_err(|detail| AudioStreamError {
                stage: "resample",
                detail,
                next_sample: self.position,
            })?;
            if self.pending_offset < pending.len() {
                let count = (max_samples - output.len()).min(pending.len() - self.pending_offset);
                output
                    .extend_from_slice(&pending[self.pending_offset..self.pending_offset + count]);
                self.pending_offset += count;
                continue;
            }
            self.pending.clear();
            self.pending_offset = 0;
            self.pending_frame = false;
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
                    match self.input.read_packet(&mut packet) {
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
                        Err(_) => {
                            if self.cancellation.is_cancelled() {
                                return Err(Failure {
                                    stage: "cancelled",
                                    detail: "Audio decoding cancelled".into(),
                                });
                            }
                            if let Some(error) = self.input.io_error() {
                                return Err(Failure {
                                    stage: "input-read",
                                    detail: error.to_string(),
                                });
                            }
                            continue;
                        }
                    }
                }
                Phase::Receiving | Phase::Draining => {
                    match self.decoder.receive_frame(&mut self.decoded_frame) {
                        Ok(()) => {
                            self.resampler_output
                                .run(&mut self.resampler, &self.decoded_frame)
                                .map_err(|e| Failure {
                                    stage: "resample",
                                    detail: e,
                                })?;
                            self.resampler_output.samples().map_err(|detail| Failure {
                                stage: "resample",
                                detail,
                            })?;
                            self.pending_frame = true;
                            return Ok(());
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
                    let capacity = delay
                        .output
                        .max(1)
                        .saturating_add(16)
                        .min(i64::from(i32::MAX)) as usize;
                    let frame = self.resampler_output.prepare(&self.resampler, capacity);
                    let remaining = self.resampler.flush(frame).map_err(|error| Failure {
                        stage: "flush",
                        detail: format!("Flush Resampler / {error}"),
                    })?;
                    let output_samples = frame.samples();
                    self.resampler_output.samples().map_err(|detail| Failure {
                        stage: "flush",
                        detail,
                    })?;
                    self.pending_frame = true;
                    self.flush_iterations += 1;
                    if remaining.is_none() || output_samples == 0 {
                        self.phase = Phase::Complete;
                    }
                    if output_samples > 0 || self.phase == Phase::Complete {
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
            let stream = AudioStream::open(file.path(), cancellation.clone()).unwrap();
            assert_eq!(Arc::strong_count(&cancellation), 2);
            let callback = unsafe { (*stream.input.input().as_ptr()).interrupt_callback };
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
            let callback = unsafe { (*stream.input.input().as_ptr()).interrupt_callback };
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

    #[test]
    fn relocatable_audio_preserves_decoder_samples_across_publication_and_rollback() {
        for (rate, channels) in [(44_100, 1), (48_000, 2), (96_000, 6)] {
            let file = pcm_wav(rate, channels, 100_003);
            let reference = crate::AudioData::from_file(file.path()).unwrap();
            let bytes = std::fs::read(file.path()).unwrap();
            let directory = tempfile::tempdir().unwrap();
            let original = directory.path().join("original");
            let retained = directory.path().join("retained");
            std::fs::create_dir(&original).unwrap();
            let paths: Vec<_> = bytes
                .chunks(32_768)
                .enumerate()
                .map(|(index, bytes)| {
                    let path = std::path::PathBuf::from(format!("part-{index:03}.bin"));
                    std::fs::write(original.join(&path), bytes).unwrap();
                    path
                })
                .collect();
            let source = cap_enc_ffmpeg::RelocatableSource::new(original.clone()).unwrap();
            let mut stream = AudioStream::open_relocatable(
                &source,
                paths.iter().map(std::path::PathBuf::as_path),
                Arc::new(AtomicBool::new(false)),
            )
            .unwrap();
            let mut samples = Vec::new();
            let mut chunks = 0;
            loop {
                match stream.read_chunk(997).unwrap() {
                    ChunkRead::Chunk(chunk) => {
                        assert_eq!(chunk.channels, reference.channels());
                        assert_eq!(
                            chunk.source_start_sample as usize,
                            samples.len() / usize::from(reference.channels())
                        );
                        samples.extend(chunk.samples);
                        match chunks {
                            0 => {
                                source.relocate(retained.clone()).unwrap();
                                std::fs::create_dir(&original).unwrap();
                                std::fs::write(original.join(&paths[0]), b"published media")
                                    .unwrap();
                            }
                            1 => {
                                assert!(
                                    source
                                        .relocate(directory.path().join("missing/target"))
                                        .is_err()
                                );
                            }
                            2 => {
                                assert_eq!(
                                    std::fs::read(original.join(&paths[0])).unwrap(),
                                    b"published media"
                                );
                                std::fs::remove_file(original.join(&paths[0])).unwrap();
                                std::fs::remove_dir(&original).unwrap();
                                source.relocate(original.clone()).unwrap();
                            }
                            _ => {}
                        }
                        chunks += 1;
                    }
                    ChunkRead::Eof { next_sample } => {
                        assert_eq!(next_sample as usize, reference.sample_count());
                        break;
                    }
                }
            }
            assert!(chunks > 3);
            assert_eq!(samples.len(), reference.samples().len());
            assert!(
                samples
                    .iter()
                    .zip(reference.samples())
                    .all(|(actual, expected)| actual.to_bits() == expected.to_bits())
            );
            assert_eq!(
                stream.validate_to_end().unwrap() as usize,
                reference.sample_count()
            );
            let retained_bytes: Vec<_> = paths
                .iter()
                .flat_map(|path| std::fs::read(original.join(path)).unwrap())
                .collect();
            assert_eq!(retained_bytes, bytes);
        }
    }

    #[test]
    fn relocatable_audio_cancellation_retains_positions_and_releases_ownership() {
        let file = pcm_wav(48_000, 2, 100_003);
        let directory = tempfile::tempdir().unwrap();
        let original = directory.path().join("original");
        let retained = directory.path().join("retained");
        std::fs::create_dir(&original).unwrap();
        std::fs::copy(file.path(), original.join("audio.wav")).unwrap();
        let source = cap_enc_ffmpeg::RelocatableSource::new(original.clone()).unwrap();
        let user = Arc::new(AtomicBool::new(false));
        let abort = Arc::new(AtomicBool::new(false));
        for use_abort in [false, true] {
            let mut stream = AudioStream::open_relocatable_with_abort(
                &source,
                [Path::new("audio.wav")],
                user.clone(),
                abort.clone(),
            )
            .unwrap();
            assert_eq!(Arc::strong_count(&user), 2);
            assert_eq!(Arc::strong_count(&abort), 2);
            assert!(matches!(stream.read_chunk(7).unwrap(), ChunkRead::Chunk(_)));
            source.relocate(retained.clone()).unwrap();
            let flag = if use_abort { &abort } else { &user };
            flag.store(true, Ordering::Relaxed);
            let callback = unsafe { (*stream.input.input().as_ptr()).interrupt_callback };
            assert_eq!(unsafe { callback.callback.unwrap()(callback.opaque) }, 1);
            let error = stream.read_chunk(48_000).unwrap_err();
            assert!(error.is_cancelled());
            assert_eq!(error.next_sample, 7);
            assert_eq!(stream.position(), 7);
            flag.store(false, Ordering::Relaxed);
            assert_eq!(stream.read_chunk(1).unwrap_err(), error);
            drop(stream);
            assert_eq!(Arc::strong_count(&user), 1);
            assert_eq!(Arc::strong_count(&abort), 1);
            source.relocate(original.clone()).unwrap();
        }
        let missing = AudioStream::open_relocatable_with_abort(
            &source,
            [Path::new("missing.wav")],
            user.clone(),
            abort.clone(),
        );
        assert!(missing.is_err());
        assert_eq!(Arc::strong_count(&user), 1);
        assert_eq!(Arc::strong_count(&abort), 1);
        abort.store(true, Ordering::Relaxed);
        assert!(
            AudioStream::open_relocatable_with_abort(
                &source,
                [Path::new("audio.wav")],
                user.clone(),
                abort.clone(),
            )
            .err()
            .unwrap()
            .is_cancelled()
        );
        assert_eq!(Arc::strong_count(&user), 1);
        assert_eq!(Arc::strong_count(&abort), 1);
    }

    #[test]
    fn missing_relocatable_audio_never_spins_or_becomes_clean_eof() {
        let file = pcm_wav(48_000, 2, 480_003);
        let directory = tempfile::tempdir().unwrap();
        let original = directory.path().join("original");
        let retained = directory.path().join("retained");
        std::fs::create_dir(&original).unwrap();
        std::fs::copy(file.path(), original.join("audio.wav")).unwrap();
        let source = cap_enc_ffmpeg::RelocatableSource::new(original).unwrap();
        let mut stream = AudioStream::open_relocatable(
            &source,
            [Path::new("audio.wav")],
            Arc::new(AtomicBool::new(false)),
        )
        .unwrap();
        assert!(matches!(stream.read_chunk(7).unwrap(), ChunkRead::Chunk(_)));
        source.relocate(retained.clone()).unwrap();
        std::fs::remove_file(retained.join("audio.wav")).unwrap();
        let error = stream.validate_to_end().unwrap_err();
        assert_eq!(error.stage, "input-read");
        assert!(error.next_sample >= 7);
        assert_eq!(stream.validate_to_end().unwrap_err(), error);
        assert_eq!(stream.read_chunk(1).unwrap_err(), error);
    }
}
