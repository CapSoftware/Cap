//! End-to-end check of the fork's `paint_surface_fitted`: opens a borderless
//! window, paints a quadrant-colored BGRA IOSurface as a circle with a cover
//! crop, screenshots the region, and asserts the clip, the crop orientation,
//! and the channel order. Exercises the runtime-compiled Metal shader, so a
//! shader regression fails here rather than at app launch.
//!
//! Run: cargo run -p cap-desktop-gpui --example surface-clip-check --release

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
    use std::process::Command;
    use std::time::Duration;

    use cidre::{arc, cf, cv};
    use core_foundation::base::TCFType as _;
    use core_video::pixel_buffer::{CVPixelBuffer, CVPixelBufferRef};
    use gpui::{
        App, AppContext as _, Bounds, Context, IntoElement, ParentElement as _, Render, Styled,
        Window, WindowBounds, WindowKind, WindowOptions, div, point, px, size,
    };

    const WINDOW_ORIGIN: (f32, f32) = (200., 200.);
    const WINDOW_SIZE: f32 = 400.;
    const PREVIEW_INSET: f32 = 50.;
    const PREVIEW_SIZE: f32 = 300.;
    const FRAME_WIDTH: usize = 640;
    const FRAME_HEIGHT: usize = 360;
    const UNROUNDED_ORIGIN: (f32, f32) = (170., 356.);
    const UNROUNDED_SIZE: (f32, f32) = (64., 36.);

    fn make_quadrant_frame() -> arc::R<cv::PixelBuf> {
        let io_surface_properties = cf::Dictionary::new();
        let keys: [&cf::Type; 2] = [
            cv::pixel_buffer::keys::io_surf_props().as_ref(),
            cv::pixel_buffer::keys::metal_compatibility().as_ref(),
        ];
        let values: [&cf::Type; 2] = [
            io_surface_properties.as_ref(),
            cf::Boolean::value_true().as_ref(),
        ];
        let attrs = cf::Dictionary::with_keys_values(&keys, &values).expect("attrs");
        let mut buf = cv::PixelBuf::new(
            FRAME_WIDTH,
            FRAME_HEIGHT,
            cv::PixelFormat::_32_BGRA,
            Some(&attrs),
        )
        .expect("BGRA frame");
        assert!(buf.io_surf().is_some(), "frame must be IOSurface-backed");

        unsafe extern "C-unwind" {
            fn CVPixelBufferGetBaseAddress(pixel_buf: *const cv::PixelBuf) -> *mut u8;
            fn CVPixelBufferGetBytesPerRow(pixel_buf: *const cv::PixelBuf) -> usize;
        }

        let ptr = buf.as_ref() as *const cv::PixelBuf;
        unsafe {
            buf.lock_base_addr(cv::pixel_buffer::LockFlags::DEFAULT)
                .result()
                .expect("lock frame");
            let base = CVPixelBufferGetBaseAddress(ptr);
            let stride = CVPixelBufferGetBytesPerRow(ptr);
            for row in 0..FRAME_HEIGHT {
                for col in 0..FRAME_WIDTH {
                    let top = row < FRAME_HEIGHT / 2;
                    let left = col < FRAME_WIDTH / 2;
                    // BGRA: TL red, TR magenta, BL blue, BR yellow.
                    let (b, g, r) = match (top, left) {
                        (true, true) => (0u8, 0u8, 255u8),
                        (true, false) => (255, 0, 255),
                        (false, true) => (255, 0, 0),
                        (false, false) => (0, 255, 255),
                    };
                    let px_ptr = base.add(row * stride + col * 4);
                    *px_ptr = b;
                    *px_ptr.add(1) = g;
                    *px_ptr.add(2) = r;
                    *px_ptr.add(3) = 255;
                }
            }
            buf.unlock_lock_base_addr(cv::pixel_buffer::LockFlags::DEFAULT);
        }
        buf
    }

    struct ClipCheckView {
        buffer: CVPixelBuffer,
    }

    impl Render for ClipCheckView {
        fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
            let buffer = self.buffer.clone();
            div()
                .size_full()
                .bg(gpui::rgb(0x202020))
                .child(gpui::canvas(
                    |_, _, _| {},
                    move |bounds, _, window, _| {
                        let preview = Bounds {
                            origin: point(
                                bounds.origin.x + px(PREVIEW_INSET),
                                bounds.origin.y + px(PREVIEW_INSET),
                            ),
                            size: size(px(PREVIEW_SIZE), px(PREVIEW_SIZE)),
                        };
                        let frame_size = gpui::size(
                            gpui::DevicePixels(FRAME_WIDTH as i32),
                            gpui::DevicePixels(FRAME_HEIGHT as i32),
                        );
                        let fitted = gpui::ObjectFit::Cover.get_bounds(preview, frame_size);
                        window.paint_surface_fitted(
                            preview,
                            fitted,
                            gpui::Corners::all(px(PREVIEW_SIZE / 2.)),
                            buffer.clone(),
                        );
                        // The editor preview's path: plain paint_surface, no
                        // radii, full-frame UVs. Its corners must stay sharp.
                        let unrounded = Bounds {
                            origin: point(
                                bounds.origin.x + px(UNROUNDED_ORIGIN.0),
                                bounds.origin.y + px(UNROUNDED_ORIGIN.1),
                            ),
                            size: size(px(UNROUNDED_SIZE.0), px(UNROUNDED_SIZE.1)),
                        };
                        window.paint_surface(unrounded, buffer.clone());
                    },
                ))
        }
    }

    #[derive(Clone, Copy, PartialEq, Debug)]
    enum Expected {
        Background,
        Red,
        Magenta,
        Blue,
        Yellow,
    }

    fn classify(pixel: [u8; 4]) -> Option<Expected> {
        let [r, g, b, _] = pixel;
        if r < 90 && g < 90 && b < 90 {
            Some(Expected::Background)
        } else if r > 140 && g < 110 && b < 110 {
            Some(Expected::Red)
        } else if r > 140 && g < 110 && b > 140 {
            Some(Expected::Magenta)
        } else if r < 110 && g < 110 && b > 140 {
            Some(Expected::Blue)
        } else if r > 140 && g > 140 && b < 110 {
            Some(Expected::Yellow)
        } else {
            None
        }
    }

    fn check_screenshot() -> Result<(), String> {
        let path = "/tmp/surface-clip-check.png";
        let region = format!(
            "{},{},{},{}",
            WINDOW_ORIGIN.0, WINDOW_ORIGIN.1, WINDOW_SIZE, WINDOW_SIZE
        );
        let status = Command::new("screencapture")
            .args(["-x", "-R", &region, path])
            .status()
            .map_err(|e| format!("screencapture failed to launch: {e}"))?;
        if !status.success() {
            return Err(format!("screencapture exited with {status}"));
        }
        let image = image::open(path)
            .map_err(|e| format!("could not open screenshot: {e}"))?
            .into_rgba8();
        let scale = image.width() as f32 / WINDOW_SIZE;

        // (window-local point, expectation, description)
        let cases: [((f32, f32), Expected, &str); 10] = [
            ((25., 25.), Expected::Background, "outside preview bounds"),
            (
                (62., 62.),
                Expected::Background,
                "inside bounds, outside circle (top-left)",
            ),
            (
                (62., 338.),
                Expected::Background,
                "inside bounds, outside circle (bottom-left)",
            ),
            ((140., 140.), Expected::Red, "top-left quadrant"),
            ((260., 140.), Expected::Magenta, "top-right quadrant"),
            ((140., 260.), Expected::Blue, "bottom-left quadrant"),
            ((260., 260.), Expected::Yellow, "bottom-right quadrant"),
            ((185., 60.), Expected::Red, "near top edge, inside circle"),
            (
                (171.5, 357.5),
                Expected::Red,
                "unrounded surface: top-left corner stays sharp",
            ),
            (
                (232.5, 390.5),
                Expected::Yellow,
                "unrounded surface: bottom-right corner stays sharp",
            ),
        ];

        let mut failures = Vec::new();
        for ((x, y), expected, description) in cases {
            let sx = (x * scale) as u32;
            let sy = (y * scale) as u32;
            let pixel = image.get_pixel(sx, sy).0;
            let actual = classify(pixel);
            let pass = actual == Some(expected);
            println!(
                "{} ({x},{y}) rgba={pixel:?} expected {expected:?} got {actual:?} -- {description}",
                if pass { "PASS" } else { "FAIL" },
            );
            if !pass {
                failures.push(description);
            }
        }
        if failures.is_empty() {
            Ok(())
        } else {
            Err(format!("{} sample(s) failed", failures.len()))
        }
    }

    pub fn run() {
        let app = gpui_platform::application();
        app.run(move |cx: &mut App| {
            let buffer = make_quadrant_frame();
            let raw = buffer.as_ref() as *const cv::PixelBuf as CVPixelBufferRef;
            let buffer = unsafe { CVPixelBuffer::wrap_under_get_rule(raw) };

            cx.open_window(
                WindowOptions {
                    window_bounds: Some(WindowBounds::Windowed(Bounds {
                        origin: point(px(WINDOW_ORIGIN.0), px(WINDOW_ORIGIN.1)),
                        size: size(px(WINDOW_SIZE), px(WINDOW_SIZE)),
                    })),
                    titlebar: None,
                    kind: WindowKind::PopUp,
                    focus: false,
                    show: true,
                    is_resizable: false,
                    is_minimizable: false,
                    window_background: gpui::WindowBackgroundAppearance::Opaque,
                    ..Default::default()
                },
                |_, cx| cx.new(|_| ClipCheckView { buffer }),
            )
            .expect("open window");

            cx.background_executor()
                .spawn(async move {
                    std::thread::sleep(Duration::from_millis(1500));
                    let result = check_screenshot();
                    match result {
                        Ok(()) => {
                            println!("surface-clip-check: PASS");
                            std::process::exit(0);
                        }
                        Err(message) => {
                            eprintln!("surface-clip-check: FAIL ({message})");
                            std::process::exit(1);
                        }
                    }
                })
                .detach();
        });
    }
}
