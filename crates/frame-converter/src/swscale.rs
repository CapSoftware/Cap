use crate::output_frame::cached_output_frame;
use crate::packed_yuv::{self, Nv12Mut, Packed422};
use crate::{ConversionConfig, ConvertError, ConverterBackend, FrameConverter};
use ffmpeg::{format::Pixel, frame, software::scaling};
use std::cell::UnsafeCell;
use thread_local::ThreadLocal;

struct SendableContext(UnsafeCell<scaling::Context>);

unsafe impl Send for SendableContext {}

impl SendableContext {
    fn new(ctx: scaling::Context) -> Self {
        Self(UnsafeCell::new(ctx))
    }

    fn run(&self, input: &frame::Video, output: &mut frame::Video) -> Result<(), ffmpeg::Error> {
        unsafe { (*self.0.get()).run(input, output) }
    }
}

pub struct SwscaleConverter {
    contexts: ThreadLocal<SendableContext>,
    config: ConversionConfig,
    output_format: Pixel,
    output_width: u32,
    output_height: u32,
}

impl SwscaleConverter {
    pub fn new(config: ConversionConfig) -> Result<Self, ConvertError> {
        Self::create_context(&config)?;

        Ok(Self {
            contexts: ThreadLocal::new(),
            output_format: config.output_format,
            output_width: config.output_width,
            output_height: config.output_height,
            config,
        })
    }

    fn create_context(config: &ConversionConfig) -> Result<scaling::Context, ConvertError> {
        let flags = if config.needs_scaling() {
            scaling::flag::Flags::BICUBIC
        } else {
            scaling::flag::Flags::FAST_BILINEAR
        };

        scaling::Context::get(
            config.input_format,
            config.input_width,
            config.input_height,
            config.output_format,
            config.output_width,
            config.output_height,
            flags,
        )
        .map_err(|_| ConvertError::UnsupportedFormat(config.input_format, config.output_format))
    }

    fn get_or_create_context(&self) -> Result<&SendableContext, ConvertError> {
        self.contexts
            .get_or_try(|| Self::create_context(&self.config).map(SendableContext::new))
    }

    #[cfg(test)]
    pub(crate) fn convert_swscale_into(
        &self,
        input: &frame::Video,
        output: &mut frame::Video,
    ) -> Result<(), ConvertError> {
        let context = self.get_or_create_context()?;
        context
            .run(input, output)
            .map_err(|e| ConvertError::ConversionFailed(e.to_string()))?;
        Ok(())
    }
}

fn positive_linesize(frame: &frame::Video, plane: usize) -> Option<usize> {
    if plane >= frame.planes() {
        return None;
    }
    let linesize = unsafe { (*frame.as_ptr()).linesize[plane] };
    if linesize <= 0 {
        None
    } else {
        Some(linesize as usize)
    }
}

fn planes_disjoint(a: *const u8, a_len: usize, b: *const u8, b_len: usize) -> bool {
    if a_len == 0 || b_len == 0 {
        return true;
    }
    let Some(a_end) = (a as usize).checked_add(a_len) else {
        return false;
    };
    let Some(b_end) = (b as usize).checked_add(b_len) else {
        return false;
    };
    a_end <= b as usize || b_end <= a as usize
}

