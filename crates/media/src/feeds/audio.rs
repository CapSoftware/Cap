use cap_audio::{AudioData, StereoMode};
use cap_media_info::AudioInfo;
use cap_project::{AudioConfiguration, ProjectConfiguration, TimelineConfiguration};
use ffmpeg::{ChannelLayout, format as avformat, software::resampling};
use ringbuf::{
    HeapRb,
    traits::{Consumer, Observer, Producer},
};
use std::sync::Arc;

use crate::{
    MediaError,
    data::{FFAudio, FromSampleBytes, cast_f32_slice_to_bytes},
};

// fn decode_audio_to_f32(
//     decoder: &mut decoder::Audio,
//     input_ctx: &mut format::context::Input,
//     stream_index: usize,
// ) -> Vec<f32> {
//     let mut decoded_frame = ffmpeg::frame::Audio::empty();
//     let mut resampled_frame = ffmpeg::frame::Audio::empty();

//     let mut resampler = ffmpeg::software::resampler(
//         (decoder.format(), decoder.channel_layout(), decoder.rate()),
//         (
//             Sample::F32(Type::Packed),
//             decoder.channel_layout(),
//             AudioData::SAMPLE_RATE,
//         ),
//     )
//     .unwrap();

//     // let mut resampled_frames = 0;
//     let mut samples: Vec<f32> = vec![];

//     fn process_resampler(
//         resampler: &mut resampling::Context,
//         samples: &mut Vec<f32>,
//         resampled_frame: &mut FFAudio,
//     ) {
//         loop {
//             let resample_delay = resampler.flush(resampled_frame).unwrap();
//             if resampled_frame.samples() == 0 {
//                 break;
//             }

//             let slice = &resampled_frame.data(0)
//                 [0..resampled_frame.samples() * 4 * resampled_frame.channels() as usize];
//             samples.extend(unsafe { cast_bytes_to_f32_slice(slice) });

//             if resample_delay.is_none() {
//                 break;
//             }
//         }
//     }

//     fn process_decoder(
//         decoder: &mut ffmpeg::decoder::Audio,
//         decoded_frame: &mut FFAudio,
//         resampler: &mut resampling::Context,
//         resampled_frame: &mut FFAudio,
//         samples: &mut Vec<f32>,
//     ) {
//         while decoder.receive_frame(decoded_frame).is_ok() {
//             let resample_delay = resampler.run(decoded_frame, resampled_frame).unwrap();

//             let slice = &resampled_frame.data(0)
//                 [0..resampled_frame.samples() * 4 * resampled_frame.channels() as usize];
//             samples.extend(unsafe { cast_bytes_to_f32_slice(slice) });

//             if resample_delay.is_some() {
//                 process_resampler(resampler, samples, resampled_frame);
//             }
//         }
//     }

//     for (stream, packet) in input_ctx.packets() {
//         if stream.index() != stream_index {
//             continue;
//         }

//         decoder.send_packet(&packet).unwrap();

//         process_decoder(
//             decoder,
//             &mut decoded_frame,
//             &mut resampler,
//             &mut resampled_frame,
//             &mut samples,
//         );

//         if resampler.delay().is_some() {
//             process_resampler(&mut resampler, &mut samples, &mut resampled_frame);
//         }
//     }

//     decoder.send_eof().unwrap();

//     process_decoder(
//         decoder,
//         &mut decoded_frame,
//         &mut resampler,
//         &mut resampled_frame,
//         &mut samples,
//     );

//     process_resampler(&mut resampler, &mut samples, &mut resampled_frame);

//     samples
// }

pub struct AudioRenderer {
    data: Vec<AudioSegment>,
    cursor: AudioRendererCursor,
    // sum of `frame.samples()` that have elapsed
    // this * channel count = cursor
    elapsed_samples: usize,
}

#[derive(Clone, Copy, Debug)]
pub struct AudioRendererCursor {
    segment_index: u32,
    // excludes channels
    samples: usize,
}

#[derive(Clone)]
pub struct AudioSegment {
    pub tracks: Vec<AudioSegmentTrack>,
}

#[derive(Clone)]
pub struct AudioSegmentTrack {
    data: Arc<AudioData>,
    get_gain: fn(&AudioConfiguration) -> f32,
    get_stereo_mode: fn(&AudioConfiguration) -> StereoMode,
}

impl AudioSegmentTrack {
    pub fn new(
        data: Arc<AudioData>,
        get_gain: fn(&AudioConfiguration) -> f32,
        get_stereo_mode: fn(&AudioConfiguration) -> StereoMode,
    ) -> Self {
        Self {
            data,
            get_gain,
            get_stereo_mode,
        }
    }

