use crate::{
    data::{FFPacket, FFVideo, VideoInfo},
    MediaError,
};
use ffmpeg::{
    codec::{codec::Codec, context, encoder},
    format::{self},
    threading::Config,
    Dictionary,
};

pub struct H264EncoderBuilder {
    name: &'static str,
    bpp: f32,
    input_config: VideoInfo,
    preset: H264Preset,
    direct_bitrate_bps: Option<usize>,
}

#[derive(Clone, Copy)]
pub enum H264Preset {
    Slow,
    Medium,
    Ultrafast,
}

impl H264EncoderBuilder {
    pub const QUALITY_BPP: f32 = 0.3;

    pub fn new(name: &'static str, input_config: VideoInfo) -> Self {
        Self {
            name,
            input_config,
            bpp: Self::QUALITY_BPP,
            preset: H264Preset::Ultrafast,
            direct_bitrate_bps: None,
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

    pub fn with_direct_bitrate_kbps(mut self, bitrate_kbps: u32) -> Self {
        // Store direct bitrate to bypass BPP calculation entirely
        self.direct_bitrate_bps = Some((bitrate_kbps * 1000) as usize);
        self
    }

    pub fn build(self, output: &mut format::context::Output) -> Result<H264Encoder, MediaError> {
        let input_config = &self.input_config;
        let is_streaming = self.direct_bitrate_bps.is_some();
        let (codec, encoder_options) = get_codec_and_options(&input_config, self.preset, is_streaming)?;

        let (format, converter) = if !codec
            .video()
            .unwrap()
            .formats()
            .unwrap()
            .any(|f| f == input_config.pixel_format)
        {
            let format = ffmpeg::format::Pixel::YUV420P;
            tracing::debug!(
                "Converting from {:?} to {:?} for H264 encoding",
                input_config.pixel_format,
                format
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
                        tracing::error!(
                            "Failed to create converter from {:?} to YUV420P: {:?}",
                            input_config.pixel_format,
                            e
                        );
                        MediaError::Any("Failed to create frame converter".into())
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
        encoder.set_time_base(input_config.frame_rate.invert());
        encoder.set_frame_rate(Some(input_config.frame_rate));

        let bitrate = if let Some(direct_bitrate) = self.direct_bitrate_bps {
            tracing::info!("Using direct bitrate: {} bps ({} kbps)", direct_bitrate, direct_bitrate / 1000);
            direct_bitrate
        } else {
            let calculated = get_bitrate(
                input_config.width,
                input_config.height,
                input_config.frame_rate.0 as f32 / input_config.frame_rate.1 as f32,
                self.bpp,
            );
            tracing::info!("Using calculated bitrate: {} bps ({} kbps)", calculated, calculated / 1000);
            calculated
        };

        tracing::info!("Setting encoder bitrate to: {} bps ({} kbps)", bitrate, bitrate / 1000);
        encoder.set_bit_rate(bitrate);
        encoder.set_max_bit_rate(bitrate);
        
        // For streaming, be more aggressive about bitrate control
        if self.direct_bitrate_bps.is_some() {
            // Set buffer size for more consistent bitrate
            encoder.set_rc_buffer_size(bitrate); // 1 second buffer
            encoder.set_rc_max_rate(bitrate); // Hard limit
            tracing::info!("Applied streaming bitrate controls: buffer_size={}, max_rate={}", bitrate, bitrate);
        }

        let video_encoder = encoder.open_with(encoder_options)?;

        let mut output_stream = output.add_stream(codec)?;
        let stream_index = output_stream.index();
        output_stream.set_time_base(input_config.frame_rate.invert());
        output_stream.set_rate(input_config.frame_rate);
        output_stream.set_parameters(&video_encoder);

        Ok(H264Encoder {
            tag: self.name,
            encoder: video_encoder,
            stream_index,
            config: self.input_config,
            converter,
            packet: FFPacket::empty(),
        })
    }
}

pub struct H264Encoder {
    tag: &'static str,
    encoder: encoder::Video,
    config: VideoInfo,
    converter: Option<ffmpeg::software::scaling::Context>,
    stream_index: usize,
    packet: ffmpeg::Packet,
}

unsafe impl Send for H264Encoder {}

impl H264Encoder {
    pub fn builder(name: &'static str, input_config: VideoInfo) -> H264EncoderBuilder {
        H264EncoderBuilder::new(name, input_config)
    }

    pub fn queue_frame(&mut self, frame: FFVideo, output: &mut format::context::Output) {
        let frame = if let Some(converter) = &mut self.converter {
            let mut new_frame = FFVideo::empty();
            match converter.run(&frame, &mut new_frame) {
                Ok(_) => {
                    new_frame.set_pts(frame.pts());
                    new_frame
                }
                Err(e) => {
                    tracing::error!(
                        "Failed to convert frame: {:?} from format {:?} to YUV420P",
                        e,
                        frame.format()
                    );
                    // Return early as we can't process this frame
                    return;
                }
            }
        } else {
            frame
        };

        if let Err(e) = self.encoder.send_frame(&frame) {
            tracing::error!("Failed to send frame to encoder: {:?}", e);
            return;
        }

        self.process_frame(output);
    }

    fn process_frame(&mut self, output: &mut format::context::Output) {
        while self.encoder.receive_packet(&mut self.packet).is_ok() {
            self.packet.set_stream(self.stream_index);
            self.packet.rescale_ts(
                self.config.time_base,
                output.stream(self.stream_index).unwrap().time_base(),
            );
            if let Err(e) = self.packet.write_interleaved(output) {
                tracing::error!("Failed to write packet: {:?}", e);
                break;
            }
        }
    }

    pub fn finish(&mut self, output: &mut format::context::Output) {
        if let Err(e) = self.encoder.send_eof() {
            tracing::error!("Failed to send EOF to encoder: {:?}", e);
            return;
        }
        self.process_frame(output);
    }
}

fn get_codec_and_options(
    config: &VideoInfo,
    preset: H264Preset,
    is_streaming: bool,
) -> Result<(Codec, Dictionary), MediaError> {
    let encoder_name = {
        if cfg!(target_os = "macos") {
            "libx264"
            // looks terrible rn :(
            // "h264_videotoolbox"
        } else {
            "libx264"
        }
    };

    if let Some(codec) = encoder::find_by_name(encoder_name) {
        let mut options = Dictionary::new();

        if encoder_name == "h264_videotoolbox" {
            options.set("realtime", "true");
        } else {
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
            
            // Streaming-specific options for better bitrate control
            if is_streaming {
                options.set("rc", "cbr"); // Constant bitrate mode
                options.set("bufsize", "4000k"); // Buffer size
                options.set("maxrate", "4000k"); // Max bitrate 
                options.set("minrate", "3800k"); // Min bitrate
                tracing::info!("Applied streaming encoder options: cbr mode, bufsize=4000k, maxrate=4000k");
            }
            
            options.set("vsync", "1");
            options.set("g", &keyframe_interval_str);
            options.set("keyint_min", &keyframe_interval_str);
        }

        return Ok((codec, options));
    }

    Err(MediaError::MissingCodec("H264 video"))
}

fn get_bitrate(width: u32, height: u32, frame_rate: f32, bpp: f32) -> usize {
    // higher frame rates don't really need double the bitrate lets be real
    let frame_rate_multiplier = (frame_rate - 30.0).max(0.0) * 0.6 + 30.0;
    let pixels_per_second = (width * height) as f32 * frame_rate_multiplier;

    (pixels_per_second * bpp) as usize
}
