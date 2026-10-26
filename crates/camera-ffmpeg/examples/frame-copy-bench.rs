#[cfg(windows)]
fn main() {
    use cap_camera::CapturedFrame;
    use cap_camera_ffmpeg::{copy_media_buffer_to_ffmpeg, media_buffer_as_ffmpeg};
    use cap_camera_windows::{Frame, PixelFormat};
    use cap_mediafoundation_utils::IMFMediaBufferExt;
    use ffmpeg::{format::Pixel, frame::Video};
    use std::time::{Duration, Instant};
    use windows::Win32::Media::MediaFoundation::{MFCreate2DMediaBuffer, MFCreateMemoryBuffer};

    const WIDTH: usize = 1920;
    const HEIGHT: usize = 1080;
    const ITERATIONS: usize = 1000;

    let len = WIDTH * HEIGHT * 3 / 2;

    let surface = unsafe {
        MFCreate2DMediaBuffer(
            WIDTH as u32,
            HEIGHT as u32,
            u32::from_le_bytes(*b"NV12"),
            false,
        )
    }
    .expect("2D camera buffer");
    {
        let mut lock = surface.lock_for_write().expect("surface lock");
        for (index, byte) in lock.iter_mut().enumerate() {
            *byte = (index * 31) as u8;
        }
    }
    let surface_frame = Frame::from_media_foundation(
        surface,
        PixelFormat::NV12,
        WIDTH,
        HEIGHT,
        false,
        Duration::ZERO,
        0,
    );
    let captured = CapturedFrame::from_windows_frame(surface_frame, Duration::ZERO);
    let native_buffer = captured.native().media_buffer().expect("native buffer");

    let memory = unsafe { MFCreateMemoryBuffer(len as u32) }.expect("camera buffer");
    {
        let mut lock = memory.lock_for_write().expect("buffer lock");
        for (index, byte) in lock.iter_mut().enumerate() {
            *byte = (index * 31) as u8;
        }
    }
    unsafe { memory.SetCurrentLength(len as u32) }.expect("buffer length");
    let memory_frame = Frame::from_media_foundation(
        memory,
        PixelFormat::NV12,
        WIDTH,
        HEIGHT,
        false,
        Duration::ZERO,
        0,
    );
    let copy_captured = CapturedFrame::from_windows_frame(memory_frame, Duration::ZERO);
    let copy_bytes = copy_captured.native().bytes().expect("camera bytes");

    for _ in 0..50 {
        let frame = media_buffer_as_ffmpeg(&native_buffer, PixelFormat::NV12, WIDTH, HEIGHT, false)
            .expect("warmup conversion");
        std::hint::black_box(frame);
    }

    let start = Instant::now();
    for _ in 0..ITERATIONS {
        let frame = media_buffer_as_ffmpeg(&native_buffer, PixelFormat::NV12, WIDTH, HEIGHT, false)
            .expect("conversion");
        std::hint::black_box(frame);
    }
    let zero_copy = start.elapsed();

    for _ in 0..50 {
        let frame = copy_media_buffer_to_ffmpeg(&native_buffer, PixelFormat::NV12, WIDTH, HEIGHT)
            .expect("warmup preview copy");
        std::hint::black_box(frame);
    }

    let start = Instant::now();
    for _ in 0..ITERATIONS {
        let frame = copy_media_buffer_to_ffmpeg(&native_buffer, PixelFormat::NV12, WIDTH, HEIGHT)
            .expect("preview copy");
        std::hint::black_box(frame);
    }
    let preview_copy = start.elapsed();

    let start = Instant::now();
    for _ in 0..ITERATIONS {
        let mut frame = Video::new(Pixel::NV12, WIDTH as u32, HEIGHT as u32);
        let stride = frame.stride(0);
        for row in 0..HEIGHT {
            frame.data_mut(0)[row * stride..row * stride + WIDTH]
                .copy_from_slice(&copy_bytes[row * WIDTH..row * WIDTH + WIDTH]);
        }
        let uv_stride = frame.stride(1);
        let uv_offset = WIDTH * HEIGHT;
        for row in 0..HEIGHT / 2 {
            frame.data_mut(1)[row * uv_stride..row * uv_stride + WIDTH].copy_from_slice(
                &copy_bytes[uv_offset + row * WIDTH..uv_offset + row * WIDTH + WIDTH],
            );
        }
        std::hint::black_box(frame);
    }
    let copy = start.elapsed();

    let start = Instant::now();
    for _ in 0..ITERATIONS {
        let buffer = captured.native().media_buffer().expect("native buffer");
        std::hint::black_box(buffer);
    }
    let buffer_clone = start.elapsed();

    let start = Instant::now();
    for _ in 0..ITERATIONS {
        let bytes = captured.native().bytes().expect("native bytes").to_vec();
        std::hint::black_box(bytes);
    }
    let bytes_copy = start.elapsed();

    println!(
        "zero-copy:    {:.3} ms/frame ({:.1} fps)",
        zero_copy.as_secs_f64() * 1000.0 / ITERATIONS as f64,
        ITERATIONS as f64 / zero_copy.as_secs_f64()
    );
    println!(
        "preview copy: {:.3} ms/frame ({:.1} fps)",
        preview_copy.as_secs_f64() * 1000.0 / ITERATIONS as f64,
        ITERATIONS as f64 / preview_copy.as_secs_f64()
    );
    println!(
        "row copy:     {:.3} ms/frame ({:.1} fps)",
        copy.as_secs_f64() * 1000.0 / ITERATIONS as f64,
        ITERATIONS as f64 / copy.as_secs_f64()
    );
    println!(
        "buffer clone: {:.3} ms/frame",
        buffer_clone.as_secs_f64() * 1000.0 / ITERATIONS as f64
    );
    println!(
        "bytes copy:   {:.3} ms/frame",
        bytes_copy.as_secs_f64() * 1000.0 / ITERATIONS as f64
    );
}

#[cfg(not(windows))]
fn main() {
    println!("frame-copy-bench requires Windows camera buffers");
}
