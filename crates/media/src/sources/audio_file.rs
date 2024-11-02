use ffmpeg::{
    codec::{context, decoder},
    format, media,
    packet::Mut,
    sys::av_packet_add_side_data,
    Rescale,
};
use flume::Sender;
use std::path::PathBuf;

use crate::{
    data::{AudioInfo, FFAudio, FFError, FFPacket},
    pipeline::{clock::RecordedClock, control::Control, task::PipelineSourceTask},
    MediaError,
};

pub struct AudioFileSource {
    input_ctx: format::context::Input,
    decoder: decoder::Audio,
    stream_index: usize,
    info: AudioInfo,
}

impl AudioFileSource {
    pub fn init(source: PathBuf) -> Result<Self, MediaError> {
        let input_ctx = format::input(&source)?;
        let input_stream = input_ctx
            .streams()
            .best(media::Type::Audio)
            .ok_or(MediaError::MissingMedia("audio"))?;

        let decoder_ctx = context::Context::from_parameters(input_stream.parameters())?;
        let mut decoder = decoder_ctx.decoder().audio()?;
        decoder.set_parameters(input_stream.parameters())?;

        Ok(Self {
            stream_index: input_stream.index(),
            info: AudioInfo::from_decoder(&decoder),
            input_ctx,
            decoder,
        })
    }

    pub fn info(&self) -> AudioInfo {
        self.info
    }

    fn set_playhead(&mut self, playhead_ratio: f64) -> bool {
        let duration: f64 = num_traits::cast(self.input_ctx.duration()).unwrap();
        let timestamp: i64 = num_traits::cast(duration * playhead_ratio).unwrap();

        let stream = self.input_ctx.stream(self.stream_index).unwrap();
        let stream_time_base = stream.time_base();
        let decoder_time_base = self.decoder.time_base();

        let target_timestamp = timestamp.rescale(ffmpeg_sys_next::AV_TIME_BASE_Q, stream_time_base);

        self.decoder.flush();
        if let Err(error) = self.input_ctx.seek(target_timestamp, ..target_timestamp) {
            eprintln!("Error while seeking in audio file: {error}");
            return false;
        }

        let (maybe_packet, packets_remaining) = self.read_packet();

        if let Some(mut packet) = maybe_packet {
            match packet.pts() {
                Some(pts) if pts < target_timestamp => {
                    use ffmpeg::packet::side_data::Type::SkipSamples;
                    let diff =
                        (target_timestamp - pts).rescale(stream_time_base, decoder_time_base);
                    unsafe {
                        av_packet_add_side_data(
                            packet.as_mut_ptr(),
                            SkipSamples.into(),
                            diff.to_le_bytes().as_mut_ptr(),
                            8,
                        );
                    }
                }
                _ => {}
            }

            self.decoder.send_packet(&packet).unwrap();
        }

        packets_remaining
    }

    fn queue_packet(&mut self) -> bool {
        let (maybe_packet, packets_remaining) = self.read_packet();

        if let Some(packet) = maybe_packet {
            self.decoder.send_packet(&packet).unwrap();
        }

        packets_remaining
    }

    fn read_packet(&mut self) -> (Option<FFPacket>, bool) {
        let mut packet = FFPacket::empty();

        match packet.read(&mut self.input_ctx) {
            Ok(_) => (Some(packet), true),
            Err(FFError::Eof) => (None, false),
            Err(_) => {
                // TODO: What to do with other errors here? The ffmpeg wrapper ignores them and keeps looping
                (None, true)
            }
        }
    }

    fn process_frames(&mut self, output: &Sender<FFAudio>) -> usize {
        let mut decoded_frame = FFAudio::empty();
        let mut processed_frames = 0;

        while self.decoder.receive_frame(&mut decoded_frame).is_ok() {
            let timestamp = decoded_frame.timestamp();
            decoded_frame.set_pts(timestamp);
            output.send(decoded_frame).unwrap();

            decoded_frame = FFAudio::empty();
            processed_frames += 1;
        }

        processed_frames
    }
}

impl PipelineSourceTask for AudioFileSource {
    type Output = FFAudio;

    type Clock = RecordedClock;

    fn run(
        &mut self,
        clock: Self::Clock,
        ready_signal: crate::pipeline::task::PipelineReadySignal,
        mut control_signal: crate::pipeline::control::PipelineControlSignal,
        output: Sender<Self::Output>,
    ) {
        println!("Preparing audio file decoding thread...");

        let mut paused = true;
        let mut packets_remaining = true;
        let mut decoding_complete = false;
        ready_signal.send(Ok(())).unwrap();

        loop {
            match control_signal.blocking_last_if(decoding_complete) {
                Some(Control::Play) => {
                    let old_packets_remaining = packets_remaining;

                    if paused {
                        packets_remaining = self.set_playhead(clock.playhead_ratio());
                        paused = false;
                    } else if packets_remaining {
                        packets_remaining = self.queue_packet();
                    }

                    if old_packets_remaining && !packets_remaining {
                        self.decoder.send_eof().unwrap();
                    }
                    let processed_frames = self.process_frames(&output);
                    decoding_complete = processed_frames == 0 && !packets_remaining;
                }
                Some(Control::Pause) => {
                    println!("Received pause signal");
                    paused = true;
                }
                Some(Control::Shutdown) | None => {
                    println!("Received shutdown signal");
                    break;
                }
            }
        }
    }
}
