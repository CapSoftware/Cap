use std::ffi::CStr;

use crate::{
    data::{
        AudioInfo, FFAudio, FFPacket, FFRational, FFVideo, PlanarData, RawVideoFormat, VideoInfo,
    },
    feeds::AudioData,
    pipeline::{audio_buffer::AudioBuffer, task::PipelineSinkTask},
    MediaError,
};
use ffmpeg::{
    codec::{codec::Codec, context, encoder},
    format::{self, sample::Sample},
    software,
    threading::Config,
    Dictionary, Rescale,
};
use ffmpeg_sys_next::FF_QP2LAMBDA;
use tracing::{debug, info, trace};

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
    frame_count: i64,
}

pub struct MP4Encoder {
    tag: &'static str,
    output_ctx: format::context::Output,
    video: Video,
    audio: Option<Audio>,
}

impl MP4Encoder {
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
        video_enc.set_time_base(FFRational(1, video_config.frame_rate.numerator()));
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
            frame_count: 0,
        };

        let audio = if let Some(audio_config) = audio_config {
            let audio_codec = encoder::find_by_name("libopus")
                .ok_or(MediaError::TaskLaunch("Could not find Opus codec".into()))?;
            let mut audio_ctx = context::Context::new_with_codec(audio_codec);
            let mut audio_enc = audio_ctx.encoder().audio()?;

            audio_enc.set_bit_rate(128 * 1000);
            let output_format = ffmpeg::format::Sample::F32(format::sample::Type::Packed);

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

            // let (mut audio_enc, audio_codec, output_format) = if cfg!(target_os = "macos") {
            //     let audio_codec = encoder::find_by_name("aac_at")
            //         .ok_or(MediaError::TaskLaunch("Could not find AAC codec".into()))?;
            //     let mut audio_ctx = context::Context::new_with_codec(audio_codec);
            //     audio_ctx.set_threading(Config::count(4));
            //     let mut audio_enc = audio_ctx.encoder().audio()?;

            //     let output_format = ffmpeg::format::Sample::I16(format::sample::Type::Planar);

            //     audio_enc.set_flags(ffmpeg::codec::Flags::QSCALE);
            //     audio_enc.set_quality(10 * FF_QP2LAMBDA as usize);

            //     (audio_enc, audio_codec, output_format)
            // } else {
            //     let audio_codec = encoder::find_by_name("aac")
            //         .ok_or(MediaError::TaskLaunch("Could not find AAC codec".into()))?;
            //     let mut audio_ctx = context::Context::new_with_codec(audio_codec);
            //     audio_ctx.set_threading(Config::count(4));
            //     let mut audio_enc = audio_ctx.encoder().audio()?;

            //     audio_enc.set_bit_rate(128 * 1000);
            //     let output_format = ffmpeg::format::Sample::F32(format::sample::Type::Planar);

            //     if !audio_codec
            //         .audio()
            //         .unwrap()
            //         .rates()
            //         .into_iter()
            //         .flatten()
            //         .any(|r| r == audio_config.rate())
            //     {
            //         return Err(MediaError::TaskLaunch(format!(
            //             "AAC Codec does not support sample rate {}",
            //             audio_config.rate()
            //         )));
            //     }

            //     (audio_enc, audio_codec, output_format)
            // };

            audio_enc.set_rate(audio_config.rate());
            audio_enc.set_format(output_format);
            audio_enc.set_channel_layout(audio_config.channel_layout());
            audio_enc.set_time_base(FFRational(1, audio_config.rate()));

            let resampler = software::resampler(
                (
                    AudioData::FORMAT,
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
        video_stream.set_time_base(FFRational(1, video_config.frame_rate.numerator()));
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

    pub fn queue_video_frame(&mut self, mut frame: FFVideo) {
        // println!(
        //     "MP4Encoder: Processing frame {} (input PTS: {:?})",
        //     self.video.frame_count,
        //     frame.pts()
        // );
        let mut scaler = ffmpeg::software::converter(
            (frame.width(), frame.height()),
            frame.format(),
            self.video.config.pixel_format,
        )
        .unwrap();

        let mut output = FFVideo::empty();
        scaler.run(&frame, &mut output).unwrap();

        // Set PTS in microseconds (1/1_000_000 second units)
        let pts = frame.pts().unwrap_or_else(|| self.video.frame_count);
        output.set_pts(Some(pts));
        // println!(
        //     "MP4Encoder: Setting frame {} PTS to {}",
        //     self.video.frame_count, pts
        // );
        self.video.frame_count += 1;

        self.video.encoder.send_frame(&output).unwrap();
        self.process_video_packets();
    }

    pub fn queue_audio_frame(&mut self, frame: FFAudio) {
        let Some(audio) = &mut self.audio else {
            return;
        };

        // println!(
        //     "MP4Encoder: Queueing audio frame with PTS: {:?}, samples: {}",
        //     frame.pts(),
        //     frame.samples()
        // );

        audio.buffer.consume(frame);

        // Process all buffered frames
        loop {
            let Some(buffered_frame) = audio.buffer.next_frame() else {
                break;
            };

            let mut output = ffmpeg::util::frame::Audio::empty();

            audio.resampler.run(&buffered_frame, &mut output).unwrap();

            // Preserve PTS from input frame
            if let Some(pts) = buffered_frame.pts() {
                output.set_pts(Some(pts));
            }

            let data = output.data(0);
            let data_f32 =
                unsafe { std::slice::from_raw_parts(data.as_ptr() as *const u8, data.len() / 4) };

            // Send frame to encoder
            audio.encoder.send_frame(&output).unwrap();

            // Process any encoded packets
            let mut encoded_packet = FFPacket::empty();
            while audio.encoder.receive_packet(&mut encoded_packet).is_ok() {
                encoded_packet.set_stream(1);
                encoded_packet.rescale_ts(
                    audio.encoder.time_base(),
                    self.output_ctx.stream(1).unwrap().time_base(),
                );
                encoded_packet
                    .write_interleaved(&mut self.output_ctx)
                    .unwrap();
            }
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
        if let Some(audio) = self.audio.as_mut() {
            let mut encoded_packet = FFPacket::empty();

            while audio.encoder.receive_packet(&mut encoded_packet).is_ok() {
                println!(
                    "MP4Encoder: Writing audio packet with PTS: {:?}, size: {}",
                    encoded_packet.pts(),
                    encoded_packet.size()
                );

                // Set stream index for audio (stream 1)
                encoded_packet.set_stream(1);

                // Rescale timestamps to output timebase
                encoded_packet.rescale_ts(
                    audio.encoder.time_base(),
                    self.output_ctx.stream(1).unwrap().time_base(),
                );

                encoded_packet
                    .write_interleaved(&mut self.output_ctx)
                    .unwrap();
            }
        }
    }

    pub fn finish(&mut self) {
        println!("MP4Encoder: Finishing encoding");

        // Flush video encoder
        self.video.encoder.send_eof().unwrap();
        self.process_video_packets();

        // Flush audio encoder
        if let Some(audio) = &mut self.audio {
            println!("MP4Encoder: Flushing audio encoder");

            // Process any remaining frames in the buffer
            while let Some(buffered_frame) = audio.buffer.next_frame() {
                let mut output = ffmpeg::util::frame::Audio::empty();
                audio.resampler.run(&buffered_frame, &mut output).unwrap();

                if let Some(pts) = buffered_frame.pts() {
                    output.set_pts(Some(pts));
                }

                audio.encoder.send_frame(&output).unwrap();

                // Process packets after each frame
                let mut encoded_packet = FFPacket::empty();
                while audio.encoder.receive_packet(&mut encoded_packet).is_ok() {
                    encoded_packet.set_stream(1);
                    encoded_packet.rescale_ts(
                        audio.encoder.time_base(),
                        self.output_ctx.stream(1).unwrap().time_base(),
                    );
                    encoded_packet
                        .write_interleaved(&mut self.output_ctx)
                        .unwrap();
                }
            }

            // Send EOF to audio encoder and process final packets
            audio.encoder.send_eof().unwrap();
            let mut encoded_packet = FFPacket::empty();
            while audio.encoder.receive_packet(&mut encoded_packet).is_ok() {
                encoded_packet.set_stream(1);
                encoded_packet.rescale_ts(
                    audio.encoder.time_base(),
                    self.output_ctx.stream(1).unwrap().time_base(),
                );
                encoded_packet
                    .write_interleaved(&mut self.output_ctx)
                    .unwrap();
            }
        }

        println!("MP4Encoder: Writing trailer");
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
        ready_signal.send(Ok(())).unwrap();

        while let Ok(frame) = input.recv() {
            self.queue_video_frame(frame.video);
            if let Some(audio) = frame.audio {
                self.queue_audio_frame(audio);
            }
        }
    }

    fn finish(&mut self) {
        self.finish();
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
