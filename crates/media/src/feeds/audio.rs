use cap_project::TimelineConfiguration;
use ffmpeg::{
    codec::{context, decoder},
    format::{
        self,
        sample::{Sample, Type},
    },
    frame,
    software::resampling,
};
use ringbuf::{
    traits::{Consumer, Observer, Producer},
    HeapRb,
};
use std::{path::PathBuf, sync::Arc};

use crate::{
    data::{cast_bytes_to_f32_slice, cast_f32_slice_to_bytes, AudioInfo, FFAudio, FromSampleBytes},
    MediaError,
};

#[derive(Clone, PartialEq)]
pub struct AudioData {
    pub buffer: Arc<Vec<f32>>,
    pub info: AudioInfo,
}

impl AudioData {
    pub const FORMAT: Sample = Sample::F32(Type::Packed);

    pub fn from_file(path: PathBuf) -> Result<Self, MediaError> {
        let mut input_ctx = ffmpeg::format::input(&path)?;
        let input_stream = input_ctx
            .streams()
            .best(ffmpeg::media::Type::Audio)
            .ok_or(MediaError::MissingMedia("audio"))?;

        let decoder_ctx = context::Context::from_parameters(input_stream.parameters())?;
        let mut decoder = decoder_ctx.decoder().audio()?;
        decoder.set_parameters(input_stream.parameters())?;
        decoder.set_packet_time_base(input_stream.time_base());

        let mut info = AudioInfo::from_decoder(&decoder)?;
        info.sample_format = Self::FORMAT;

        let stream_index = input_stream.index();
        Ok(Self {
            buffer: Arc::new(decode_audio_to_f32(
                &mut decoder,
                &mut input_ctx,
                stream_index,
            )),
            info,
        })
    }
}

fn decode_audio_to_f32(
    decoder: &mut decoder::Audio,
    input_ctx: &mut format::context::Input,
    stream_index: usize,
) -> Vec<f32> {
    let mut decoded_frame = ffmpeg::frame::Audio::empty();
    let mut resampled_frame = ffmpeg::frame::Audio::empty();

    let mut resampler = ffmpeg::software::resampler(
        (decoder.format(), decoder.channel_layout(), decoder.rate()),
        (
            Sample::F32(Type::Packed),
            decoder.channel_layout(),
            decoder.rate(),
        ),
    )
    .unwrap();

    // let mut resampled_frames = 0;
    let mut samples: Vec<f32> = vec![];

    fn process_resampler(
        resampler: &mut resampling::Context,
        samples: &mut Vec<f32>,
        resampled_frame: &mut FFAudio,
    ) {
        loop {
            let resample_delay = resampler.flush(resampled_frame).unwrap();
            if resampled_frame.samples() == 0 {
                break;
            }

            let slice = &resampled_frame.data(0)
                [0..resampled_frame.samples() * 4 * resampled_frame.channels() as usize];
            samples.extend(unsafe { cast_bytes_to_f32_slice(slice) });

            if resample_delay.is_none() {
                break;
            }
        }
    }

    fn process_decoder(
        decoder: &mut ffmpeg::decoder::Audio,
        decoded_frame: &mut FFAudio,
        resampler: &mut resampling::Context,
        resampled_frame: &mut FFAudio,
        samples: &mut Vec<f32>,
    ) {
        while let Ok(_) = decoder.receive_frame(decoded_frame) {
            let resample_delay = resampler.run(&decoded_frame, resampled_frame).unwrap();

            let slice = &resampled_frame.data(0)
                [0..resampled_frame.samples() * 4 * resampled_frame.channels() as usize];
            samples.extend(unsafe { cast_bytes_to_f32_slice(slice) });

            if resample_delay.is_some() {
                process_resampler(resampler, samples, resampled_frame);
            }
        }
    }

    for (stream, packet) in input_ctx.packets() {
        if stream.index() != stream_index {
            continue;
        }

        decoder.send_packet(&packet).unwrap();

        process_decoder(
            decoder,
            &mut decoded_frame,
            &mut resampler,
            &mut resampled_frame,
            &mut samples,
        );

        if resampler.delay().is_some() {
            process_resampler(&mut resampler, &mut samples, &mut resampled_frame);
        }
    }

    decoder.send_eof().unwrap();

    process_decoder(
        decoder,
        &mut decoded_frame,
        &mut resampler,
        &mut resampled_frame,
        &mut samples,
    );

    process_resampler(&mut resampler, &mut samples, &mut resampled_frame);

    samples
}

pub struct AudioFrameBuffer {
    data: Vec<AudioData>,
    cursor: AudioFrameBufferCursor,
    // sum of `frame.samples()` that have elapsed
    // this * channel count = cursor
    elapsed_samples: usize,
    sample_size: usize,
}

#[derive(Clone, Copy, Debug)]
pub struct AudioFrameBufferCursor {
    segment_index: usize,
    // excludes channels
    samples: usize,
}

impl AudioFrameBuffer {
    pub fn new(data: Vec<AudioData>) -> Self {
        let info = data[0].info;
        let sample_size = info.channels * info.sample_format.bytes();

        Self {
            data,
            cursor: AudioFrameBufferCursor {
                segment_index: 0,
                samples: 0,
            },
            elapsed_samples: 0,
            sample_size,
        }
    }

    pub fn info(&self) -> AudioInfo {
        self.data[0].info
    }