pub(crate) fn try_packed_yuv_nv12(input: &frame::Video, output: &mut frame::Video) -> bool {
    let kind = match input.format() {
        Pixel::UYVY422 => Packed422::Uyvy,
        Pixel::YUYV422 => Packed422::Yuyv,
        _ => return false,
    };
    if output.format() != Pixel::NV12 {
        return false;
    }
    let width_px = input.width();
    let height_px = input.height();
    if output.width() != width_px || output.height() != height_px {
        return false;
    }
    if width_px == 0 || height_px == 0 {
        return true;
    }
    if input.planes() < 1 || output.planes() < 2 {
        return false;
    }
    let Some(src_stride) = positive_linesize(input, 0) else {
        return false;
    };
    let Some(y_stride) = positive_linesize(output, 0) else {
        return false;
    };
    let Some(uv_stride) = positive_linesize(output, 1) else {
        return false;
    };
    let width = width_px as usize;
    let height = height_px as usize;
    let src_h = input.plane_height(0) as usize;
    let y_h = output.plane_height(0) as usize;
    let uv_h = output.plane_height(1) as usize;
    if src_h < height || y_h < height || uv_h < height.div_ceil(2) {
        return false;
    }
    let Some(src_len) = src_stride.checked_mul(src_h) else {
        return false;
    };
    let Some(y_len) = y_stride.checked_mul(y_h) else {
        return false;
    };
    let Some(uv_len) = uv_stride.checked_mul(uv_h) else {
        return false;
    };
    unsafe {
        let in_raw = input.as_ptr();
        let out_raw = output.as_mut_ptr();
        if in_raw.is_null() || out_raw.is_null() {
            return false;
        }
        let src_ptr = (*in_raw).data[0];
        let y_ptr = (*out_raw).data[0];
        let uv_ptr = (*out_raw).data[1];
        if src_ptr.is_null() || y_ptr.is_null() || uv_ptr.is_null() {
            return false;
        }
        if !planes_disjoint(y_ptr, y_len, uv_ptr, uv_len) {
            return false;
        }
        let src = std::slice::from_raw_parts(src_ptr, src_len);
        let y = std::slice::from_raw_parts_mut(y_ptr, y_len);
        let uv = std::slice::from_raw_parts_mut(uv_ptr, uv_len);
        let mut dst = Nv12Mut {
            y,
            y_stride,
            uv,
            uv_stride,
        };
        packed_yuv::convert_packed422_to_nv12(kind, src, src_stride, width, height, &mut dst)
    }
}

impl FrameConverter for SwscaleConverter {
    fn convert(&self, input: frame::Video) -> Result<frame::Video, ConvertError> {
        let mut output =
            cached_output_frame(self.output_format, self.output_width, self.output_height);
        self.convert_into(input, &mut output)?;
        Ok(output)
    }

    fn convert_into(
        &self,
        input: frame::Video,
        output: &mut frame::Video,
    ) -> Result<(), ConvertError> {
        let pts = input.pts();
        if !try_packed_yuv_nv12(&input, output) {
            let context = self.get_or_create_context()?;
            context
                .run(&input, output)
                .map_err(|e| ConvertError::ConversionFailed(e.to_string()))?;
        }
        output.set_pts(pts);
        Ok(())
    }

    fn name(&self) -> &'static str {
        "swscale"
    }

    fn backend(&self) -> ConverterBackend {
        ConverterBackend::Swscale
    }
}

