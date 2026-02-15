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
use tracing::{debug, error, trace, warn};

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
    encoder_priority_override: Option<&'static [&'static str]>,
    is_export: bool,
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
            encoder_priority_override: None,
            is_export: false,
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
        );
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
                    let is_hardware = matches!(
                        codec_name.as_str(),
                        "h264_videotoolbox" | "h264_nvenc" | "h264_qsv" | "h264_amf" | "h264_mf"
                    );
                    let fps =
                        input_config.frame_rate.0 as f32 / input_config.frame_rate.1.max(1) as f32;
                    if is_hardware {
                        debug!(
                            encoder = %codec_name,
                            width = input_config.width,
                            height = input_config.height,
                            fps = fps,
                            "Selected hardware H264 encoder"
                        );
                    } else {
                        let is_high_throughput =
                            requires_software_encoder(&input_config, self.preset);
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
            ffmpeg::format::Pixel::NV12
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
        encoder.set_color_range(color::Range::MPEG);
        unsafe {
            (*encoder.as_mut_ptr()).color_primaries =
                ffmpeg::ffi::AVColorPrimaries::AVCOL_PRI_BT709;
            (*encoder.as_mut_ptr()).color_trc =
                ffmpeg::ffi::AVColorTransferCharacteristic::AVCOL_TRC_BT709;
        }

        let bitrate = get_bitrate(
            output_width,
            output_height,
            input_config.frame_rate.0 as f32 / input_config.frame_rate.1 as f32,
            bpp,
        );

        encoder.set_bit_rate(bitrate);

        let encoder = encoder.open_with(encoder_options)?;

        let mut output_stream = output.add_stream(codec)?;
        let stream_index = output_stream.index();
        output_stream.set_time_base((1, H264Encoder::TIME_BASE));
        output_stream.set_rate(input_config.frame_rate);
        output_stream.set_parameters(&encoder);

        let converted_frame_pool = if converter.is_some() {
            Some(frame::Video::new(
                output_format,
                output_width,
                output_height,
            ))
        } else {
            None
        };

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
            converted_frame_pool,
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

const VIDEOTOOLBOX_4K_MAX_FPS: f64 = 55.0;
const VIDEOTOOLBOX_1080P_MAX_FPS: f64 = 190.0;
const NVENC_4K_MAX_FPS: f64 = 120.0;
const NVENC_1080P_MAX_FPS: f64 = 500.0;
const QSV_4K_MAX_FPS: f64 = 90.0;
const QSV_1080P_MAX_FPS: f64 = 300.0;
const AMF_4K_MAX_FPS: f64 = 100.0;
const AMF_1080P_MAX_FPS: f64 = 350.0;

const PIXELS_4K: f64 = 3840.0 * 2160.0;
const PIXELS_1080P: f64 = 1920.0 * 1080.0;

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

fn requires_software_encoder(config: &VideoInfo, preset: H264Preset) -> bool {
    if preset == H264Preset::HighThroughput {
        return true;
    }

    let fps = config.frame_rate.numerator() as f64 / config.frame_rate.denominator().max(1) as f64;

    #[cfg(target_os = "macos")]
    {
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
        &[
            "h264_videotoolbox",
            "h264_qsv",
            "h264_nvenc",
            "h264_amf",
            "h264_mf",
            "libx264",
        ]
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

        match detect_primary_gpu().map(|info| info.vendor) {
            Some(GpuVendor::Nvidia) => ENCODER_PRIORITY_NVIDIA,
            Some(GpuVendor::Amd) => ENCODER_PRIORITY_AMD,
            Some(GpuVendor::Intel) => ENCODER_PRIORITY_INTEL,
            _ => ENCODER_PRIORITY_DEFAULT,
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
) -> &'static [&'static str] {
    if requires_software_encoder(config, preset) {
        return &["libx264"];
    }

    override_priority.unwrap_or_else(|| get_default_encoder_priority(config))
}

fn export_encoder_priority_override(
    config: &VideoInfo,
    preset: H264Preset,
) -> Option<&'static [&'static str]> {
    if requires_software_encoder(config, preset) {
        return None;
    }

    #[cfg(target_os = "windows")]
    {
        use cap_frame_converter::{GpuVendor, detect_primary_gpu};

        static ENCODER_PRIORITY_AMD_EXPORT: &[&str] =
            &["h264_mf", "h264_amf", "h264_nvenc", "h264_qsv", "libx264"];

        if let Some(GpuVendor::Amd) = detect_primary_gpu().map(|info| info.vendor) {
            return Some(ENCODER_PRIORITY_AMD_EXPORT);
        }
    }

    None
}

pub const DEFAULT_KEYFRAME_INTERVAL_SECS: u32 = 3;

fn get_codec_and_options(
    config: &VideoInfo,
    preset: H264Preset,
    encoder_priority_override: Option<&'static [&'static str]>,
    is_export: bool,
) -> Vec<(Codec, Dictionary<'static>)> {
    let keyframe_interval_secs = DEFAULT_KEYFRAME_INTERVAL_SECS;
    let denominator = config.frame_rate.denominator();
    let frames_per_sec = config.frame_rate.numerator() as f64
        / if denominator == 0 { 1 } else { denominator } as f64;
    let keyframe_interval = (keyframe_interval_secs as f64 * frames_per_sec)
        .round()
        .max(1.0) as i32;
    let keyframe_interval_str = keyframe_interval.to_string();

    let encoder_priority =
        get_encoder_priority_with_override(config, preset, encoder_priority_override);

    let mut encoders = Vec::new();

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
                    options.set("profile", "baseline");
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
                if is_export {
                    options.set(
                        "preset",
                        match preset {
                            H264Preset::Slow => "slow",
                            H264Preset::Medium => "medium",
                            _ => "veryfast",
                        },
                    );
                } else {
                    options.set(
                        "preset",
                        match preset {
                            H264Preset::Slow => "slow",
                            H264Preset::Medium => "medium",
                            H264Preset::Ultrafast | H264Preset::HighThroughput => "ultrafast",
                        },
                    );
                    if matches!(preset, H264Preset::Ultrafast | H264Preset::HighThroughput) {
                        options.set("tune", "zerolatency");
                    }
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
