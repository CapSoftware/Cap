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

pub struct AudioPlaybackBuffer<T: FromSampleBytes> {
    data: AudioData,
    cursor: usize,
    processing_chunk_size: usize,
    resampler: AudioResampler,
    resampled_buffer: HeapRb<T>,
    video_frame_duration: f64,
}

impl<T: FromSampleBytes> AudioPlaybackBuffer<T> {
    pub const PLAYBACK_SAMPLES_COUNT: u32 = 256;
    const PROCESSING_SAMPLES_COUNT: u32 = 1024;

    pub fn new(data: AudioData, output_info: AudioInfo, video_frame_duration: f64) -> Self {
        println!("Input info: {:?}", data.info);
        println!("Output info: {:?}", output_info);

        let resampler = AudioResampler::new(data.info, output_info).unwrap();

        // Up to 1 second of pre-rendered audio
        let capacity = (output_info.sample_rate as usize)
            * (output_info.channels as usize)
            * output_info.sample_format.bytes();
        let resampled_buffer = HeapRb::new(capacity);

        let processing_chunk_size = (Self::PROCESSING_SAMPLES_COUNT as usize)
            * data.info.channels
            * data.info.sample_format.bytes();

        Self {
            data,
            cursor: 0,
            processing_chunk_size,
            resampler,
            resampled_buffer,
            video_frame_duration,
        }
    }

    pub fn set_playhead(&mut self, playhead: u32) {
        self.resampler.reset();
        self.resampled_buffer.clear();

        println!("Audio seeking to video frame {playhead}");
        let chunk_size = self.data.info.channels * self.data.info.sample_format.bytes();
        let total_samples = self.data.buffer.len() / chunk_size;

        let estimated_cursor =
            (total_samples as f64) * f64::from(playhead) / self.video_frame_duration;
        let cursor: usize = num_traits::cast(estimated_cursor).unwrap();
        println!("Successful seek to sample {cursor}");
        self.cursor = cursor * chunk_size;
    }

    pub fn buffer_reaching_limit(&self) -> bool {
        self.resampled_buffer.vacant_len() <= 2 * self.processing_chunk_size
    }

    fn create_frame(&mut self) -> FFAudio {
        let mut samples = Self::PROCESSING_SAMPLES_COUNT as usize;
        let mut chunk_size = self.processing_chunk_size;

        let remaining_chunk = self.data.buffer.len() - self.cursor;
        if remaining_chunk < chunk_size {
            chunk_size = remaining_chunk;
            samples =
                remaining_chunk / (self.data.info.channels * self.data.info.sample_format.bytes());
        }

        let mut raw_frame = FFAudio::new(
            self.data.info.sample_format,
            samples,
            self.data.info.channel_layout(),
        );
        raw_frame.set_rate(self.data.info.sample_rate);
        let start = self.cursor;
        let end = self.cursor + chunk_size;
        raw_frame.data_mut(0)[0..chunk_size].copy_from_slice(&self.data.buffer[start..end]);
        self.cursor = end;

        raw_frame
    }

    pub fn render(&mut self) {
        if self.buffer_reaching_limit() {
            return;
        }

        let bytes_per_sample = self.resampler.output.sample_size();
        let maybe_rendered = match self.cursor >= self.data.buffer.len() {
            true => self.resampler.flush_frame(),
            false => {
                let frame = self.create_frame();
                Some(self.resampler.queue_and_process_frame(&frame))
            }
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
