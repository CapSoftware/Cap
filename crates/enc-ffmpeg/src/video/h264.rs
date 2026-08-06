use std::{thread, time::Duration};

use cap_media_info::{Pixel, VideoInfo, ensure_even};
use ffmpeg::{
    Dictionary,
    codec::{codec::Codec, context, encoder},
    color,
    format::{self},
    frame,
    threading::Config,
};
use tracing::{debug, error, info, trace, warn};

use crate::base::EncoderBase;
use crate::video::h264_packet::H264PacketEncoder;

fn is_420(format: ffmpeg::format::Pixel) -> bool {
    format
        .descriptor()
        .map(|desc| desc.log2_chroma_w() == 1 && desc.log2_chroma_h() == 1)
        .unwrap_or(false)
}

#[derive(Clone)]
pub struct H264EncoderBuilder {
    bpp: f32,
    input_config: VideoInfo,
    preset: H264Preset,
    output_size: Option<(u32, u32)>,
    external_conversion: bool,
    encoder_priority_override: Option<&'static [&'static str]>,
    is_export: bool,
    crf: Option<u8>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum H264Preset {
    Slow,
    Medium,
    Ultrafast,
    HighThroughput,
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
    #[error("Hardware encoder self-test failed: {0}")]
    SelfTest(String),
}

fn is_hardware_h264(codec_name: &str) -> bool {
    matches!(
        codec_name,
        "h264_videotoolbox" | "h264_nvenc" | "h264_qsv" | "h264_amf" | "h264_mf"
    )
}

impl H264EncoderBuilder {
    pub const QUALITY_BPP: f32 = 0.3;
    pub const ULTRA_BPP: f32 = 1.0;
    pub const INSTANT_MODE_BPP: f32 = 0.15;

