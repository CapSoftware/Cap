use std::time::Duration;

pub fn main() {
    #[cfg(windows)]
    {
        use scap_direct3d::*;

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
            use scap_ffmpeg::AsFFmpeg;

            let ff_frame = frame.as_ffmpeg()?;

            dbg!(ff_frame.width(), ff_frame.height(), ff_frame.format());

            Ok(())
        });

        std::thread::sleep(Duration::from_secs(3));

        capture_handle.stop().unwrap();

        std::thread::sleep(Duration::from_secs(3));
    }
}
