//! Fragmented-recording encoder benchmark: software-frame VideoToolbox input
//! (the shipped path: lock IOSurface + copy NV12 planes into an AVFrame)
//! against zero-copy VideoToolbox input (CVPixelBuffer wrapped as an
//! `AV_PIX_FMT_VIDEOTOOLBOX` frame).
//!
//! Both paths drive a real `SegmentedVideoEncoder` (DASH init.mp4 + m4s
//! segments) over identical synthetic IOSurface-backed 420v frames, then the
//! segments are reassembled and decoded so the outputs can be compared
//! pixel-for-pixel. The software path runs twice to establish the encoder's
//! own determinism as a control.
//!
//! Run: cargo run -p cap-recording --example vt-hwframe-encode-benchmark --release

#[cfg(not(target_os = "macos"))]
fn main() {
    eprintln!("macOS only");
}

#[cfg(target_os = "macos")]
fn main() {
    macos::run();
}

#[cfg(target_os = "macos")]
mod macos {
    use std::ffi::c_void;
    use std::path::{Path, PathBuf};
    use std::time::{Duration, Instant};

    use cap_enc_ffmpeg::h264::H264Preset;
    use cap_enc_ffmpeg::remux::concatenate_m4s_segments_with_init;
    use cap_enc_ffmpeg::segmented_stream::{SegmentedVideoEncoder, SegmentedVideoEncoderConfig};
    use cap_media_info::VideoInfo;
    use cidre::{arc, cf, cv};

    const WARMUP: usize = 30;
    const FRAMES: usize = 300;
    const UNIQUE_FRAMES: usize = 60;

    fn iosurface_attrs() -> arc::R<cf::Dictionary> {
        let io_surface_properties = cf::Dictionary::new();
        let keys: [&cf::Type; 2] = [
            cv::pixel_buffer::keys::io_surf_props().as_ref(),
            cv::pixel_buffer::keys::metal_compatibility().as_ref(),
        ];
        let values: [&cf::Type; 2] = [
            io_surface_properties.as_ref(),
            cf::Boolean::value_true().as_ref(),
        ];
        cf::Dictionary::with_keys_values(&keys, &values).expect("pixel buffer attributes")
    }

    /// A moving diagonal gradient: enough inter-frame motion that the encoder
    /// does real work, fully deterministic across runs.
    fn make_420v_frame(width: usize, height: usize, index: usize) -> arc::R<cv::PixelBuf> {
        let attrs = iosurface_attrs();
        let mut buf = cv::PixelBuf::new(width, height, cv::PixelFormat::_420V, Some(&attrs))
            .expect("420v frame");
        assert!(buf.io_surf().is_some());
        unsafe {
            buf.lock_base_addr(cv::pixel_buffer::LockFlags::DEFAULT)
                .result()
                .expect("lock frame");
        }
        let shift = index * 4;
        let y_stride = buf.plane_bytes_per_row(0);
        let uv_stride = buf.plane_bytes_per_row(1);
        let uv_height = buf.plane_height(1);
        unsafe {
            let y_base = buf.plane_base_address(0).cast_mut();
            for row in 0..buf.plane_height(0) {
                for col in 0..width {
                    *y_base.add(row * y_stride + col) = 16 + ((row + col + shift) * 3 % 220) as u8;
                }
            }
            let uv_base = buf.plane_base_address(1).cast_mut();
            for row in 0..uv_height {
                for pair in 0..(width / 2) {
                    *uv_base.add(row * uv_stride + pair * 2) =
                        16 + ((row * 2 + pair + shift) % 208) as u8;
                    *uv_base.add(row * uv_stride + pair * 2 + 1) =
                        16 + ((row + pair * 2 + shift * 3) % 208) as u8;
                }
            }
            buf.unlock_lock_base_addr(cv::pixel_buffer::LockFlags::DEFAULT);
        }
        buf
    }

