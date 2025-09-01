use ffmpeg::{
    codec as avcodec,
    format::{self as avformat, context::input::PacketIter},
    frame as avframe,
    sys::{AVHWDeviceType, EAGAIN},
    util as avutil,
};
use ffmpeg_hw_device::{CodecContextExt, HwDevice};
use std::path::PathBuf;
use tracing::debug;

pub struct FFmpegDecoder {
    input: avformat::context::Input,
    decoder: avcodec::decoder::Video,
    stream_index: usize,
    hw_device: Option<HwDevice>,
    start_time: i64,
}

impl FFmpegDecoder {
    pub fn new(
        path: impl Into<PathBuf>,
        hw_device_type: Option<AVHWDeviceType>,
    ) -> Result<Self, String> {
        fn inner(
            path: PathBuf,
            hw_device_type: Option<AVHWDeviceType>,
        ) -> Result<FFmpegDecoder, String> {
            let input = ffmpeg::format::input(&path).map_err(|e| format!("open file / {e}"))?;

            let input_stream = input
                .streams()
                .best(avutil::media::Type::Video)
                .ok_or_else(|| "no video stream".to_string())?;

            let start_time = input_stream.start_time();

            let stream_index = input_stream.index();

            let mut decoder = avcodec::Context::from_parameters(input_stream.parameters())
                .map_err(|e| format!("decoder context / {e}"))?
                .decoder()
                .video()
                .map_err(|e| format!("video decoder / {e}"))?;

            decoder.set_time_base(input_stream.time_base());

            let width = decoder.width();
            let height = decoder.height();

            let exceeds_common_hw_limits = width > 4096 || height > 4096;

            let hw_device = hw_device_type
                .and_then(|_| {
		                if exceeds_common_hw_limits{
				                debug!("Video dimensions {width}x{height} exceed common hardware decoder limits (4096x4096), not using hardware acceleration");
				                None
		                } else {
			               		None
		                }
                })
                .and_then(|hw_device_type| decoder.try_use_hw_device(hw_device_type).ok());

            Ok(FFmpegDecoder {
                input,
                decoder,
                stream_index,
                hw_device,
                start_time,
            })
        }

        inner(path.into(), hw_device_type)
    }

    pub fn reset(&mut self, requested_time: f32) -> Result<(), ffmpeg::Error> {
        use ffmpeg::rescale;
        let timestamp_us = (requested_time * 1_000_000.0) as i64;
        let position = rescale::Rescale::rescale(&timestamp_us, (1, 1_000_000), rescale::TIME_BASE);

        self.decoder.flush();
        self.input.seek(position, ..position)
    }

    pub fn frames(&mut self) -> FramesIter<'_> {
        FramesIter {
            packets: self.input.packets(),
            decoder: &mut self.decoder,
            stream_index: self.stream_index,
            hw_device: self.hw_device.as_mut(),
        }
    }

    pub fn decoder(&self) -> &avcodec::decoder::Video {
        &self.decoder
    }

    pub fn start_time(&self) -> i64 {
        self.start_time
    }
}

unsafe impl Send for FFmpegDecoder {}

pub struct FramesIter<'a> {
    decoder: &'a mut avcodec::decoder::Video,
    packets: PacketIter<'a>,
    stream_index: usize,
    hw_device: Option<&'a mut HwDevice>,
}

impl FramesIter<'_> {
    pub fn decoder(&self) -> &avcodec::decoder::Video {
        self.decoder
    }
}

impl<'a> Iterator for FramesIter<'a> {
    type Item = Result<avframe::Video, avutil::error::Error>;

    fn next(&mut self) -> Option<Self::Item> {
        let mut frame = avframe::Video::empty();

        loop {
            match self.decoder.receive_frame(&mut frame) {
                Ok(()) => {
                    return match &self.hw_device {
                        Some(hw_device) => Some(Ok(hw_device.get_hwframe(&frame).unwrap_or(frame))),
                        None => Some(Ok(frame)),
                    };
                }
                Err(ffmpeg::Error::Eof) => return None,
                Err(ffmpeg::Error::Other { errno }) if errno == EAGAIN => {}
                Err(e) => return Some(Err(e)),
            }

            let (stream, packet) = self.packets.next()?;

            if stream.index() != self.stream_index {
                continue;
            };

            match self.decoder.send_packet(&packet) {
                Ok(_) => {}
                Err(ffmpeg::Error::Eof) => return None,
                Err(ffmpeg::Error::Other { errno }) if errno == EAGAIN => {}
                Err(e) => return Some(Err(e)),
            }
        }
    }
}
