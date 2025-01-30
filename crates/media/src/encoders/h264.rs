use std::path::PathBuf;

use crate::{
    data::{FFPacket, FFVideo, VideoInfo},
    pipeline::task::PipelineSinkTask,
    MediaError,
};
use ffmpeg::{
    codec::{codec::Codec, context, encoder},
    format::{self},
    threading::Config,
    Dictionary, Rescale,
};
use ffmpeg_sys_next as sys;

pub struct H264Encoder {
    tag: &'static str,
    encoder: encoder::Video,
    config: VideoInfo,
    frame_count: i64,
    converter: Option<ffmpeg::software::scaling::Context>,
    stream_index: usize,
}

impl H264Encoder {
    pub fn factory(
        tag: &'static str,
        config: VideoInfo,
    ) -> impl FnOnce(&mut format::context::Output) -> Result<Self, MediaError> {
        move |o| Self::init(tag, config, o)
    }

    pub fn init(
        tag: &'static str,
        config: VideoInfo,
        output: &mut format::context::Output,
    ) -> Result<Self, MediaError> {
        let (codec, options) = get_codec_and_options(&config)?;

        let (format, converter) = if !codec
            .video()
            .unwrap()
            .formats()
            .unwrap()
            .any(|f| f == config.pixel_format)
        {
            let format = ffmpeg::format::Pixel::YUV420P;
            (
                format,
                Some(
                    ffmpeg::software::converter(
                        (config.width, config.height),
                        config.pixel_format,
                        format,
                    )
                    .expect("Failed to create frame converter"),
                ),
            )
        } else {
            (config.pixel_format, None)
        };

        let mut encoder_ctx = context::Context::new_with_codec(codec);

        // TODO: Configure this per system
        encoder_ctx.set_threading(Config::count(4));
        let mut encoder = encoder_ctx.encoder().video()?;

        encoder.set_width(config.width);
        encoder.set_height(config.height);
        encoder.set_format(format);
        encoder.set_time_base(config.frame_rate.invert());
        encoder.set_frame_rate(Some(config.frame_rate));
        encoder.set_bit_rate(12_000_000);
        encoder.set_max_bit_rate(12_000_000);

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
            frame_count: 0,
            converter,
        })
    }

    pub fn queue_frame(&mut self, mut frame: FFVideo, output: &mut format::context::Output) {
        dbg!(
            frame.width(),
            frame.height(),
            frame.planes(),
            frame.stride(0),
            frame.format()
        );
        dbg!(self.converter.is_some());
        if let Some(converter) = &mut self.converter {
            let mut new_frame = FFVideo::empty();
            converter.run(&frame, &mut new_frame).unwrap();
            dbg!(
                new_frame.width(),
                new_frame.height(),
                new_frame.planes(),
                new_frame.format()
            );
            frame = new_frame;
        }

        frame.set_pts(Some(self.frame_count));
        self.frame_count += 1;
        self.encoder.send_frame(&frame).unwrap();

        self.process_frame(output);
    }

    fn process_frame(&mut self, output: &mut format::context::Output) {
        let mut encoded_packet = FFPacket::empty();

        while self.encoder.receive_packet(&mut encoded_packet).is_ok() {
            encoded_packet.set_stream(0);
            encoded_packet.rescale_ts(
                self.encoder.time_base(),
                output.stream(0).unwrap().time_base(),
            );
            encoded_packet.write_interleaved(output).unwrap();
        }
    }

    pub fn finish(&mut self, output: &mut format::context::Output) {
        self.encoder.send_eof().unwrap();
        self.process_frame(output);
    }
}

// unsafe impl Send for H264Encoder {}

// impl PipelineSinkTask for H264Encoder {
//     type Input = FFVideo;

//     fn run(
//         &mut self,
//         ready_signal: crate::pipeline::task::PipelineReadySignal,
//         input: &flume::Receiver<Self::Input>,
//     ) {
//         ready_signal.send(Ok(())).unwrap();

//         while let Ok(frame) = input.recv() {
//             self.queue_frame(frame);
//             self.process_frame();
//         }
//     }

//     fn finish(&mut self) {
//         self.finish();
//     }
// }

fn get_codec_and_options(config: &VideoInfo) -> Result<(Codec, Dictionary), MediaError> {
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
            // options.set("constant_bit_rate", "true");
            options.set("realtime", "true");
        } else {
            let keyframe_interval_secs = 2;
            let keyframe_interval = keyframe_interval_secs * config.frame_rate.numerator();
            let keyframe_interval_str = keyframe_interval.to_string();

            options.set("preset", "ultrafast");
            options.set("tune", "zerolatency");
            options.set("vsync", "1");
            options.set("g", &keyframe_interval_str);
            options.set("keyint_min", &keyframe_interval_str);
            // // TODO: Is it worth limiting quality? Maybe make this configurable
            // options.set("crf", "14");
        }

        return Ok((codec, options));
    }

    Err(MediaError::MissingCodec("H264 video"))
}
