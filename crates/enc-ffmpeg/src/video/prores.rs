use std::{thread, time::Duration};

use cap_media_info::{RawVideoFormat, VideoInfo};
use ffmpeg::{
    Dictionary,
    codec::{context, encoder},
    color, format, frame,
    threading::{Config, Type},
};

use crate::base::EncoderBase;

const MAX_FRAME_THREADS: usize = 8;
// Each frame thread holds a whole frame and its packet: about 16 bytes per
// output pixel at peak, measured on 4K exports (8 threads added 1.2 GB). The
// threads may use at most a sixteenth of RAM, so an 8 GB Mac exporting 4K
// gets 4 threads instead of swapping, and 16 GB or more gets all 8.
const FRAME_THREAD_BYTES_PER_PIXEL: u64 = 16;
const FRAME_THREAD_MEMORY_SHARE: u64 = 16;

fn frame_thread_count(
    cores: usize,
    total_memory: Option<u64>,
    output_width: u32,
    output_height: u32,
) -> usize {
    let thread_bytes = u64::from(output_width)
        .saturating_mul(u64::from(output_height))
        .saturating_mul(FRAME_THREAD_BYTES_PER_PIXEL)
        .max(1);
    let by_memory = total_memory.map_or(1, |memory| {
        usize::try_from(memory / FRAME_THREAD_MEMORY_SHARE / thread_bytes).unwrap_or(usize::MAX)
    });
    cores.min(MAX_FRAME_THREADS).min(by_memory).max(1)
}

fn total_memory_bytes() -> Option<u64> {
    let system = sysinfo::System::new_with_specifics(
        sysinfo::RefreshKind::new().with_memory(sysinfo::MemoryRefreshKind::new().with_ram()),
    );
    Some(system.total_memory()).filter(|memory| *memory > 0)
}

pub struct ProResEncoderBuilder {
    input_config: VideoInfo,
    output_size: Option<(u32, u32)>,
}

#[derive(thiserror::Error, Debug)]
pub enum ProResEncoderError {
    #[error("{0:?}")]
    FFmpeg(#[from] ffmpeg::Error),
    #[error("Codec not found")]
    CodecNotFound,
    #[error("Invalid output dimensions {width}x{height}; expected non-zero width and height")]
    InvalidOutputDimensions { width: u32, height: u32 },
}

impl ProResEncoderBuilder {
    pub fn new(input_config: VideoInfo) -> Self {
        Self {
            input_config,
            output_size: None,
        }
    }

    pub fn with_output_size(mut self, width: u32, height: u32) -> Result<Self, ProResEncoderError> {
        if width == 0 || height == 0 {
            return Err(ProResEncoderError::InvalidOutputDimensions { width, height });
        }

        self.output_size = Some((width, height));
        Ok(self)
    }

    pub fn build(
        self,
        output: &mut format::context::Output,
    ) -> Result<ProResEncoder, ProResEncoderError> {
        let codec = encoder::find_by_name("prores_ks").ok_or(ProResEncoderError::CodecNotFound)?;
        let input_config = self.input_config;
        let (output_width, output_height) = self
            .output_size
            .unwrap_or((input_config.width, input_config.height));
        let output_format = format::Pixel::YUVA444P10LE;

        let converter = if input_config.pixel_format != output_format
            || input_config.width != output_width
            || input_config.height != output_height
        {
            let mut converter = ffmpeg::software::scaling::Context::get(
                input_config.pixel_format,
                input_config.width,
                input_config.height,
                output_format,
                output_width,
                output_height,
                ffmpeg::software::scaling::flag::Flags::BICUBIC,
            )?;
            super::colour::use_bt709_for_rgb_input(
                &mut converter,
                input_config.pixel_format,
                output_format,
            )?;
            Some(converter)
        } else {
            None
        };

        let mut encoder_ctx = context::Context::new_with_codec(codec);
        let thread_count = frame_thread_count(
            thread::available_parallelism().map_or(1, |v| v.get()),
            total_memory_bytes(),
            output_width,
            output_height,
        );
        // `Config::count` leaves `thread_type` at 0, which libavcodec treats as
        // "no threading" for prores_ks. Frame threading keeps a reference to each
        // sent frame until a worker encodes it, so it is only safe when frames
        // come from `converted_frames`, which never rewrites a frame the encoder
        // still holds.
        let mut threading = Config::kind(if converter.is_some() {
            Type::Frame
        } else {
            Type::None
        });
        threading.count = thread_count;
        encoder_ctx.set_threading(threading);

        let mut encoder = encoder_ctx.encoder().video()?;
        encoder.set_width(output_width);
        encoder.set_height(output_height);
        encoder.set_format(output_format);
        encoder.set_time_base(input_config.time_base);
        encoder.set_frame_rate(Some(input_config.frame_rate));
        encoder.set_colorspace(color::Space::BT709);
        // Limited range: what the converter above produces (and the ProRes
        // convention).
        encoder.set_color_range(color::Range::MPEG);
        unsafe {
            (*encoder.as_mut_ptr()).color_primaries =
                ffmpeg::ffi::AVColorPrimaries::AVCOL_PRI_BT709;
            (*encoder.as_mut_ptr()).color_trc =
                ffmpeg::ffi::AVColorTransferCharacteristic::AVCOL_TRC_BT709;
        }

        let mut options = Dictionary::new();
        options.set("profile", "4444");
        options.set("alpha_bits", "16");

        let encoder = encoder.open_with(options)?;

        let mut output_stream = output.add_stream(codec)?;
        let stream_index = output_stream.index();
        output_stream.set_time_base(input_config.time_base);
        output_stream.set_rate(input_config.frame_rate);
        output_stream.set_parameters(&encoder);

        Ok(ProResEncoder {
            base: EncoderBase::new(stream_index),
            encoder,
            converter,
            converted_frames: Vec::new(),
            output_format,
            output_size: (output_width, output_height),
        })
    }
}

pub struct ProResEncoder {
    base: EncoderBase,
    encoder: encoder::Video,
    converter: Option<ffmpeg::software::scaling::Context>,
    converted_frames: Vec<frame::Video>,
    output_format: format::Pixel,
    output_size: (u32, u32),
}

#[derive(thiserror::Error, Debug)]
pub enum QueueFrameError {
    #[error("Converter: {0}")]
    Converter(ffmpeg::Error),
    #[error("Encode: {0}")]
    Encode(ffmpeg::Error),
}

impl ProResEncoder {
    pub fn builder(input_config: VideoInfo) -> ProResEncoderBuilder {
        ProResEncoderBuilder::new(input_config)
    }

