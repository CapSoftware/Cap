use cpal::*;

pub trait DataExt {
	fn as_ffmepg(&self) -> ffmpeg::frame::Audio;
}

impl DataExt for Data {
	fn as_ffmepg(&self) -> ffmpeg::Frame::Audio {

	}
}
