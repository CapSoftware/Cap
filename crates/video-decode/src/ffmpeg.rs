use std::path::PathBuf;

use ffmpeg::{
    codec as avcodec,
    format::{self as avformat, context::input::PacketIter},
    frame as avframe, util as avutil,
};
use ffmpeg_hw_device::{CodecContextExt, HwDevice};
use ffmpeg_sys_next::AVHWDeviceType;

pub struct FFmpegDecoder {
    input: avformat::context::Input,
    decoder: avcodec::decoder::Video,
    stream_index: usize,
    hw_device: Option<HwDevice>,
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

            let stream_index = input_stream.index();

            let mut decoder = avcodec::Context::from_parameters(input_stream.parameters())
                .map_err(|e| format!("decoder context / {e}"))?
                .decoder()
                .video()
                .map_err(|e| format!("video decoder / {e}"))?;

            let hw_device = hw_device_type
                .and_then(|hw_device_type| decoder.try_use_hw_device(hw_device_type).ok());

            Ok(FFmpegDecoder {
                input,
                decoder,
                stream_index,
                hw_device,
            })
        }

        inner(path.into(), hw_device_type)
    }

    pub fn frames(&mut self) -> FrameIter {
        FrameIter {
            packets: self.input.packets(),
            decoder: &mut self.decoder,
            stream_index: self.stream_index,
        }
    }
}

pub struct FrameIter<'a> {
    decoder: &'a mut avcodec::decoder::Video,
    packets: PacketIter<'a>,
    stream_index: usize,
}

impl<'a> Iterator for FrameIter<'a> {
    type Item = Result<avframe::Video, String>;

    fn next(&mut self) -> Option<Result<avframe::Video, String>> {
        let mut frame = avframe::Video::empty();

        loop {
            if self.decoder.receive_frame(&mut frame).is_ok() {
                return Some(Ok(frame));
            }

            let Some((stream, packet)) = self.packets.next() else {
                return None;
            };

            if stream.index() != self.stream_index {
                continue;
            };

            let _ = self.decoder.send_packet(&packet);
        }
    }
}