    pub fn input_format() -> RawVideoFormat {
        RawVideoFormat::Rgba
    }

    pub fn queue_frame(
        &mut self,
        frame: &mut frame::Video,
        timestamp: Duration,
        output: &mut format::context::Output,
    ) -> Result<(), QueueFrameError> {
        self.base.update_pts(frame, timestamp, &mut self.encoder);

        let Some(converter) = &mut self.converter else {
            return self
                .base
                .send_frame(frame, output, &mut self.encoder)
                .map_err(QueueFrameError::Encode);
        };

        let mut converted = match self.converted_frames.iter_mut().position(
            |pooled| unsafe { ffmpeg::ffi::av_frame_is_writable(pooled.as_mut_ptr()) } != 0,
        ) {
            Some(index) => self.converted_frames.swap_remove(index),
            None => frame::Video::new(self.output_format, self.output_size.0, self.output_size.1),
        };
        converter
            .run(frame, &mut converted)
            .map_err(QueueFrameError::Converter)?;
        converted.set_pts(frame.pts());

        let result = self
            .base
            .send_frame(&converted, output, &mut self.encoder)
            .map_err(QueueFrameError::Encode);
        self.converted_frames.push(converted);
        result
    }

    pub fn flush(&mut self, output: &mut format::context::Output) -> Result<(), ffmpeg::Error> {
        self.base.process_eof(output, &mut self.encoder)
    }
}

unsafe impl Send for ProResEncoder {}

#[cfg(test)]
mod frame_thread_tests {
    use super::frame_thread_count;

    const GB: u64 = 1024 * 1024 * 1024;

    #[test]
    fn small_macs_get_fewer_threads_at_4k() {
        assert_eq!(frame_thread_count(8, Some(8 * GB), 3840, 2160), 4);
        assert_eq!(frame_thread_count(10, Some(16 * GB), 3840, 2160), 8);
        assert_eq!(frame_thread_count(16, Some(128 * GB), 3840, 2160), 8);
    }

    #[test]
    fn smaller_outputs_use_every_allowed_thread() {
        assert_eq!(frame_thread_count(8, Some(8 * GB), 1920, 1080), 8);
        assert_eq!(frame_thread_count(4, Some(8 * GB), 1920, 1080), 4);
    }

    #[test]
    fn degenerate_inputs_still_encode_on_one_thread() {
        assert_eq!(frame_thread_count(16, None, 3840, 2160), 1);
        assert_eq!(frame_thread_count(0, Some(128 * GB), 3840, 2160), 1);
        assert_eq!(frame_thread_count(16, Some(GB), 7680, 4320), 1);
        assert_eq!(frame_thread_count(16, Some(128 * GB), 0, 0), 8);
        assert_eq!(
            frame_thread_count(16, Some(u64::MAX), u32::MAX, u32::MAX),
            1
        );
    }
}
