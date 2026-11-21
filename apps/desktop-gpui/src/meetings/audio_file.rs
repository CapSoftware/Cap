use std::path::{Path, PathBuf};

use ffmpeg::{
    ChannelLayout, Packet, Rational,
    codec::{context, encoder},
    format::{self, Sample, sample::Type},
    frame,
};

use super::timeline::RATE;

const BIT_RATE: usize = 24_000;
const FLUSH_EVERY_SAMPLES: u64 = RATE as u64 * 2;

/// Meeting audio is readable by its owner only. The file is made owner-only
/// before ffmpeg opens it, so ffmpeg's truncating open keeps that mode, and
/// its folder is closed to other users too.
#[cfg(unix)]
fn keep_private(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::{OpenOptionsExt as _, PermissionsExt as _};
    if let Some(parent) = path.parent() {
        std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| e.to_string())?;
    }
    std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)
        .map_err(|e| e.to_string())?;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
        .map_err(|e| e.to_string())
}

#[cfg(not(unix))]
fn keep_private(_path: &Path) -> Result<(), String> {
    Ok(())
}

pub struct OpusOggWriter {
    path: PathBuf,
    output: format::context::Output,
    encoder: encoder::Audio,
    frame_size: usize,
    pending: Vec<f32>,
    pts: i64,
    written: u64,
    unflushed: u64,
    packet: Packet,
    finished: bool,
}

impl OpusOggWriter {
    pub fn create(path: &Path) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        keep_private(path)?;
        let mut output = format::output_as(&path, "ogg").map_err(|e| e.to_string())?;
        let codec = encoder::find_by_name("libopus").ok_or("libopus is unavailable")?;
        let mut audio = context::Context::new_with_codec(codec)
            .encoder()
            .audio()
            .map_err(|e| e.to_string())?;
        audio.set_rate(RATE as i32);
        audio.set_format(Sample::F32(Type::Packed));
        audio.set_channel_layout(ChannelLayout::MONO);
        audio.set_bit_rate(BIT_RATE);
        audio.set_time_base(Rational(1, RATE as i32));
        let encoder = audio.open().map_err(|e| e.to_string())?;
        let mut stream = output.add_stream(codec).map_err(|e| e.to_string())?;
        stream.set_time_base(Rational(1, RATE as i32));
        stream.set_parameters(&encoder);
        output.write_header().map_err(|e| e.to_string())?;
        let frame_size = (encoder.frame_size() as usize).max(1);
        let mut writer = Self {
            path: path.to_path_buf(),
            output,
            encoder,
            frame_size,
            pending: Vec::with_capacity(frame_size * 2),
            pts: 0,
            written: 0,
            unflushed: 0,
            packet: Packet::empty(),
            finished: false,
        };
        writer.flush_io();
        Ok(writer)
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn duration_ms(&self) -> u64 {
        super::timeline::samples_to_ms(self.written)
    }

    pub fn write_silence(&mut self, samples: u64) -> Result<(), String> {
        const BLOCK: [f32; 1600] = [0.0; 1600];
        let mut remaining = samples;
        while remaining > 0 {
            let n = remaining.min(BLOCK.len() as u64) as usize;
            self.write(&BLOCK[..n])?;
            remaining -= n as u64;
        }
        Ok(())
    }

    pub fn write(&mut self, samples: &[f32]) -> Result<(), String> {
        if self.finished {
            return Ok(());
        }
        self.written += samples.len() as u64;
        self.unflushed += samples.len() as u64;
        let mut rest = samples;
        while !rest.is_empty() {
            let take = (self.frame_size - self.pending.len()).min(rest.len());
            self.pending.extend_from_slice(&rest[..take]);
            rest = &rest[take..];
            if self.pending.len() == self.frame_size {
                self.encode_pending()?;
            }
        }
        if self.unflushed >= FLUSH_EVERY_SAMPLES {
            self.unflushed = 0;
            self.flush_io();
        }
        Ok(())
    }

    pub fn finish(&mut self) -> Result<(), String> {
        if self.finished {
            return Ok(());
        }
        self.finished = true;
        if !self.pending.is_empty() {
            self.encode_pending()?;
        }
        self.encoder.send_eof().map_err(|e| e.to_string())?;
        self.drain()?;
        self.output.write_trailer().map_err(|e| e.to_string())?;
        self.flush_io();
        Ok(())
    }

    fn encode_pending(&mut self) -> Result<(), String> {
        let count = self.pending.len();
        let mut audio = frame::Audio::new(Sample::F32(Type::Packed), count, ChannelLayout::MONO);
        audio.set_rate(RATE);
        audio.set_pts(Some(self.pts));
        let bytes = audio.data_mut(0);
        for (slot, sample) in bytes.as_chunks_mut::<4>().0.iter_mut().zip(&self.pending) {
            slot.copy_from_slice(&sample.to_ne_bytes());
        }
        self.pts += count as i64;
        self.pending.clear();
        self.encoder.send_frame(&audio).map_err(|e| e.to_string())?;
        self.drain()
    }

