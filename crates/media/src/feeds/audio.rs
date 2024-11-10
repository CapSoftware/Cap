use cap_project::TimelineConfiguration;
use ffmpeg::{
    codec::{context, decoder},
    format::sample::{Sample, Type},
    software::resampling,
};
use ringbuf::{
    traits::{Consumer, Observer, Producer},
    HeapRb,
};
use std::{path::PathBuf, sync::Arc};

use crate::{
    data::{AudioInfo, FFAudio, FromSampleBytes},
    MediaError,
};

#[derive(Clone, PartialEq, Eq)]
pub struct AudioData {
    pub buffer: Arc<Vec<u8>>,
    pub info: AudioInfo,
}

impl AudioData {
    pub const FORMAT: Sample = Sample::F64(Type::Packed);

    pub fn from_file(path: PathBuf) -> Result<Self, MediaError> {
        let input_ctx = ffmpeg::format::input(&path)?;
        let input_stream = input_ctx
            .streams()
            .best(ffmpeg::media::Type::Audio)
            .ok_or(MediaError::MissingMedia("audio"))?;

        let decoder_ctx = context::Context::from_parameters(input_stream.parameters())?;
        let mut decoder = decoder_ctx.decoder().audio()?;
        decoder.set_parameters(input_stream.parameters())?;
        decoder.set_packet_time_base(input_stream.time_base());

        let input_info = AudioInfo::from_decoder(&decoder);
        let mut output_info = input_info.clone();
        output_info.sample_format = Self::FORMAT;

        let resampler = AudioResampler::new(input_info, output_info)?;

        let reader = AudioFileReader {
            stream_index: input_stream.index(),
            info: input_info,
            resampler,
            decoder,
            first: true,
        };

        reader.read(input_ctx)
    }
}

pub struct AudioFrameBuffer {
    data: AudioData,
    cursor: usize,
    elapsed_samples: usize,
    sample_size: usize,
}

impl AudioFrameBuffer {
    pub fn new(data: AudioData) -> Self {
        let sample_size = data.info.channels * data.info.sample_format.bytes();

        Self {
            data,
            cursor: 0,
            elapsed_samples: 0,
            sample_size,
        }
    }

    pub fn info(&self) -> AudioInfo {
        self.data.info
    }

    pub fn set_playhead(&mut self, playhead: f64, maybe_timeline: Option<&TimelineConfiguration>) {
        self.elapsed_samples = self.playhead_to_samples(playhead);

        self.cursor = match maybe_timeline {
            Some(timeline) => match timeline.get_recording_time(playhead) {
                Some(time) => self.playhead_to_samples(time) * self.sample_size,
                None => self.data.buffer.len(),
            },
            None => self.elapsed_samples * self.sample_size,
        };
    }

    fn adjust_cursor(&mut self, timeline: &TimelineConfiguration) {
        let playhead = self.elapsed_samples_to_playhead();

        // ! Basically, to allow for some slop in the float -> usize and back conversions,
        // this will only seek if there is a significant change in actual vs expected next sample
        // (corresponding to a trim or split point). Currently this change is at least 0.2 seconds
        // - not sure we offer that much precision in the editor even!
        let new_cursor = match timeline.get_recording_time(playhead) {
            Some(time) => self.playhead_to_samples(time) * self.sample_size,
            None => self.data.buffer.len(),
        };

        let cursor_diff = new_cursor as isize - self.cursor as isize;
        if cursor_diff.abs() as usize > (self.data.info.sample_rate as usize) / 5 {
            self.cursor = new_cursor;
        }
    }

    fn playhead_to_samples(&self, playhead: f64) -> usize {
        let estimated_start_sample = playhead * f64::from(self.data.info.sample_rate);
        num_traits::cast(estimated_start_sample).unwrap()
    }

    fn elapsed_samples_to_playhead(&self) -> f64 {
        self.elapsed_samples as f64 / f64::from(self.data.info.sample_rate)
    }

    pub fn next_frame(
        &mut self,
        requested_samples: usize,
        timeline: Option<&TimelineConfiguration>,
    ) -> Option<FFAudio> {
        let format = self.data.info.sample_format;
        let channels = self.data.info.channel_layout();
        let sample_rate = self.data.info.sample_rate;

        self.next_frame_data(requested_samples, timeline)
            .map(move |(samples, data)| {
                let mut raw_frame = FFAudio::new(format, samples, channels);
                raw_frame.set_rate(sample_rate);
                raw_frame.data_mut(0)[0..data.len()].copy_from_slice(data);

                raw_frame
            })
    }

