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
    data::{cast_f32_slice_to_bytes, AudioInfo, FFAudio, FromSampleBytes},
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
    let mut resampler = F32Resampler::new(&decoder);

    let decoder_time_base = decoder.time_base();
    run_audio_decoder(
        decoder,
        input_ctx.packets().filter_map(|(s, mut p)| {
            if s.index() == stream_index {
                p.rescale_ts(s.time_base(), decoder_time_base);
                Some(p)
            } else {
                None
            }
        }),
        |frame| {
            let ts = frame.timestamp();
            frame.set_pts(ts);

            resampler.ingest_frame(&frame);
        },
    );

    resampler.finish().0
}

fn run_audio_decoder(
    decoder: &mut decoder::Audio,
    packets: impl Iterator<Item = ffmpeg::codec::packet::Packet>,
    mut on_frame: impl FnMut(&mut frame::Audio),
) {
    let mut decoder_frame = frame::Audio::empty();
    let mut decode_packets = |decoder: &mut decoder::Audio| {
        while decoder.receive_frame(&mut decoder_frame).is_ok() {
            on_frame(&mut decoder_frame);
        }
    };

    for packet in packets {
        decoder.send_packet(&packet).unwrap();
        decode_packets(decoder);
    }

    decoder.send_eof().unwrap();
    decode_packets(decoder);
}

pub struct AudioFrameBuffer {
    data: Vec<AudioData>,
    cursor: AudioFrameBufferCursor,
    elapsed_samples: usize,
    sample_size: usize,
}

#[derive(Clone, Copy, Debug)]
pub struct AudioFrameBufferCursor {
    segment_index: usize,
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
        // self.data.info
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
                samples: self.data[0].buffer.len(),
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
        let estimated_start_sample = playhead * f64::from(self.info().sample_rate);
        num_traits::cast(estimated_start_sample).unwrap()
    }

    fn elapsed_samples_to_playhead(&self) -> f64 {
        self.elapsed_samples as f64 / f64::from(self.info().sample_rate)
    }

    pub fn next_frame(
        &mut self,
        requested_samples: usize,
        timeline: Option<&TimelineConfiguration>,
    ) -> Option<FFAudio> {
        let format = self.info().sample_format;
        let channels = self.info().channel_layout();
        let sample_rate = self.info().sample_rate;

        self.next_frame_data(requested_samples, timeline)
            .map(move |(samples, data)| {
                let mut raw_frame = FFAudio::new(format, samples, channels);
                raw_frame.set_rate(sample_rate);
                raw_frame.data_mut(0)[0..data.len() * f32::BYTE_SIZE]
                    .copy_from_slice(unsafe { cast_f32_slice_to_bytes(data) });

                raw_frame
            })
    }

    pub fn next_frame_data<'a>(
        &'a mut self,
        requested_samples: usize,
        maybe_timeline: Option<&TimelineConfiguration>,
    ) -> Option<(usize, &'a [f32])> {
        if let Some(timeline) = maybe_timeline {
            self.adjust_cursor(timeline);
        }

        let buffer = &self.data[self.cursor.segment_index].buffer;
        if self.cursor.samples >= buffer.len() {
            self.elapsed_samples += requested_samples;
            return None;
        }

        let samples = requested_samples.min(buffer.len() - self.cursor.samples);

        let start = self.cursor;
        self.elapsed_samples += samples;
        self.cursor.samples += samples;
        Some((samples, &buffer[start.samples..self.cursor.samples]))
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
            <= 2 * (Self::PROCESSING_SAMPLES_COUNT as usize)
                * self.resampler.output.channels
                * self.resampler.output.sample_format.bytes()
    }

    pub fn render(&mut self, timeline: Option<&TimelineConfiguration>) {
        if self.buffer_reaching_limit() {
            return;
        }

        let bytes_per_sample = self.resampler.output.sample_size();
        let maybe_rendered = match self
            .frame_buffer
            .next_frame(Self::PROCESSING_SAMPLES_COUNT as usize, timeline)
        {
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
    context: resampling::Context,
    output_frame: FFAudio,
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

fn write_f32_ne_bytes(bytes: &[u8], buf: &mut Vec<f32>) {
    buf.extend(
        bytes
            .chunks(4)
            .map(|c| f32::from_ne_bytes([c[0], c[1], c[2], c[3]])),
    );
}

struct F32Resampler {
    resampler: ffmpeg::software::resampling::Context,
    buf: Vec<f32>,
    resampled_frame: frame::Audio,
    resampled_samples: usize,
}

impl F32Resampler {
    pub fn new(decoder: &ffmpeg::codec::decoder::Audio) -> Self {
        let resampler = ffmpeg::software::resampler(
            (decoder.format(), decoder.channel_layout(), decoder.rate()),
            (AudioData::FORMAT, decoder.channel_layout(), decoder.rate()),
        )
        .unwrap();

        Self {
            resampler,
            buf: Vec::new(),
            resampled_frame: frame::Audio::empty(),
            resampled_samples: 0,
        }
    }

    pub fn ingest_frame(&mut self, frame: &frame::Audio) {
        let resample_delay = self
            .resampler
            .run(&frame, &mut self.resampled_frame)
            .unwrap();

        self.resampled_samples += self.resampled_frame.samples();

        write_f32_ne_bytes(
            &self.resampled_frame.data(0)[0..self.resampled_frame.samples() * f32::BYTE_SIZE],
            &mut self.buf,
        );

        if resample_delay.is_some() {
            self.flush();
        }
    }

    fn flush(&mut self) {
        loop {
            let delay = self.resampler.flush(&mut self.resampled_frame).unwrap();

            self.resampled_samples += self.resampled_frame.samples();

            write_f32_ne_bytes(
                &self.resampled_frame.data(0)[0..self.resampled_frame.samples() * f32::BYTE_SIZE],
                &mut self.buf,
            );

            if delay.is_none() {
                break;
            }
        }
    }

    pub fn finish(mut self) -> (Vec<f32>, usize) {
        self.flush();

        (self.buf, self.resampled_samples)
    }
}