    pub fn new(input_config: VideoInfo) -> Self {
        Self {
            input_config,
            bpp: Self::QUALITY_BPP,
            preset: H264Preset::Ultrafast,
            output_size: None,
            external_conversion: false,
            encoder_priority_override: None,
            is_export: false,
            crf: None,
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

    pub fn with_export_priority(mut self) -> Self {
        if let Some(priority) = export_encoder_priority_override(&self.input_config, self.preset) {
            self.encoder_priority_override = Some(priority);
        }
        self
    }

    pub fn with_export_settings(mut self) -> Self {
        self.is_export = true;
        self
    }

    pub fn with_crf(mut self, crf: u8) -> Self {
        self.crf = Some(crf);
        self
    }

    pub fn with_encoder_priority_override(mut self, codecs: &'static [&'static str]) -> Self {
        self.encoder_priority_override = Some(codecs);
        self
    }

    pub fn build(
        self,
        output: &mut format::context::Output,
    ) -> Result<H264Encoder, H264EncoderError> {
        let input_config = self.input_config;
        let (raw_width, raw_height) = self
            .output_size
            .unwrap_or((input_config.width, input_config.height));

        let output_width = ensure_even(raw_width);
        let output_height = ensure_even(raw_height);

        if raw_width != output_width || raw_height != output_height {
            warn!(
                raw_width,
                raw_height,
                output_width,
                output_height,
                "Auto-adjusted odd dimensions to even for H264 encoding"
            );
        }

        let candidates = get_codec_and_options(
            &input_config,
            self.preset,
            self.encoder_priority_override,
            self.is_export,
            self.crf,
        );
        if candidates.is_empty() {
            return Err(H264EncoderError::CodecNotFound);
        }

        let mut last_error = None;

        for (codec, encoder_options) in candidates {
            let codec_name = codec.name().to_string();

            if is_hardware_h264(&codec_name)
                && let Err(reason) = cached_hardware_self_test(
                    codec,
                    &encoder_options,
                    &input_config,
                    output_width,
                    output_height,
                    self.bpp,
                    self.crf,
                )
            {
                warn!(
                    encoder = %codec_name,
                    %reason,
                    "Hardware H264 encoder failed pre-flight self-test, trying next candidate"
                );
                last_error = Some(H264EncoderError::SelfTest(reason));
                continue;
            }

            match Self::build_with_codec(
                codec,
                encoder_options,
                &input_config,
                output,
                output_width,
                output_height,
                self.bpp,
                self.external_conversion,
                self.crf,
            ) {
                Ok(encoder) => {
                    let is_hardware = is_hardware_h264(&codec_name);
                    let fps =
                        input_config.frame_rate.0 as f32 / input_config.frame_rate.1.max(1) as f32;
                    if is_hardware {
                        info!(
                            encoder = %codec_name,
                            width = input_config.width,
                            height = input_config.height,
                            fps = fps,
                            "Selected hardware H264 encoder"
                        );
                    } else {
                        let is_high_throughput =
                            requires_software_encoder(&input_config, self.preset, self.is_export);
                        if is_high_throughput {
                            warn!(
                                encoder = %codec_name,
                                width = input_config.width,
                                height = input_config.height,
                                fps = fps,
                                preset = ?self.preset,
                                "Using SOFTWARE encoder for high throughput (hardware cannot keep up at this resolution/fps)"
                            );
                        } else {
                            warn!(
                                encoder = %codec_name,
                                width = input_config.width,
                                height = input_config.height,
                                fps = fps,
                                "Using SOFTWARE H264 encoder (high CPU usage expected)"
                            );
                        }
                    }
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
        crf: Option<u8>,
    ) -> Result<H264Encoder, H264EncoderError> {
        let OpenedVideoEncoder {
            encoder,
            converter,
            converted_frame_pool,
            output_format,
            output_width,
            output_height,
            input_format,
            input_width,
            input_height,
        } = open_video_encoder(
            codec,
            encoder_options,
            input_config,
            output_width,
            output_height,
            bpp,
            external_conversion,
            crf,
        )?;

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
            input_format,
            input_width,
            input_height,
            converted_frame_pool,
        })
    }

    pub fn build_standalone(self) -> Result<H264PacketEncoder, H264EncoderError> {
        let input_config = self.input_config;
        let (raw_width, raw_height) = self
            .output_size
            .unwrap_or((input_config.width, input_config.height));

        let output_width = ensure_even(raw_width);
        let output_height = ensure_even(raw_height);

        if raw_width != output_width || raw_height != output_height {
            warn!(
                raw_width,
                raw_height,
                output_width,
                output_height,
                "Auto-adjusted odd dimensions to even for H264 encoding (standalone)"
            );
        }

        let candidates = get_codec_and_options(
            &input_config,
            self.preset,
            self.encoder_priority_override,
            self.is_export,
            self.crf,
        );
        if candidates.is_empty() {
            return Err(H264EncoderError::CodecNotFound);
        }

        let mut last_error = None;

        for (codec, encoder_options) in candidates {
            let codec_name = codec.name().to_string();

            if is_hardware_h264(&codec_name)
                && let Err(reason) = cached_hardware_self_test(
                    codec,
                    &encoder_options,
                    &input_config,
                    output_width,
                    output_height,
                    self.bpp,
                    self.crf,
                )
            {
                warn!(
                    encoder = %codec_name,
                    %reason,
                    "Hardware H264 encoder failed pre-flight self-test, trying next candidate"
                );
                last_error = Some(H264EncoderError::SelfTest(reason));
                continue;
            }

            match Self::build_standalone_with_codec(
                codec,
                encoder_options,
                &input_config,
                output_width,
                output_height,
                self.bpp,
                self.external_conversion,
                self.crf,
            ) {
                Ok(encoder) => {
                    let fps =
                        input_config.frame_rate.0 as f32 / input_config.frame_rate.1.max(1) as f32;
                    debug!(
                        encoder = %codec_name,
                        input_width = input_config.width,
                        input_height = input_config.height,
                        output_width = output_width,
                        output_height = output_height,
                        fps = fps,
                        "Selected standalone H264 encoder"
                    );
                    return Ok(encoder);
                }
                Err(err) => {
                    debug!("Standalone encoder {} init failed: {:?}", codec_name, err);
                    last_error = Some(err);
                }
            }
        }

        Err(last_error.unwrap_or(H264EncoderError::CodecNotFound))
    }

    #[allow(clippy::too_many_arguments)]
    fn build_standalone_with_codec(
        codec: Codec,
        encoder_options: Dictionary<'static>,
        input_config: &VideoInfo,
        output_width: u32,
        output_height: u32,
        bpp: f32,
        external_conversion: bool,
        crf: Option<u8>,
    ) -> Result<H264PacketEncoder, H264EncoderError> {
        let opened = open_video_encoder_with_flags(
            codec,
            encoder_options,
            input_config,
            output_width,
            output_height,
            bpp,
            external_conversion,
            crf,
            true,
        )?;
        let codec_name = codec.name().to_string();
        Ok(H264PacketEncoder::from_opened(
            opened,
            codec_name,
            input_config.time_base,
            input_config.frame_rate,
        ))
    }
}

pub(crate) struct OpenedVideoEncoder {
    pub encoder: encoder::Video,
    pub converter: Option<ffmpeg::software::scaling::Context>,
    pub converted_frame_pool: Option<frame::Video>,
    pub output_format: format::Pixel,
    pub output_width: u32,
    pub output_height: u32,
    pub input_format: format::Pixel,
    pub input_width: u32,
    pub input_height: u32,
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn open_video_encoder(
    codec: Codec,
    encoder_options: Dictionary<'static>,
    input_config: &VideoInfo,
    output_width: u32,
    output_height: u32,
    bpp: f32,
    external_conversion: bool,
    crf: Option<u8>,
) -> Result<OpenedVideoEncoder, H264EncoderError> {
    open_video_encoder_inner(
        codec,
        encoder_options,
        input_config,
        output_width,
        output_height,
        bpp,
        external_conversion,
        crf,
        false,
    )
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn open_video_encoder_with_flags(
    codec: Codec,
    encoder_options: Dictionary<'static>,
    input_config: &VideoInfo,
    output_width: u32,
    output_height: u32,
    bpp: f32,
    external_conversion: bool,
    crf: Option<u8>,
    global_header: bool,
) -> Result<OpenedVideoEncoder, H264EncoderError> {
    open_video_encoder_inner(
        codec,
        encoder_options,
        input_config,
        output_width,
        output_height,
        bpp,
        external_conversion,
        crf,
        global_header,
    )
}

#[allow(clippy::too_many_arguments)]
fn open_video_encoder_inner(
    codec: Codec,
    encoder_options: Dictionary<'static>,
    input_config: &VideoInfo,
    output_width: u32,
    output_height: u32,
    bpp: f32,
    external_conversion: bool,
    crf: Option<u8>,
    global_header: bool,
) -> Result<OpenedVideoEncoder, H264EncoderError> {
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
        if codec.name() == "libx264" {
            ffmpeg::format::Pixel::YUV420P
        } else {
            ffmpeg::format::Pixel::NV12
        }
    };

    debug!(
        encoder = %codec.name(),
        input_format = ?input_config.pixel_format,
        output_format = ?output_format,
        needs_pixel_conversion = needs_pixel_conversion,
        external_conversion = external_conversion,
        "Encoder pixel format configuration"
    );

    if is_420(output_format)
        && (!output_width.is_multiple_of(2) || !output_height.is_multiple_of(2))
    {
        return Err(H264EncoderError::InvalidOutputDimensions {
            width: output_width,
            height: output_height,
        });
    }

    let needs_scaling = output_width != input_config.width || output_height != input_config.height;

    if needs_scaling && !external_conversion {
        debug!(
            "Scaling video frames for H264 encoding from {}x{} to {}x{}",
            input_config.width, input_config.height, output_width, output_height
        );
    }

    let converter = if external_conversion {
        debug!(
            output_format = ?output_format,
            output_width = output_width,
            output_height = output_height,
            "External conversion enabled, skipping internal converter"
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
            Ok(context) => {
                debug!(
                    encoder = %codec.name(),
                    src_format = ?input_config.pixel_format,
                    src_size = %format!("{}x{}", input_config.width, input_config.height),
                    dst_format = ?output_format,
                    dst_size = %format!("{}x{}", output_width, output_height),
                    needs_scaling = needs_scaling,
                    "Created SOFTWARE scaler for pixel format conversion (CPU-intensive)"
                );
                Some(context)
            }
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
        debug!(
            encoder = %codec.name(),
            "No pixel format conversion needed (zero-copy path)"
        );
        None
    };

    let thread_count = thread::available_parallelism()
        .map(|v| v.get())
        .unwrap_or(1);

    let encoder = {
        let mut encoder_ctx = context::Context::new_with_codec(codec);
        encoder_ctx.set_threading(Config::count(thread_count));
        let mut encoder = encoder_ctx.encoder().video()?;

        encoder.set_width(output_width);
        encoder.set_height(output_height);
        encoder.set_format(output_format);
        encoder.set_time_base(input_config.time_base);
        encoder.set_frame_rate(Some(input_config.frame_rate));
        encoder.set_colorspace(color::Space::BT709);
        encoder.set_color_range(color::Range::MPEG);
        unsafe {
            (*encoder.as_mut_ptr()).color_primaries =
                ffmpeg::ffi::AVColorPrimaries::AVCOL_PRI_BT709;
            (*encoder.as_mut_ptr()).color_trc =
                ffmpeg::ffi::AVColorTransferCharacteristic::AVCOL_TRC_BT709;
            if global_header {
                (*encoder.as_mut_ptr()).flags |= ffmpeg::ffi::AV_CODEC_FLAG_GLOBAL_HEADER as i32;
            }
        }

        if crf.is_some() {
            encoder.set_bit_rate(0);
        } else {
            let bitrate = get_bitrate(
                output_width,
                output_height,
                input_config.frame_rate.0 as f32 / input_config.frame_rate.1 as f32,
                bpp,
            );
            encoder.set_bit_rate(bitrate);
            encoder.set_max_bit_rate(bitrate * 3 / 2);
        }

        encoder.open_as_with(codec, encoder_options)?
    };

    let converted_frame_pool = if converter.is_some() {
        Some(frame::Video::new(
            output_format,
            output_width,
            output_height,
        ))
    } else {
        None
    };

    Ok(OpenedVideoEncoder {
        encoder,
        converter,
        converted_frame_pool,
        output_format,
        output_width,
        output_height,
        input_format: input_config.pixel_format,
        input_width: input_config.width,
        input_height: input_config.height,
    })
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
    converted_frame_pool: Option<frame::Video>,
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

        let frame_to_send = if let Some(converter) = &mut self.converter {
            let pts = frame.pts();
            let converted = self.converted_frame_pool.as_mut().unwrap();
            converter
                .run(&frame, converted)
                .map_err(QueueFrameError::Converter)?;
            converted.set_pts(pts);
            converted as &frame::Video
        } else {
            &frame
        };

        self.base
            .send_frame(frame_to_send, output, &mut self.encoder)
            .map_err(QueueFrameError::Encode)?;

        Ok(())
    }

    pub fn queue_frame_reusable(
        &mut self,
        frame: &mut frame::Video,
        converted_frame: &mut Option<frame::Video>,
        timestamp: Duration,
        output: &mut format::context::Output,
    ) -> Result<(), QueueFrameError> {
        self.base.update_pts(frame, timestamp, &mut self.encoder);

        let frame_to_send = if let Some(converter) = &mut self.converter {
            let pts = frame.pts();
            let converted = converted_frame.get_or_insert_with(|| {
                frame::Video::new(self.output_format, self.output_width, self.output_height)
            });
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

#[cfg(any(target_os = "macos", target_os = "windows"))]
const VIDEOTOOLBOX_4K_MAX_FPS: f64 = 55.0;
#[cfg(any(target_os = "macos", target_os = "windows"))]
const VIDEOTOOLBOX_1080P_MAX_FPS: f64 = 190.0;
#[cfg(any(target_os = "macos", target_os = "windows"))]
const NVENC_4K_MAX_FPS: f64 = 120.0;
#[cfg(any(target_os = "macos", target_os = "windows"))]
const NVENC_1080P_MAX_FPS: f64 = 500.0;
#[cfg(any(target_os = "macos", target_os = "windows"))]
const QSV_4K_MAX_FPS: f64 = 90.0;
#[cfg(any(target_os = "macos", target_os = "windows"))]
const QSV_1080P_MAX_FPS: f64 = 300.0;
#[cfg(any(target_os = "macos", target_os = "windows"))]
const AMF_4K_MAX_FPS: f64 = 100.0;
#[cfg(any(target_os = "macos", target_os = "windows"))]
const AMF_1080P_MAX_FPS: f64 = 350.0;

#[cfg(any(target_os = "macos", target_os = "windows"))]
const PIXELS_4K: f64 = 3840.0 * 2160.0;
#[cfg(any(target_os = "macos", target_os = "windows"))]
const PIXELS_1080P: f64 = 1920.0 * 1080.0;

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn estimate_hw_encoder_max_fps(encoder_name: &str, width: u32, height: u32) -> f64 {
    let pixels = (width as f64) * (height as f64);

    let (max_fps_4k, max_fps_1080p) = match encoder_name {
        "h264_videotoolbox" => (VIDEOTOOLBOX_4K_MAX_FPS, VIDEOTOOLBOX_1080P_MAX_FPS),
        "h264_nvenc" => (NVENC_4K_MAX_FPS, NVENC_1080P_MAX_FPS),
        "h264_qsv" => (QSV_4K_MAX_FPS, QSV_1080P_MAX_FPS),
        "h264_amf" | "h264_mf" => (AMF_4K_MAX_FPS, AMF_1080P_MAX_FPS),
        _ => return f64::MAX,
    };

    if pixels >= PIXELS_4K {
        max_fps_4k
    } else if pixels <= PIXELS_1080P {
        max_fps_1080p
    } else {
        let ratio = (pixels - PIXELS_1080P) / (PIXELS_4K - PIXELS_1080P);
        max_fps_1080p + (max_fps_4k - max_fps_1080p) * ratio
    }
}

fn requires_software_encoder(config: &VideoInfo, preset: H264Preset, is_export: bool) -> bool {
    if is_export {
        return false;
    }

    if preset == H264Preset::HighThroughput {
        return true;
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let _ = config;

    #[cfg(target_os = "macos")]
    {
        let fps =
            config.frame_rate.numerator() as f64 / config.frame_rate.denominator().max(1) as f64;
        let max_hw_fps =
            estimate_hw_encoder_max_fps("h264_videotoolbox", config.width, config.height);
        let headroom_factor = 0.9;
        if fps > max_hw_fps * headroom_factor {
            debug!(
                width = config.width,
                height = config.height,
                target_fps = fps,
                hw_max_fps = max_hw_fps,
                "Target FPS exceeds VideoToolbox capability, using software encoder"
            );
            return true;
        }
    }

    #[cfg(target_os = "windows")]
    {
        use cap_frame_converter::{GpuVendor, detect_primary_gpu};

        let fps =
            config.frame_rate.numerator() as f64 / config.frame_rate.denominator().max(1) as f64;
        let encoder_name = match detect_primary_gpu().map(|info| info.vendor) {
            Some(GpuVendor::Nvidia) => "h264_nvenc",
            Some(GpuVendor::Amd) => "h264_amf",
            Some(GpuVendor::Intel) => "h264_qsv",
            _ => "h264_nvenc",
        };

        let max_hw_fps = estimate_hw_encoder_max_fps(encoder_name, config.width, config.height);
        let headroom_factor = 0.9;
        if fps > max_hw_fps * headroom_factor {
            debug!(
                width = config.width,
                height = config.height,
                target_fps = fps,
                hw_max_fps = max_hw_fps,
                encoder = encoder_name,
                "Target FPS exceeds hardware encoder capability, using software encoder"
            );
            return true;
        }
    }

    false
}

fn get_default_encoder_priority(_config: &VideoInfo) -> &'static [&'static str] {
    #[cfg(target_os = "macos")]
    {
        &["h264_videotoolbox", "libx264"]
    }

    #[cfg(target_os = "windows")]
    {
        use cap_frame_converter::{GpuVendor, detect_primary_gpu};

        static ENCODER_PRIORITY_NVIDIA: &[&str] =
            &["h264_nvenc", "h264_mf", "h264_qsv", "h264_amf", "libx264"];
        static ENCODER_PRIORITY_AMD: &[&str] =
            &["h264_amf", "h264_mf", "h264_nvenc", "h264_qsv", "libx264"];
        static ENCODER_PRIORITY_INTEL: &[&str] =
            &["h264_qsv", "h264_mf", "h264_nvenc", "h264_amf", "libx264"];
        static ENCODER_PRIORITY_DEFAULT: &[&str] =
            &["h264_nvenc", "h264_qsv", "h264_amf", "h264_mf", "libx264"];

        match detect_primary_gpu() {
            Some(info) if !info.supports_hardware_encoding() => &["libx264"],
            Some(info) => match info.vendor {
                GpuVendor::Nvidia => ENCODER_PRIORITY_NVIDIA,
                GpuVendor::Amd => ENCODER_PRIORITY_AMD,
                GpuVendor::Intel => ENCODER_PRIORITY_INTEL,
                _ => ENCODER_PRIORITY_DEFAULT,
            },
            None => ENCODER_PRIORITY_DEFAULT,
        }
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        &["libx264"]
    }
}

fn get_encoder_priority_with_override(
    config: &VideoInfo,
    preset: H264Preset,
    override_priority: Option<&'static [&'static str]>,
    is_export: bool,
) -> &'static [&'static str] {
    if force_software_encoder() {
        return &["libx264"];
    }

    if requires_software_encoder(config, preset, is_export) {
        return &["libx264"];
    }

    override_priority.unwrap_or_else(|| get_default_encoder_priority(config))
}

fn force_software_encoder() -> bool {
    std::env::var("CAP_EXPORT_FORCE_SOFTWARE_ENCODER").is_ok_and(|value| {
        matches!(
            value.to_ascii_lowercase().as_str(),
            "1" | "true" | "yes" | "on"
        )
    })
}

fn export_encoder_priority_override(
    _config: &VideoInfo,
    _preset: H264Preset,
) -> Option<&'static [&'static str]> {
    #[cfg(target_os = "windows")]
    {
        use cap_frame_converter::{GpuVendor, detect_primary_gpu};

        static ENCODER_PRIORITY_AMD_EXPORT: &[&str] =
            &["h264_amf", "h264_mf", "h264_nvenc", "h264_qsv", "libx264"];

        if let Some(info) = detect_primary_gpu()
            && info.supports_hardware_encoding()
            && info.vendor == GpuVendor::Amd
        {
            return Some(ENCODER_PRIORITY_AMD_EXPORT);
        }
    }

    None
}

pub const DEFAULT_KEYFRAME_INTERVAL_SECS: u32 = 2;

fn get_codec_and_options(
    config: &VideoInfo,
    preset: H264Preset,
    encoder_priority_override: Option<&'static [&'static str]>,
    is_export: bool,
    crf: Option<u8>,
) -> Vec<(Codec, Dictionary<'static>)> {
    let keyframe_interval_secs = DEFAULT_KEYFRAME_INTERVAL_SECS;
    let denominator = config.frame_rate.denominator();
    let frames_per_sec = config.frame_rate.numerator() as f64
        / if denominator == 0 { 1 } else { denominator } as f64;
    let keyframe_interval = (keyframe_interval_secs as f64 * frames_per_sec)
        .round()
        .max(1.0) as i32;
    let keyframe_interval_str = keyframe_interval.to_string();

    let encoder_priority = if crf.is_some() {
        &["libx264"] as &[&str]
    } else {
        get_encoder_priority_with_override(config, preset, encoder_priority_override, is_export)
    };

    let mut encoders = Vec::new();

    let crf_str = crf.map(|v| v.to_string());

    for encoder_name in encoder_priority {
        let Some(codec) = encoder::find_by_name(encoder_name) else {
            continue;
        };

        let mut options = Dictionary::new();

        match *encoder_name {
            "h264_videotoolbox" => {
                if is_export {
                    options.set("realtime", "false");
                    options.set("profile", "main");
                    options.set("allow_sw", "0");
                } else {
                    options.set("realtime", "true");
                    options.set("prio_speed", "true");
                    options.set("profile", "main");
                }
            }
            "h264_nvenc" => {
                if is_export {
                    options.set("preset", "p5");
                    options.set("tune", "hq");
                    options.set("rc", "vbr");
                    options.set("spatial-aq", "1");
                    options.set("temporal-aq", "1");
                    options.set("b_ref_mode", "middle");
                } else {
                    options.set("preset", "p4");
                    options.set("tune", "ll");
                    options.set("rc", "vbr");
                    options.set("spatial-aq", "1");
                    options.set("temporal-aq", "1");
                }
                options.set("g", &keyframe_interval_str);
            }
            "h264_qsv" => {
                if is_export {
                    options.set("preset", "medium");
                    options.set("look_ahead", "1");
                    options.set("look_ahead_depth", "20");
                } else {
                    options.set("preset", "faster");
                    options.set("look_ahead", "1");
                }
                options.set("g", &keyframe_interval_str);
            }
            "h264_amf" => {
                if is_export {
                    options.set("quality", "quality");
                    options.set("rc", "vbr_peak");
                } else {
                    options.set("quality", "balanced");
                    options.set("rc", "vbr_latency");
                }
                options.set("g", &keyframe_interval_str);
            }
            "h264_mf" => {
                options.set("hw_encoding", "true");
                if is_export {
                    options.set("scenario", "0");
                    options.set("quality", "0");
                } else {
                    options.set("scenario", "4");
                    options.set("quality", "1");
                }
                options.set("g", &keyframe_interval_str);
            }
            "libx264" => {
                if let Some(ref crf_val) = crf_str {
                    options.set("preset", "slow");
                    options.set("crf", crf_val);
                    options.set("pix_fmt", "yuv420p");
                } else if is_export {
                    options.set(
                        "preset",
                        match preset {
                            H264Preset::Slow => "slow",
                            H264Preset::Medium => "medium",
                            _ => "veryfast",
                        },
                    );
                    if !matches!(preset, H264Preset::Slow | H264Preset::Medium) {
                        let thread_count = thread::available_parallelism()
                            .map(|v| v.get())
                            .unwrap_or(4);
                        options.set("threads", &thread_count.to_string());
                        options.set("bf", "0");
                        options.set("rc-lookahead", "10");
                        options.set("b-adapt", "0");
                        options.set("aq-mode", "1");
                        options.set("ref", "2");
                        options.set("subme", "2");
                        options.set("trellis", "0");
                    }
                } else {
                    let realtime_preset = match preset {
                        H264Preset::Slow | H264Preset::Medium => "veryfast",
                        H264Preset::Ultrafast | H264Preset::HighThroughput => "ultrafast",
                    };
                    options.set("preset", realtime_preset);
                    options.set("tune", "zerolatency");
                }
                options.set("g", &keyframe_interval_str);
                options.set("keyint_min", &keyframe_interval_str);
            }
            _ => {}
        }

        encoders.push((codec, options));
    }

    encoders
}

/// Some GPU driver stacks open a hardware H264 session successfully but then
/// emit zeroed YUV — rendered as a solid green (or black) recording — with no
/// error surfaced anywhere. Before committing a recording to a hardware
/// encoder, encode a short neutral-gray clip and decode it back with the
/// software decoder; if the gray does not survive the round trip, the
/// candidate is rejected and encoder selection falls through to the next one
/// (terminating at libx264, which never takes this path).
///
/// Windows-only: that is where the multi-vendor encoder/driver matrix
/// (nvenc/amf/qsv/mf) lives and where zeroed-output reports come from.
/// VideoToolbox is a single-vendor OS stack, and measured session creation
/// alone costs ~1.6s — too much to add to recording start for a failure mode
/// never observed there. Results are cached per everything that shapes the
/// encode path (encoder, resolution, input pixel format, frame rate, bitrate
/// inputs, and the full option set) so the cost is one-time per process, and
/// `CAP_DISABLE_ENCODER_SELF_TEST=1` bypasses the check as an escape hatch.
fn cached_hardware_self_test(
    codec: Codec,
    encoder_options: &Dictionary<'static>,
    input_config: &VideoInfo,
    output_width: u32,
    output_height: u32,
    bpp: f32,
    crf: Option<u8>,
) -> Result<(), String> {
    use std::{
        collections::HashMap,
        fmt::Write,
        sync::{Mutex, OnceLock},
    };

    if !cfg!(target_os = "windows") {
        return Ok(());
    }

    if std::env::var("CAP_DISABLE_ENCODER_SELF_TEST")
        .is_ok_and(|v| matches!(v.to_ascii_lowercase().as_str(), "1" | "true" | "yes" | "on"))
    {
        return Ok(());
    }

    type Cache = Mutex<HashMap<String, Result<(), String>>>;
    static CACHE: OnceLock<Cache> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));

