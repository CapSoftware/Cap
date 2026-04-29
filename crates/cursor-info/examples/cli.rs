use cap_cursor_info::CursorShape;
#[cfg(target_os = "macos")]
use cap_cursor_info::CursorShapeMacOS;
#[cfg(target_os = "macos")]
use sha2::{Digest, Sha256};
#[cfg(target_os = "macos")]
use std::collections::HashMap;

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

    let mtm = MainThreadMarker::new().expect("Not on main thread");
    let _app: Retained<NSApplication> = NSApplication::sharedApplication(mtm);

    let cursors = vec![
        ("arrow", NSCursor::arrowCursor()),
        ("contextualMenu", NSCursor::contextualMenuCursor()),
        ("closedHand", NSCursor::closedHandCursor()),
        ("crosshair", NSCursor::crosshairCursor()),
        ("disappearingItem", NSCursor::disappearingItemCursor()),
        ("dragCopy", NSCursor::dragCopyCursor()),
        ("dragLink", NSCursor::dragLinkCursor()),
        ("IBeam", NSCursor::IBeamCursor()),
        ("openHand", NSCursor::openHandCursor()),
        ("operationNotAllowed", NSCursor::operationNotAllowedCursor()),
        ("pointingHand", NSCursor::pointingHandCursor()),
        ("resizeDown", NSCursor::resizeDownCursor()),
        ("resizeLeft", NSCursor::resizeLeftCursor()),
        ("resizeLeftRight", NSCursor::resizeLeftRightCursor()),
        ("resizeRight", NSCursor::resizeRightCursor()),
        ("resizeUp", NSCursor::resizeUpCursor()),
        ("resizeUpDown", NSCursor::resizeUpDownCursor()),
        ("IBeamVertical", NSCursor::IBeamCursorForVerticalLayout()),
    ];

    unsafe {
        let mut cursor_lookup = HashMap::new();

        for (name, cursor) in cursors {
            let hash = hex::encode(Sha256::digest(
                cursor
                    .image()
                    .TIFFRepresentation()
                    .expect("Failed to get TIFF representation of built-in cursor")
                    .as_bytes_unchecked(),
            ));
            println!("{name}: {hash}");
            cursor_lookup.insert(hash, name);
        }

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
                        println!("CursorShape: {cursor_shape}");
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
