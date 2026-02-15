use ffmpeg::{
    codec as avcodec,
    format::{self as avformat, context::input::PacketIter},
    frame as avframe,
    sys::{AVHWDeviceType, EAGAIN},
    util as avutil,
};
use ffmpeg_hw_device::{CodecContextExt, HwDevice};
use std::path::PathBuf;
use std::sync::OnceLock;
use tempfile::NamedTempFile;
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
                Direct3D::D3D_DRIVER_TYPE_HARDWARE,
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
        let mut device = None;
        unsafe {
            D3D11CreateDevice(
                None,
                D3D_DRIVER_TYPE_HARDWARE,
                HMODULE::default(),
                D3D11_CREATE_DEVICE_VIDEO_SUPPORT,
                None,
                D3D11_SDK_VERSION,
                Some(&mut device),
                None,
                None,
            )
            .map_err(|e| format!("D3D11CreateDevice failed: {e:?}"))?;
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
        cpu_count.min(8).max(2) as i32
    } else {
        cpu_count.min(6).max(2) as i32
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
    input: avformat::context::Input,
    decoder: avcodec::decoder::Video,
    stream_index: usize,
    hw_device: Option<HwDevice>,
    start_time: i64,
    _temp_file: Option<NamedTempFile>,
}

fn combine_fragmented_segments(dir_path: &std::path::Path) -> Result<NamedTempFile, String> {
    let init_segment = dir_path.join("init.mp4");
    if !init_segment.exists() {
        return Err(format!(
            "init.mp4 not found in fragmented directory: {}",
            dir_path.display()
        ));
    }

    let mut fragments: Vec<PathBuf> = std::fs::read_dir(dir_path)
        .map_err(|e| format!("read fragmented directory / {e}"))?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|ext| ext == "m4s"))
        .collect();

    fragments.sort();

    if fragments.is_empty() {
        return Err(format!(
            "no .m4s segments found in fragmented directory: {}",
            dir_path.display()
        ));
    }

    let mut combined_data =
        std::fs::read(&init_segment).map_err(|e| format!("read init.mp4 / {e}"))?;

    for fragment in &fragments {
        let data = std::fs::read(fragment)
            .map_err(|e| format!("read fragment {} / {e}", fragment.display()))?;
        combined_data.extend(data);
    }

    let temp_file = NamedTempFile::new().map_err(|e| format!("create temp file / {e}"))?;

    std::fs::write(temp_file.path(), &combined_data)
        .map_err(|e| format!("write combined file / {e}"))?;

    info!(
        "Combined {} fragmented segments ({} bytes) into temp file: {}",
        fragments.len(),
        combined_data.len(),
        temp_file.path().display()
    );

    Ok(temp_file)
}

impl FFmpegDecoder {
    pub fn new(
        path: impl Into<PathBuf>,
        hw_device_type: Option<AVHWDeviceType>,
    ) -> Result<Self, String> {
        let path = path.into();

        let (effective_path, temp_file): (PathBuf, Option<NamedTempFile>) = if path.is_dir() {
            let temp = combine_fragmented_segments(&path)?;
            (temp.path().to_path_buf(), Some(temp))
        } else {
            (path, None)
        };

        let input =
            ffmpeg::format::input(&effective_path).map_err(|e| format!("open file / {e}"))?;

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
            _temp_file: temp_file,
        })
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

    pub fn is_hardware_accelerated(&self) -> bool {
        self.hw_device.is_some()
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
