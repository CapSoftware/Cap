use crate::{
    data::{
        AudioInfo, FFAudio, FFPacket, FFRational, FFVideo, PlanarData, RawVideoFormat, VideoInfo,
    },
    pipeline::{audio_buffer::AudioBuffer, task::PipelineSinkTask},
    MediaError,
};
use ffmpeg::{
    codec::{codec::Codec, context, encoder},
    format::{self},
    software,
    threading::Config,
    Dictionary,
};

use super::Output;

struct Audio {
    encoder: encoder::Audio,
    buffer: AudioBuffer,
    input_config: AudioInfo,
    resampler: software::resampling::Context,
}

struct Video {
    encoder: ffmpeg::encoder::Video,
    config: VideoInfo,
}

pub struct MP4Encoder {
    tag: &'static str,
    output_ctx: format::context::Output,
    video: Video,
    audio: Option<Audio>,
}

impl MP4Encoder {
    const AUDIO_BITRATE: usize = 128 * 1000; // 128k

    pub fn init(
        tag: &'static str,
        video_config: VideoInfo,
        audio_config: Option<AudioInfo>,
        output: Output,
    ) -> Result<Self, MediaError> {
        dbg!(&audio_config, video_config);

        let Output::File(destination) = output;
        let mut output_ctx = format::output(&destination)?;

        // Setup video encoder
        let (video_codec, video_options) = get_video_codec_and_options(&video_config)?;
        let mut video_ctx = context::Context::new_with_codec(video_codec);
        video_ctx.set_threading(Config::count(4));
        let mut video_enc = video_ctx.encoder().video()?;

        video_enc.set_width(video_config.width);
        video_enc.set_height(video_config.height);
        video_enc.set_format(video_config.pixel_format);
        video_enc.set_time_base(video_config.frame_rate.invert());
        video_enc.set_frame_rate(Some(video_config.frame_rate));

        if video_codec.name() == "h264_videotoolbox" {
            video_enc.set_bit_rate(1_200_000);
            video_enc.set_max_bit_rate(120_000);
        } else {
            video_enc.set_bit_rate(8_000_000);
            video_enc.set_max_bit_rate(8_000_000);
        }

        let video_encoder = video_enc.open_with(video_options)?;

        let video = Video {
            encoder: video_encoder,
            config: video_config,
        };

        let audio = if let Some(audio_config) = audio_config {
            // Setup audio encoder
            let audio_codec = encoder::find(ffmpeg::codec::Id::AAC)
                .ok_or(MediaError::TaskLaunch("Could not find AAC codec".into()))?;
            let mut audio_ctx = context::Context::new_with_codec(audio_codec);
            audio_ctx.set_threading(Config::count(4));
            let mut audio_enc = audio_ctx.encoder().audio()?;

            if !audio_codec
                .audio()
                .unwrap()
                .rates()
                .into_iter()
                .flatten()
                .any(|r| r == audio_config.rate())
            {
                return Err(MediaError::TaskLaunch(format!(
                    "AAC Codec does not support sample rate {}",
                    audio_config.rate()
                )));
            }

            let output_format = ffmpeg::format::Sample::F32(format::sample::Type::Packed);

            audio_enc.set_bit_rate(Self::AUDIO_BITRATE);
            audio_enc.set_rate(audio_config.rate());
            audio_enc.set_format(output_format);
            audio_enc.set_channel_layout(audio_config.channel_layout());
            audio_enc.set_time_base(audio_config.time_base);

            let resampler = software::resampler(
                (
                    audio_config.sample_format,
                    audio_config.channel_layout(),
                    audio_config.sample_rate,
                ),
                (
                    output_format,
                    audio_config.channel_layout(),
                    audio_config.sample_rate,
                ),
            )?;

            Some((audio_enc.open()?, audio_codec, audio_config, resampler))
        } else {
            None
        };

        // Setup output streams
        let mut video_stream = output_ctx.add_stream(video_codec)?;
        video_stream.set_time_base(video_config.frame_rate.invert());
        video_stream.set_parameters(&video.encoder);

        let audio = if let Some((encoder, codec, input_config, resampler)) = audio {
            let mut stream = output_ctx.add_stream(codec)?;
            stream.set_time_base(FFRational(1, input_config.rate()));
            stream.set_parameters(&encoder);

            let buffer = AudioBuffer::new(input_config, &encoder);

            Some(Audio {
                encoder,
                buffer,
                input_config,
                resampler,
            })
        } else {
            None
        };

        output_ctx.write_header()?;

        Ok(Self {
            tag,
            output_ctx,
            video,
            audio,
        })
    }