    pub fn next_frame_data<'a>(
        &'a mut self,
        mut samples: usize,
        maybe_timeline: Option<&TimelineConfiguration>,
    ) -> Option<(usize, &'a [u8])> {
        if let Some(timeline) = maybe_timeline {
            self.adjust_cursor(timeline);
        }

        if self.cursor >= self.data.buffer.len() {
            return None;
        }

        let mut bytes_size = self.sample_size * samples;

        let remaining_data = self.data.buffer.len() - self.cursor;
        if remaining_data < bytes_size {
            bytes_size = remaining_data;
            samples = remaining_data / self.sample_size;
        }

        let start = self.cursor;
        self.elapsed_samples += samples;
        self.cursor += bytes_size;
        Some((samples, &self.data.buffer[start..self.cursor]))
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

    pub fn new(data: AudioData, output_info: AudioInfo) -> Self {
        println!("Input info: {:?}", data.info);
        println!("Output info: {:?}", output_info);

        let resampler = AudioResampler::new(data.info, output_info).unwrap();

        // Up to 1 second of pre-rendered audio
        let capacity = (output_info.sample_rate as usize)
            * (output_info.channels as usize)
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

        println!("Successful seek to sample {}", self.frame_buffer.cursor);
    }

    pub fn buffer_reaching_limit(&self) -> bool {
        self.resampled_buffer.vacant_len()
            <= 2 * (Self::PROCESSING_SAMPLES_COUNT as usize)
                * (self.resampler.output.channels as usize)
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

struct AudioFileReader {
    decoder: decoder::Audio,
    resampler: AudioResampler,
    stream_index: usize,
    info: AudioInfo,
    first: bool,
}

impl AudioFileReader {
    fn read(
        mut self,
        mut input_ctx: ffmpeg::format::context::Input,
    ) -> Result<AudioData, MediaError> {
        let mut buffer = Vec::new();
        let output_info = self.resampler.output;

        for (stream, mut packet) in input_ctx.packets() {
            if stream.index() == self.stream_index {
                packet.rescale_ts(stream.time_base(), self.info.time_base);
                self.decoder.send_packet(&packet).unwrap();
                self.decode_packets(&mut buffer);
            }
        }

        self.finish_resampling(&mut buffer);

        Ok(AudioData {
            buffer: Arc::new(buffer),
            info: output_info,
        })
    }

    fn decode_packets(&mut self, data: &mut Vec<u8>) {
        let mut decoded_frame = FFAudio::empty();

        while self.decoder.receive_frame(&mut decoded_frame).is_ok() {
            let timestamp = decoded_frame.timestamp();
            if self.first {
                println!(
                    "First timestamp: {timestamp:?}, time base {}",
                    self.decoder.time_base()
                );
                self.first = false;
            }
            decoded_frame.set_pts(timestamp);
            let resampled = self.resampler.queue_and_process_frame(&decoded_frame);
            // println!("Resampled: {:?}", resampled);
            data.extend_from_slice(resampled);
            decoded_frame = FFAudio::empty();
        }
    }

    fn finish_resampling(&mut self, data: &mut Vec<u8>) {
        self.decoder.send_eof().unwrap();
        self.decode_packets(data);

        while let Some(resampled) = self.resampler.flush_frame() {
            data.extend_from_slice(resampled);
        }
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

    fn current_frame_data<'a>(&'a self) -> &'a [u8] {
        let end = self.output_frame.samples() * self.output.channels * self.output.sample_size();
        &self.output_frame.data(0)[0..end]
    }

    pub fn queue_and_process_frame<'a>(&'a mut self, frame: &FFAudio) -> &'a [u8] {
        self.delay = self.context.run(frame, &mut self.output_frame).unwrap();

        // Teeechnically this doesn't work for planar output
        self.current_frame_data()
    }

    pub fn flush_frame<'a>(&'a mut self) -> Option<&'a [u8]> {
        if self.delay.is_none() {
            return None;
        };

        self.delay = self.context.flush(&mut self.output_frame).unwrap();

        Some(self.current_frame_data())
    }
}
