fn main() {
    #[cfg(target_os = "macos")]
    macos::main();
}

#[cfg(target_os = "macos")]
mod macos {
    use cidre::sc;
    use scap_targets::Display;
    use std::time::Duration;

    use futures::executor::block_on;
    use scap_screencapturekit::{Capturer, StreamCfgBuilder};

    #[tokio::main]
    pub async fn main() {
        let display = Display::primary();
        let display = display.raw_handle();

        // let windows = block_on(Window::list()).expect("Failed to list windows");
        // let window = windows
        //     .iter()
        //     .find(|w| w.title().map(|t| t.starts_with("native")).unwrap_or(false))
        //     .expect("No native window found");

        let config = StreamCfgBuilder::default()
            .with_fps(60.0)
            .with_width(display.physical_size().unwrap().width() as usize)
            .with_height(display.physical_size().unwrap().height() as usize)
            .build();

        let capturer = Capturer::builder(
            block_on(display.as_content_filter(sc::ShareableContent::current().await.unwrap()))
                .expect("Failed to get display as content filter"),
            config,
        )
        .with_output_sample_buf_cb(|_| {
            // if let Some(image_buf) = buf.image_buf() {
            //     image_buf.show();
            // }
        })
        .with_stop_with_err_cb(|_, _| {})
        .build()
        .expect("Failed to build capturer");

        block_on(capturer.start()).expect("Failed to start capturing");

        std::thread::sleep(Duration::from_secs(3));

        block_on(capturer.stop()).expect("Failed to stop capturing");

        std::thread::sleep(Duration::from_secs(1));
    }
}
