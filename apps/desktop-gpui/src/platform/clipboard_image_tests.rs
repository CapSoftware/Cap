//! The benchmark times what runs on the main thread, next to the `NSImage`
//! write it replaced, on a private pasteboard so the user's clipboard is left
//! alone:
//!   cargo test --bin cap-gpui clipboard_image -- --ignored --nocapture

use std::time::Instant;

use objc2::rc::autoreleasepool;
use objc2::runtime::{AnyObject, Bool};
use objc2::{class, msg_send};
use objc2_foundation::{NSArray, NSData, NSString};

use super::mac::write_image_to_pasteboard;
use super::prepare_clipboard_image;

const SAMPLES: usize = 9;

fn screenshot_png(width: u32, height: u32) -> Vec<u8> {
    let mut noise = 0x2545_f491_u32;
    let image = image::RgbaImage::from_fn(width, height, |x, y| {
        let row = y % 40;
        match (y / 40) % 3 {
            1 => image::Rgba([(x * 255 / width) as u8, 120, (y * 255 / height) as u8, 255]),
            2 if (9..30).contains(&row) => {
                noise = noise.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                if noise >> 28 < 5 {
                    image::Rgba([30, 30, 34, 255])
                } else {
                    image::Rgba([245, 245, 247, 255])
                }
            }
            _ => image::Rgba([245, 245, 247, 255]),
        }
    });
    let mut bytes = Vec::new();
    image::DynamicImage::ImageRgba8(image)
        .write_to(
            &mut std::io::Cursor::new(&mut bytes),
            image::ImageFormat::Png,
        )
        .unwrap();
    bytes
}

unsafe fn private_pasteboard() -> *mut AnyObject {
    unsafe { msg_send![class!(NSPasteboard), pasteboardWithUniqueName] }
}

unsafe fn pasteboard_tiff(pasteboard: *mut AnyObject) -> (Vec<String>, Vec<u8>) {
    unsafe {
        let types: *mut NSArray<NSString> = msg_send![pasteboard, types];
        let types = types
            .as_ref()
            .map(|types| types.iter().map(|kind| kind.to_string()).collect())
            .unwrap_or_default();
        let kind = NSString::from_str("public.tiff");
        let data: *mut NSData = msg_send![pasteboard, dataForType: &*kind];
        let tiff = data.as_ref().map(NSData::to_vec).unwrap_or_default();
        (types, tiff)
    }
}

/// The write this replaced: the pasteboard is handed an `NSImage` and builds
/// the TIFF itself.
unsafe fn write_nsimage(pasteboard: *mut AnyObject, png: &[u8]) {
    unsafe {
        let data = NSData::with_bytes(png);
        let image: *mut AnyObject = msg_send![class!(NSImage), alloc];
        let image: *mut AnyObject = msg_send![image, initWithData: &*data];
        assert!(!image.is_null());
        let objects: *mut AnyObject = msg_send![class!(NSArray), arrayWithObject: image];
        let _: isize = msg_send![pasteboard, clearContents];
        let written: Bool = msg_send![pasteboard, writeObjects: objects];
        assert!(written.as_bool());
        let _: () = msg_send![image, release];
    }
}

#[test]
fn clipboard_image_matches_what_an_nsimage_writes() {
    let png = screenshot_png(640, 400);
    autoreleasepool(|_| unsafe {
        let reference = private_pasteboard();
        write_nsimage(reference, &png);
        let expected = pasteboard_tiff(reference);
        let _: () = msg_send![reference, releaseGlobally];

        let pasteboard = private_pasteboard();
        let prepared = prepare_clipboard_image(png.clone()).unwrap();
        write_image_to_pasteboard(pasteboard, &prepared).unwrap();
        let actual = pasteboard_tiff(pasteboard);
        let _: () = msg_send![pasteboard, releaseGlobally];

        assert_eq!(
            expected.0,
            ["public.tiff", "NeXT TIFF v4.0 pasteboard type"]
        );
        assert_eq!(actual.0, expected.0);
        assert!(!expected.1.is_empty());
        assert!(actual.1 == expected.1, "the TIFF bytes differ");
    });
}

#[test]
fn an_undecodable_clipboard_image_is_an_error() {
    autoreleasepool(|_| unsafe {
        let pasteboard = private_pasteboard();
        let result = prepare_clipboard_image(b"not an image".to_vec())
            .and_then(|image| write_image_to_pasteboard(pasteboard, &image));
        let _: () = msg_send![pasteboard, releaseGlobally];
        assert!(result.is_err());
    });
}

#[test]
#[ignore = "benchmark"]
fn benchmark_clipboard_image_main_thread_time() {
    for (width, height) in [(1920, 1080), (3024, 1964), (5120, 2880)] {
        let png = screenshot_png(width, height);
        let mut nsimage_ms = Vec::with_capacity(SAMPLES);
        let mut prepare_ms = Vec::with_capacity(SAMPLES);
        let mut main_thread_ms = Vec::with_capacity(SAMPLES);
        for _ in 0..SAMPLES {
            autoreleasepool(|_| unsafe {
                let reference = private_pasteboard();
                let started = Instant::now();
                write_nsimage(reference, &png);
                nsimage_ms.push(started.elapsed().as_secs_f64() * 1e3);
                let _: () = msg_send![reference, releaseGlobally];

                let pasteboard = private_pasteboard();
                let started = Instant::now();
                let prepared = prepare_clipboard_image(png.clone()).unwrap();
                prepare_ms.push(started.elapsed().as_secs_f64() * 1e3);
                let started = Instant::now();
                write_image_to_pasteboard(pasteboard, &prepared).unwrap();
                main_thread_ms.push(started.elapsed().as_secs_f64() * 1e3);
                let _: () = msg_send![pasteboard, releaseGlobally];
            });
        }
        nsimage_ms.sort_by(f64::total_cmp);
        prepare_ms.sort_by(f64::total_cmp);
        main_thread_ms.sort_by(f64::total_cmp);
        println!(
            "clipboard-bench: {width}x{height} png {} KB, NSImage write {:.2} ms, background prepare {:.2} ms, main_thread_ms {:.2}",
            png.len() / 1024,
            nsimage_ms[SAMPLES / 2],
            prepare_ms[SAMPLES / 2],
            main_thread_ms[SAMPLES / 2],
        );
    }
}
