//! Pixel-exactness guard for the camera preview's IOSurface conversion.
//!
//! The preview used to VideoToolbox-transfer camera frames into a CPU pixel
//! buffer and row-copy them into a `RenderImage`; it now transfers into an
//! IOSurface-backed buffer painted directly by gpui. Both destinations must
//! receive byte-identical BGRA from the same source, or the switch changed
//! what the user sees.

#![cfg(target_os = "macos")]

use cidre::{arc, cf, cv, vt};

unsafe extern "C-unwind" {
    fn CVPixelBufferGetBaseAddress(pixel_buf: *const cv::PixelBuf) -> *const u8;
    fn CVPixelBufferGetBytesPerRow(pixel_buf: *const cv::PixelBuf) -> usize;
}

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

fn make_420v_source(width: usize, height: usize) -> arc::R<cv::PixelBuf> {
    let attrs = iosurface_attrs();
    let mut buf = cv::PixelBuf::new(width, height, cv::PixelFormat::_420V, Some(&attrs))
        .expect("420v source");
    unsafe {
        buf.lock_base_addr(cv::pixel_buffer::LockFlags::DEFAULT)
            .result()
            .expect("lock source");
    }
    let y_stride = buf.plane_bytes_per_row(0);
    let uv_stride = buf.plane_bytes_per_row(1);
    let uv_height = buf.plane_height(1);
    unsafe {
        let y_base = buf.plane_base_address(0).cast_mut();
        for row in 0..buf.plane_height(0) {
            for col in 0..width {
                *y_base.add(row * y_stride + col) = 16 + ((row * 7 + col * 3) % 220) as u8;
            }
        }
        let uv_base = buf.plane_base_address(1).cast_mut();
        for row in 0..uv_height {
            for pair in 0..(width / 2) {
                *uv_base.add(row * uv_stride + pair * 2) = 16 + ((row * 5 + pair * 2) % 208) as u8;
                *uv_base.add(row * uv_stride + pair * 2 + 1) =
                    16 + ((row * 3 + pair * 5) % 208) as u8;
            }
        }
        buf.unlock_lock_base_addr(cv::pixel_buffer::LockFlags::DEFAULT);
    }
    buf
}

fn read_bgra(buf: &mut arc::R<cv::PixelBuf>, width: usize, height: usize) -> Vec<u8> {
    let mut data = vec![0u8; width * height * 4];
    let ptr = buf.as_ref() as *const cv::PixelBuf;
    let _guard = buf
        .base_address_lock(cv::pixel_buffer::LockFlags::READ_ONLY)
        .expect("lock destination");
    let base = unsafe { CVPixelBufferGetBaseAddress(ptr) };
    let stride = unsafe { CVPixelBufferGetBytesPerRow(ptr) };
    assert!(!base.is_null() && stride >= width * 4);
    for row in 0..height {
        let src_row = unsafe { std::slice::from_raw_parts(base.add(row * stride), width * 4) };
        data[row * width * 4..(row + 1) * width * 4].copy_from_slice(src_row);
    }
    data
}

#[test]
fn the_iosurface_destination_matches_the_cpu_destination() {
    for (width, height) in [(1280usize, 720usize), (1920, 1080)] {
        let src = make_420v_source(width, height);
        let mut session = vt::PixelTransferSession::new().expect("VT session");
        session.set_realtime(true).expect("VT realtime");

        let mut cpu_dst = cv::PixelBuf::new(width, height, cv::PixelFormat::_32_BGRA, None)
            .expect("CPU destination");
        let attrs = iosurface_attrs();
        let mut surface_dst =
            cv::PixelBuf::new(width, height, cv::PixelFormat::_32_BGRA, Some(&attrs))
                .expect("IOSurface destination");
        assert!(surface_dst.io_surf().is_some());

        session.transfer(&src, &cpu_dst).expect("transfer to CPU");
        session
            .transfer(&src, &surface_dst)
            .expect("transfer to IOSurface");

        let cpu = read_bgra(&mut cpu_dst, width, height);
        let surface = read_bgra(&mut surface_dst, width, height);
        let mut max_delta = 0u8;
        for (a, b) in cpu.iter().zip(surface.iter()) {
            max_delta = max_delta.max(a.abs_diff(*b));
        }
        assert_eq!(
            max_delta, 0,
            "{width}x{height}: VideoToolbox output diverged between CPU and IOSurface destinations"
        );
    }
}
