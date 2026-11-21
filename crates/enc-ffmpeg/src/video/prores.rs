use std::{thread, time::Duration};

use cap_media_info::{RawVideoFormat, VideoInfo};
use ffmpeg::{
    Dictionary,
    codec::{Capabilities, context, encoder},
    color, format, frame,
    threading::{Config, Type},
};
use tracing::{info, warn};

use crate::base::EncoderBase;

const MAX_FRAME_THREADS: usize = 8;
// Each frame thread holds a whole frame and its packet: about 16 bytes per
// output pixel at peak, measured on 4K exports (8 threads added 1.2 GB). The
// threads may use at most a sixteenth of RAM, so an 8 GB Mac exporting 4K
// gets 4 threads instead of swapping, and 16 GB or more gets all 8.
const FRAME_THREAD_BYTES_PER_PIXEL: u64 = 16;
const FRAME_THREAD_MEMORY_SHARE: u64 = 16;

// VideoToolbox widens 8-bit alpha by a shift, so BGRA input decodes opaque
// as 4080 of 4095 in the ProRes 4444 alpha plane; 16-bit input keeps 4095.
#[cfg(target_os = "macos")]
const ENCODERS: &[(&str, format::Pixel)] = &[
    ("prores_videotoolbox", format::Pixel::AYUV64LE),
    ("prores_ks", format::Pixel::YUVA444P10LE),
];
#[cfg(not(target_os = "macos"))]
const ENCODERS: &[(&str, format::Pixel)] = &[("prores_ks", format::Pixel::YUVA444P10LE)];

fn frame_thread_count(
    cores: usize,
    total_memory: Option<u64>,
    output_width: u32,
    output_height: u32,
) -> usize {
    let thread_bytes = u64::from(output_width)
        .saturating_mul(u64::from(output_height))
        .saturating_mul(FRAME_THREAD_BYTES_PER_PIXEL)
        .max(1);
    let by_memory = total_memory.map_or(1, |memory| {
        usize::try_from(memory / FRAME_THREAD_MEMORY_SHARE / thread_bytes).unwrap_or(usize::MAX)
    });
    cores.min(MAX_FRAME_THREADS).min(by_memory).max(1)
}

fn total_memory_bytes() -> Option<u64> {
    let system = sysinfo::System::new_with_specifics(
        sysinfo::RefreshKind::new().with_memory(sysinfo::MemoryRefreshKind::new().with_ram()),
    );
    Some(system.total_memory()).filter(|memory| *memory > 0)
}

pub struct ProResEncoderBuilder {
    input_config: VideoInfo,
    output_size: Option<(u32, u32)>,
}

#[derive(thiserror::Error, Debug)]
pub enum ProResEncoderError {
    #[error("{0:?}")]
    FFmpeg(#[from] ffmpeg::Error),
    #[error("Codec not found")]
    CodecNotFound,
    #[error("Invalid output dimensions {width}x{height}; expected non-zero width and height")]
    InvalidOutputDimensions { width: u32, height: u32 },
}

impl ProResEncoderBuilder {
    pub fn new(input_config: VideoInfo) -> Self {
        Self {
            input_config,
            output_size: None,
        }
    }

    pub fn with_output_size(mut self, width: u32, height: u32) -> Result<Self, ProResEncoderError> {
        if width == 0 || height == 0 {
            return Err(ProResEncoderError::InvalidOutputDimensions { width, height });
        }

        self.output_size = Some((width, height));
        Ok(self)
    }

    pub fn build(
        self,
        output: &mut format::context::Output,
    ) -> Result<ProResEncoder, ProResEncoderError> {
        let (fallback, preferred) = ENCODERS.split_last().expect("at least one ProRes encoder");
        for (name, encoder_format) in preferred {
            match self.build_with(name, *encoder_format, output) {
                Ok(encoder) => return Ok(encoder),
                Err(error) => {
                    warn!(encoder = name, %error, "ProRes encoder unavailable, falling back")
                }
            }
        }
        self.build_with(fallback.0, fallback.1, output)
    }

