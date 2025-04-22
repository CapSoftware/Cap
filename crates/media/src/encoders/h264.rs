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
use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
pub enum CompressionQuality {
    Studio,
    Social,
    Web,
    WebLow,
}

impl Default for CompressionQuality {
    fn default() -> Self {
        Self::Web
    }
}

impl CompressionQuality {
    fn bitrate(&self) -> usize {
        match self {
            CompressionQuality::Studio => 80_000_000,
            CompressionQuality::Social => 24_000_000,
            CompressionQuality::Web => 12_000_000,
            CompressionQuality::WebLow => 3_000_000,
        }
    }

    fn preset(&self) -> &'static str {
        match self {
            CompressionQuality::Studio => "slow",
            _ => "ultrafast",
        }
    }

    fn uses_crf(&self) -> bool {
        matches!(self, CompressionQuality::Studio)
    }
}

pub struct H264Encoder {
    tag: &'static str,
    encoder: encoder::Video,
    config: VideoInfo,
    converter: Option<ffmpeg::software::scaling::Context>,
    stream_index: usize,
    packet: ffmpeg::Packet,
    compression: CompressionQuality,
}

impl H264Encoder {
    pub fn factory(
        tag: &'static str,
        config: VideoInfo,
        compression: CompressionQuality,
    ) -> impl FnOnce(&mut format::context::Output) -> Result<Self, MediaError> {
        move |o| Self::init(tag, config, compression, o)
    }

    pub fn init(
        tag: &'static str,
        config: VideoInfo,
        compression: CompressionQuality,
        output: &mut format::context::Output,
    ) -> Result<Self, MediaError> {
        let (codec, options) = get_codec_and_options(&config, compression)?;

        let (format, converter) = if !codec
            .video()
            .unwrap()
            .formats()
            .unwrap()
            .any(|f| f == config.pixel_format)
        {
            let format = ffmpeg::format::Pixel::YUV420P;
            tracing::debug!(
                "Converting from {:?} to {:?} for H264 encoding",
                config.pixel_format,
                format
            );
            (
                format,
                Some(
                    ffmpeg::software::converter(
                        (config.width, config.height),
                        config.pixel_format,
                        format,
                    )
                    .map_err(|e| {
                        tracing::error!(
                            "Failed to create converter from {:?} to YUV420P: {:?}",
                            config.pixel_format,
                            e
                        );
                        MediaError::Any("Failed to create frame converter".into())
                    })?,
                ),
            )
        } else {
            (config.pixel_format, None)
        };

        let mut encoder_ctx = context::Context::new_with_codec(codec);

        encoder_ctx.set_threading(Config::count(4));
        let mut encoder = encoder_ctx.encoder().video()?;

        encoder.set_width(config.width);
        encoder.set_height(config.height);
        encoder.set_format(format);
        encoder.set_time_base(config.frame_rate.invert());
        encoder.set_frame_rate(Some(config.frame_rate));

        let target_bitrate = compression.bitrate();

        encoder.set_bit_rate(target_bitrate);
        encoder.set_max_bit_rate(target_bitrate);

        let video_encoder = encoder.open_with(options)?;

        let mut output_stream = output.add_stream(codec)?;
        let stream_index = output_stream.index();
        output_stream.set_time_base(config.frame_rate.invert());
        output_stream.set_rate(config.frame_rate);
        output_stream.set_parameters(&video_encoder);

        Ok(Self {
            tag,
            encoder: video_encoder,
            stream_index,
            config,
            converter,
            packet: FFPacket::empty(),
            compression,
        })
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
    compression: CompressionQuality,
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

            let preset = compression.preset();

            options.set("preset", preset);
            options.set("tune", "zerolatency");
            options.set("vsync", "1");
            options.set("g", &keyframe_interval_str);
            options.set("keyint_min", &keyframe_interval_str);

            if compression.uses_crf() {
                options.set("crf", "16");
            }
        }

        return Ok((codec, options));
    }

    Err(MediaError::MissingCodec("H264 video"))
}