    // The verdict depends on everything that shapes the encoder session:
    // options (which differ between recording and export), frame rate (the
    // keyframe interval), the input pixel format (it selects the negotiated
    // encode format), and the bitrate inputs — not just name and size.
    let mut key = format!(
        "{}|{}x{}|{:?}|{}/{}|{}|{:?}",
        codec.name(),
        output_width,
        output_height,
        input_config.pixel_format,
        input_config.frame_rate.numerator(),
        input_config.frame_rate.denominator(),
        bpp,
        crf,
    );
    for (k, v) in encoder_options.iter() {
        let _ = write!(key, "|{k}={v}");
    }
    if let Some(result) = cache
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(&key)
    {
        return result.clone();
    }

    let started = std::time::Instant::now();
    let result = hardware_encoder_self_test(
        codec,
        clone_options(encoder_options),
        input_config,
        output_width,
        output_height,
        bpp,
        crf,
    );
    debug!(
        encoder = %codec.name(),
        width = output_width,
        height = output_height,
        elapsed_ms = started.elapsed().as_millis(),
        ok = result.is_ok(),
        "Hardware H264 encoder self-test finished"
    );
    cache
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(key, result.clone());
    result
}

fn clone_options(options: &Dictionary<'static>) -> Dictionary<'static> {
    let mut copy = Dictionary::new();
    for (k, v) in options.iter() {
        copy.set(k, v);
    }
    copy
}

fn hardware_encoder_self_test(
    codec: Codec,
    encoder_options: Dictionary<'static>,
    input_config: &VideoInfo,
    output_width: u32,
    output_height: u32,
    bpp: f32,
    crf: Option<u8>,
) -> Result<(), String> {
    // A throwaway encoder with production settings; frames are built directly
    // in the negotiated output format, so no converter is needed.
    let opened = open_video_encoder_inner(
        codec,
        encoder_options,
        input_config,
        output_width,
        output_height,
        bpp,
        true,
        crf,
        false,
    )
    .map_err(|e| format!("test encoder open: {e}"))?;
    let mut encoder = opened.encoder;

    // Mid-gray is neutral in both RGB (128,128,128) and YUV (Y=128, U=V=128)
    // representations, so filling every plane with 128 produces a valid gray
    // frame in any format the encoder negotiated.
    let mut test_frame = frame::Video::new(opened.output_format, output_width, output_height);
    for i in 0..test_frame.planes() {
        test_frame.data_mut(i).fill(128);
    }

    let fps = {
        let num = input_config.frame_rate.numerator().max(1);
        let den = input_config.frame_rate.denominator().max(1);
        (f64::from(num) / f64::from(den)).max(1.0)
    };
    let pts_step = ((f64::from(input_config.time_base.denominator().max(1)) / fps) as i64).max(1);

    fn drain_packets(encoder: &mut encoder::Video, packets: &mut Vec<ffmpeg::Packet>) {
        loop {
            let mut packet = ffmpeg::Packet::empty();
            if encoder.receive_packet(&mut packet).is_err() {
                break;
            }
            packets.push(packet);
        }
    }

    let mut packets = Vec::new();
    const TEST_FRAME_COUNT: i64 = 8;
    for i in 0..TEST_FRAME_COUNT {
        test_frame.set_pts(Some(i * pts_step));
        encoder
            .send_frame(&test_frame)
            .map_err(|e| format!("send_frame: {e}"))?;
        drain_packets(&mut encoder, &mut packets);
    }
    encoder.send_eof().map_err(|e| format!("send_eof: {e}"))?;
    drain_packets(&mut encoder, &mut packets);

    if packets.is_empty() {
        return Err("encoder produced no packets".to_string());
    }

    let decoder_codec = ffmpeg::codec::decoder::find(ffmpeg::codec::Id::H264)
        .ok_or_else(|| "no software H264 decoder available".to_string())?;
    let mut decoder_ctx = context::Context::new_with_codec(decoder_codec);
    // Hand over out-of-band SPS/PPS when the encoder produced extradata;
    // in-band parameter sets (the common case without GLOBAL_HEADER) decode
    // without it.
    unsafe {
        let enc = encoder.as_ptr();
        if !(*enc).extradata.is_null() && (*enc).extradata_size > 0 {
            let size = (*enc).extradata_size as usize;
            let buf =
                ffmpeg::ffi::av_mallocz(size + ffmpeg::ffi::AV_INPUT_BUFFER_PADDING_SIZE as usize)
                    .cast::<u8>();
            if !buf.is_null() {
                std::ptr::copy_nonoverlapping((*enc).extradata, buf, size);
                let dec = decoder_ctx.as_mut_ptr();
                (*dec).extradata = buf;
                (*dec).extradata_size = size as i32;
            }
        }
    }
    let mut decoder = decoder_ctx
        .decoder()
        .video()
        .map_err(|e| format!("test decoder open: {e}"))?;

    let mut decoded = frame::Video::empty();
    let mut decoded_count = 0usize;
    for packet in &packets {
        if decoder.send_packet(packet).is_err() {
            continue;
        }
        while decoder.receive_frame(&mut decoded).is_ok() {
            decoded_count += 1;
            verify_neutral_gray(&decoded)?;
        }
    }
    let _ = decoder.send_eof();
    while decoder.receive_frame(&mut decoded).is_ok() {
        decoded_count += 1;
        verify_neutral_gray(&decoded)?;
    }

    if decoded_count == 0 {
        return Err(format!(
            "none of {} encoded packets decoded to a frame",
            packets.len()
        ));
    }

    Ok(())
}

/// Asserts a decoded self-test frame still carries the neutral-gray content
/// that was encoded. A zeroed-YUV frame (Y=U=V=0, rendered green) or a black
/// frame (Y=16) fails by a wide margin; any functioning encoder reproduces a
/// flat gray I-frame nearly losslessly.
fn verify_neutral_gray(frame: &frame::Video) -> Result<(), String> {
    const TOLERANCE: f64 = 32.0;

    fn plane_mean(frame: &frame::Video, plane: usize, row_bytes: usize, rows: usize) -> f64 {
        let stride = frame.stride(plane);
        let data = frame.data(plane);
        let mut sum = 0u64;
        let mut count = 0u64;
        for row in 0..rows {
            let start = row * stride;
            let Some(slice) = data.get(start..start + row_bytes) else {
                break;
            };
            sum += slice.iter().map(|&b| u64::from(b)).sum::<u64>();
            count += row_bytes as u64;
        }
        if count == 0 {
            return f64::NAN;
        }
        sum as f64 / count as f64
    }

    let width = frame.width() as usize;
    let height = frame.height() as usize;
    let means: Vec<f64> = match frame.format() {
        format::Pixel::YUV420P | format::Pixel::YUVJ420P => vec![
            plane_mean(frame, 0, width, height),
            plane_mean(frame, 1, width.div_ceil(2), height.div_ceil(2)),
            plane_mean(frame, 2, width.div_ceil(2), height.div_ceil(2)),
        ],
        format::Pixel::NV12 => vec![
            plane_mean(frame, 0, width, height),
            plane_mean(frame, 1, width, height.div_ceil(2)),
        ],
        // Our encoders are configured for 8-bit 4:2:0; anything else decoding
        // out of the test stream is itself evidence the session is not doing
        // what was asked. Fail closed — the cost is falling back to the next
        // candidate, never accepting output we could not verify.
        other => {
            return Err(format!(
                "decoded self-test frame has unexpected pixel format {other:?}"
            ));
        }
    };

    for (plane, mean) in means.iter().enumerate() {
        if !mean.is_finite() || (mean - 128.0).abs() > TOLERANCE {
            return Err(format!(
                "decoded plane {plane} mean {mean:.1} deviates from neutral gray 128 \
                 (zeroed or corrupted encoder output)"
            ));
        }
    }

    Ok(())
}

fn get_bitrate(width: u32, height: u32, frame_rate: f32, bpp: f32) -> usize {
    // higher frame rates don't really need double the bitrate lets be real
    let frame_rate_multiplier = ((frame_rate as f64 - 30.0).max(0.0) * 0.6) + 30.0;
    let area = (width as f64) * (height as f64);
    let pixels_per_second = area * frame_rate_multiplier;

    (pixels_per_second * bpp as f64) as usize
}

#[cfg(test)]
mod self_test_tests {
    use super::*;

    fn yuv420p_frame(y: u8, u: u8, v: u8) -> frame::Video {
        let mut frame = frame::Video::new(format::Pixel::YUV420P, 64, 48);
        frame.data_mut(0).fill(y);
        frame.data_mut(1).fill(u);
        frame.data_mut(2).fill(v);
        frame
    }

    #[test]
    fn verifier_accepts_gray_and_rejects_zeroed_or_black() {
        assert!(verify_neutral_gray(&yuv420p_frame(128, 128, 128)).is_ok());
        assert!(verify_neutral_gray(&yuv420p_frame(120, 132, 125)).is_ok());
        // Zeroed YUV is what renders as the solid-green display.
        assert!(verify_neutral_gray(&yuv420p_frame(0, 0, 0)).is_err());
        // A black frame means the encoder dropped the content entirely.
        assert!(verify_neutral_gray(&yuv420p_frame(16, 128, 128)).is_err());
    }

    #[test]
    fn self_test_round_trip_passes_on_software_encoder() {
        ffmpeg::init().ok();
        let codec = encoder::find_by_name("libx264").expect("libx264 available");
        let mut options = Dictionary::new();
        options.set("preset", "ultrafast");

        let config = VideoInfo::from_raw(cap_media_info::RawVideoFormat::Bgra, 160, 120, 30);
        hardware_encoder_self_test(codec, options, &config, 160, 120, 0.3, None)
            .expect("healthy encoder passes the round trip");
    }
}
