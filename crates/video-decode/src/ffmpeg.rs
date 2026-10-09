use ffmpeg::{
    codec as avcodec,
    format::{self as avformat, context::input::PacketIter},
    frame as avframe,
    sys::{AVHWDeviceType, EAGAIN},
    util as avutil,
};
use ffmpeg_hw_device::{CodecContextExt, HwDevice};
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use tracing::*;

#[derive(Debug, Clone)]
pub struct HwDecoderCapabilities {
    pub max_width: u32,
    pub max_height: u32,
    pub supports_hw_decode: bool,
}

impl Default for HwDecoderCapabilities {
    fn default() -> Self {
        Self {
            max_width: 8192,
            max_height: 8192,
            supports_hw_decode: true,
        }
    }
}

static HW_CAPABILITIES: OnceLock<HwDecoderCapabilities> = OnceLock::new();

#[cfg(target_os = "windows")]
fn query_d3d11_video_decoder_capabilities() -> HwDecoderCapabilities {
    use windows::{
        Win32::{
            Foundation::HMODULE,
            Graphics::{
                Direct3D::D3D_DRIVER_TYPE_UNKNOWN,
                Direct3D11::{
                    D3D11_CREATE_DEVICE_VIDEO_SUPPORT, D3D11_DECODER_PROFILE_H264_VLD_NOFGT,
                    D3D11_DECODER_PROFILE_HEVC_VLD_MAIN, D3D11_SDK_VERSION,
                    D3D11_VIDEO_DECODER_DESC, D3D11CreateDevice, ID3D11VideoDevice,
                },
                Dxgi::Common::DXGI_FORMAT_NV12,
            },
        },
        core::Interface,
    };

    let result: Result<HwDecoderCapabilities, String> = (|| {
        let selected = cap_d3d_adapter::select_capture_adapter(None)?;

        let mut device = None;
        unsafe {
            D3D11CreateDevice(
                Some(&selected.adapter),
                D3D_DRIVER_TYPE_UNKNOWN,
                HMODULE::default(),
                D3D11_CREATE_DEVICE_VIDEO_SUPPORT,
                None,
                D3D11_SDK_VERSION,
                Some(&mut device),
                None,
                None,
            )
            .map_err(|e| {
                format!(
                    "D3D11CreateDevice failed on '{}': {e:?}",
                    selected.description
                )
            })?;
        }

        let device = device.ok_or("D3D11CreateDevice returned null")?;

        let video_device: ID3D11VideoDevice = device
            .cast()
            .map_err(|e| format!("Failed to get ID3D11VideoDevice: {e:?}"))?;

        let profiles = [
            D3D11_DECODER_PROFILE_H264_VLD_NOFGT,
            D3D11_DECODER_PROFILE_HEVC_VLD_MAIN,
        ];

        let mut max_width = 4096u32;
        let mut max_height = 4096u32;
        let mut supports_hw = false;

        for profile in &profiles {
            let desc = D3D11_VIDEO_DECODER_DESC {
                Guid: *profile,
                SampleWidth: 8192,
                SampleHeight: 8192,
                OutputFormat: DXGI_FORMAT_NV12,
            };

            if let Ok(config_count) = unsafe { video_device.GetVideoDecoderConfigCount(&desc) } {
                if config_count > 0 {
                    supports_hw = true;
                    max_width = max_width.max(8192);
                    max_height = max_height.max(8192);
                }
            } else {
                let desc_4k = D3D11_VIDEO_DECODER_DESC {
                    Guid: *profile,
                    SampleWidth: 4096,
                    SampleHeight: 4096,
                    OutputFormat: DXGI_FORMAT_NV12,
                };

                if let Ok(config_count) =
                    unsafe { video_device.GetVideoDecoderConfigCount(&desc_4k) }
                    && config_count > 0
                {
                    supports_hw = true;
                }
            }
        }

        Ok(HwDecoderCapabilities {
            max_width,
            max_height,
            supports_hw_decode: supports_hw,
        })
    })();

    match result {
        Ok(caps) => {
            info!(
                "D3D11 video decoder capabilities: {}x{}, hw_decode={}",
                caps.max_width, caps.max_height, caps.supports_hw_decode
            );
            caps
        }
        Err(e) => {
            warn!("Failed to query D3D11 video decoder capabilities: {e}, using defaults");
            HwDecoderCapabilities::default()
        }
    }
}

