use std::time::Duration;

use cidre::{cv, sc};
use futures::executor::block_on;
use scap_screencapturekit::{Capturer, Display, StreamCfgBuilder, Window};

fn main() {
    let display = block_on(Display::primary()).expect("Primary display not found");

    let windows = block_on(Window::list()).expect("Failed to list windows");
    let window = windows
        .iter()
        .find(|w| w.title().map(|t| t.starts_with("native")).unwrap_or(false))
        .expect("No native window found");

    let config = StreamCfgBuilder::default()
        .with_fps(1.0)
        .with_width(window.width())
        .with_height(window.height())
        .build();

    let capturer = Capturer::builder(
        window.as_content_filter(), /* display.as_content_filter()*/
        config,
    )
    .with_output_sample_buf_cb(|stream, buf, typ| {
        if let Some(image_buf) = buf.image_buf() {
            image_buf.show();
        }
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