    fn build_with(
        &self,
        name: &str,
        output_format: format::Pixel,
        output: &mut format::context::Output,
    ) -> Result<ProResEncoder, ProResEncoderError> {
        let codec = encoder::find_by_name(name).ok_or(ProResEncoderError::CodecNotFound)?;
        let input_config = self.input_config;
        let (output_width, output_height) = self
            .output_size
            .unwrap_or((input_config.width, input_config.height));

        let converter = if input_config.pixel_format != output_format
            || input_config.width != output_width
            || input_config.height != output_height
        {
            let mut converter = ffmpeg::software::scaling::Context::get(
                input_config.pixel_format,
                input_config.width,
                input_config.height,
                output_format,
                output_width,
                output_height,
                ffmpeg::software::scaling::flag::Flags::BICUBIC,
            )?;
            super::colour::use_bt709_for_rgb_input(
                &mut converter,
                input_config.pixel_format,
                output_format,
            )?;
            Some(converter)
        } else {
            None
        };

        let mut encoder_ctx = context::Context::new_with_codec(codec);
        let cores = thread::available_parallelism().map_or(1, |v| v.get());
        let thread_count =
            frame_thread_count(cores, total_memory_bytes(), output_width, output_height);
        // `Config::count` leaves `thread_type` at 0, which libavcodec treats as
        // "no threading" for prores_ks. Frame threading keeps a reference to each
        // sent frame until a worker encodes it, so it is only safe when frames
        // come from `converted_frames`, which never rewrites a frame the encoder
        // still holds.
        let mut threading = Config::kind(
            if converter.is_some() && codec.capabilities().contains(Capabilities::FRAME_THREADS) {
                Type::Frame
            } else {
                Type::None
            },
        );
        threading.count = thread_count;
        encoder_ctx.set_threading(threading);

        let mut encoder = encoder_ctx.encoder().video()?;
        encoder.set_width(output_width);
        encoder.set_height(output_height);
        encoder.set_format(output_format);
        encoder.set_time_base(input_config.time_base);
        encoder.set_frame_rate(Some(input_config.frame_rate));
        encoder.set_colorspace(color::Space::BT709);
        encoder.set_color_range(color::Range::MPEG);
        unsafe {
            (*encoder.as_mut_ptr()).color_primaries =
                ffmpeg::ffi::AVColorPrimaries::AVCOL_PRI_BT709;
            (*encoder.as_mut_ptr()).color_trc =
                ffmpeg::ffi::AVColorTransferCharacteristic::AVCOL_TRC_BT709;
        }

        let mut options = Dictionary::new();
        options.set("profile", "4444");
        if name == "prores_ks" {
            options.set("alpha_bits", "16");
        }

        let encoder = encoder.open_with(options)?;
        info!(encoder = name, "ProRes encoder opened");

        let mut output_stream = output.add_stream(codec)?;
        let stream_index = output_stream.index();
        output_stream.set_time_base(input_config.time_base);
        output_stream.set_rate(input_config.frame_rate);
        output_stream.set_parameters(&encoder);

        Ok(ProResEncoder {
            base: EncoderBase::new(stream_index),
            encoder,
            converter,
            converted_frames: Vec::new(),
            output_format,
            output_size: (output_width, output_height),
            conversion_threads: cores,
        })
    }
}

pub struct ProResEncoder {
    base: EncoderBase,
    encoder: encoder::Video,
    converter: Option<ffmpeg::software::scaling::Context>,
    converted_frames: Vec<frame::Video>,
    output_format: format::Pixel,
    output_size: (u32, u32),
    conversion_threads: usize,
}

#[derive(thiserror::Error, Debug)]
pub enum QueueFrameError {
    #[error("Converter: {0}")]
    Converter(ffmpeg::Error),
    #[error("Encode: {0}")]
    Encode(ffmpeg::Error),
}

impl ProResEncoder {
    pub fn builder(input_config: VideoInfo) -> ProResEncoderBuilder {
        ProResEncoderBuilder::new(input_config)
    }

    pub fn input_format() -> RawVideoFormat {
        RawVideoFormat::Rgba
    }

    pub fn queue_frame(
        &mut self,
        frame: &mut frame::Video,
        timestamp: Duration,
        output: &mut format::context::Output,
    ) -> Result<(), QueueFrameError> {
        self.base.update_pts(frame, timestamp, &mut self.encoder);

        let Some(converter) = &mut self.converter else {
            return self
                .base
                .send_frame(frame, output, &mut self.encoder)
                .map_err(QueueFrameError::Encode);
        };

        let mut converted = match self.converted_frames.iter_mut().position(
            |pooled| unsafe { ffmpeg::ffi::av_frame_is_writable(pooled.as_mut_ptr()) } != 0,
        ) {
            Some(index) => self.converted_frames.swap_remove(index),
            None => frame::Video::new(self.output_format, self.output_size.0, self.output_size.1),
        };
        if !convert_rgba_to_ayuv64(frame, &mut converted, self.conversion_threads) {
            converter
                .run(frame, &mut converted)
                .map_err(QueueFrameError::Converter)?;
        }
        converted.set_pts(frame.pts());

        let result = self
            .base
            .send_frame(&converted, output, &mut self.encoder)
            .map_err(QueueFrameError::Encode);
        self.converted_frames.push(converted);
        result
    }

