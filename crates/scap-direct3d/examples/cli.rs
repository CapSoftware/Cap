fn main() {
    #[cfg(windows)]
    win::main();
}

#[cfg(windows)]
mod win {
    use scap_direct3d::{Capturer, Display, PixelFormat, Settings};
    use std::time::Duration;

    pub fn main() {
        let display = Display::primary().unwrap();

        let capturer = Capturer::new(
            display.try_as_capture_item().unwrap(),
            Settings {
                is_border_required: Some(true),
                is_cursor_capture_enabled: Some(true),
                pixel_format: PixelFormat::R8G8B8A8Unorm,
            },
        );

        let capture_handle = capturer.start(|frame| {
            dbg!(frame);

            Ok(())
        });

        std::thread::sleep(Duration::from_secs(3));

        capture_handle.stop().unwrap();

        std::thread::sleep(Duration::from_secs(3));
    }
}