    pub fn data(&self) -> &Arc<AudioData> {
        &self.data
    }

    pub fn gain(&self, config: &AudioConfiguration) -> f32 {
        (self.get_gain)(config)
    }

    pub fn stereo_mode(&self, config: &AudioConfiguration) -> StereoMode {
        (self.get_stereo_mode)(config)
    }
}

impl AudioRenderer {
    pub const SAMPLE_FORMAT: avformat::Sample = AudioData::SAMPLE_FORMAT;
    pub const SAMPLE_RATE: u32 = AudioData::SAMPLE_RATE;
    pub const CHANNELS: u16 = 2;

    pub fn info() -> AudioInfo {
        AudioInfo::new(Self::SAMPLE_FORMAT, Self::SAMPLE_RATE, Self::CHANNELS).unwrap()
    }

    pub fn new(data: Vec<AudioSegment>) -> Self {
        Self {
            data,
            cursor: AudioRendererCursor {
                segment_index: 0,
                samples: 0,
            },
            elapsed_samples: 0,
        }
    }

    pub fn set_playhead(&mut self, playhead: f64, project: &ProjectConfiguration) {
        self.elapsed_samples = self.playhead_to_samples(playhead);

        self.cursor = match project.get_segment_time(playhead) {
            Some((segment_time, segment_i)) => AudioRendererCursor {
                segment_index: segment_i,
                samples: self.playhead_to_samples(segment_time),
            },
            None => AudioRendererCursor {
                segment_index: 0,
                samples: self.elapsed_samples,
            },
        };
    }

    fn adjust_cursor(&mut self, timeline: &TimelineConfiguration) {
        let playhead = self.elapsed_samples_to_playhead();

        // ! Basically, to allow for some slop in the float -> usize and back conversions,
        // this will only seek if there is a significant change in actual vs expected next sample
        // (corresponding to a trim or split point). Currently this change is at least 0.2 seconds
        // - not sure we offer that much precision in the editor even!
        let new_cursor = match timeline.get_segment_time(playhead) {
            Some((segment_time, segment_i)) => AudioRendererCursor {
                segment_index: segment_i,
                samples: self.playhead_to_samples(segment_time),
            },
            None => AudioRendererCursor {
                segment_index: 0,
                samples: 0,
            },
        };

        let cursor_diff = new_cursor.samples as isize - self.cursor.samples as isize;
        if new_cursor.segment_index != self.cursor.segment_index
            || cursor_diff.unsigned_abs() > (AudioData::SAMPLE_RATE as usize) / 5
        {
            self.cursor = new_cursor;
        }
    }

    fn playhead_to_samples(&self, playhead: f64) -> usize {
        (playhead * AudioData::SAMPLE_RATE as f64) as usize
    }

    pub fn elapsed_samples_to_playhead(&self) -> f64 {
        self.elapsed_samples as f64 / AudioData::SAMPLE_RATE as f64
    }

    pub fn render_frame(
        &mut self,
        requested_samples: usize,
        project: &ProjectConfiguration,
    ) -> Option<FFAudio> {
        self.render_frame_raw(requested_samples, project)
            .map(move |(samples, data)| {
                let mut raw_frame =
                    FFAudio::new(AudioData::SAMPLE_FORMAT, samples, ChannelLayout::STEREO);
                raw_frame.set_rate(AudioData::SAMPLE_RATE);
                raw_frame.data_mut(0)[0..data.len() * f32::BYTE_SIZE]
                    .copy_from_slice(unsafe { cast_f32_slice_to_bytes(&data) });

                raw_frame
            })
    }

    pub fn render_frame_raw(
        &mut self,
        samples: usize,
        project: &ProjectConfiguration,
    ) -> Option<(usize, Vec<f32>)> {
        if let Some(timeline) = &project.timeline {
            self.adjust_cursor(timeline);
        }
        let channels: usize = 2;

        let tracks = &self.data[self.cursor.segment_index as usize].tracks;

        if tracks.is_empty() {
            return None;
        }

        let max_samples = tracks
            .iter()
            .map(|t| t.data().sample_count())
            .max()
            .unwrap();

        if self.cursor.samples >= max_samples {
            self.elapsed_samples += samples;
            return None;
        }

        let samples = samples.min(max_samples - self.cursor.samples);

        let start = self.cursor;

        let mut ret = vec![0.0; samples * 2];

        let track_datas = tracks
            .iter()
            .map(|t| {
                (
                    t.data().as_ref(),
                    if project.audio.mute {
                        f32::NEG_INFINITY
                    } else {
                        let g = t.gain(&project.audio);
                        if g < -30.0 { f32::NEG_INFINITY } else { g }
                    },
                    t.stereo_mode(&project.audio),
                )
            })
            .collect::<Vec<_>>();

        let actual_sample_count =
            cap_audio::render_audio(&track_datas, start.samples, samples, 0, &mut ret);

        self.elapsed_samples += actual_sample_count;
        self.cursor.samples += actual_sample_count;

        if actual_sample_count * channels < ret.len() {
            ret.resize(actual_sample_count * channels, 0.0);
        };

        Some((actual_sample_count, ret))
    }
}

