use std::collections::HashMap;

use objc2::{MainThreadMarker, rc::Retained};
use objc2_app_kit::{NSApplication, NSCursor};
use sha2::{Digest, Sha256};

#[allow(deprecated)]
fn main() {
    #[cfg(target_os = "macos")]
    run_macos();
    #[cfg(not(target_os = "macos"))]
    panic!("Unsupported platform!");
}

#[cfg(target_os = "macos")]
fn run_macos() {
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
                &cursor
                    .image()
                    .TIFFRepresentation()
                    .expect("Failed to get TIFF representation of built-in cursor")
                    .as_bytes_unchecked(),
            ));
            println!("{name}: {}", hash);
            cursor_lookup.insert(hash, name);
        }

        // return;

        loop {
            #[allow(deprecated)]
            let cursor = NSCursor::currentSystemCursor().unwrap_or(NSCursor::currentCursor());
            let hash = hex::encode(Sha256::digest(
                &cursor
                    .image()
                    .TIFFRepresentation()
                    .expect("Failed to get TIFF representation of built-in cursor")
                    .as_bytes_unchecked(),
            ));

            if cursor_lookup.get(&hash).is_none() {
                panic!("Cursor hash '{hash}' not known",);
            };

            println!(
                "{cursor:?} {hash} {}",
                cursor_lookup.get(&hash).unwrap_or(&"Unknown")
            );
        }
    };
}
