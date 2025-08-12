use std::time::Duration;

use futures::executor::block_on;
use scap_screencapturekit::{Capturer, Display, StreamCfgBuilder, Window};

fn main() {
    let display = block_on(Display::primary()).expect("Primary display not found");

    // let windows = block_on(Window::list()).expect("Failed to list windows");
    // let window = windows
    //     .iter()
    //     .find(|w| w.title().map(|t| t.starts_with("native")).unwrap_or(false))
    //     .expect("No native window found");

    let config = StreamCfgBuilder::default()
        .with_fps(60.0)
        .with_width(display.width())
        .with_height(display.height())
        .build();

    let capturer = Capturer::builder(display.as_content_filter(), config)
        .with_output_sample_buf_cb(|frame| {
            dbg!(frame.output_type());
            // if let Some(image_buf) = buf.image_buf() {
            //     image_buf.show();
            // }
        })
        .with_stop_with_err_cb(|stream, error| {
            dbg!(stream, error);
        })
        .build()
        .expect("Failed to build capturer");

    block_on(capturer.start()).expect("Failed to start capturing");

    std::thread::sleep(Duration::from_secs(3));

    block_on(capturer.stop()).expect("Failed to stop capturing");

    std::thread::sleep(Duration::from_secs(1));
}
