use std::{thread, time::Duration};

use cap_media_info::{RawVideoFormat, VideoInfo};
use ffmpeg::{
    Dictionary,
    codec::{context, encoder},
    color, format, frame,
    threading::Config,
};

use crate::base::EncoderBase;

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
            Some(ffmpeg::software::scaling::Context::get(
                input_config.pixel_format,
                input_config.width,
                input_config.height,
                output_format,
                output_width,
                output_height,
                ffmpeg::software::scaling::flag::Flags::BICUBIC,
            )?)
        } else {
            None
        };

        let mut encoder_ctx = context::Context::new_with_codec(codec);
        let thread_count = thread::available_parallelism()
            .map(|v| v.get())
            .unwrap_or(1);
        encoder_ctx.set_threading(Config::count(thread_count));

        let mut encoder = encoder_ctx.encoder().video()?;
        encoder.set_width(output_width);
        encoder.set_height(output_height);
        encoder.set_format(output_format);
        encoder.set_time_base(input_config.time_base);
        encoder.set_frame_rate(Some(input_config.frame_rate));
        encoder.set_colorspace(color::Space::BT709);
        encoder.set_color_range(color::Range::JPEG);
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

        let converted_frame_pool = converter
            .as_ref()
            .map(|_| frame::Video::new(output_format, output_width, output_height));

        Ok(ProResEncoder {
            base: EncoderBase::new(stream_index),
            encoder,
            converter,
            converted_frame_pool,
        })
    }
}

pub struct ProResEncoder {
    base: EncoderBase,
    encoder: encoder::Video,
    converter: Option<ffmpeg::software::scaling::Context>,
    converted_frame_pool: Option<frame::Video>,
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

        let frame_to_send = if let Some(converter) = &mut self.converter {
            let pts = frame.pts();
            let converted = self.converted_frame_pool.as_mut().unwrap();
            converter
                .run(frame, converted)
                .map_err(QueueFrameError::Converter)?;
            converted.set_pts(pts);
            converted as &frame::Video
        } else {
            frame as &frame::Video
        };

        self.base
            .send_frame(frame_to_send, output, &mut self.encoder)
            .map_err(QueueFrameError::Encode)?;

        Ok(())
    }

    pub fn flush(&mut self, output: &mut format::context::Output) -> Result<(), ffmpeg::Error> {
        self.base.process_eof(output, &mut self.encoder)
    }
}

unsafe impl Send for ProResEncoder {}
