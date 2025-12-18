use cap_cursor_info::CursorShape;

#[allow(unreachable_code)]
fn main() {
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    return run();
    panic!("Unsupported platform!");
}

#[cfg(target_os = "macos")]
#[allow(deprecated)]
fn run() {
    use objc2::{MainThreadMarker, rc::Retained};
    use objc2_app_kit::{NSApplication, NSCursor};
    use sha2::{Digest, Sha256};

    let mtm = MainThreadMarker::new().expect("Not on main thread");
    let _app: Retained<NSApplication> = NSApplication::sharedApplication(mtm);

    unsafe {
        let cursor_hash_map = CursorShapeMacOS::get_cursor_cache();
        println!("Cursors hash map: {:#?}", cursor_hash_map);

        println!("\nStarting cursor monitoring...\n");

        loop {
            #[allow(deprecated)]
            let cursor = NSCursor::currentSystemCursor().unwrap_or(NSCursor::currentCursor());
            let hash = hex::encode(Sha256::digest(
                cursor
                    .image()
                    .TIFFRepresentation()
                    .expect("Failed to get TIFF representation of built-in cursor")
                    .as_bytes_unchecked(),
            ));

            // Try to resolve to CursorShape
            if let Some(cursor_shape_macos) = CursorShapeMacOS::from_hash(&hash) {
                let cursor_shape = CursorShape::MacOS(cursor_shape_macos);
                println!("CursorShape: {cursor_shape} | Hash: {hash}");
            } else {
                println!("Unknown cursor | Hash: {hash}");
            }

            std::thread::sleep(std::time::Duration::from_millis(100));
        }
    };
}

#[cfg(target_os = "windows")]
fn run() {
    use windows::Win32::{
        Foundation::POINT,
        UI::WindowsAndMessaging::{CURSORINFO, CURSORINFO_FLAGS, GetCursorInfo, HCURSOR},
    };

    println!("Starting cursor monitoring...\n");

    loop {
        unsafe {
            let mut cursor_info = CURSORINFO {
                cbSize: std::mem::size_of::<CURSORINFO>() as u32,
                flags: CURSORINFO_FLAGS(0),
                hCursor: HCURSOR(std::ptr::null_mut()),
                ptScreenPos: POINT { x: 0, y: 0 },
            };

            if GetCursorInfo(&mut cursor_info).is_ok() {
                // Try to convert HCURSOR to CursorShape using the TryFrom implementation
                match CursorShape::try_from(&cursor_info.hCursor) {
                    Ok(cursor_shape) => {
                        println!("CursorShape: {}", cursor_shape);
                    }
                    Err(_) => {
                        println!("Unknown cursor: {:?}", cursor_info.hCursor);
                    }
                }
            } else {
                println!("Failed to get cursor info");
            }
        }

        std::thread::sleep(std::time::Duration::from_millis(100));
    }
}