    pub fn video_format() -> RawVideoFormat {
        RawVideoFormat::YUYV420
    }

    pub fn queue_video_frame(&mut self, frame: FFVideo) {
        let mut scaler = ffmpeg::software::converter(
            (frame.width(), frame.height()),
            frame.format(),
            self.video.config.pixel_format,
        )
        .unwrap();

        let mut output = FFVideo::empty();

        scaler.run(&frame, &mut output).unwrap();

        output.set_pts(frame.pts());

        self.video.encoder.send_frame(&output).unwrap();
        self.process_video_packets();
    }

    pub fn queue_audio_frame(&mut self, frame: FFAudio) {
        if let Some(buffer) = self.audio.as_mut().map(|a| &mut a.buffer) {
            buffer.consume(frame);
        }

        while let Some((buffered_frame, audio)) = self
            .audio
            .as_mut()
            .and_then(|a| Some((a.buffer.next_frame()?, a)))
        {
            let mut output = ffmpeg::util::frame::Audio::empty();
            audio.resampler.run(&buffered_frame, &mut output).unwrap();
            audio.encoder.send_frame(&output).unwrap();
            self.process_audio_packets();
        }
    }

    fn process_video_packets(&mut self) {
        let mut encoded_packet = FFPacket::empty();

        while self
            .video
            .encoder
            .receive_packet(&mut encoded_packet)
            .is_ok()
        {
            encoded_packet.set_stream(0); // Video is stream 0
            encoded_packet.rescale_ts(
                self.video.encoder.time_base(),
                self.output_ctx.stream(0).unwrap().time_base(),
            );
            encoded_packet
                .write_interleaved(&mut self.output_ctx)
                .unwrap();
        }
    }

    fn process_audio_packets(&mut self) {
        let mut packet = FFPacket::empty();

        if let Some(audio) = self.audio.as_mut() {
            while audio.encoder.receive_packet(&mut packet).is_ok() {
                packet.set_stream(1); // Audio is stream 1
                packet.set_time_base(self.output_ctx.stream(1).unwrap().time_base());
                packet.rescale_ts(
                    packet.time_base(),
                    self.output_ctx.stream(1).unwrap().time_base(),
                );
                packet.write_interleaved(&mut self.output_ctx).unwrap();
            }
        }
    }

    pub fn finish(&mut self) {
        self.video.encoder.send_eof().unwrap();
        self.process_video_packets();

        if let Some(audio) = self.audio.as_mut() {
            audio.encoder.send_eof().unwrap();
            self.process_audio_packets();
        }

        self.output_ctx.write_trailer().unwrap();
    }
}

pub struct MP4Input {
    pub video: FFVideo,
    pub audio: Option<FFAudio>,
}

impl PipelineSinkTask for MP4Encoder {
    type Input = MP4Input;

    fn run(
        &mut self,
        ready_signal: crate::pipeline::task::PipelineReadySignal,
        input: flume::Receiver<Self::Input>,
    ) {
        println!("Starting {} MP4 encoding thread", self.tag);
        ready_signal.send(Ok(())).unwrap();

        while let Ok(frame) = input.recv() {
            self.queue_video_frame(frame.video);
            if let Some(audio) = frame.audio {
                self.queue_audio_frame(audio);
            }
        }

        println!("Received last {} frame. Finishing up encoding.", self.tag);
        self.finish();

        println!("Shutting down {} MP4 encoding thread", self.tag);
    }
}

fn get_video_codec_and_options(config: &VideoInfo) -> Result<(Codec, Dictionary), MediaError> {
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

            options.set("preset", "ultrafast");
            options.set("tune", "zerolatency");
        }

        return Ok((codec, options));
    }

    Err(MediaError::MissingCodec("H264 video"))
}