    pub fn set_playhead(&mut self, playhead: f64, maybe_timeline: Option<&TimelineConfiguration>) {
        self.elapsed_samples = self.playhead_to_samples(playhead);

        self.cursor = match maybe_timeline {
            Some(timeline) => match timeline.get_recording_time(playhead) {
                Some((time, segment)) => {
                    let index = segment.unwrap_or(0) as usize;
                    AudioFrameBufferCursor {
                        segment_index: index,
                        samples: self.playhead_to_samples(time),
                    }
                }
                None => AudioFrameBufferCursor {
                    segment_index: 0,
                    samples: self.data[0].buffer.len(),
                },
            },
            None => AudioFrameBufferCursor {
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
        let new_cursor = match timeline.get_recording_time(playhead) {
            Some((time, segment)) => AudioFrameBufferCursor {
                segment_index: segment.unwrap_or(0) as usize,
                samples: self.playhead_to_samples(time),
            },
            None => AudioFrameBufferCursor {
                segment_index: 0,
                samples: self.data[0].buffer.len() / self.info().channels,
            },
        };

        let cursor_diff = new_cursor.samples as isize - self.cursor.samples as isize;
        if new_cursor.segment_index != self.cursor.segment_index
            || cursor_diff.unsigned_abs() > (self.info().sample_rate as usize) / 5
        {
            self.cursor = new_cursor;
        }
    }

    fn playhead_to_samples(&self, playhead: f64) -> usize {
        (playhead * self.info().sample_rate as f64) as usize
    }

    fn elapsed_samples_to_playhead(&self) -> f64 {
        self.elapsed_samples as f64 / self.info().sample_rate as f64
    }

    pub fn next_frame(
        &mut self,
        requested_samples: usize,
        timeline: Option<&TimelineConfiguration>,
    ) -> Option<FFAudio> {
        let format = self.info().sample_format;
        let channels = self.info().channel_layout();
        let sample_rate = self.info().sample_rate;

        let res = self
            .next_frame_data(requested_samples, timeline)
            .map(move |(samples, data)| {
                let mut raw_frame = FFAudio::new(format, samples, channels);
                raw_frame.set_rate(sample_rate);
                raw_frame.data_mut(0)[0..data.len() * f32::BYTE_SIZE]
                    .copy_from_slice(unsafe { cast_f32_slice_to_bytes(data) });

                raw_frame
            });

        res
    }

    // buffer samples = frame samples * channel count
    pub fn next_frame_data<'a>(
        &'a mut self,
        samples: usize,
        maybe_timeline: Option<&TimelineConfiguration>,
    ) -> Option<(usize, &'a [f32])> {
        if let Some(timeline) = maybe_timeline {
            self.adjust_cursor(timeline);
        }

        let data = &self.data[self.cursor.segment_index];
        let buffer = &data.buffer;
        if self.cursor.samples >= buffer.len() / self.info().channels {
            self.elapsed_samples += samples;
            return None;
        }

        let samples = (samples).min((buffer.len() / self.info().channels) - self.cursor.samples);

        let start = self.cursor;
        self.elapsed_samples += samples;
        self.cursor.samples += samples;
        Some((
            samples,
            &buffer
                [start.samples * self.info().channels..self.cursor.samples * self.info().channels],
        ))
    }
}

pub struct AudioPlaybackBuffer<T: FromSampleBytes> {
    frame_buffer: AudioFrameBuffer,
    resampler: AudioResampler,
    resampled_buffer: HeapRb<T>,
}

impl<T: FromSampleBytes> AudioPlaybackBuffer<T> {
    pub const PLAYBACK_SAMPLES_COUNT: u32 = 256;
    const PROCESSING_SAMPLES_COUNT: u32 = 1024;

    pub fn new(data: Vec<AudioData>, output_info: AudioInfo) -> Self {
        println!("Input info: {:?}", data[0].info);
        println!("Output info: {:?}", output_info);

        let resampler = AudioResampler::new(data[0].info, output_info).unwrap();

        // Up to 1 second of pre-rendered audio
        let capacity = (output_info.sample_rate as usize)
            * output_info.channels
            * output_info.sample_format.bytes();
        let resampled_buffer = HeapRb::new(capacity);

        let frame_buffer = AudioFrameBuffer::new(data);

        Self {
            frame_buffer,
            resampler,
            resampled_buffer,
        }
    }

    pub fn set_playhead(&mut self, playhead: f64, maybe_timeline: Option<&TimelineConfiguration>) {
        self.resampler.reset();
        self.resampled_buffer.clear();
        self.frame_buffer.set_playhead(playhead, maybe_timeline);

        println!("Successful seek to sample {:?}", self.frame_buffer.cursor);
    }

    pub fn buffer_reaching_limit(&self) -> bool {
        self.resampled_buffer.vacant_len()
            <= 2 * (Self::PROCESSING_SAMPLES_COUNT as usize) * self.resampler.output.channels
    }

    pub fn render(&mut self, timeline: Option<&TimelineConfiguration>) {
        if self.buffer_reaching_limit() {
            return;
        }

        let bytes_per_sample = self.resampler.output.sample_size();

        let next_frame = self
            .frame_buffer
            .next_frame(Self::PROCESSING_SAMPLES_COUNT as usize, timeline);

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
    input: AudioInfo,
    output: AudioInfo,
}

impl AudioResampler {
    pub fn new(input_info: AudioInfo, output_info: AudioInfo) -> Result<Self, MediaError> {
        let context = ffmpeg::software::resampler(
            (
                input_info.sample_format,
                input_info.channel_layout(),
                input_info.sample_rate,
            ),
            (
                output_info.sample_format,
                output_info.channel_layout(),
                output_info.sample_rate,
            ),
        )?;

        Ok(Self {
            input: input_info,
            output: output_info,
            context,
            output_frame: FFAudio::empty(),
            delay: None,
        })
    }

    pub fn reset(&mut self) {
        *self = Self::new(self.input, self.output).unwrap();
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