#[cfg(not(target_os = "windows"))]
fn query_d3d11_video_decoder_capabilities() -> HwDecoderCapabilities {
    HwDecoderCapabilities::default()
}

pub fn get_hw_decoder_capabilities() -> &'static HwDecoderCapabilities {
    HW_CAPABILITIES.get_or_init(query_d3d11_video_decoder_capabilities)
}

fn configure_software_threading(decoder: &mut avcodec::decoder::Video, width: u32, height: u32) {
    let pixel_count = (width as u64) * (height as u64);
    let cpu_count = num_cpus::get();

    let thread_count = if pixel_count > 8294400 {
        0
    } else if pixel_count > 2073600 {
        cpu_count.clamp(2, 8) as i32
    } else {
        cpu_count.clamp(2, 6) as i32
    };

    let thread_type = ffmpeg::sys::FF_THREAD_FRAME | ffmpeg::sys::FF_THREAD_SLICE;

    unsafe {
        let codec_ctx = decoder.as_mut_ptr();
        if !codec_ctx.is_null() {
            (*codec_ctx).thread_count = thread_count;
            (*codec_ctx).thread_type = thread_type;
        }
    }

    info!(
        "Software decode configured: {width}x{height}, thread_count={}, thread_type=frame+slice, cpus={}",
        if thread_count == 0 {
            "auto".to_string()
        } else {
            thread_count.to_string()
        },
        cpu_count
    );
}

pub struct FFmpegDecoder {
    input: DecoderInput,
    decoder: avcodec::decoder::Video,
    stream_index: usize,
    hw_device: Option<HwDevice>,
    start_time: i64,
}

enum DecoderInput {
    File(avformat::context::Input),
    Segmented(cap_enc_ffmpeg::SegmentedInput),
}

impl DecoderInput {
    fn input(&self) -> &avformat::context::Input {
        match self {
            Self::File(input) => input,
            Self::Segmented(input) => input.input(),
        }
    }

    fn seek(&mut self, position: i64) -> Result<(), ffmpeg::Error> {
        match self {
            Self::File(input) => input.seek(position, ..position),
            Self::Segmented(input) => input.seek(position),
        }
    }

    fn packets(&mut self) -> DecoderPackets<'_> {
        match self {
            Self::File(input) => DecoderPackets::File(input.packets()),
            Self::Segmented(input) => DecoderPackets::Segmented(input),
        }
    }
}

enum DecoderPackets<'a> {
    File(PacketIter<'a>),
    Segmented(&'a mut cap_enc_ffmpeg::SegmentedInput),
}

impl Iterator for DecoderPackets<'_> {
    type Item = Result<(usize, ffmpeg::Packet), ffmpeg::Error>;

    fn next(&mut self) -> Option<Self::Item> {
        match self {
            Self::File(packets) => packets
                .next()
                .map(|(stream, packet)| Ok((stream.index(), packet))),
            Self::Segmented(input) => {
                let mut packet = ffmpeg::Packet::empty();
                match input.read_packet(&mut packet) {
                    Ok(()) => Some(Ok((packet.stream(), packet))),
                    Err(ffmpeg::Error::Eof) => None,
                    Err(error) => Some(Err(error)),
                }
            }
        }
    }
}

pub fn open_fragmented_input(
    dir_path: &std::path::Path,
) -> Result<cap_enc_ffmpeg::SegmentedInput, String> {
    let init_segment = dir_path.join("init.mp4");
    if !init_segment.exists() {
        return Err(format!(
            "init.mp4 not found in fragmented directory: {}",
            dir_path.display()
        ));
    }
    let mut fragments = std::fs::read_dir(dir_path)
        .map_err(|error| format!("read fragmented directory / {error}"))?
        .map(|entry| entry.map(|entry| entry.path()))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("read fragmented directory / {error}"))?;
    fragments.retain(|path| path.extension().is_some_and(|extension| extension == "m4s"));
    fragments.sort();
    if fragments.is_empty() {
        return Err(format!(
            "no .m4s segments found in fragmented directory: {}",
            dir_path.display()
        ));
    }
    cap_enc_ffmpeg::SegmentedInput::open(
        std::iter::once(init_segment.as_path()).chain(fragments.iter().map(PathBuf::as_path)),
    )
    .map_err(|error| format!("open fragmented video / {error}"))
}