    pub fn flush(&mut self, output: &mut format::context::Output) -> Result<(), ffmpeg::Error> {
        self.base.process_eof(output, &mut self.encoder)
    }
}

unsafe impl Send for ProResEncoder {}

// swscale's generic path for packed 16-bit 4:4:4:4 output runs at about
// 100 Mpx/s per core, a quarter of what the hardware encoder takes at 4K60,
// so same-size RGBA to AYUV64LE is converted here instead: BT.709 limited
// range in 2^12 fixed point, straight alpha. Anything else stays on swscale.
const FIXED_POINT: i32 = 12;
const Y_COEFFICIENTS: [i32; 3] = [191455, 644067, 65019];
const CB_COEFFICIENTS: [i32; 3] = [-105533, -355018, 460551];
const CR_COEFFICIENTS: [i32; 3] = [460551, -418321, -42230];
const Y_OFFSET: i32 = ((16 << 8) << FIXED_POINT) + (1 << (FIXED_POINT - 1));
const CHROMA_OFFSET: i32 = ((128 << 8) << FIXED_POINT) + (1 << (FIXED_POINT - 1));

fn convert_rgba_to_ayuv64(src: &frame::Video, dst: &mut frame::Video, threads: usize) -> bool {
    let (width, height) = (src.width() as usize, src.height() as usize);
    let (src_stride, dst_stride) = (src.stride(0), dst.stride(0));
    if src.format() != format::Pixel::RGBA
        || dst.format() != format::Pixel::AYUV64LE
        || (width, height) != (dst.width() as usize, dst.height() as usize)
        || width == 0
        || height == 0
    {
        return false;
    }

    let rows_per_band = height.div_ceil(threads.max(1));
    let src_bands = src.data(0).chunks(src_stride * rows_per_band);
    let dst_bands = dst.data_mut(0).chunks_mut(dst_stride * rows_per_band);
    thread::scope(|scope| {
        for (src_band, dst_band) in src_bands.zip(dst_bands) {
            scope.spawn(move || {
                let rows = src_band
                    .chunks(src_stride)
                    .zip(dst_band.chunks_mut(dst_stride));
                for (src_row, dst_row) in rows {
                    convert_rgba_row_to_ayuv64(&src_row[..width * 4], &mut dst_row[..width * 8]);
                }
            });
        }
    });
    true
}

fn convert_rgba_row_to_ayuv64(src: &[u8], dst: &mut [u8]) {
    for (pixel, sample) in src.chunks_exact(4).zip(dst.chunks_exact_mut(8)) {
        let rgb = [
            i32::from(pixel[0]),
            i32::from(pixel[1]),
            i32::from(pixel[2]),
        ];
        let mix = |coefficients: [i32; 3], offset: i32| {
            let sum = offset
                + coefficients[0] * rgb[0]
                + coefficients[1] * rgb[1]
                + coefficients[2] * rgb[2];
            (sum >> FIXED_POINT) as u16
        };
        let [a, y, cb, cr] = [
            u16::from(pixel[3]) * 257,
            mix(Y_COEFFICIENTS, Y_OFFSET),
            mix(CB_COEFFICIENTS, CHROMA_OFFSET),
            mix(CR_COEFFICIENTS, CHROMA_OFFSET),
        ]
        .map(u16::to_le_bytes);
        sample.copy_from_slice(&[a[0], a[1], y[0], y[1], cb[0], cb[1], cr[0], cr[1]]);
    }
}

#[cfg(test)]
mod conversion_tests {
    use ffmpeg::{format, frame, software::scaling};

    use super::convert_rgba_to_ayuv64;
    use crate::video::colour::use_bt709_for_rgb_input;

