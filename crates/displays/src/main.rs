use std::{thread::sleep, time::Duration};

fn main() {
    loop {
        dbg!(cap_displays::DisplayImpl::get_display_at_cursor().map(|d| d.id()));
        sleep(Duration::from_millis(50));
    }
}