impl FFmpegDecoder {
    pub fn new(
        path: impl Into<PathBuf>,
        hw_device_type: Option<AVHWDeviceType>,
    ) -> Result<Self, String> {
        let path = path.into();

        let input = if path.is_dir() {
            DecoderInput::Segmented(open_fragmented_input(&path)?)
        } else {
            DecoderInput::File(
                ffmpeg::format::input(&path).map_err(|e| format!("open file / {e}"))?,
            )
        };

        Self::from_input(input, hw_device_type)
    }

    pub fn new_relocatable<'a>(
        source: &cap_enc_ffmpeg::RelocatableSource,
        paths: impl IntoIterator<Item = &'a Path>,
        hw_device_type: Option<AVHWDeviceType>,
    ) -> Result<Self, String> {
        let input = cap_enc_ffmpeg::SegmentedInput::open_relocatable(source, paths)
            .map_err(|error| format!("open relocatable video / {error}"))?;
        Self::from_input(DecoderInput::Segmented(input), hw_device_type)
    }

    pub fn new_relocatable_interruptible<'a>(
        source: &cap_enc_ffmpeg::RelocatableSource,
        paths: impl IntoIterator<Item = &'a Path>,
        hw_device_type: Option<AVHWDeviceType>,
        interrupt: Arc<dyn Fn() -> bool + Send + Sync>,
    ) -> Result<Self, String> {
        let input = cap_enc_ffmpeg::SegmentedInput::open_relocatable_interruptible(
            source, paths, interrupt,
        )
        .map_err(|error| format!("open relocatable video / {error}"))?;
        Self::from_input(DecoderInput::Segmented(input), hw_device_type)
    }

    fn from_input(
        input: DecoderInput,
        hw_device_type: Option<AVHWDeviceType>,
    ) -> Result<Self, String> {
        let input_stream = input
            .input()
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

        let hw_caps = get_hw_decoder_capabilities();
        let exceeds_hw_limits =
            width > hw_caps.max_width || height > hw_caps.max_height || !hw_caps.supports_hw_decode;

        let hw_device = hw_device_type.and_then(|hw_device_type| {
            if exceeds_hw_limits {
                warn!(
                    "Video dimensions {width}x{height} exceed hardware decoder limits ({}x{}), using software decode",
                    hw_caps.max_width, hw_caps.max_height
                );
                configure_software_threading(&mut decoder, width, height);
                None
            } else {
                match decoder.try_use_hw_device(hw_device_type) {
                    Ok(device) => {
                        info!(
                            "Using hardware acceleration for {width}x{height} video (device: {:?})",
                            hw_device_type
                        );
                        Some(device)
                    }
                    Err(error) => {
                        warn!("Failed to enable hardware decoder: {error:?}, falling back to optimized software decode");
                        configure_software_threading(&mut decoder, width, height);
                        None
                    }
                }
            }
        });

        if hw_device.is_none() && hw_device_type.is_none() {
            configure_software_threading(&mut decoder, width, height);
        }

        Ok(FFmpegDecoder {
            input,
            decoder,
            stream_index,
            hw_device,
            start_time,
        })
    }

    pub fn reset(&mut self, requested_time: f32) -> Result<(), ffmpeg::Error> {
        use ffmpeg::rescale;
        let timestamp_us = (requested_time * 1_000_000.0) as i64;
        let position = rescale::Rescale::rescale(&timestamp_us, (1, 1_000_000), rescale::TIME_BASE);

        self.decoder.flush();
        self.input.seek(position)
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

    pub fn is_hardware_accelerated(&self) -> bool {
        self.hw_device.is_some()
    }
}

unsafe impl Send for FFmpegDecoder {}

