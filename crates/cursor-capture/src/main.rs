use cap_cursor_capture::RawCursorPosition;
use cap_displays::Display;

fn main() {
    loop {
        let position = RawCursorPosition::get()
            .relative_to_display(Display::list()[1])
            .unwrap()
            .normalize();

        println!("{position:?}");
    }
}