    /// The shipped software path's conversion: lock the IOSurface and copy
    /// both NV12 planes into a reusable ffmpeg frame (mirrors
    /// `fill_frame_from_sample_buf` / `copy_plane_data`).
    fn fill_sw_frame(src: &mut arc::R<cv::PixelBuf>, dst: &mut ffmpeg::frame::Video) {
        unsafe {
            src.lock_base_addr(cv::pixel_buffer::LockFlags::READ_ONLY)
                .result()
                .expect("lock source");
        }
        let width = src.width();
        let height = src.height();
        let y_stride = src.plane_bytes_per_row(0);
        let uv_stride = src.plane_bytes_per_row(1);
        let uv_height = src.plane_height(1);
        unsafe {
            let y_src = std::slice::from_raw_parts(src.plane_base_address(0), y_stride * height);
            let dst_y_stride = dst.stride(0);
            let y_dst = dst.data_mut(0);
            if y_stride == width && dst_y_stride == width {
                y_dst[..width * height].copy_from_slice(&y_src[..width * height]);
            } else {
                for row in 0..height {
                    y_dst[row * dst_y_stride..row * dst_y_stride + width]
                        .copy_from_slice(&y_src[row * y_stride..row * y_stride + width]);
                }
            }
            let uv_src =
                std::slice::from_raw_parts(src.plane_base_address(1), uv_stride * uv_height);
            let dst_uv_stride = dst.stride(1);
            let uv_dst = dst.data_mut(1);
            if uv_stride == width && dst_uv_stride == width {
                uv_dst[..width * uv_height].copy_from_slice(&uv_src[..width * uv_height]);
            } else {
                for row in 0..uv_height {
                    uv_dst[row * dst_uv_stride..row * dst_uv_stride + width]
                        .copy_from_slice(&uv_src[row * uv_stride..row * uv_stride + width]);
                }
            }
            src.unlock_lock_base_addr(cv::pixel_buffer::LockFlags::READ_ONLY);
        }
    }

    struct Stats {
        samples: Vec<f64>,
        cpu_us_per_frame: f64,
    }

    impl Stats {
        fn new() -> Self {
            Self {
                samples: Vec::with_capacity(FRAMES),
                cpu_us_per_frame: 0.0,
            }
        }

        fn report(&mut self) -> (f64, f64, f64) {
            self.samples
                .sort_by(|a, b| a.partial_cmp(b).expect("no NaN samples"));
            let mean = self.samples.iter().sum::<f64>() / self.samples.len() as f64;
            let p50 = self.samples[self.samples.len() / 2];
            let p95 = self.samples[(self.samples.len() as f64 * 0.95) as usize];
            (mean, p50, p95)
        }
    }

    /// Process CPU time (user + system) in microseconds. The encoder work all
    /// happens in-process (VideoToolbox sessions included), so the delta over
    /// a paced run divided by frames is the honest CPU cost per frame.
    fn process_cpu_us() -> f64 {
        let mut usage: libc::rusage = unsafe { std::mem::zeroed() };
        let result = unsafe { libc::getrusage(libc::RUSAGE_SELF, &mut usage) };
        assert_eq!(result, 0);
        let user = usage.ru_utime.tv_sec as f64 * 1e6 + usage.ru_utime.tv_usec as f64;
        let system = usage.ru_stime.tv_sec as f64 * 1e6 + usage.ru_stime.tv_usec as f64;
        user + system
    }

    /// Sleeps until this frame's paced slot so encode work interleaves at the
    /// real capture cadence instead of saturating the encoder queue.
    fn pace(run_start: Instant, index: usize, frame_ns: u64) {
        let due = run_start + Duration::from_nanos(index as u64 * frame_ns);
        let now = Instant::now();
        if due > now {
            std::thread::sleep(due - now);
        }
    }