    fn gradient(width: u32, height: u32) -> frame::Video {
        let mut rgba = frame::Video::new(format::Pixel::RGBA, width, height);
        let stride = rgba.stride(0);
        for row in 0..height as usize {
            for col in 0..width as usize {
                let offset = row * stride + col * 4;
                rgba.data_mut(0)[offset..offset + 4].copy_from_slice(&[
                    (col * 4) as u8,
                    (row * 7) as u8,
                    ((col * 3 + row * 5) & 255) as u8,
                    (col * 4 + 3) as u8,
                ]);
            }
        }
        rgba
    }

    fn samples(frame: &frame::Video) -> Vec<[u16; 4]> {
        let width = frame.width() as usize;
        frame
            .data(0)
            .chunks(frame.stride(0))
            .take(frame.height() as usize)
            .flat_map(|row| {
                row[..width * 8].chunks_exact(8).map(|sample| {
                    [0, 2, 4, 6].map(|i| u16::from_le_bytes([sample[i], sample[i + 1]]))
                })
            })
            .collect()
    }

    #[test]
    fn matches_swscale_bt709_limited_range_and_keeps_alpha_exact() {
        ffmpeg::init().unwrap();
        let (width, height) = (64, 33);
        let rgba = gradient(width, height);

        let mut fast = frame::Video::new(format::Pixel::AYUV64LE, width, height);
        assert!(convert_rgba_to_ayuv64(&rgba, &mut fast, 4));

        let mut scaler = scaling::Context::get(
            format::Pixel::RGBA,
            width,
            height,
            format::Pixel::AYUV64LE,
            width,
            height,
            scaling::Flags::BICUBIC,
        )
        .unwrap();
        use_bt709_for_rgb_input(&mut scaler, format::Pixel::RGBA, format::Pixel::AYUV64LE).unwrap();
        let mut reference = frame::Video::new(format::Pixel::AYUV64LE, width, height);
        scaler.run(&rgba, &mut reference).unwrap();

        let mut largest = [0u16; 4];
        for (fast, reference) in samples(&fast).into_iter().zip(samples(&reference)) {
            for channel in 0..4 {
                largest[channel] = largest[channel].max(fast[channel].abs_diff(reference[channel]));
            }
        }
        // 256 is one 8-bit step at 16 bits.
        assert!(
            largest[1..].iter().all(|diff| *diff <= 64),
            "Y, Cb, Cr differ by {largest:?}"
        );
        assert!(largest[0] <= 4, "alpha differs by {largest:?}");
        assert_eq!(samples(&fast)[63][0], 65535);
    }

    #[test]
    fn other_shapes_stay_on_swscale() {
        ffmpeg::init().unwrap();
        let rgba = gradient(16, 16);
        let mut smaller = frame::Video::new(format::Pixel::AYUV64LE, 8, 8);
        assert!(!convert_rgba_to_ayuv64(&rgba, &mut smaller, 4));
        let mut planar = frame::Video::new(format::Pixel::YUVA444P10LE, 16, 16);
        assert!(!convert_rgba_to_ayuv64(&rgba, &mut planar, 4));
    }
}

#[cfg(test)]
mod frame_thread_tests {
    use super::frame_thread_count;

    const GB: u64 = 1024 * 1024 * 1024;

    #[test]
    fn small_macs_get_fewer_threads_at_4k() {
        assert_eq!(frame_thread_count(8, Some(8 * GB), 3840, 2160), 4);
        assert_eq!(frame_thread_count(10, Some(16 * GB), 3840, 2160), 8);
        assert_eq!(frame_thread_count(16, Some(128 * GB), 3840, 2160), 8);
    }

    #[test]
    fn smaller_outputs_use_every_allowed_thread() {
        assert_eq!(frame_thread_count(8, Some(8 * GB), 1920, 1080), 8);
        assert_eq!(frame_thread_count(4, Some(8 * GB), 1920, 1080), 4);
    }

    #[test]
    fn degenerate_inputs_still_encode_on_one_thread() {
        assert_eq!(frame_thread_count(16, None, 3840, 2160), 1);
        assert_eq!(frame_thread_count(0, Some(128 * GB), 3840, 2160), 1);
        assert_eq!(frame_thread_count(16, Some(GB), 7680, 4320), 1);
        assert_eq!(frame_thread_count(16, Some(128 * GB), 0, 0), 8);
        assert_eq!(
            frame_thread_count(16, Some(u64::MAX), u32::MAX, u32::MAX),
            1
        );
    }
}
