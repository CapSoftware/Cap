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
use tracing::{debug, info, trace};

use super::Output;

pub struct H264Encoder {
    tag: &'static str,
    encoder: encoder::Video,
    output_ctx: format::context::Output,
    last_pts: Option<i64>,
    config: VideoInfo,
    frame_count: i64,
}

impl H264Encoder {
    pub fn init(tag: &'static str, config: VideoInfo, output: Output) -> Result<Self, MediaError> {
        let Output::File(destination) = output;

        let mut output_ctx = format::output(&destination)?;

        let (codec, options) = get_codec_and_options(&config)?;

        let mut encoder_ctx = context::Context::new_with_codec(codec);

        // TODO: Configure this per system
        encoder_ctx.set_threading(Config::count(4));
        let mut encoder = encoder_ctx.encoder().video()?;

        encoder.set_width(config.width);
        encoder.set_height(config.height);
        encoder.set_format(config.pixel_format);
        encoder.set_time_base(config.frame_rate.invert());
        encoder.set_frame_rate(Some(config.frame_rate));

        if codec.name() == "h264_videotoolbox" {
            encoder.set_bit_rate(1_200_000);
            encoder.set_max_bit_rate(120_000);
        } else {
            encoder.set_bit_rate(8_000_000);
            encoder.set_max_bit_rate(8_000_000);
        }

        let video_encoder = encoder.open_with(options)?;

        let mut output_stream = output_ctx.add_stream(codec)?;
        output_stream.set_time_base(config.frame_rate.invert());
        output_stream.set_rate(config.frame_rate);
        output_stream.set_parameters(&video_encoder);
        output_ctx.write_header()?;

        Ok(Self {
            tag,
            encoder: video_encoder,
            output_ctx,
            last_pts: None,
            config,
            frame_count: 0,
        })
    }

    fn queue_frame(&mut self, mut frame: FFVideo) {
        frame.set_pts(Some(self.frame_count));
        self.frame_count += 1;
        self.encoder.send_frame(&frame).unwrap();
    }

    fn process_frame(&mut self) {
        let mut encoded_packet = FFPacket::empty();

        while self.encoder.receive_packet(&mut encoded_packet).is_ok() {
            encoded_packet.set_stream(0);
            encoded_packet.rescale_ts(
                self.encoder.time_base(),
                self.output_ctx.stream(0).unwrap().time_base(),
            );
            encoded_packet
                .write_interleaved(&mut self.output_ctx)
                .unwrap();
        }
    }

    fn finish(&mut self) {
        self.encoder.send_eof().unwrap();
        self.process_frame();

        // Set the duration in the output container's stream
        if let Some(stream) = self.output_ctx.stream(0) {
            let duration = self
                .frame_count
                .rescale(self.config.frame_rate.invert(), stream.time_base());
            unsafe {
                let stream_ptr = stream.as_ptr() as *mut sys::AVStream;
                (*stream_ptr).duration = duration;
                (*stream_ptr).time_base = stream.time_base().into();
                (*stream_ptr).nb_frames = self.frame_count;
                (*stream_ptr).start_time = 0;
                (*stream_ptr).r_frame_rate = self.config.frame_rate.into();
                (*stream_ptr).avg_frame_rate = self.config.frame_rate.into();
            }
        }

        self.output_ctx.write_trailer().unwrap();
    }
}

impl PipelineSinkTask for H264Encoder {
    type Input = FFVideo;

    fn run(
        &mut self,
        ready_signal: crate::pipeline::task::PipelineReadySignal,
        input: flume::Receiver<Self::Input>,
    ) {
        trace!("Starting {} video encoding thread", self.tag);
        ready_signal.send(Ok(())).unwrap();

        while let Ok(frame) = input.recv() {
            self.queue_frame(frame);
            self.process_frame();
        }

        trace!("Received last {} frame. Finishing up encoding.", self.tag);
        self.finish();

        info!("Shut down {} video encoding thread", self.tag);
    }
}

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
