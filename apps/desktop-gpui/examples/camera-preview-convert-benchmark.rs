//! Camera-preview conversion benchmark: the shipped RenderImage path against
//! the IOSurface surface-paint path, head to head on synthetic 420v frames.
//!
//! "old" reproduces `frame::FrameConverter` in `src/camera_window.rs` exactly:
//! VideoToolbox transfers 420v -> BGRA into a reused CPU pixel buffer, then a
//! per-frame `vec![0; w*h*4]` + row-copy lifts it into a gpui `RenderImage`
//! (which the window then re-uploads through the sprite atlas -- not measured
//! here, so "old" numbers are a lower bound on the shipped cost).
//!
//! "new" is the replacement: the same VideoToolbox transfer, but into a
//! Metal-compatible IOSurface-backed BGRA buffer from a fixed ring, ready for
//! `paint_surface` with zero further CPU touches.
//!
//! Run: cargo run -p cap-desktop-gpui --example camera-preview-convert-benchmark --release

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
    use std::sync::Arc;
    use std::time::Instant;

    use cidre::{arc, cf, cv, vt};
    use gpui::RenderImage;
    use image::Frame;
    use smallvec::smallvec;

    unsafe extern "C-unwind" {
        fn CVPixelBufferGetBaseAddress(pixel_buf: *const cv::PixelBuf) -> *const u8;
        fn CVPixelBufferGetBytesPerRow(pixel_buf: *const cv::PixelBuf) -> usize;
    }

    const WARMUP: usize = 30;
    const ITERATIONS: usize = 300;
    const SOURCE_RING: usize = 4;
    const DEST_RING: usize = 4;

    struct Stats {
        samples: Vec<f64>,
    }

    impl Stats {
        fn new() -> Self {
            Self {
                samples: Vec::with_capacity(ITERATIONS),
            }
        }

        fn push(&mut self, us: f64) {
            self.samples.push(us);
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

    fn iosurface_bgra_attrs() -> arc::R<cf::Dictionary> {
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

    fn make_420v_source(width: usize, height: usize, seed: u8) -> arc::R<cv::PixelBuf> {
        let attrs = iosurface_bgra_attrs();
        let mut buf = cv::PixelBuf::new(width, height, cv::PixelFormat::_420V, Some(&attrs))
            .expect("420v source buffer");
        unsafe {
            buf.lock_base_addr(cv::pixel_buffer::LockFlags::DEFAULT)
                .result()
                .expect("lock 420v source");
        }
        let y_stride = buf.plane_bytes_per_row(0);
        let y_height = buf.plane_height(0);
        let uv_stride = buf.plane_bytes_per_row(1);
        let uv_height = buf.plane_height(1);
        unsafe {
            let y_base = buf.plane_base_address(0).cast_mut();
            for row in 0..y_height {
                for col in 0..width {
                    // Video-range luma with structure in both axes.
                    let value = 16 + ((row * 7 + col * 3 + seed as usize * 31) % 220) as u8;
                    *y_base.add(row * y_stride + col) = value;
                }
            }
            let uv_base = buf.plane_base_address(1).cast_mut();
            for row in 0..uv_height {
                for pair in 0..(width / 2) {
                    let cb = 16 + ((row * 5 + pair * 2 + seed as usize * 17) % 208) as u8;
                    let cr = 16 + ((row * 3 + pair * 5 + seed as usize * 23) % 208) as u8;
                    *uv_base.add(row * uv_stride + pair * 2) = cb;
                    *uv_base.add(row * uv_stride + pair * 2 + 1) = cr;
                }
            }
            buf.unlock_lock_base_addr(cv::pixel_buffer::LockFlags::DEFAULT);
        }
        buf
    }

    fn old_path_frame(
        session: &vt::PixelTransferSession,
        src: &cv::PixelBuf,
        dst: &mut arc::R<cv::PixelBuf>,
        width: usize,
        height: usize,
    ) -> Option<Arc<RenderImage>> {
        session.transfer(src, dst).ok()?;
        let mut data = vec![0u8; width * height * 4];
        {
            let dst_ptr = dst.as_ref() as *const cv::PixelBuf;
            let _guard = dst
                .base_address_lock(cv::pixel_buffer::LockFlags::READ_ONLY)
                .ok()?;
            let base = unsafe { CVPixelBufferGetBaseAddress(dst_ptr) };
            let stride = unsafe { CVPixelBufferGetBytesPerRow(dst_ptr) };
            if base.is_null() || stride < width * 4 {
                return None;
            }
            for row in 0..height {
                let src_row =
                    unsafe { std::slice::from_raw_parts(base.add(row * stride), width * 4) };
                data[row * width * 4..(row + 1) * width * 4].copy_from_slice(src_row);
            }
        }
        let buffer = image::RgbaImage::from_raw(width as u32, height as u32, data)?;
        Some(Arc::new(RenderImage::new(smallvec![Frame::new(buffer)])))
    }

    fn read_bgra(buf: &mut arc::R<cv::PixelBuf>, width: usize, height: usize) -> Vec<u8> {
        let mut data = vec![0u8; width * height * 4];
        let ptr = buf.as_ref() as *const cv::PixelBuf;
        let _guard = buf
            .base_address_lock(cv::pixel_buffer::LockFlags::READ_ONLY)
            .expect("lock BGRA destination");
        let base = unsafe { CVPixelBufferGetBaseAddress(ptr) };
        let stride = unsafe { CVPixelBufferGetBytesPerRow(ptr) };
        assert!(!base.is_null() && stride >= width * 4);
        for row in 0..height {
            let src_row = unsafe { std::slice::from_raw_parts(base.add(row * stride), width * 4) };
            data[row * width * 4..(row + 1) * width * 4].copy_from_slice(src_row);
        }
        data
    }

    pub fn run() {
        let resolutions = [(1280usize, 720usize), (1920, 1080), (3840, 2160)];
        println!(" resolution |    path | mean / p50 / p95 (us)");

        for (width, height) in resolutions {
            let sources: Vec<_> = (0..SOURCE_RING)
                .map(|seed| make_420v_source(width, height, seed as u8))
                .collect();

            let mut session = vt::PixelTransferSession::new().expect("VT session");
            session.set_realtime(true).expect("VT realtime");

            let mut cpu_dst = cv::PixelBuf::new(width, height, cv::PixelFormat::_32_BGRA, None)
                .expect("CPU BGRA destination");

            let attrs = iosurface_bgra_attrs();
            let mut surface_ring: Vec<arc::R<cv::PixelBuf>> = (0..DEST_RING)
                .map(|_| {
                    cv::PixelBuf::new(width, height, cv::PixelFormat::_32_BGRA, Some(&attrs))
                        .expect("IOSurface BGRA destination")
                })
                .collect();
            for slot in &surface_ring {
                assert!(
                    slot.io_surf().is_some(),
                    "destination ring must be IOSurface-backed"
                );
            }

            let mut old_stats = Stats::new();
            let mut new_stats = Stats::new();
            let mut next_slot = 0usize;

            for iteration in 0..(WARMUP + ITERATIONS) {
                let src = &sources[iteration % SOURCE_RING];

                let started = Instant::now();
                let image = old_path_frame(&session, src, &mut cpu_dst, width, height)
                    .expect("old path frame");
                let old_us = started.elapsed().as_secs_f64() * 1e6;
                drop(image);

                let started = Instant::now();
                session
                    .transfer(src, &surface_ring[next_slot])
                    .expect("transfer to IOSurface");
                let new_us = started.elapsed().as_secs_f64() * 1e6;
                next_slot = (next_slot + 1) % DEST_RING;

                if iteration >= WARMUP {
                    old_stats.push(old_us);
                    new_stats.push(new_us);
                }
            }

            let (mean, p50, p95) = old_stats.report();
            println!("{width}x{height:<6} |     old | {mean:8.1} / {p50:8.1} / {p95:8.1}");
            let (mean, p50, p95) = new_stats.report();
            println!("{width}x{height:<6} |     new | {mean:8.1} / {p50:8.1} / {p95:8.1}");

            session
                .transfer(&sources[0], &cpu_dst)
                .expect("exactness transfer to CPU");
            session
                .transfer(&sources[0], &surface_ring[0])
                .expect("exactness transfer to IOSurface");
            let cpu_pixels = read_bgra(&mut cpu_dst, width, height);
            let surface_pixels = read_bgra(&mut surface_ring[0], width, height);
            let mut max_delta = 0u8;
            let mut differing = 0usize;
            for (a, b) in cpu_pixels.iter().zip(surface_pixels.iter()) {
                let delta = a.abs_diff(*b);
                if delta > 0 {
                    differing += 1;
                }
                max_delta = max_delta.max(delta);
            }
            println!(
                "{width}x{height:<6} | exactness: max channel delta {max_delta}, {differing}/{} bytes differ",
                cpu_pixels.len()
            );
            assert!(
                max_delta <= 2,
                "IOSurface destination diverges from the CPU destination"
            );
        }
    }
}
