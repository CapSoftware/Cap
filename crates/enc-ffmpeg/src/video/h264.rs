use std::time::Duration;

use cap_media_info::{Pixel, VideoInfo};
use ffmpeg::{
    Dictionary,
    codec::{codec::Codec, context, encoder},
    format::{self},
    frame,
    threading::Config,
};
use tracing::{debug, error};

use crate::base::EncoderBase;

pub struct H264EncoderBuilder {
    bpp: f32,
    input_config: VideoInfo,
    preset: H264Preset,
}

#[derive(Clone, Copy)]
pub enum H264Preset {
    Slow,
    Medium,
    Ultrafast,
}

#[derive(thiserror::Error, Debug)]
pub enum H264EncoderError {
    #[error("{0:?}")]
    FFmpeg(#[from] ffmpeg::Error),
    #[error("Codec not found")]
    CodecNotFound,
    #[error("Pixel format {0:?} not supported")]
    PixFmtNotSupported(Pixel),
}

impl H264EncoderBuilder {
    pub const QUALITY_BPP: f32 = 0.3;

    pub fn new(input_config: VideoInfo) -> Self {
        Self {
            input_config,
            bpp: Self::QUALITY_BPP,
            preset: H264Preset::Ultrafast,
        }
    }

    pub fn with_preset(mut self, preset: H264Preset) -> Self {
        self.preset = preset;
        self
    }

    pub fn with_bpp(mut self, bpp: f32) -> Self {
        self.bpp = bpp;
        self
    }

    pub fn build(
        self,
        output: &mut format::context::Output,
    ) -> Result<H264Encoder, H264EncoderError> {
        let input_config = &self.input_config;
        let (codec, encoder_options) = get_codec_and_options(input_config, self.preset)
            .ok_or(H264EncoderError::CodecNotFound)?;

        let (format, converter) = if !codec
            .video()
            .unwrap()
            .formats()
            .unwrap()
            .any(|f| f == input_config.pixel_format)
        {
            let format = ffmpeg::format::Pixel::NV12;
            debug!(
                "Converting from {:?} to {:?} for H264 encoding",
                input_config.pixel_format, format
            );
            (
                format,
                Some(
                    ffmpeg::software::converter(
                        (input_config.width, input_config.height),
                        input_config.pixel_format,
                        format,
                    )
                    .map_err(|e| {
                        error!(
                            "Failed to create converter from {:?} to NV12: {:?}",
                            input_config.pixel_format, e
                        );
                        H264EncoderError::PixFmtNotSupported(input_config.pixel_format)
                    })?,
                ),
            )
        } else {
            (input_config.pixel_format, None)
        };

        let mut encoder_ctx = context::Context::new_with_codec(codec);

        encoder_ctx.set_threading(Config::count(4));
        let mut encoder = encoder_ctx.encoder().video()?;

        encoder.set_width(input_config.width);
        encoder.set_height(input_config.height);
        encoder.set_format(format);
        encoder.set_time_base(input_config.time_base);
        encoder.set_frame_rate(Some(input_config.frame_rate));

        // let target_bitrate = compression.bitrate();
        let bitrate = get_bitrate(
            input_config.width,
            input_config.height,
            input_config.frame_rate.0 as f32 / input_config.frame_rate.1 as f32,
            self.bpp,
        );

        encoder.set_bit_rate(bitrate);
        encoder.set_max_bit_rate(bitrate);

        let encoder = encoder.open_with(encoder_options)?;

        let mut output_stream = output.add_stream(codec)?;
        let stream_index = output_stream.index();
        output_stream.set_time_base((1, H264Encoder::TIME_BASE));
        output_stream.set_rate(input_config.frame_rate);
        output_stream.set_parameters(&encoder);

        Ok(H264Encoder {
            base: EncoderBase::new(stream_index),
            encoder,
            config: self.input_config,
            converter,
        })
    }
}

pub struct H264Encoder {
    base: EncoderBase,
    encoder: encoder::Video,
    config: VideoInfo,
    converter: Option<ffmpeg::software::scaling::Context>,
}

impl H264Encoder {
    const TIME_BASE: i32 = 90000;

    pub fn builder(input_config: VideoInfo) -> H264EncoderBuilder {
        H264EncoderBuilder::new(input_config)
    }

    pub fn queue_frame(
        &mut self,
        mut frame: frame::Video,
        timestamp: Duration,
        output: &mut format::context::Output,
    ) {
        self.base
            .update_pts(&mut frame, timestamp, &mut self.encoder);

        let frame = if let Some(converter) = &mut self.converter {
            let mut new_frame = frame::Video::empty();
            match converter.run(&frame, &mut new_frame) {
                Ok(_) => {
                    new_frame.set_pts(frame.pts());
                    new_frame
                }
                Err(e) => {
                    tracing::error!(
                        "Failed to convert frame: {} from format {:?} to {:?}",
                        e,
                        frame.format(),
                        converter.output().format
                    );
                    // Return early as we can't process this frame
                    return;
                }
            }
        } else {
            frame
        };

        if let Err(e) = self.base.send_frame(&frame, output, &mut self.encoder) {
            tracing::error!("Failed to send frame to encoder: {:?}", e);
            return;
        }
    }

    pub fn finish(&mut self, output: &mut format::context::Output) {
        if let Err(e) = self.base.process_eof(output, &mut self.encoder) {
            tracing::error!("Failed to send EOF to encoder: {:?}", e);
            return;
        }
    }
}

fn get_codec_and_options(
    config: &VideoInfo,
    preset: H264Preset,
) -> Option<(Codec, Dictionary<'_>)> {
    let encoder_name = {
        // if cfg!(target_os = "macos") {
        //     "libx264"
        //     // looks terrible rn :(
        //     // "h264_videotoolbox"
        // } else {
        //     "libx264"
        // }

        "libx264"
    };

    if let Some(codec) = encoder::find_by_name(encoder_name) {
        let mut options = Dictionary::new();

        if encoder_name == "h264_videotoolbox" {
            options.set("realtime", "true");
        } else if encoder_name == "libx264" {
            let keyframe_interval_secs = 2;
            let keyframe_interval = keyframe_interval_secs * config.frame_rate.numerator();
            let keyframe_interval_str = keyframe_interval.to_string();

            options.set(
                "preset",
                match preset {
                    H264Preset::Slow => "slow",
                    H264Preset::Medium => "medium",
                    H264Preset::Ultrafast => "ultrafast",
                },
            );
            if let H264Preset::Ultrafast = preset {
                options.set("tune", "zerolatency");
            }
            options.set("vsync", "1");
            options.set("g", &keyframe_interval_str);
            options.set("keyint_min", &keyframe_interval_str);
        } else if encoder_name == "h264_mf" {
            options.set("hw_encoding", "true");
            options.set("scenario", "4");
            options.set("quality", "1");
        }

        return Some((codec, options));
    }

    None
}

fn get_bitrate(width: u32, height: u32, frame_rate: f32, bpp: f32) -> usize {
    // higher frame rates don't really need double the bitrate lets be real
    let frame_rate_multiplier = (frame_rate - 30.0).max(0.0) * 0.6 + 30.0;
    let pixels_per_second = (width * height) as f32 * frame_rate_multiplier;

    (pixels_per_second * bpp) as usize
}
