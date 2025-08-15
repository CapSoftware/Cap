use cap_cursor_capture::RawCursorPosition;
use cap_displays::{
    Display,
    bounds::{LogicalPosition, LogicalSize},
};

fn main() {
    loop {
        let position = RawCursorPosition::get()
            .relative_to_display(Display::list()[0])
            .normalize()
            .with_crop(LogicalPosition::new(0.0, 0.0), LogicalSize::new(1.0, 1.0));

        println!("{position:?}");
    }
}
