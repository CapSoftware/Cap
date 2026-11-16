use super::{CAPTURE_FRAME_POOL_CAPACITY, CaptureFramePool, frame_from_pipewire_data, spa};
use std::{
    hint::black_box,
    os::fd::{AsRawFd, FromRawFd, OwnedFd},
    time::Instant,
};

struct MemfdFrame {
    fd: OwnedFd,
    mapping: *mut libc::c_void,
    len: usize,
    width: u32,
    height: u32,
}

impl MemfdFrame {
    fn new(width: u32, height: u32) -> Self {
        let len = width as usize * height as usize * 4;
        let raw_fd =
            unsafe { libc::memfd_create(c"cap-frame-pool-test".as_ptr(), libc::MFD_CLOEXEC) };
        assert!(raw_fd >= 0);
        let fd = unsafe { OwnedFd::from_raw_fd(raw_fd) };
        assert_eq!(unsafe { libc::ftruncate(fd.as_raw_fd(), len as i64) }, 0);
        let mapping = unsafe {
            libc::mmap(
                std::ptr::null_mut(),
                len,
                libc::PROT_READ | libc::PROT_WRITE,
                libc::MAP_SHARED,
                fd.as_raw_fd(),
                0,
            )
        };
        assert_ne!(mapping, libc::MAP_FAILED);
        unsafe { std::slice::from_raw_parts_mut(mapping.cast::<u8>(), len) }.fill(0x5a);
        Self {
            fd,
            mapping,
            len,
            width,
            height,
        }
    }

    fn capture(&mut self, pool: &mut CaptureFramePool) -> ffmpeg::frame::Video {
        let mut chunk = spa::sys::spa_chunk {
            offset: 0,
            size: self.len as u32,
            stride: (self.width * 4) as i32,
            flags: 0,
        };
        let mut raw: spa::sys::spa_data = unsafe { std::mem::zeroed() };
        raw.type_ = spa::sys::SPA_DATA_MemFd;
        raw.flags = spa::sys::SPA_DATA_FLAG_READABLE;
        raw.fd = i64::from(self.fd.as_raw_fd());
        raw.maxsize = self.len as u32;
        raw.data = self.mapping;
        raw.chunk = &mut chunk;
        let data =
            unsafe { &mut *(&mut raw as *mut spa::sys::spa_data).cast::<spa::buffer::Data>() };
        let mut format = spa::param::video::VideoInfoRaw::new();
        format.set_format(spa::param::video::VideoFormat::BGRx);
        format.set_size(spa::utils::Rectangle {
            width: self.width,
            height: self.height,
        });
        frame_from_pipewire_data(data, format, None, pool)
            .unwrap()
            .unwrap()
    }
}

impl Drop for MemfdFrame {
    fn drop(&mut self) {
        assert_eq!(unsafe { libc::munmap(self.mapping, self.len) }, 0);
    }
}

#[test]
fn memfd_frames_are_writable_in_place_and_recycled() {
    let mut source = MemfdFrame::new(63, 35);
    let mut pool = CaptureFramePool::new();
    let mut recycled = None;
    for _ in 0..12 {
        let mut frame = source.capture(&mut pool);
        let pixels = frame.data(0).as_ptr();
        let buffer = unsafe { (*frame.as_ptr()).buf[0] };
        assert_eq!(
            unsafe { ffmpeg::ffi::av_frame_is_writable(frame.as_mut_ptr()) },
            1
        );
        assert_eq!(unsafe { ffmpeg::ffi::av_buffer_get_ref_count(buffer) }, 1);
        assert_eq!(
            unsafe { ffmpeg::ffi::av_frame_make_writable(frame.as_mut_ptr()) },
            0
        );
        assert_eq!(frame.data(0).as_ptr(), pixels);
        assert_eq!(unsafe { (*frame.as_ptr()).buf[0] }, buffer);
        if let Some(recycled) = recycled {
            assert_eq!(pixels, recycled);
        }
        for row in frame.data(0).chunks(frame.stride(0)).take(35) {
            assert!(row[..63 * 4].iter().all(|byte| *byte == 0x5a));
        }
        frame.data_mut(0).fill(0x33);
        recycled = Some(pixels);
        drop(frame);
    }
}