    fn assemble(dir: &Path) -> PathBuf {
        let mut segments: Vec<PathBuf> = std::fs::read_dir(dir)
            .expect("read segment dir")
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| p.extension().is_some_and(|ext| ext == "m4s"))
            .collect();
        segments.sort();
        assert!(!segments.is_empty(), "no media segments in {dir:?}");
        let output = dir.join("assembled.mp4");
        concatenate_m4s_segments_with_init(&dir.join("init.mp4"), &segments, &output)
            .expect("assemble segments");
        output
    }

    fn decode_frames(path: &Path) -> Vec<Vec<u8>> {
        let mut input = ffmpeg::format::input(path).expect("open assembled output");
        let stream_index = input
            .streams()
            .best(ffmpeg::media::Type::Video)
            .expect("video stream")
            .index();
        let params = input.stream(stream_index).unwrap().parameters();
        let context = ffmpeg::codec::context::Context::from_parameters(params).expect("context");
        let mut decoder = context.decoder().video().expect("decoder");

        fn plane_row_bytes(format: ffmpeg::format::Pixel, plane: usize, width: usize) -> usize {
            match (format, plane) {
                (ffmpeg::format::Pixel::YUV420P, 0) => width,
                (ffmpeg::format::Pixel::YUV420P, _) => width.div_ceil(2),
                (ffmpeg::format::Pixel::NV12, _) => width,
                other => panic!("unexpected decoded pixel format {other:?}"),
            }
        }

        fn collect(decoder: &mut ffmpeg::codec::decoder::Video, frames: &mut Vec<Vec<u8>>) {
            let mut frame = ffmpeg::frame::Video::empty();
            while decoder.receive_frame(&mut frame).is_ok() {
                let width = frame.width() as usize;
                let height = frame.height() as usize;
                let mut tight = Vec::new();
                for plane in 0..frame.planes() {
                    let stride = frame.stride(plane);
                    let row_bytes = plane_row_bytes(frame.format(), plane, width);
                    let rows = if plane == 0 {
                        height
                    } else {
                        height.div_ceil(2)
                    };
                    let data = frame.data(plane);
                    for row in 0..rows {
                        tight.extend_from_slice(&data[row * stride..row * stride + row_bytes]);
                    }
                }
                frames.push(tight);
            }
        }

        let mut frames = Vec::new();
        for (stream, packet) in input.packets() {
            if stream.index() != stream_index {
                continue;
            }
            if decoder.send_packet(&packet).is_ok() {
                collect(&mut decoder, &mut frames);
            }
        }
        let _ = decoder.send_eof();
        collect(&mut decoder, &mut frames);
        frames
    }

    fn compare(label: &str, a: &[Vec<u8>], b: &[Vec<u8>]) -> u8 {
        assert_eq!(
            a.len(),
            b.len(),
            "{label}: decoded frame counts differ ({} vs {})",
            a.len(),
            b.len()
        );
        let mut max_delta = 0u8;
        for (frame_a, frame_b) in a.iter().zip(b.iter()) {
            assert_eq!(frame_a.len(), frame_b.len(), "{label}: frame sizes differ");
            for (x, y) in frame_a.iter().zip(frame_b.iter()) {
                max_delta = max_delta.max(x.abs_diff(*y));
            }
        }
        max_delta
    }

    fn dir_size(dir: &Path) -> u64 {
        std::fs::read_dir(dir)
            .map(|entries| {
                entries
                    .flatten()
                    .filter(|e| {
                        e.path()
                            .extension()
                            .is_some_and(|ext| ext == "m4s" || ext == "mp4")
                    })
                    .filter(|e| e.file_name() != "assembled.mp4")
                    .filter_map(|e| e.metadata().ok().map(|m| m.len()))
                    .sum()
            })
            .unwrap_or(0)
    }

    fn run_sw(
        dir: &Path,
        frames: &mut [arc::R<cv::PixelBuf>],
        info: VideoInfo,
        fps: u32,
    ) -> (Stats, Vec<Vec<u8>>, u64) {
        let mut encoder = SegmentedVideoEncoder::init(
            dir.to_path_buf(),
            info,
            SegmentedVideoEncoderConfig {
                preset: H264Preset::Ultrafast,
                ..Default::default()
            },
        )
        .expect("software encoder");
        assert!(!encoder.is_videotoolbox_hw_input());

        let mut reusable =
            ffmpeg::frame::Video::new(ffmpeg::format::Pixel::NV12, info.width, info.height);
        let mut stats = Stats::new();
        let frame_ns = 1_000_000_000u64 / fps as u64;
        let run_start = Instant::now();
        let mut cpu_at_measure_start = 0.0;
        for i in 0..(WARMUP + FRAMES) {
            pace(run_start, i, frame_ns);
            if i == WARMUP {
                cpu_at_measure_start = process_cpu_us();
            }
            let src = &mut frames[i % UNIQUE_FRAMES];
            let timestamp = Duration::from_nanos(i as u64 * frame_ns);
            let started = Instant::now();
            fill_sw_frame(src, &mut reusable);
            let mut owned =
                ffmpeg::frame::Video::new(ffmpeg::format::Pixel::NV12, info.width, info.height);
            std::mem::swap(&mut owned, &mut reusable);
            encoder.queue_frame(owned, timestamp).expect("queue sw");
            let elapsed = started.elapsed().as_secs_f64() * 1e6;
            if i >= WARMUP {
                stats.samples.push(elapsed);
            }
        }
        stats.cpu_us_per_frame = (process_cpu_us() - cpu_at_measure_start) / FRAMES as f64;
        encoder.finish().expect("finish sw");
        let assembled = assemble(dir);
        let decoded = decode_frames(&assembled);
        (stats, decoded, dir_size(dir))
    }

    fn run_hw(
        dir: &Path,
        frames: &[arc::R<cv::PixelBuf>],
        info: VideoInfo,
        fps: u32,
    ) -> Option<(Stats, Vec<Vec<u8>>, u64)> {
        let mut encoder = SegmentedVideoEncoder::init(
            dir.to_path_buf(),
            info,
            SegmentedVideoEncoderConfig {
                preset: H264Preset::Ultrafast,
                prefer_videotoolbox_hw_input: true,
                ..Default::default()
            },
        )
        .expect("hw encoder init");
        if !encoder.is_videotoolbox_hw_input() {
            return None;
        }

        let mut stats = Stats::new();
        let frame_ns = 1_000_000_000u64 / fps as u64;
        let run_start = Instant::now();
        let mut cpu_at_measure_start = 0.0;
        for i in 0..(WARMUP + FRAMES) {
            pace(run_start, i, frame_ns);
            if i == WARMUP {
                cpu_at_measure_start = process_cpu_us();
            }
            let src = &frames[i % UNIQUE_FRAMES];
            let timestamp = Duration::from_nanos(i as u64 * frame_ns);
            let ptr = src.as_ref() as *const cv::PixelBuf as *mut c_void;
            let started = Instant::now();
            encoder
                .queue_hw_pixel_buffer(ptr, timestamp)
                .expect("queue hw");
            let elapsed = started.elapsed().as_secs_f64() * 1e6;
            if i >= WARMUP {
                stats.samples.push(elapsed);
            }
        }
        stats.cpu_us_per_frame = (process_cpu_us() - cpu_at_measure_start) / FRAMES as f64;
        encoder.finish().expect("finish hw");
        let assembled = assemble(dir);
        let decoded = decode_frames(&assembled);
        Some((stats, decoded, dir_size(dir)))
    }

    pub fn run() {
        ffmpeg::init().ok();
        let configs = [
            (1920usize, 1080usize, 30u32),
            (3840, 2160, 30),
            (3840, 2160, 60),
        ];
        println!(" config |    path | mean / p50 / p95 (us) | output bytes");

        for (width, height, fps) in configs {
            let label = format!("{width}x{height}@{fps}");
            let info = VideoInfo::from_raw(
                cap_media_info::RawVideoFormat::Nv12,
                width as u32,
                height as u32,
                fps,
            );
            let mut frames: Vec<_> = (0..UNIQUE_FRAMES)
                .map(|i| make_420v_frame(width, height, i))
                .collect();

            let base =
                std::env::temp_dir().join(format!("vt-hwframe-bench-{width}x{height}-{fps}"));
            let _ = std::fs::remove_dir_all(&base);
            let sw_dir = base.join("sw");
            let sw2_dir = base.join("sw2");
            let hw_dir = base.join("hw");
            std::fs::create_dir_all(&sw_dir).unwrap();
            std::fs::create_dir_all(&sw2_dir).unwrap();
            std::fs::create_dir_all(&hw_dir).unwrap();

            let (mut sw_stats, sw_decoded, sw_bytes) = run_sw(&sw_dir, &mut frames, info, fps);
            let (_, sw2_decoded, _) = run_sw(&sw2_dir, &mut frames, info, fps);
            let control_delta = compare(&format!("{label} sw-vs-sw"), &sw_decoded, &sw2_decoded);

            let hw_result = run_hw(&hw_dir, &frames, info, fps);

            let (mean, p50, p95) = sw_stats.report();
            let cpu = sw_stats.cpu_us_per_frame;
            println!(
                "{label} |      sw | {mean:8.1} / {p50:8.1} / {p95:8.1} | cpu/frame {cpu:8.1} | {sw_bytes}"
            );
            println!(
                "{label} | control | sw runs twice: decoded max channel delta {control_delta}"
            );

            match hw_result {
                Some((mut hw_stats, hw_decoded, hw_bytes)) => {
                    let (mean, p50, p95) = hw_stats.report();
                    let cpu = hw_stats.cpu_us_per_frame;
                    println!(
                        "{label} |      hw | {mean:8.1} / {p50:8.1} / {p95:8.1} | cpu/frame {cpu:8.1} | {hw_bytes}"
                    );
                    let delta = compare(&format!("{label} sw-vs-hw"), &sw_decoded, &hw_decoded);
                    let size_ratio = hw_bytes as f64 / sw_bytes.max(1) as f64;
                    println!(
                        "{label} | sw-vs-hw decoded max channel delta {delta}, size ratio {size_ratio:.4}"
                    );
                }
                None => {
                    println!(
                        "{label} |      hw | refused (expected for rates beyond the VT cap) -- software fallback engaged"
                    );
                }
            }
        }
    }
}
