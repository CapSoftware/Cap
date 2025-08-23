fn main() {
    #[cfg(windows)]
    windows::main();
}

#[cfg(windows)]
mod windows {
    use scap_direct3d::{Capturer, PixelFormat, Settings};
    use scap_ffmpeg::*;
    use scap_targets::*;
    use std::time::Duration;
    use windows::Win32::Graphics::Direct3D11::D3D11_BOX;

    pub fn main() {
        let display = Display::primary();
        let display = display.raw_handle();

        let capturer = Capturer::new(
            display.try_as_capture_item().unwrap(),
            Settings {
                is_border_required: Some(false),
                is_cursor_capture_enabled: Some(true),
                pixel_format: PixelFormat::R8G8B8A8Unorm,
                crop: Some(D3D11_BOX {
                    left: 0,
                    top: 0,
                    right: 500,
                    bottom: 400,
                    front: 0,
                    back: 1,
                }),
                ..Default::default()
            },
        );

        let capture_handle = capturer.start(
            |frame| {
                dbg!(&frame);

                let ff_frame = frame.as_ffmpeg()?;
                dbg!(ff_frame.width(), ff_frame.height(), ff_frame.format());

                Ok(())
            },
            || Ok(()),
        );

        std::thread::sleep(Duration::from_secs(3));

        capture_handle.stop().unwrap();

        std::thread::sleep(Duration::from_secs(3));
    }
}
