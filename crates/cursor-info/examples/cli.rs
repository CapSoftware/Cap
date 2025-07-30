use objc2::{MainThreadMarker, rc::Retained};
use objc2_app_kit::{NSApplication, NSCursor};

fn main() {
    let mtm = MainThreadMarker::new().expect("Not on main thread");

    let app: Retained<NSApplication> = NSApplication::sharedApplication(mtm);

    std::thread::spawn(|| unsafe {
        let arrow = NSCursor::arrowCursor();

        loop {
            #[allow(deprecated)]
            let cursor = NSCursor::currentSystemCursor().unwrap_or(NSCursor::currentCursor());

            print!("{cursor:?} {:?}", cursor.image() == arrow.image());

            if cursor == arrow {
                println!("Cursor is an arrow");
            } else {
                println!("Cursor is not an arrow");
            }
        }
    });

    app.run();
}
