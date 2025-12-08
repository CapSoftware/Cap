use std::{thread, time::Duration};

use cap_media_info::{Pixel, VideoInfo};
use ffmpeg::{
    Dictionary,
    codec::{codec::Codec, context, encoder},
    format::{self},
    frame,
    threading::Config,
};
use tracing::{debug, error, trace};

use crate::base::EncoderBase;

fn is_420(format: ffmpeg::format::Pixel) -> bool {
    format
        .descriptor()
        .map(|desc| desc.log2_chroma_w() == 1 && desc.log2_chroma_h() == 1)
        .unwrap_or(false)
}

pub struct H264EncoderBuilder {
    bpp: f32,
    input_config: VideoInfo,
    preset: H264Preset,
    output_size: Option<(u32, u32)>,
    external_conversion: bool,
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
    #[error("Invalid output dimensions {width}x{height}; expected non-zero even width and height")]
    InvalidOutputDimensions { width: u32, height: u32 },
}

impl H264EncoderBuilder {
    pub const QUALITY_BPP: f32 = 0.3;

    pub fn new(input_config: VideoInfo) -> Self {
        Self {
            input_config,
            bpp: Self::QUALITY_BPP,
            preset: H264Preset::Ultrafast,
            output_size: None,
            external_conversion: false,
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

    pub fn with_output_size(mut self, width: u32, height: u32) -> Result<Self, H264EncoderError> {
        if width == 0 || height == 0 {
            return Err(H264EncoderError::InvalidOutputDimensions { width, height });
        }

        self.output_size = Some((width, height));
        Ok(self)
    }

    pub fn with_external_conversion(mut self) -> Self {
        self.external_conversion = true;
        self
    }

    pub fn build(
        self,
        output: &mut format::context::Output,
    ) -> Result<H264Encoder, H264EncoderError> {
        let input_config = self.input_config;
        let (output_width, output_height) = self
            .output_size
            .unwrap_or((input_config.width, input_config.height));

        if output_width == 0 || output_height == 0 {
            return Err(H264EncoderError::InvalidOutputDimensions {
                width: output_width,
                height: output_height,
            });
        }

        let candidates = get_codec_and_options(&input_config, self.preset);
        if candidates.is_empty() {
            return Err(H264EncoderError::CodecNotFound);
        }

        let mut last_error = None;

        for (codec, encoder_options) in candidates {
            let codec_name = codec.name().to_string();

            match Self::build_with_codec(
                codec,
                encoder_options,
                &input_config,
                output,
                output_width,
                output_height,
                self.bpp,
                self.external_conversion,
            ) {
                Ok(encoder) => {
                    debug!("Using encoder {}", codec_name);
                    return Ok(encoder);
                }
                Err(err) => {
                    debug!("Encoder {} init failed: {:?}", codec_name, err);
                    last_error = Some(err);
                }
            }
        }

        Err(last_error.unwrap_or(H264EncoderError::CodecNotFound))
    }

    #[allow(clippy::too_many_arguments)]
    fn build_with_codec(
        codec: Codec,
        encoder_options: Dictionary<'static>,
        input_config: &VideoInfo,
        output: &mut format::context::Output,
        output_width: u32,
        output_height: u32,
        bpp: f32,
        external_conversion: bool,
    ) -> Result<H264Encoder, H264EncoderError> {
        let encoder_supports_input_format = codec
            .video()
            .ok()
            .and_then(|codec_video| codec_video.formats())
            .is_some_and(|mut formats| formats.any(|f| f == input_config.pixel_format));

        let mut needs_pixel_conversion = false;

        let output_format = if encoder_supports_input_format {
            input_config.pixel_format
        } else {
            needs_pixel_conversion = true;
            let format = ffmpeg::format::Pixel::NV12;
            if !external_conversion {
                debug!(
                    "Converting from {:?} to {:?} for H264 encoding",
                    input_config.pixel_format, format
                );
            }
            format
        };

        if is_420(output_format)
            && (!output_width.is_multiple_of(2) || !output_height.is_multiple_of(2))
        {
            return Err(H264EncoderError::InvalidOutputDimensions {
                width: output_width,
                height: output_height,
            });
        }

        let needs_scaling =
            output_width != input_config.width || output_height != input_config.height;

        if needs_scaling && !external_conversion {
            debug!(
                "Scaling video frames for H264 encoding from {}x{} to {}x{}",
                input_config.width, input_config.height, output_width, output_height
            );
        }

        let converter = if external_conversion {
            debug!(
                "External conversion enabled, skipping internal converter. Expected input: {:?} {}x{}",
                output_format, output_width, output_height
            );
            None
        } else if needs_pixel_conversion || needs_scaling {
            let flags = if needs_scaling {
                ffmpeg::software::scaling::flag::Flags::BICUBIC
            } else {
                ffmpeg::software::scaling::flag::Flags::FAST_BILINEAR
            };

            match ffmpeg::software::scaling::Context::get(
                input_config.pixel_format,
                input_config.width,
                input_config.height,
                output_format,
                output_width,
                output_height,
                flags,
            ) {
                Ok(context) => Some(context),
                Err(e) => {
                    if needs_pixel_conversion {
                        error!(
                            "Failed to create converter from {:?} to {:?}: {:?}",
                            input_config.pixel_format, output_format, e
                        );
                        return Err(H264EncoderError::PixFmtNotSupported(
                            input_config.pixel_format,
                        ));
                    }

                    return Err(H264EncoderError::FFmpeg(e));
                }
            }
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

        let bitrate = get_bitrate(
            output_width,
            output_height,
            input_config.frame_rate.0 as f32 / input_config.frame_rate.1 as f32,
            bpp,
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
            converter,
            output_format,
            output_width,
            output_height,
            input_format: input_config.pixel_format,
            input_width: input_config.width,
            input_height: input_config.height,
        })
    }
}

pub struct H264Encoder {
    base: EncoderBase,
    encoder: encoder::Video,
    converter: Option<ffmpeg::software::scaling::Context>,
    output_format: format::Pixel,
    output_width: u32,
    output_height: u32,
    input_format: format::Pixel,
    input_width: u32,
    input_height: u32,
}

pub struct ConversionRequirements {
    pub input_format: format::Pixel,
    pub input_width: u32,
    pub input_height: u32,
    pub output_format: format::Pixel,
    pub output_width: u32,
    pub output_height: u32,
    pub needs_conversion: bool,
}

#[derive(thiserror::Error, Debug)]
pub enum QueueFrameError {
    #[error("Converter: {0}")]
    Converter(ffmpeg::Error),
    #[error("Encode: {0}")]
    Encode(ffmpeg::Error),
}

impl H264Encoder {
    const TIME_BASE: i32 = 90000;

    pub fn builder(input_config: VideoInfo) -> H264EncoderBuilder {
        H264EncoderBuilder::new(input_config)
    }

    pub fn conversion_requirements(&self) -> ConversionRequirements {
        let needs_conversion = self.input_format != self.output_format
            || self.input_width != self.output_width
            || self.input_height != self.output_height;
        ConversionRequirements {
            input_format: self.input_format,
            input_width: self.input_width,
            input_height: self.input_height,
            output_format: self.output_format,
            output_width: self.output_width,
            output_height: self.output_height,
            needs_conversion,
        }
    }

    pub fn queue_frame(
        &mut self,
        mut frame: frame::Video,
        timestamp: Duration,
        output: &mut format::context::Output,
    ) -> Result<(), QueueFrameError> {
        self.base
            .update_pts(&mut frame, timestamp, &mut self.encoder);

        if let Some(converter) = &mut self.converter {
            let pts = frame.pts();
            let mut converted =
                frame::Video::new(self.output_format, self.output_width, self.output_height);
            converter
                .run(&frame, &mut converted)
                .map_err(QueueFrameError::Converter)?;
            converted.set_pts(pts);
            frame = converted;
        }

        self.base
            .send_frame(&frame, output, &mut self.encoder)
            .map_err(QueueFrameError::Encode)?;

        Ok(())
    }

    pub fn queue_preconverted_frame(
        &mut self,
        mut frame: frame::Video,
        timestamp: Duration,
        output: &mut format::context::Output,
    ) -> Result<(), QueueFrameError> {
        trace!(
            "Encoding pre-converted frame: format={:?}, size={}x{}, expected={:?} {}x{}",
            frame.format(),
            frame.width(),
            frame.height(),
            self.output_format,
            self.output_width,
            self.output_height
        );

        self.base
            .update_pts(&mut frame, timestamp, &mut self.encoder);

        self.base
            .send_frame(&frame, output, &mut self.encoder)
            .map_err(QueueFrameError::Encode)?;

        Ok(())
    }

    pub fn flush(&mut self, output: &mut format::context::Output) -> Result<(), ffmpeg::Error> {
        self.base.process_eof(output, &mut self.encoder)
    }
}

fn get_codec_and_options(
    config: &VideoInfo,
    preset: H264Preset,
) -> Vec<(Codec, Dictionary<'static>)> {
    let keyframe_interval_secs = 2;
    let denominator = config.frame_rate.denominator();
    let frames_per_sec = config.frame_rate.numerator() as f64
        / if denominator == 0 { 1 } else { denominator } as f64;
    let keyframe_interval = (keyframe_interval_secs as f64 * frames_per_sec)
        .round()
        .max(1.0) as i32;
    let keyframe_interval_str = keyframe_interval.to_string();

    let encoder_priority: &[&str] = if cfg!(target_os = "macos") {
        &[
            "h264_videotoolbox",
            "h264_qsv",
            "h264_nvenc",
            "h264_amf",
            "h264_mf",
            "libx264",
        ]
    } else {
        &["h264_nvenc", "h264_qsv", "h264_amf", "h264_mf", "libx264"]
    };

    let mut encoders = Vec::new();

    for encoder_name in encoder_priority {
        let Some(codec) = encoder::find_by_name(encoder_name) else {
            continue;
        };

        let mut options = Dictionary::new();

        match *encoder_name {
            "h264_videotoolbox" => {
                options.set("realtime", "true");
            }
            "h264_nvenc" => {
                options.set("preset", "fast");
                options.set("g", &keyframe_interval_str);
            }
            "h264_qsv" => {
                options.set("preset", "fast");
                options.set("g", &keyframe_interval_str);
            }
            "h264_amf" => {
                options.set("quality", "speed");
                options.set("g", &keyframe_interval_str);
            }
            "h264_mf" => {
                options.set("hw_encoding", "true");
                options.set("scenario", "4");
                options.set("quality", "1");
                options.set("g", &keyframe_interval_str);
            }
            "libx264" => {
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
            }
            _ => {}
        }

        encoders.push((codec, options));
    }

    encoders
}

fn get_bitrate(width: u32, height: u32, frame_rate: f32, bpp: f32) -> usize {
    // higher frame rates don't really need double the bitrate lets be real
    let frame_rate_multiplier = ((frame_rate as f64 - 30.0).max(0.0) * 0.6) + 30.0;
    let area = (width as f64) * (height as f64);
    let pixels_per_second = area * frame_rate_multiplier;

    (pixels_per_second * bpp as f64) as usize
}