#[test]
fn frame_pool_recycles_only_after_the_last_reference_on_another_thread() {
    let mut source = MemfdFrame::new(64, 48);
    let mut pool = CaptureFramePool::new();
    let frame = source.capture(&mut pool);
    let pixels = frame.data(0).as_ptr();
    let mut alias = ffmpeg::frame::Video::empty();
    assert_eq!(
        unsafe { ffmpeg::ffi::av_frame_ref(alias.as_mut_ptr(), frame.as_ptr()) },
        0
    );
    let held: Vec<_> = (1..CAPTURE_FRAME_POOL_CAPACITY)
        .map(|_| source.capture(&mut pool))
        .collect();
    drop(frame);
    assert!(pool.frames.lock().is_empty());
    assert!(held.iter().all(|frame| frame.data(0).as_ptr() != pixels));
    std::thread::spawn(move || drop(alias)).join().unwrap();
    assert_eq!(pool.frames.lock().len(), 1);
    let recycled = source.capture(&mut pool);
    assert_eq!(recycled.data(0).as_ptr(), pixels);
}

#[test]
fn frame_pool_keeps_copy_on_write_isolation_for_explicit_aliases() {
    let mut source = MemfdFrame::new(64, 48);
    let mut pool = CaptureFramePool::new();
    let frame = source.capture(&mut pool);
    let pixels = frame.data(0).as_ptr();
    let mut alias = ffmpeg::frame::Video::empty();
    assert_eq!(
        unsafe { ffmpeg::ffi::av_frame_ref(alias.as_mut_ptr(), frame.as_ptr()) },
        0
    );
    assert_eq!(
        unsafe { ffmpeg::ffi::av_frame_is_writable(alias.as_mut_ptr()) },
        0
    );
    assert_eq!(
        unsafe { ffmpeg::ffi::av_frame_make_writable(alias.as_mut_ptr()) },
        0
    );
    assert_ne!(alias.data(0).as_ptr(), pixels);
    alias.data_mut(0).fill(0xff);
    assert!(frame.data(0).iter().all(|byte| *byte == 0x5a));
    assert_eq!(pool.frames.lock().len(), CAPTURE_FRAME_POOL_CAPACITY - 1);
    drop(frame);
    assert_eq!(pool.frames.lock().len(), CAPTURE_FRAME_POOL_CAPACITY);
    let recycled = source.capture(&mut pool);
    assert_eq!(recycled.data(0).as_ptr(), pixels);
}

#[test]
fn frame_pool_retired_generations_and_shutdown_leave_live_frames_valid() {
    let format = ffmpeg::format::Pixel::BGRZ;
    let mut pool = CaptureFramePool::new();
    let mut frame = pool.acquire(format, 64, 48);
    frame.data_mut(0).fill(0x71);
    let frame = pool.share(frame);
    let retired = std::sync::Arc::downgrade(&pool.frames);
    let resized = pool.acquire(format, 32, 24);
    let resized = pool.share(resized);
    assert!(retired.upgrade().is_none());
    assert_eq!(pool.frames.lock().len(), CAPTURE_FRAME_POOL_CAPACITY - 1);
    assert!(frame.data(0).iter().all(|byte| *byte == 0x71));
    drop(frame);
    assert_eq!(pool.frames.lock().len(), CAPTURE_FRAME_POOL_CAPACITY - 1);
    drop(resized);

    let frame = pool.acquire(format, 32, 24);
    let mut frame = pool.share(frame);
    let current = std::sync::Arc::downgrade(&pool.frames);
    let current_pixels = frame.data(0).as_ptr();
    drop(pool);
    assert!(current.upgrade().is_none());
    assert_eq!(
        unsafe { ffmpeg::ffi::av_frame_make_writable(frame.as_mut_ptr()) },
        0
    );
    assert_eq!(frame.data(0).as_ptr(), current_pixels);
    frame.data_mut(0).fill(0x27);
    std::thread::spawn(move || drop(frame)).join().unwrap();
}

