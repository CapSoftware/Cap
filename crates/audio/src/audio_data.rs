use ffmpeg::{
    ChannelLayout, codec as avcodec,
    format::{self as avformat},
};
use std::path::Path;

use crate::cast_bytes_to_f32_slice;

// F32 Packed 48kHz audio
pub struct AudioData {
    samples: Vec<f32>,
    channels: u16,
}

impl AudioData {
    pub const SAMPLE_FORMAT: avformat::Sample =
        avformat::Sample::F32(avformat::sample::Type::Packed);
    pub const SAMPLE_RATE: u32 = 48_000;

    pub fn from_file(path: impl AsRef<Path>) -> Result<Self, String> {
        fn inner(path: &Path) -> Result<AudioData, String> {
            let mut input_ctx =
                ffmpeg::format::input(&path).map_err(|e| format!("Input Open / {e}"))?;
            let input_stream = input_ctx
                .streams()
                .best(ffmpeg::media::Type::Audio)
                .ok_or_else(|| "No Stream".to_string())?;

            let decoder_ctx = avcodec::Context::from_parameters(input_stream.parameters())
                .map_err(|e| format!("AudioData Parameters / {e}"))?;
            let mut decoder = decoder_ctx
                .decoder()
                .audio()
                .map_err(|e| format!("Set Parameters / {e}"))?;

            if decoder.channel_layout().is_empty() {
                decoder.set_channel_layout(ChannelLayout::default(decoder.channels() as i32));
            }
            decoder.set_packet_time_base(input_stream.time_base());

            let mut resampler = ffmpeg::software::resampler(
                (decoder.format(), decoder.channel_layout(), decoder.rate()),
                (
                    AudioData::SAMPLE_FORMAT,
                    decoder.channel_layout(),
                    AudioData::SAMPLE_RATE,
                ),
            )
            .map_err(|e| format!("Resampler / {e}"))?;

            let index = input_stream.index();

            let mut decoded_frame = ffmpeg::frame::Audio::empty();
            let mut resampled_frame = ffmpeg::frame::Audio::empty();

            // let mut resampled_frames = 0;
            let mut samples: Vec<f32> = vec![];

            for (stream, packet) in input_ctx.packets() {
                if stream.index() != index {
                    continue;
                }

                decoder
                    .send_packet(&packet)
                    .map_err(|e| format!("Send Packet / {e}"))?;

                while decoder.receive_frame(&mut decoded_frame).is_ok() {
                    let resample_delay = resampler
                        .run(&decoded_frame, &mut resampled_frame)
                        .map_err(|e| format!("Run Resampler / {e:?}"))?;

                    let slice = &resampled_frame.data(0)
                        [0..resampled_frame.samples() * 4 * resampled_frame.channels() as usize];
                    samples.extend(unsafe { cast_bytes_to_f32_slice(slice) });

                    if resample_delay.is_some() {
                        loop {
                            let resample_delay = resampler
                                .flush(&mut resampled_frame)
                                .map_err(|e| format!("Flush Resampler / {e}"))?;

                            let slice = &resampled_frame.data(0)[0..resampled_frame.samples()
                                * 4
                                * resampled_frame.channels() as usize];
                            samples.extend(unsafe { cast_bytes_to_f32_slice(slice) });

                            if resample_delay.is_none() {
                                break;
                            }
                        }
                    }
                }

                loop {
                    let resample_delay = resampler
                        .flush(&mut resampled_frame)
                        .map_err(|e| format!("Flush Resampler / {e}"))?;

                    let slice = &resampled_frame.data(0)
                        [0..resampled_frame.samples() * 4 * resampled_frame.channels() as usize];
                    samples.extend(unsafe { cast_bytes_to_f32_slice(slice) });

                    if resample_delay.is_none() {
                        break;
                    }
                }
            }

            decoder.send_eof().unwrap();

            while decoder.receive_frame(&mut decoded_frame).is_ok() {
                let resample_delay = resampler
                    .run(&decoded_frame, &mut resampled_frame)
                    .map_err(|e| format!("Run Resampler / {e}"))?;

                let slice = &resampled_frame.data(0)
                    [0..resampled_frame.samples() * 4 * resampled_frame.channels() as usize];
                samples.extend(unsafe { cast_bytes_to_f32_slice(slice) });

                if resample_delay.is_some() {
                    loop {
                        let resample_delay = resampler
                            .flush(&mut resampled_frame)
                            .map_err(|e| format!("Flush Resampler / {e}"))?;

                        let slice = &resampled_frame.data(0)[0..resampled_frame.samples()
                            * 4
                            * resampled_frame.channels() as usize];
                        samples.extend(unsafe { cast_bytes_to_f32_slice(slice) });

                        if resample_delay.is_none() {
                            break;
                        }
                    }
                }
            }

            loop {
                let resample_delay = resampler
                    .flush(&mut resampled_frame)
                    .map_err(|e| format!("Flush Resampler / {e}"))?;

                let slice = &resampled_frame.data(0)
                    [0..resampled_frame.samples() * 4 * resampled_frame.channels() as usize];
                samples.extend(unsafe { cast_bytes_to_f32_slice(slice) });

                if resample_delay.is_none() {
                    break;
                }
            }

            Ok(AudioData {
                samples,
                channels: decoder.channels(),
            })
        }

        inner(path.as_ref())
    }

    pub fn channels(&self) -> u16 {
        self.channels
    }

    pub fn samples(&self) -> &[f32] {
        self.samples.as_slice()
    }

    pub fn sample_count(&self) -> usize {
        self.samples.len() / self.channels as usize
    }
}