unsafe impl Send for SwscaleConverter {}
unsafe impl Sync for SwscaleConverter {}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::packed_yuv::{Packed422, convert_packed422_scalar};
    use std::sync::Once;
    use std::time::{Duration, Instant};

    fn init_ffmpeg() {
        static ONCE: Once = Once::new();
        ONCE.call_once(|| {
            ffmpeg::init().expect("ffmpeg init");
        });
    }

    fn fill(buf: &mut [u8], mut seed: u32) {
        for byte in buf.iter_mut() {
            seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
            *byte = (seed >> 24) as u8;
        }
    }

    fn fill_frame(frame: &mut frame::Video, seed: u32) {
        for plane in 0..frame.planes() {
            fill(frame.data_mut(plane), seed.wrapping_add(plane as u32 * 97));
        }
    }

    fn active_rows(plane: &[u8], stride: usize, rows: usize, active: usize) -> Vec<u8> {
        let mut out = Vec::with_capacity(rows * active);
        for row in 0..rows {
            let start = row * stride;
            out.extend_from_slice(&plane[start..start + active]);
        }
        out
    }

    fn kind_of(format: Pixel) -> Packed422 {
        match format {
            Pixel::UYVY422 => Packed422::Uyvy,
            Pixel::YUYV422 => Packed422::Yuyv,
            _ => panic!("packed 4:2:2 format"),
        }
    }

    #[test]
    fn convert_into_matches_scalar_kernel() {
        init_ffmpeg();
        let shapes = [
            (16u32, 8u32),
            (17, 3),
            (15, 2),
            (31, 5),
            (32, 1),
            (33, 4),
            (64, 27),
            (47, 9),
        ];
        for format in [Pixel::UYVY422, Pixel::YUYV422] {
            for (width, height) in shapes {
                let config =
                    ConversionConfig::new(format, width, height, Pixel::NV12, width, height);
                let converter = SwscaleConverter::new(config).expect("converter");
                let mut input = frame::Video::new(format, width, height);
                fill_frame(&mut input, width.wrapping_mul(13).wrapping_add(height));
                input.set_pts(Some(i64::from(width) * 1000 + i64::from(height)));
                let mut output = frame::Video::new(Pixel::NV12, width, height);
                converter
                    .convert_into(input.clone(), &mut output)
                    .expect("convert_into");
                assert_eq!(
                    output.pts(),
                    Some(i64::from(width) * 1000 + i64::from(height))
                );
                assert_eq!(output.format(), Pixel::NV12);

                let src_stride = input.stride(0);
                let y_stride = output.stride(0);
                let uv_stride = output.stride(1);
                let mut y = vec![0u8; y_stride * output.plane_height(0) as usize];
                let mut uv = vec![0u8; uv_stride * output.plane_height(1) as usize];
                {
                    let mut dst = crate::packed_yuv::Nv12Mut {
                        y: &mut y,
                        y_stride,
                        uv: &mut uv,
                        uv_stride,
                    };
                    assert!(convert_packed422_scalar(
                        kind_of(format),
                        input.data(0),
                        src_stride,
                        width as usize,
                        height as usize,
                        &mut dst,
                    ));
                }
                assert_eq!(
                    active_rows(output.data(0), y_stride, height as usize, width as usize),
                    active_rows(&y, y_stride, height as usize, width as usize),
                    "{format:?} {width}x{height} y"
                );
                let chroma_bytes = (width as usize).div_ceil(2) * 2;
                assert_eq!(
                    active_rows(
                        output.data(1),
                        uv_stride,
                        height.div_ceil(2) as usize,
                        chroma_bytes
                    ),
                    active_rows(&uv, uv_stride, height.div_ceil(2) as usize, chroma_bytes),
                    "{format:?} {width}x{height} uv"
                );
            }
        }
    }

    // FAST_BILINEAR is not an identity luma copy and is not (a + b + 1) >> 1.
    // On even frames through 1920x1080 the max absolute difference was 20 luma
    // and 19 chroma. Odd heights use a different swscale vertical filter
    // (about 120 levels on 64x33) and stay in the exact kernel tests.
    const LUMA_TOLERANCE: i32 = 24;
    const CHROMA_TOLERANCE: i32 = 24;

    fn max_plane_diff(left: &[u8], right: &[u8], stride: usize, rows: usize, active: usize) -> i32 {
        let mut max_diff = 0i32;
        for row in 0..rows {
            let start = row * stride;
            for offset in 0..active {
                let delta = i32::from(left[start + offset]) - i32::from(right[start + offset]);
                max_diff = max_diff.max(delta.abs());
            }
        }
        max_diff
    }

    #[test]
    fn packed_path_stays_close_to_swscale() {
        init_ffmpeg();
        let shapes = [
            (64u32, 48u32),
            (320, 180),
            (640, 360),
            (1280, 720),
            (1920, 1080),
        ];
        for format in [Pixel::UYVY422, Pixel::YUYV422] {
            for (width, height) in shapes {
                let config =
                    ConversionConfig::new(format, width, height, Pixel::NV12, width, height);
                let converter = SwscaleConverter::new(config).expect("converter");
                let mut input = frame::Video::new(format, width, height);
                fill_frame(
                    &mut input,
                    0x51C0_u32.wrapping_add(width).wrapping_add(height),
                );
                let mut fast = frame::Video::new(Pixel::NV12, width, height);
                let mut sws = frame::Video::new(Pixel::NV12, width, height);
                assert!(try_packed_yuv_nv12(&input, &mut fast));
                converter
                    .convert_swscale_into(&input, &mut sws)
                    .expect("swscale");
                let luma = max_plane_diff(
                    fast.data(0),
                    sws.data(0),
                    fast.stride(0),
                    height as usize,
                    width as usize,
                );
                let chroma_bytes = (width as usize / 2) * 2;
                let chroma = max_plane_diff(
                    fast.data(1),
                    sws.data(1),
                    fast.stride(1),
                    height.div_ceil(2) as usize,
                    chroma_bytes,
                );
                assert!(
                    luma <= LUMA_TOLERANCE && chroma <= CHROMA_TOLERANCE,
                    "{format:?} {width}x{height} luma {luma} chroma {chroma}"
                );
            }
        }
    }

    #[test]
    fn other_formats_and_scaling_still_use_swscale() {
        init_ffmpeg();
        let scaled = SwscaleConverter::new(ConversionConfig::new(
            Pixel::UYVY422,
            32,
            16,
            Pixel::NV12,
            16,
            8,
        ))
        .expect("scaled");
        let mut input = frame::Video::new(Pixel::UYVY422, 32, 16);
        fill_frame(&mut input, 9);
        let output = scaled.convert(input).expect("scale");
        assert_eq!(
            (output.width(), output.height(), output.format()),
            (16, 8, Pixel::NV12)
        );

        let bgra = SwscaleConverter::new(ConversionConfig::new(
            Pixel::BGRA,
            16,
            16,
            Pixel::NV12,
            16,
            16,
        ))
        .expect("bgra");
        let mut input = frame::Video::new(Pixel::BGRA, 16, 16);
        fill_frame(&mut input, 4);
        let output = bgra.convert(input).expect("bgra convert");
        assert_eq!(output.format(), Pixel::NV12);
        assert_eq!((output.width(), output.height()), (16, 16));
    }

    #[test]
    fn convert_keeps_live_frames_independent() {
        init_ffmpeg();
        let converter = SwscaleConverter::new(ConversionConfig::new(
            Pixel::UYVY422,
            82,
            18,
            Pixel::NV12,
            82,
            18,
        ))
        .expect("converter");
        let mut first_src = frame::Video::new(Pixel::UYVY422, 82, 18);
        first_src.data_mut(0).fill(30);
        first_src.set_pts(Some(42));
        let mut first = converter.convert(first_src).expect("first");
        assert_eq!(first.pts(), Some(42));
        let first_y = first.data(0).to_vec();
        let first_uv = first.data(1).to_vec();
        unsafe {
            assert_eq!(ffmpeg::ffi::av_frame_is_writable(first.as_mut_ptr()), 1);
        }
        let mut second_src = frame::Video::new(Pixel::UYVY422, 82, 18);
        second_src.data_mut(0).fill(90);
        let mut second = converter.convert(second_src).expect("second");
        assert_eq!(first.data(0), first_y.as_slice());
        assert_eq!(first.data(1), first_uv.as_slice());
        assert!(second.data(0).contains(&90));
        assert!(!second.data(0).iter().take(82).all(|byte| *byte == 30));
        unsafe {
            assert_eq!(ffmpeg::ffi::av_frame_is_writable(first.as_mut_ptr()), 1);
            assert_eq!(ffmpeg::ffi::av_frame_is_writable(second.as_mut_ptr()), 1);
        }
        drop(first);
        drop(second);
        let mut third_src = frame::Video::new(Pixel::UYVY422, 82, 18);
        third_src.data_mut(0).fill(11);
        let third = converter.convert(third_src).expect("third");
        assert!(third.data(0).iter().take(82).all(|byte| *byte == 11));
    }

    #[inline(never)]
    fn time_swscale(converter: &SwscaleConverter, input: &frame::Video, output: &mut frame::Video) {
        converter
            .convert_swscale_into(input, output)
            .expect("swscale");
        let index = output.stride(0);
        std::hint::black_box(output.data(0)[index]);
    }

    #[inline(never)]
    fn time_packed(input: &frame::Video, output: &mut frame::Video) {
        assert!(try_packed_yuv_nv12(input, output));
        let index = output.stride(0);
        std::hint::black_box(output.data(0)[index]);
    }

    fn median(samples: &mut [Duration]) -> Duration {
        samples.sort_unstable();
        samples[samples.len() / 2]
    }

    fn cpu_model() -> String {
        let Ok(text) = std::fs::read_to_string("/proc/cpuinfo") else {
            return "unknown".to_string();
        };
        for line in text.lines() {
            let Some(rest) = line.strip_prefix("model name") else {
                continue;
            };
            return rest.trim_start_matches([' ', ':', '\t']).to_string();
        }
        "unknown".to_string()
    }

    #[test]
    #[ignore]
    fn bench_packed_yuv_nv12() {
        init_ffmpeg();
        if cfg!(debug_assertions) {
            eprintln!("debug build; rerun with --release for representative medians");
        }
        #[cfg(target_arch = "x86_64")]
        let avx2 = is_x86_feature_detected!("avx2");
        #[cfg(not(target_arch = "x86_64"))]
        let avx2 = false;
        let warmup = 16;
        let runs = 51;
        println!("cpu: {}", cpu_model());
        println!("avx2: {avx2}");
        println!("warmup: {warmup}");
        println!("timed runs: {runs}");
        println!(
            "before: swscale FAST_BILINEAR, after: packed kernel, frames allocated outside the timer"
        );
        let shapes = [(1280u32, 720u32), (1920, 1080), (3840, 2160)];
        for format in [Pixel::UYVY422, Pixel::YUYV422] {
            for (width, height) in shapes {
                let config =
                    ConversionConfig::new(format, width, height, Pixel::NV12, width, height);
                let converter = SwscaleConverter::new(config).expect("converter");
                let mut input = frame::Video::new(format, width, height);
                fill_frame(&mut input, width.wrapping_mul(height));
                let mut sws_out = frame::Video::new(Pixel::NV12, width, height);
                let mut fast_out = frame::Video::new(Pixel::NV12, width, height);
                for _ in 0..warmup {
                    time_swscale(&converter, &input, &mut sws_out);
                }
                let mut sws_samples = Vec::with_capacity(runs);
                for _ in 0..runs {
                    let start = Instant::now();
                    time_swscale(&converter, &input, &mut sws_out);
                    sws_samples.push(start.elapsed());
                }
                for _ in 0..warmup {
                    time_packed(&input, &mut fast_out);
                }
                let mut fast_samples = Vec::with_capacity(runs);
                for _ in 0..runs {
                    let start = Instant::now();
                    time_packed(&input, &mut fast_out);
                    fast_samples.push(start.elapsed());
                }
                let sws_min = sws_samples.iter().copied().min().unwrap_or_default();
                let fast_min = fast_samples.iter().copied().min().unwrap_or_default();
                let sws_max = sws_samples.iter().copied().max().unwrap_or_default();
                let fast_max = fast_samples.iter().copied().max().unwrap_or_default();
                let sws_med = median(&mut sws_samples);
                let fast_med = median(&mut fast_samples);
                let speedup = sws_med.as_secs_f64() / fast_med.as_secs_f64();
                println!(
                    "{width}x{height} {format:?} before {:.3} ms after {:.3} ms speedup {speedup:.2}x n {runs} before_min {:.3} before_max {:.3} after_min {:.3} after_max {:.3}",
                    sws_med.as_secs_f64() * 1000.0,
                    fast_med.as_secs_f64() * 1000.0,
                    sws_min.as_secs_f64() * 1000.0,
                    sws_max.as_secs_f64() * 1000.0,
                    fast_min.as_secs_f64() * 1000.0,
                    fast_max.as_secs_f64() * 1000.0,
                );
                let _ = std::hint::black_box(sws_out.data(0)[0]);
                let _ = std::hint::black_box(fast_out.data(0)[0]);
            }
        }
    }
}
