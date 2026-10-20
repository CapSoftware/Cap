use ffmpeg::{format, frame};
use std::{path::PathBuf, time::Duration};

use crate::video::prores::{ProResEncoder, ProResEncoderError};

pub struct MOVFile {
    output: format::context::Output,
    video: ProResEncoder,
    is_finished: bool,
}

#[derive(thiserror::Error, Debug)]
pub enum InitError {
    #[error("{0:?}")]
    Ffmpeg(ffmpeg::Error),
    #[error("Video/{0}")]
    VideoInit(ProResEncoderError),
}

#[derive(thiserror::Error, Debug)]
pub enum FinishError {
    #[error("Already finished")]
    AlreadyFinished,
    #[error("{0}")]
    WriteTrailerFailed(ffmpeg::Error),
}

impl MOVFile {
    pub fn init(
        mut output: PathBuf,
        video: impl FnOnce(&mut format::context::Output) -> Result<ProResEncoder, ProResEncoderError>,
    ) -> Result<Self, InitError> {
        output.set_extension("mov");

        if let Some(parent) = output.parent() {
            let _ = std::fs::create_dir_all(parent);
        }

        let mut output = format::output_as(&output, "mov").map_err(InitError::Ffmpeg)?;
        let video = video(&mut output).map_err(InitError::VideoInit)?;

        output.write_header().map_err(InitError::Ffmpeg)?;

        Ok(Self {
            output,
            video,
            is_finished: false,
        })
    }

    pub fn queue_video_frame(
        &mut self,
        frame: &mut frame::Video,
        timestamp: Duration,
    ) -> Result<(), crate::video::prores::QueueFrameError> {
        if self.is_finished {
            return Ok(());
        }

        self.video.queue_frame(frame, timestamp, &mut self.output)
    }

    pub fn finish(&mut self) -> Result<(), FinishError> {
        if self.is_finished {
            return Err(FinishError::AlreadyFinished);
        }

        self.is_finished = true;

        self.video
            .flush(&mut self.output)
            .map_err(FinishError::WriteTrailerFailed)?;
        self.output
            .write_trailer()
            .map_err(FinishError::WriteTrailerFailed)?;

        Ok(())
    }
}

impl Drop for MOVFile {
    fn drop(&mut self) {
        let _ = self.finish();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cap_media_info::{RawVideoFormat, VideoInfo};

    const WIDTH: u32 = 64;
    const HEIGHT: u32 = 48;

    fn shade(index: usize) -> u8 {
        (16 + index * 9) as u8
    }

    fn decoded_shades(path: &std::path::Path) -> Vec<u8> {
        let mut input = format::input(path).unwrap();
        let stream = input.streams().best(ffmpeg::media::Type::Video).unwrap();
        let stream_index = stream.index();
        let mut decoder = ffmpeg::codec::context::Context::from_parameters(stream.parameters())
            .unwrap()
            .decoder()
            .video()
            .unwrap();
        let mut scaler = ffmpeg::software::scaling::Context::get(
            decoder.format(),
            WIDTH,
            HEIGHT,
            format::Pixel::RGBA,
            WIDTH,
            HEIGHT,
            ffmpeg::software::scaling::Flags::POINT,
        )
        .unwrap();

        let mut shades = Vec::new();
        let mut decoded = frame::Video::empty();
        let mut rgba = frame::Video::empty();
        let mut receive = |decoder: &mut ffmpeg::decoder::Video, shades: &mut Vec<u8>| {
            while decoder.receive_frame(&mut decoded).is_ok() {
                scaler.run(&decoded, &mut rgba).unwrap();
                shades.push(rgba.data(0)[0]);
            }
        };
        for (stream, packet) in input.packets() {
            if stream.index() == stream_index {
                decoder.send_packet(&packet).unwrap();
                receive(&mut decoder, &mut shades);
            }
        }
        decoder.send_eof().unwrap();
        receive(&mut decoder, &mut shades);
        shades
    }

    #[test]
    fn every_queued_frame_is_encoded_with_its_own_pixels() {
        ffmpeg::init().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("frames.mov");
        let info = VideoInfo::from_raw(RawVideoFormat::Rgba, WIDTH, HEIGHT, 30);
        let mut mov = MOVFile::init(path.clone(), |output| {
            ProResEncoder::builder(info).build(output)
        })
        .unwrap();

        let frame_count = 24;
        let mut source = frame::Video::new(format::Pixel::RGBA, WIDTH, HEIGHT);
        for index in 0..frame_count {
            let value = shade(index);
            source.data_mut(0).fill(value);
            for pixel in source.data_mut(0).chunks_exact_mut(4) {
                pixel[3] = 255;
            }
            mov.queue_video_frame(&mut source, Duration::from_secs_f64(index as f64 / 30.0))
                .unwrap();
        }
        mov.finish().unwrap();

        let shades = decoded_shades(&path);
        assert_eq!(shades.len(), frame_count);
        for (index, actual) in shades.into_iter().enumerate() {
            let expected = shade(index);
            assert!(
                actual.abs_diff(expected) <= 2,
                "frame {index} decoded as {actual}, expected {expected}"
            );
        }
    }
}