pub struct FramesIter<'a> {
    decoder: &'a mut avcodec::decoder::Video,
    packets: DecoderPackets<'a>,
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
                        Some(hw_device) => {
                            let hw_result = hw_device.get_hwframe(&frame);
                            Some(Ok(hw_result.unwrap_or(frame)))
                        }
                        None => Some(Ok(frame)),
                    };
                }
                Err(ffmpeg::Error::Eof) => {
                    return None;
                }
                Err(ffmpeg::Error::Other { errno }) if errno == EAGAIN => {}
                Err(e) => return Some(Err(e)),
            }

            let (stream_index, packet) = match self.packets.next()? {
                Ok(packet) => packet,
                Err(error) => return Some(Err(error)),
            };

            if stream_index != self.stream_index {
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

#[cfg(test)]
mod tests {
    use super::*;
    use cap_enc_ffmpeg::segmented_stream::{SegmentedVideoEncoder, SegmentedVideoEncoderConfig};
    use std::{fs::File, time::Duration};

    fn encode_segments(directory: &std::path::Path) {
        ffmpeg::init().unwrap();
        let mut encoder = SegmentedVideoEncoder::init(
            directory.to_path_buf(),
            cap_media_info::VideoInfo {
                pixel_format: cap_media_info::Pixel::NV12,
                width: 160,
                height: 120,
                time_base: ffmpeg::Rational(1, 1_000_000),
                frame_rate: ffmpeg::Rational(30, 1),
            },
            SegmentedVideoEncoderConfig::default(),
        )
        .unwrap();
        for index in 0..120 {
            let mut frame = avframe::Video::new(avformat::Pixel::NV12, 160, 120);
            frame.data_mut(0).fill(32 + (index % 192) as u8);
            frame.data_mut(1).fill(128);
            encoder
                .queue_frame(frame, Duration::from_micros(index * 1_000_000 / 30))
                .unwrap();
        }
        encoder.finish().unwrap();
        assert!(encoder.completed_segments().len() >= 2);
    }

    fn frame_data(frame: avframe::Video) -> (Option<i64>, Vec<u8>) {
        assert_eq!(frame.format(), avformat::Pixel::YUV420P);
        let mut bytes = Vec::new();
        for plane in 0..frame.planes() {
            for row in frame
                .data(plane)
                .chunks(frame.stride(plane))
                .take(frame.plane_height(plane) as usize)
            {
                bytes.extend_from_slice(&row[..frame.plane_width(plane) as usize]);
            }
        }
        (frame.timestamp().or_else(|| frame.pts()), bytes)
    }

    fn frames(decoder: &mut FFmpegDecoder) -> Vec<(Option<i64>, Vec<u8>)> {
        decoder
            .frames()
            .map(|frame| frame_data(frame.unwrap()))
            .collect()
    }

    #[test]
    fn fragmented_decoder_matches_combined_file_for_full_playback_and_seeks() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("segments");
        encode_segments(&source);
        let combined = directory.path().join("combined.mp4");
        let mut output = File::create(&combined).unwrap();
        std::io::copy(
            &mut File::open(source.join("init.mp4")).unwrap(),
            &mut output,
        )
        .unwrap();
        let mut paths = std::fs::read_dir(&source)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .filter(|path| path.extension().is_some_and(|extension| extension == "m4s"))
            .collect::<Vec<_>>();
        paths.sort();
        for path in paths {
            std::io::copy(&mut File::open(path).unwrap(), &mut output).unwrap();
        }
        drop(output);
        let mut reference = FFmpegDecoder::new(combined, None).unwrap();
        let mut candidate = FFmpegDecoder::new(source, None).unwrap();
        assert_eq!(reference.start_time(), candidate.start_time());
        let expected = frames(&mut reference);
        assert!(!expected.is_empty());
        assert_eq!(frames(&mut candidate), expected);
        for time in [1.5, 0.0, 3.0, 0.5] {
            reference.reset(time).unwrap();
            candidate.reset(time).unwrap();
            let expected = frames(&mut reference);
            assert!(!expected.is_empty());
            assert_eq!(frames(&mut candidate), expected);
        }
    }

    #[test]
    fn relocatable_decoder_preserves_live_frames_and_seeks_after_publication() {
        let directory = tempfile::tempdir().unwrap();
        let original = directory.path().join("original");
        let retained = directory.path().join("retained");
        encode_segments(&original);
        let mut paths = std::fs::read_dir(&original)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into())
            .filter(|path: &PathBuf| path.extension().is_some_and(|extension| extension == "m4s"))
            .collect::<Vec<PathBuf>>();
        paths.sort();
        paths.insert(0, PathBuf::from("init.mp4"));
        let mut reference = FFmpegDecoder::new(&original, None).unwrap();
        let expected = frames(&mut reference);
        let mut seek_reference = Vec::new();
        for time in [1.5, 0.0, 3.0, 0.5] {
            reference.reset(time).unwrap();
            seek_reference.push(frames(&mut reference));
        }
        let expected_start = reference.start_time();
        drop(reference);

        let source = cap_enc_ffmpeg::RelocatableSource::new(original.clone()).unwrap();
        let mut candidate =
            FFmpegDecoder::new_relocatable(&source, paths.iter().map(PathBuf::as_path), None)
                .unwrap();
        assert_eq!(candidate.start_time(), expected_start);
        let mut actual = Vec::new();
        for (index, count) in [1, 17, 23, 19].into_iter().enumerate() {
            actual.extend(
                candidate
                    .frames()
                    .take(count)
                    .map(|frame| frame_data(frame.unwrap())),
            );
            assert!(
                source
                    .relocate(directory.path().join("missing/target"))
                    .is_err()
            );
            source
                .relocate(if index % 2 == 0 {
                    retained.clone()
                } else {
                    original.clone()
                })
                .unwrap();
        }
        actual.extend(frames(&mut candidate));
        assert_eq!(actual, expected);
        for (time, expected) in [1.5, 0.0, 3.0, 0.5].into_iter().zip(seek_reference) {
            source.relocate(retained.clone()).unwrap();
            candidate.reset(time).unwrap();
            source.relocate(original.clone()).unwrap();
            assert_eq!(frames(&mut candidate), expected);
        }
    }

    #[test]
    fn interruptible_video_rejects_cancel_before_registering_missing_sources() {
        let directory = tempfile::tempdir().unwrap();
        let original = directory.path().join("original");
        std::fs::create_dir(&original).unwrap();
        let source = cap_enc_ffmpeg::RelocatableSource::new(original.clone()).unwrap();
        let interrupt: Arc<dyn Fn() -> bool + Send + Sync> = Arc::new(|| true);
        let owner = Arc::downgrade(&interrupt);
        let error = FFmpegDecoder::new_relocatable_interruptible(
            &source,
            [Path::new("missing.mp4")],
            None,
            interrupt,
        )
        .err()
        .unwrap();
        assert!(error.contains("cancelled"));
        assert!(owner.upgrade().is_none());
        std::fs::rename(&original, directory.path().join("retained")).unwrap();
    }

    #[test]
    fn interruptible_video_stops_partial_registration_and_releases_ownership() {
        use std::{
            cell::Cell,
            sync::atomic::{AtomicBool, Ordering},
        };

        let directory = tempfile::tempdir().unwrap();
        let original = directory.path().join("original");
        std::fs::create_dir(&original).unwrap();
        std::fs::write(original.join("part.m4s"), b"not parsed before cancellation").unwrap();
        let source = cap_enc_ffmpeg::RelocatableSource::new(original.clone()).unwrap();
        let cancelled = Arc::new(AtomicBool::new(false));
        let callback_cancelled = cancelled.clone();
        let interrupt: Arc<dyn Fn() -> bool + Send + Sync> =
            Arc::new(move || callback_cancelled.load(Ordering::Acquire));
        let owner = Arc::downgrade(&interrupt);
        let visited = Cell::new(0);
        let paths = vec![PathBuf::from("part.m4s"); 512];
        let inputs = paths.iter().enumerate().map(|(index, path)| {
            visited.set(index + 1);
            if index == 64 {
                cancelled.store(true, Ordering::Release);
            }
            path.as_path()
        });
        let error = FFmpegDecoder::new_relocatable_interruptible(&source, inputs, None, interrupt)
            .err()
            .unwrap();
        assert!(error.contains("cancelled"));
        assert!(visited.get() > 64 && visited.get() < paths.len());
        assert!(owner.upgrade().is_none());
        std::fs::rename(&original, directory.path().join("retained")).unwrap();
    }

    #[test]
    fn interruptible_video_retains_sticky_callback_until_decoder_drop() {
        use std::sync::atomic::{AtomicBool, Ordering};

        let directory = tempfile::tempdir().unwrap();
        let original = directory.path().join("original");
        encode_segments(&original);
        let mut paths = std::fs::read_dir(&original)
            .unwrap()
            .map(|entry| PathBuf::from(entry.unwrap().file_name()))
            .filter(|path| path.extension().is_some_and(|extension| extension == "m4s"))
            .collect::<Vec<_>>();
        paths.sort();
        paths.insert(0, PathBuf::from("init.mp4"));
        let source = cap_enc_ffmpeg::RelocatableSource::new(original.clone()).unwrap();
        let cancelled = Arc::new(AtomicBool::new(false));
        let callback_cancelled = cancelled.clone();
        let interrupt: Arc<dyn Fn() -> bool + Send + Sync> =
            Arc::new(move || callback_cancelled.load(Ordering::Acquire));
        let owner = Arc::downgrade(&interrupt);
        let mut decoder = FFmpegDecoder::new_relocatable_interruptible(
            &source,
            paths.iter().map(PathBuf::as_path),
            None,
            interrupt,
        )
        .unwrap();
        assert!(owner.upgrade().is_some());
        assert!(decoder.frames().next().unwrap().is_ok());
        cancelled.store(true, Ordering::Release);
        assert_eq!(decoder.reset(0.0), Err(ffmpeg::Error::Exit));
        cancelled.store(false, Ordering::Release);
        assert_eq!(decoder.reset(0.0), Err(ffmpeg::Error::Exit));
        assert!(matches!(
            decoder.frames().next(),
            Some(Err(ffmpeg::Error::Exit))
        ));
        drop(decoder);
        assert!(owner.upgrade().is_none());
        std::fs::rename(&original, directory.path().join("retained")).unwrap();
    }

    #[test]
    fn interruptible_video_releases_callback_when_input_open_fails() {
        let directory = tempfile::tempdir().unwrap();
        let original = directory.path().join("original");
        std::fs::create_dir(&original).unwrap();
        std::fs::write(original.join("broken.mp4"), b"invalid video input").unwrap();
        let source = cap_enc_ffmpeg::RelocatableSource::new(original.clone()).unwrap();
        let interrupt: Arc<dyn Fn() -> bool + Send + Sync> = Arc::new(|| false);
        let owner = Arc::downgrade(&interrupt);
        assert!(
            FFmpegDecoder::new_relocatable_interruptible(
                &source,
                [Path::new("broken.mp4")],
                None,
                interrupt,
            )
            .is_err()
        );
        assert!(owner.upgrade().is_none());
        std::fs::rename(&original, directory.path().join("retained")).unwrap();
    }

    #[test]
    fn interruptible_video_releases_callback_when_video_setup_fails() {
        let directory = tempfile::tempdir().unwrap();
        let original = directory.path().join("original");
        std::fs::create_dir(&original).unwrap();
        let data_length = 24_000_u32;
        let mut wave = Vec::new();
        wave.extend_from_slice(b"RIFF");
        wave.extend_from_slice(&(36 + data_length).to_le_bytes());
        wave.extend_from_slice(b"WAVEfmt ");
        wave.extend_from_slice(&16_u32.to_le_bytes());
        wave.extend_from_slice(&1_u16.to_le_bytes());
        wave.extend_from_slice(&1_u16.to_le_bytes());
        wave.extend_from_slice(&48_000_u32.to_le_bytes());
        wave.extend_from_slice(&96_000_u32.to_le_bytes());
        wave.extend_from_slice(&2_u16.to_le_bytes());
        wave.extend_from_slice(&16_u16.to_le_bytes());
        wave.extend_from_slice(b"data");
        wave.extend_from_slice(&data_length.to_le_bytes());
        wave.resize(wave.len() + data_length as usize, 0);
        std::fs::write(original.join("audio.wav"), &wave).unwrap();
        let source = cap_enc_ffmpeg::RelocatableSource::new(original.clone()).unwrap();
        let interrupt: Arc<dyn Fn() -> bool + Send + Sync> = Arc::new(|| false);
        let owner = Arc::downgrade(&interrupt);
        let error = FFmpegDecoder::new_relocatable_interruptible(
            &source,
            [Path::new("audio.wav")],
            None,
            interrupt,
        )
        .err()
        .unwrap();
        assert_eq!(error, "no video stream");
        assert!(owner.upgrade().is_none());
        std::fs::rename(&original, directory.path().join("retained")).unwrap();
    }

    #[test]
    fn fragmented_input_rejects_missing_init_and_empty_segments() {
        let directory = tempfile::tempdir().unwrap();
        assert!(open_fragmented_input(directory.path()).is_err());
        std::fs::write(directory.path().join("init.mp4"), b"invalid").unwrap();
        assert!(open_fragmented_input(directory.path()).is_err());
        std::fs::create_dir(directory.path().join("segment_001.m4s")).unwrap();
        assert!(open_fragmented_input(directory.path()).is_err());
    }
}