#[test]
fn frame_pool_preserves_packed_format_alignment_and_writability() {
    use ffmpeg::format::Pixel;

    let mut pool = CaptureFramePool::new();
    for format in [
        Pixel::RGBZ,
        Pixel::BGRZ,
        Pixel::ZRGB,
        Pixel::ZBGR,
        Pixel::RGBA,
        Pixel::BGRA,
        Pixel::ARGB,
        Pixel::ABGR,
        Pixel::RGB24,
        Pixel::BGR24,
    ] {
        let frame = pool.acquire(format, 63, 35);
        let pixels = frame.data(0).as_ptr();
        let stride = frame.stride(0);
        let mut frame = pool.share(frame);
        assert_eq!(
            (frame.format(), frame.width(), frame.height()),
            (format, 63, 35)
        );
        assert_eq!(frame.stride(0), stride);
        assert_eq!(stride % 32, 0);
        assert_eq!(
            unsafe { ffmpeg::ffi::av_frame_is_writable(frame.as_mut_ptr()) },
            1
        );
        assert_eq!(
            unsafe { ffmpeg::ffi::av_frame_make_writable(frame.as_mut_ptr()) },
            0
        );
        assert_eq!(frame.data(0).as_ptr(), pixels);
        drop(frame);
        assert_eq!(pool.frames.lock().len(), CAPTURE_FRAME_POOL_CAPACITY);
        let recycled = pool.acquire(format, 63, 35);
        assert_eq!(recycled.data(0).as_ptr(), pixels);
    }
}

fn report(label: &str, samples: &mut [f64]) {
    samples.sort_by(f64::total_cmp);
    println!(
        "{label}: median_ms={:.6} mean_ms={:.6} p95_ms={:.6}",
        samples[samples.len() / 2],
        samples.iter().sum::<f64>() / samples.len() as f64,
        samples[samples.len() * 95 / 100],
    );
}

#[test]
#[ignore = "timing benchmark; run with --ignored --nocapture --test-threads=1"]
fn capture_frame_pool_timing_benchmark() {
    const WARMUP: usize = 30;
    const SAMPLES: usize = 200;
    for (width, height) in [(1920, 1080), (3840, 2160)] {
        let mut source = MemfdFrame::new(width, height);
        for camera in [false, true] {
            let mut pool = CaptureFramePool::new();
            let mut previous = None;
            let mut capture_times = Vec::with_capacity(SAMPLES);
            let mut writable_times = Vec::with_capacity(SAMPLES);
            let mut copies = 0;
            for index in 0..WARMUP + SAMPLES {
                let started = Instant::now();
                let mut frame = source.capture(&mut pool);
                let capture_ms = started.elapsed().as_secs_f64() * 1000.0;
                if camera {
                    let pixels = frame.data(0).as_ptr();
                    let started = Instant::now();
                    assert_eq!(
                        unsafe { ffmpeg::ffi::av_frame_make_writable(frame.as_mut_ptr()) },
                        0
                    );
                    let writable_ms = started.elapsed().as_secs_f64() * 1000.0;
                    if index >= WARMUP {
                        writable_times.push(writable_ms);
                        copies += usize::from(pixels != frame.data(0).as_ptr());
                    }
                }
                black_box(frame.data(0));
                if index >= WARMUP {
                    capture_times.push(capture_ms);
                }
                previous = Some(frame);
                black_box(&previous);
            }
            black_box(previous);
            report(
                &format!("{width}x{height} camera={camera} capture"),
                &mut capture_times,
            );
            if camera {
                report(
                    &format!("{width}x{height} make_writable copies={copies}/{SAMPLES}"),
                    &mut writable_times,
                );
            }
        }
    }
}
