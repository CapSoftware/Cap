#[tokio::main]
pub async fn main() {
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

        let capture_handle = capturer
            .start(|frame| {
                use scap_ffmpeg::AsFFmpeg;

                let ff_frame = frame.as_ffmpeg()?;

                dbg!(ff_frame.width(), ff_frame.height(), ff_frame.format());

                Ok(())
            })
            .unwrap();

        std::thread::sleep(Duration::from_secs(3));

        capture_handle.stop().unwrap();

        std::thread::sleep(Duration::from_secs(3));
    }

    #[cfg(target_os = "macos")]
    {
        use std::time::Duration;

        use cidre::sc;
        use futures::executor::block_on;
        use scap_screencapturekit::*;
        use scap_targets::Display;

        let display = Display::primary();

        let config = StreamCfgBuilder::default()
            .with_fps(60.0)
            .with_width(display.physical_size().unwrap().width() as usize)
            .with_height(display.physical_size().unwrap().height() as usize)
            .build();

        let capturer = Capturer::builder(
            display
                .raw_handle()
                .as_content_filter(sc::ShareableContent::current().await.unwrap())
                .await
                .unwrap(),
            config,
        )
        .with_output_sample_buf_cb(|frame| {
            use scap_ffmpeg::AsFFmpeg;

            let Frame::Screen(video_frame) = frame else {
                return;
            };

            let ff_frame = video_frame.as_ffmpeg().unwrap();

            ff_frame.width();ff_frame.height();ff_frame.format();
        })
        .with_stop_with_err_cb(|stream, error| {
            (stream, error);
        })
        .build()
        .expect("Failed to build capturer");

        block_on(capturer.start()).expect("Failed to start capturing");

        std::thread::sleep(Duration::from_secs(3));

        block_on(capturer.stop()).expect("Failed to stop capturing");

        std::thread::sleep(Duration::from_secs(1));
    }
}