pub struct AudioPlaybackBuffer<T: FromSampleBytes> {
    frame_buffer: AudioRenderer,
    resampler: AudioResampler,
    resampled_buffer: HeapRb<T>,
}

impl<T: FromSampleBytes> AudioPlaybackBuffer<T> {
    pub const PLAYBACK_SAMPLES_COUNT: u32 = 256;
    const PROCESSING_SAMPLES_COUNT: u32 = 1024;

    pub fn new(data: Vec<AudioSegment>, output_info: AudioInfo) -> Self {
        // println!("Input info: {:?}", data[0][0].info);
        println!("Output info: {output_info:?}");

        let resampler = AudioResampler::new(output_info).unwrap();

        // Up to 1 second of pre-rendered audio
        let capacity = (output_info.sample_rate as usize)
            * output_info.channels
            * output_info.sample_format.bytes();
        let resampled_buffer = HeapRb::new(capacity);

        let frame_buffer = AudioRenderer::new(data);

        Self {
            frame_buffer,
            resampler,
            resampled_buffer,
        }
    }

    pub fn set_playhead(&mut self, playhead: f64, project: &ProjectConfiguration) {
        self.resampler.reset();
        self.resampled_buffer.clear();
        self.frame_buffer.set_playhead(playhead, project);
    }

    pub fn buffer_reaching_limit(&self) -> bool {
        self.resampled_buffer.vacant_len()
            <= 2 * (Self::PROCESSING_SAMPLES_COUNT as usize) * self.resampler.output.channels
    }

    pub fn render(&mut self, project: &ProjectConfiguration) {
        if self.buffer_reaching_limit() {
            return;
        }

        let bytes_per_sample = self.resampler.output.sample_size();

        let next_frame = self
            .frame_buffer
            .render_frame(Self::PROCESSING_SAMPLES_COUNT as usize, project);

        let maybe_rendered = match next_frame {
            Some(frame) => Some(self.resampler.queue_and_process_frame(&frame)),
            None => self.resampler.flush_frame(),
        };

        if let Some(rendered) = maybe_rendered {
            let mut typed_data = vec![T::EQUILIBRIUM; rendered.len() / bytes_per_sample];

            for (src, dest) in std::iter::zip(rendered.chunks(bytes_per_sample), &mut typed_data) {
                *dest = T::from_bytes(src);
            }
            self.resampled_buffer.push_slice(&typed_data);
        }
    }

    pub fn fill(&mut self, playback_buffer: &mut [T]) {
        let filled = self.resampled_buffer.pop_slice(playback_buffer);
        playback_buffer[filled..].fill(T::EQUILIBRIUM);
    }
}

pub struct AudioResampler {
    pub context: resampling::Context,
    pub output_frame: FFAudio,
    delay: Option<resampling::Delay>,
    output: AudioInfo,
}

impl AudioResampler {
    pub fn new(output_info: AudioInfo) -> Result<Self, MediaError> {
        let context = ffmpeg::software::resampler(
            (
                AudioData::SAMPLE_FORMAT,
                ChannelLayout::STEREO,
                AudioData::SAMPLE_RATE,
            ),
            (
                output_info.sample_format,
                output_info.channel_layout(),
                output_info.sample_rate,
            ),
        )?;

        Ok(Self {
            output: output_info,
            context,
            output_frame: FFAudio::empty(),
            delay: None,
        })
    }

    pub fn reset(&mut self) {
        *self = Self::new(self.output).unwrap();
    }

    fn current_frame_data(&self) -> &[u8] {
        let end = self.output_frame.samples() * self.output.channels * self.output.sample_size();
        &self.output_frame.data(0)[0..end]
    }

    pub fn queue_and_process_frame<'a>(&'a mut self, frame: &FFAudio) -> &'a [u8] {
        self.delay = self.context.run(frame, &mut self.output_frame).unwrap();

        // Teeechnically this doesn't work for planar output
        self.current_frame_data()
    }

    pub fn flush_frame(&mut self) -> Option<&[u8]> {
        self.delay?;

        self.delay = self.context.flush(&mut self.output_frame).unwrap();

        Some(self.current_frame_data())
    }
}
