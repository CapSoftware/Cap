use ffmpeg::{format, frame};
use std::{path::PathBuf, time::Duration};

use crate::audio::opus::{OpusEncoder, OpusEncoderError};

pub struct OggFile {
    encoder: OpusEncoder,
    output: format::context::Output,
    finished: bool,
}

#[derive(thiserror::Error, Debug)]
pub enum FinishError {
    #[error("Already finished")]
    AlreadyFinished,
    #[error("{0}")]
    WriteTrailerFailed(ffmpeg::Error),
}

impl OggFile {
    pub fn init(
        mut output: PathBuf,
        encoder: impl FnOnce(&mut format::context::Output) -> Result<OpusEncoder, OpusEncoderError>,
    ) -> Result<Self, Box<dyn std::error::Error>> {
        output.set_extension("ogg");
        let mut output = format::output(&output)?;

        let encoder = encoder(&mut output)?;

        // make sure this happens after adding all encoders!
        output.write_header()?;

        Ok(Self {
            encoder,
            output,
            finished: false,
        })
    }

    pub fn encoder(&self) -> &OpusEncoder {
        &self.encoder
    }

    pub fn queue_frame(
        &mut self,
        frame: frame::Audio,
        timestamp: Duration,
    ) -> Result<(), ffmpeg::Error> {
        self.encoder.queue_frame(frame, timestamp, &mut self.output)
    }

    pub fn finish(&mut self) -> Result<Result<(), ffmpeg::Error>, FinishError> {
        if self.finished {
            return Err(FinishError::AlreadyFinished);
        }

        self.finished = true;

        let flush_result = self.encoder.flush(&mut self.output);
        self.output
            .write_trailer()
            .map_err(FinishError::WriteTrailerFailed)?;

        Ok(flush_result)
    }
}

impl Drop for OggFile {
    fn drop(&mut self) {
        let _ = self.finish();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio::opus::OpusEncoder;
    use cap_media_info::AudioInfo;
    use ffmpeg::ChannelLayout;

    fn write_recording(path: std::path::PathBuf, input_rate: u32, total_samples: usize) {
        let info = AudioInfo::new_raw(
            format::Sample::F32(format::sample::Type::Packed),
            input_rate,
            1,
        );

        let mut file = OggFile::init(path, OpusEncoder::factory(info)).unwrap();

        let chunk = 1024usize;
        let mut written = 0usize;
        while written < total_samples {
            let samples = chunk.min(total_samples - written);
            let mut frame = ffmpeg::frame::Audio::new(
                format::Sample::F32(format::sample::Type::Packed),
                samples,
                ChannelLayout::MONO,
            );
            frame.set_rate(input_rate);
            frame.set_pts(Some(written as i64));
            for (i, value) in frame.data_mut(0)[..samples * 4]
                .chunks_exact_mut(4)
                .enumerate()
            {
                let t = (written + i) as f32 / input_rate as f32;
                value.copy_from_slice(&(0.5 * (t * 440.0 * std::f32::consts::TAU).sin()).to_ne_bytes());
            }

            let timestamp = Duration::from_secs_f64(written as f64 / input_rate as f64);
            file.queue_frame(frame, timestamp).unwrap();
            written += samples;
        }

        file.finish().unwrap().unwrap();
    }

    fn probed_duration_secs(path: &std::path::Path) -> f64 {
        let input = format::input(path).expect("output should be openable");
        input.duration() as f64 / f64::from(ffmpeg::ffi::AV_TIME_BASE)
    }

    #[test]
    fn sustained_96k_input_produces_playable_file() {
        // Mirrors the studio mic path for a 96kHz built-in mic: resampled to
        // 48k opus. A multi-second stream must land on disk with the right
        // duration (github.com/CapSoftware/Cap/issues/2069 claimed it stays
        // 0 bytes).
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("audio-input.ogg");

        write_recording(path.clone(), 96_000, 96_000 * 5);

        let size = std::fs::metadata(&path).unwrap().len();
        assert!(size > 10_000, "5s of opus should be well over 10kB: {size}");

        let duration = probed_duration_secs(&path);
        assert!(
            (duration - 5.0).abs() < 0.2,
            "expected ~5s of audio, probed {duration}s"
        );
    }

    #[test]
    fn sub_frame_input_is_flushed_not_dropped() {
        // Less input than one opus frame (20ms): finish() must drain the
        // resampler remainder instead of dropping it.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("audio-input.ogg");

        write_recording(path.clone(), 48_000, 480);

        let duration = probed_duration_secs(&path);
        assert!(
            duration > 0.0,
            "sub-frame audio should still be encoded, probed {duration}s"
        );
    }

    #[test]
    fn zero_frames_still_writes_container_header() {
        // A track that never received a frame must not leave a 0-byte file:
        // the container header alone keeps the file structurally valid.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("audio-input.ogg");

        let info = AudioInfo::new_raw(
            format::Sample::F32(format::sample::Type::Packed),
            48_000,
            1,
        );
        let mut file = OggFile::init(path.clone(), OpusEncoder::factory(info)).unwrap();
        file.finish().unwrap().unwrap();

        let size = std::fs::metadata(&path).unwrap().len();
        assert!(size > 0, "even an empty track should have header pages");
    }
}
