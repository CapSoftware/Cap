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
//! `--bubble` instead measures the preview's conversion at full camera size
//! (what `main` converts every frame to) against the bubble-sized cover
//! target, for small/medium/large bubbles on a 2x display, mirrored and not:
//! per-frame time, bytes written per frame, the ring's resident memory, and
//! how close each looks once gpui's linear sampler draws it at bubble size.
//!
//! Run: cargo run -p cap-desktop-gpui --example camera-preview-convert-benchmark --release [-- --bubble]

#[cfg(not(target_os = "macos"))]
fn main() {
    eprintln!("macOS only");
}

#[cfg(target_os = "macos")]
fn main() {
    if std::env::args().any(|arg| arg == "--bubble") {
        macos::bubble();
    } else {
        macos::run();
    }
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

    type CreateRotationSession = unsafe extern "C-unwind" fn(
        Option<&cf::Allocator>,
        *mut Option<arc::R<vt::PixelRotationSession>>,
    ) -> cidre::os::Status;
    type RotateImage = unsafe extern "C-unwind" fn(
        &vt::PixelRotationSession,
        &cv::PixelBuf,
        &mut cv::PixelBuf,
    ) -> cidre::os::Status;

    struct FlipSession {
        session: arc::R<vt::PixelRotationSession>,
        rotate_image: RotateImage,
    }

    impl FlipSession {
        fn new() -> Self {
            let create = unsafe {
                libc::dlsym(libc::RTLD_DEFAULT, c"VTPixelRotationSessionCreate".as_ptr())
            };
            let rotate = unsafe {
                libc::dlsym(
                    libc::RTLD_DEFAULT,
                    c"VTPixelRotationSessionRotateImage".as_ptr(),
                )
            };
            let key = unsafe {
                libc::dlsym(
                    libc::RTLD_DEFAULT,
                    c"kVTPixelRotationPropertyKey_FlipHorizontalOrientation".as_ptr(),
                )
            };
            assert!(!create.is_null() && !rotate.is_null() && !key.is_null());
            let create =
                unsafe { std::mem::transmute::<*mut libc::c_void, CreateRotationSession>(create) };
            let rotate_image =
                unsafe { std::mem::transmute::<*mut libc::c_void, RotateImage>(rotate) };
            let key = unsafe { key.cast::<*const cf::String>().read().as_ref() }
                .expect("flip property key");
            let mut session = None;
            unsafe { create(None, &mut session).result() }.expect("rotation session");
            let mut session = session.expect("rotation session");
            session
                .set_prop(key, Some(cf::Boolean::value_true().as_ref()))
                .expect("flip property");
            Self {
                session,
                rotate_image,
            }
        }

        fn rotate(&self, source: &cv::PixelBuf, destination: &mut cv::PixelBuf) {
            unsafe { (self.rotate_image)(&self.session, source, destination).result() }
                .expect("flip");
        }
    }

    const MAIN_RING: usize = 4;
    const PREVIEW_RING: usize = 6;
    const QUALITY_SEED: u8 = 200;

    struct Case {
        dims: (usize, usize),
        stats: (f64, f64, f64),
        cpu_us: f64,
        buffer_bytes: usize,
        output: Vec<u8>,
    }

    fn bgra_ring(count: usize, (width, height): (usize, usize)) -> Vec<arc::R<cv::PixelBuf>> {
        let attrs = iosurface_bgra_attrs();
        (0..count)
            .map(|_| {
                let buf = cv::PixelBuf::new(width, height, cv::PixelFormat::_32_BGRA, Some(&attrs))
                    .expect("IOSurface BGRA destination");
                assert!(buf.io_surf().is_some());
                buf
            })
            .collect()
    }

    fn process_cpu_us() -> f64 {
        let mut usage = unsafe { std::mem::zeroed::<libc::rusage>() };
        unsafe { libc::getrusage(libc::RUSAGE_SELF, &mut usage) };
        let micros = |time: libc::timeval| time.tv_sec as f64 * 1e6 + time.tv_usec as f64;
        micros(usage.ru_utime) + micros(usage.ru_stime)
    }

    fn run_case(
        sources: &[arc::R<cv::PixelBuf>],
        quality_source: &cv::PixelBuf,
        dims: (usize, usize),
        mirrored: bool,
    ) -> Case {
        let mut session = vt::PixelTransferSession::new().expect("VT session");
        session.set_realtime(true).expect("VT realtime");
        let flip = mirrored.then(FlipSession::new);
        let mut ring = bgra_ring(PREVIEW_RING, dims);
        let scratch = flip.as_ref().map(|_| bgra_ring(1, dims).remove(0));
        let mut stats = Stats::new();
        let mut next = 0;
        let mut cpu_started = 0.0;
        for iteration in 0..(WARMUP + ITERATIONS) {
            if iteration == WARMUP {
                cpu_started = process_cpu_us();
            }
            let source = &sources[iteration % sources.len()];
            let out = &mut ring[next];
            let started = Instant::now();
            match (&flip, &scratch) {
                (Some(flip), Some(scratch)) => {
                    session.transfer(source, scratch).expect("transfer");
                    flip.rotate(scratch, out);
                }
                _ => session.transfer(source, out).expect("transfer"),
            }
            let elapsed = started.elapsed().as_secs_f64() * 1e6;
            next = (next + 1) % PREVIEW_RING;
            if iteration >= WARMUP {
                stats.push(elapsed);
            }
        }
        let cpu_us = (process_cpu_us() - cpu_started) / ITERATIONS as f64;
        session
            .transfer(quality_source, &ring[0])
            .expect("quality transfer");
        let buffer_bytes = {
            let ptr = ring[0].as_ref() as *const cv::PixelBuf;
            unsafe { CVPixelBufferGetBytesPerRow(ptr) * dims.1 }
        };
        let output = read_bgra(&mut ring[0], dims.0, dims.1);
        Case {
            dims,
            stats: stats.report(),
            cpu_us,
            buffer_bytes,
            output,
        }
    }

    fn make_quality_source(width: usize, height: usize) -> arc::R<cv::PixelBuf> {
        let mut buf = make_420v_source(width, height, QUALITY_SEED);
        unsafe {
            buf.lock_base_addr(cv::pixel_buffer::LockFlags::DEFAULT)
                .result()
                .expect("lock 420v source");
            let y_stride = buf.plane_bytes_per_row(0);
            let y_base = buf.plane_base_address(0).cast_mut();
            for row in 0..height {
                for col in 0..width {
                    let x = col as f64 / width as f64;
                    let y = row as f64 / height as f64;
                    let smooth = 0.5 + 0.25 * (x * 23.0).sin() * (y * 17.0).cos();
                    let detail = 0.15 * ((x * 640.0).sin() * (y * 360.0).sin());
                    let edge = if ((col * 8 / width) + (row * 6 / height)) % 2 == 0 {
                        0.1
                    } else {
                        -0.1
                    };
                    let value = (smooth + detail + edge).clamp(0.0, 1.0);
                    *y_base.add(row * y_stride + col) = (16.0 + value * 219.0) as u8;
                }
            }
            buf.unlock_lock_base_addr(cv::pixel_buffer::LockFlags::DEFAULT);
        }
        buf
    }

    fn area_average(pixels: &[u8], src: (usize, usize), dst: (usize, usize)) -> Vec<f64> {
        let mut out = vec![0.0; dst.0 * dst.1 * 4];
        for y in 0..dst.1 {
            let y0 = y * src.1 / dst.1;
            let y1 = ((y + 1) * src.1 / dst.1).max(y0 + 1);
            for x in 0..dst.0 {
                let x0 = x * src.0 / dst.0;
                let x1 = ((x + 1) * src.0 / dst.0).max(x0 + 1);
                let mut sum = [0.0; 4];
                for sy in y0..y1 {
                    for sx in x0..x1 {
                        let offset = (sy * src.0 + sx) * 4;
                        for (channel, total) in sum.iter_mut().enumerate() {
                            *total += pixels[offset + channel] as f64;
                        }
                    }
                }
                let count = ((y1 - y0) * (x1 - x0)) as f64;
                for (channel, total) in sum.iter().enumerate() {
                    out[(y * dst.0 + x) * 4 + channel] = total / count;
                }
            }
        }
        out
    }

    fn linear_sample(pixels: &[u8], src: (usize, usize), dst: (usize, usize)) -> Vec<f64> {
        let mut out = vec![0.0; dst.0 * dst.1 * 4];
        let texel =
            |x: usize, y: usize, channel: usize| pixels[(y * src.0 + x) * 4 + channel] as f64;
        for y in 0..dst.1 {
            let v = ((y as f64 + 0.5) * src.1 as f64 / dst.1 as f64 - 0.5)
                .clamp(0.0, (src.1 - 1) as f64);
            let (y0, fy) = (v.floor() as usize, v.fract());
            let y1 = (y0 + 1).min(src.1 - 1);
            for x in 0..dst.0 {
                let u = ((x as f64 + 0.5) * src.0 as f64 / dst.0 as f64 - 0.5)
                    .clamp(0.0, (src.0 - 1) as f64);
                let (x0, fx) = (u.floor() as usize, u.fract());
                let x1 = (x0 + 1).min(src.0 - 1);
                for channel in 0..4 {
                    let top = texel(x0, y0, channel) * (1.0 - fx) + texel(x1, y0, channel) * fx;
                    let bottom = texel(x0, y1, channel) * (1.0 - fx) + texel(x1, y1, channel) * fx;
                    out[(y * dst.0 + x) * 4 + channel] = top * (1.0 - fy) + bottom * fy;
                }
            }
        }
        out
    }

    fn psnr(reference: &[f64], candidate: &[f64]) -> f64 {
        let mut squared = 0.0;
        let mut count = 0usize;
        for (pixel, other) in reference.chunks_exact(4).zip(candidate.chunks_exact(4)) {
            for (a, b) in pixel[..3].iter().zip(&other[..3]) {
                squared += (a - b).powi(2);
                count += 1;
            }
        }
        let mse = squared / count as f64;
        if mse == 0.0 {
            return f64::INFINITY;
        }
        10.0 * (255.0f64.powi(2) / mse).log10()
    }

    fn mb(bytes: usize) -> f64 {
        bytes as f64 / 1_048_576.0
    }

    pub fn bubble() {
        let bubbles = [
            ("small 230pt round", (460.0f32, 460.0f32)),
            ("medium 400pt round", (800.0, 800.0)),
            ("large 600pt full", (600.0 * 16.0 / 9.0 * 2.0, 1200.0)),
        ];
        println!(
            "| source | bubble | mirrored | path | output | mean us | p50 us | p95 us | process CPU us | MB written/frame | ring MB | PSNR at bubble size dB |"
        );
        println!("|---|---|---|---|---|---|---|---|---|---|---|---|");
        for (width, height) in [(1280usize, 720usize), (1920, 1080), (3840, 2160)] {
            let sources: Vec<_> = (0..SOURCE_RING)
                .map(|seed| make_420v_source(width, height, seed as u8))
                .collect();
            let quality_source = make_quality_source(width, height);
            for mirrored in [false, true] {
                let passes = if mirrored { 2 } else { 1 };
                let scratch = usize::from(mirrored);
                let full = run_case(&sources, &quality_source, (width, height), mirrored);
                for (label, physical) in bubbles {
                    let displayed = cap_gpui_kernels::camera_preview::cover_dimensions(
                        (width, height),
                        (physical.0.ceil() as usize, physical.1.ceil() as usize),
                    );
                    let target = cap_gpui_kernels::camera_preview::quantized_target(physical)
                        .map_or((width, height), |target| {
                            cap_gpui_kernels::camera_preview::cover_dimensions(
                                (width, height),
                                target,
                            )
                        });
                    let bubble = run_case(&sources, &quality_source, target, mirrored);
                    let reference = area_average(&full.output, full.dims, displayed);
                    for (path, case, slots) in [
                        ("main (full size)", &full, MAIN_RING),
                        ("branch (bubble)", &bubble, PREVIEW_RING),
                    ] {
                        let (mean, p50, p95) = case.stats;
                        let shown = linear_sample(&case.output, case.dims, displayed);
                        println!(
                            "| {width}x{height} | {label} | {mirrored} | {path} | {}x{} | {mean:.1} | {p50:.1} | {p95:.1} | {:.1} | {:.2} | {:.1} | {:.2} |",
                            case.dims.0,
                            case.dims.1,
                            case.cpu_us,
                            mb(case.buffer_bytes * passes),
                            mb(case.buffer_bytes * (slots + scratch)),
                            psnr(&reference, &shown),
                        );
                    }
                }
            }
        }
        println!(
            "ring MB: main keeps {MAIN_RING} slots (#2761 and this branch {PREVIEW_RING}), plus one scratch buffer when mirrored; PSNR compares gpui's linear sampling of each output at the displayed cover size against an area average of the full-size conversion."
        );
    }
}