    fn drain(&mut self) -> Result<(), String> {
        let stream_base = self
            .output
            .stream(0)
            .map(|s| s.time_base())
            .unwrap_or(Rational(1, RATE as i32));
        loop {
            match self.encoder.receive_packet(&mut self.packet) {
                Ok(()) => {
                    self.packet.set_stream(0);
                    self.packet
                        .rescale_ts(self.encoder.time_base(), stream_base);
                    self.packet
                        .write_interleaved(&mut self.output)
                        .map_err(|e| e.to_string())?;
                }
                Err(ffmpeg::Error::Eof) => return Ok(()),
                Err(ffmpeg::Error::Other { errno }) if errno == ffmpeg::error::EAGAIN => {
                    return Ok(());
                }
                Err(error) => return Err(error.to_string()),
            }
        }
    }

    fn flush_io(&mut self) {
        unsafe {
            let context = self.output.as_mut_ptr();
            if !context.is_null() && !(*context).pb.is_null() {
                ffmpeg::ffi::avio_flush((*context).pb);
            }
        }
    }
}

impl Drop for OpusOggWriter {
    fn drop(&mut self) {
        if let Err(error) = self.finish() {
            tracing::warn!(%error, path = %self.path.display(), "meeting audio did not finish cleanly");
        }
    }
}

/// Reads a saved track back as the meeting heard it: 16 kHz mono, sample 0
/// being the first sample written. Reads go forward; an earlier start opens
/// the file again. A file still being written reads to its last whole page.
pub struct TrackReader {
    path: PathBuf,
    input: format::context::Input,
    decoder: ffmpeg::decoder::Audio,
    stream: usize,
    resampler: Option<cap_meeting_platform::resample::SpeechResampler>,
    frame: frame::Audio,
    mono: Vec<f32>,
    /// Decoded samples from `position` on.
    buffer: Vec<f32>,
    position: u64,
    ended: bool,
}

impl TrackReader {
    pub fn open(path: &Path) -> Result<Self, String> {
        let input = format::input(&path).map_err(|e| e.to_string())?;
        let stream = input
            .streams()
            .best(ffmpeg::media::Type::Audio)
            .ok_or("the meeting audio has no audio stream")?;
        let index = stream.index();
        let decoder = context::Context::from_parameters(stream.parameters())
            .and_then(|c| c.decoder().audio())
            .map_err(|e| e.to_string())?;
        Ok(Self {
            path: path.to_path_buf(),
            input,
            decoder,
            stream: index,
            resampler: None,
            frame: frame::Audio::empty(),
            mono: Vec::new(),
            buffer: Vec::new(),
            position: 0,
            ended: false,
        })
    }

    /// `len` samples from `start`, shorter when the file ends first.
    pub fn read(&mut self, start: u64, len: u64) -> Result<Vec<f32>, String> {
        if start < self.position {
            *self = Self::open(&self.path)?;
        }
        let end = start + len;
        while self.position + (self.buffer.len() as u64) < end && !self.ended {
            self.decode_more()?;
            // Keep only what a later read can still ask for.
            let behind = start.saturating_sub(self.position).min(self.buffer.len() as u64);
            if behind > 0 {
                self.buffer.drain(..behind as usize);
                self.position += behind;
            }
        }
        let from = start.saturating_sub(self.position) as usize;
        let to = (end.saturating_sub(self.position) as usize).min(self.buffer.len());
        Ok(self.buffer.get(from..to).map(<[f32]>::to_vec).unwrap_or_default())
    }

    fn decode_more(&mut self) -> Result<(), String> {
        let mut packet = Packet::empty();
        loop {
            match packet.read(&mut self.input) {
                Ok(()) if packet.stream() == self.stream => {
                    if self.decoder.send_packet(&packet).is_err() {
                        continue;
                    }
                    self.receive();
                    return Ok(());
                }
                Ok(()) => {}
                Err(ffmpeg::Error::Eof) => {
                    let _ = self.decoder.send_eof();
                    self.receive();
                    if let Some(resampler) = self.resampler.as_mut() {
                        resampler.flush(&mut self.buffer);
                    }
                    self.ended = true;
                    return Ok(());
                }
                // A torn last page (the app stopped mid-write) ends the file.
                Err(_) => {
                    self.ended = true;
                    return Ok(());
                }
            }
        }
    }

    fn receive(&mut self) {
        while self.decoder.receive_frame(&mut self.frame).is_ok() {
            let rate = self.frame.rate().max(1);
            let samples = self.frame.samples();
            self.mono.clear();
            let data = self.frame.data(0);
            match self.frame.format() {
                Sample::F32(_) => self.mono.extend(
                    data.as_chunks::<4>().0.iter().take(samples).map(|b| f32::from_ne_bytes(*b)),
                ),
                Sample::I16(_) => self.mono.extend(
                    data.as_chunks::<2>()
                        .0
                        .iter()
                        .take(samples)
                        .map(|b| f32::from(i16::from_ne_bytes(*b)) / 32_768.0),
                ),
                _ => continue,
            }
            let resampler = self
                .resampler
                .get_or_insert_with(|| cap_meeting_platform::resample::SpeechResampler::new(rate));
            resampler.process(&self.mono, &mut self.buffer);
        }
    }
}

pub fn probe_duration_ms(path: &Path) -> Option<u64> {
    let input = format::input(&path).ok()?;
    let duration = input.duration();
    (duration > 0)
        .then(|| (duration as u64).saturating_mul(1000) / ffmpeg::ffi::AV_TIME_BASE as u64)
}
