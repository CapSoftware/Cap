use scap_direct3d::{Capturer, Display, Settings};
use std::time::Duration;

fn main() {
    let display = Display::primary().unwrap();

    let capturer = Capturer::new(
        display.try_as_capture_item().unwrap(),
        Settings {
            is_border_required: Some(false),
            is_cursor_capture_enabled: Some(true),
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
