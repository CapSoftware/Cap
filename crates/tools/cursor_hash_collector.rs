use objc2_app_kit::{NSCursor, NSImage, NSApplication};
use objc2_foundation::NSAutoreleasePool;
use objc2::rc::Retained;
use objc2::MainThreadMarker;
use sha2::{Digest, Sha256};
use std::collections::HashMap;

fn main() {
    println!("macOS Tahoe Cursor Hash Collector");
    println!("=================================");
    println!("Automatically capturing all available cursor types...");
    println!();
    
    let mut cursor_hashes: HashMap<String, (String, (f64, f64))> = HashMap::new();
    
    unsafe {
        // Create autorelease pool
        let _pool = NSAutoreleasePool::new();
        
        // Initialize application
        let mtm = MainThreadMarker::new().unwrap();
        let app = NSApplication::sharedApplication(mtm);
        
        // Capture all standard cursor types
        capture_cursor(&mut cursor_hashes, "Arrow testing", NSCursor::arrowCursor());
        capture_cursor(&mut cursor_hashes, "IBeam testing", NSCursor::IBeamCursor());
        capture_cursor(&mut cursor_hashes, "CrossHair testing", NSCursor::crosshairCursor());
        capture_cursor(&mut cursor_hashes, "ClosedHand testing", NSCursor::closedHandCursor());
        capture_cursor(&mut cursor_hashes, "OpenHand", NSCursor::openHandCursor());
        capture_cursor(&mut cursor_hashes, "PointingHand", NSCursor::pointingHandCursor());
        capture_cursor(&mut cursor_hashes, "ResizeLeft", NSCursor::resizeLeftCursor());
        capture_cursor(&mut cursor_hashes, "ResizeRight", NSCursor::resizeRightCursor());
        capture_cursor(&mut cursor_hashes, "ResizeLeftRight", NSCursor::resizeLeftRightCursor());
        capture_cursor(&mut cursor_hashes, "ResizeUp", NSCursor::resizeUpCursor());
        capture_cursor(&mut cursor_hashes, "ResizeDown", NSCursor::resizeDownCursor());
        capture_cursor(&mut cursor_hashes, "ResizeUpDown", NSCursor::resizeUpDownCursor());
        capture_cursor(&mut cursor_hashes, "DisappearingItem", NSCursor::disappearingItemCursor());
        capture_cursor(&mut cursor_hashes, "IBeamVerticalForVerticalLayout", NSCursor::IBeamCursorForVerticalLayout());
        capture_cursor(&mut cursor_hashes, "OperationNotAllowed", NSCursor::operationNotAllowedCursor());
        capture_cursor(&mut cursor_hashes, "DragLink", NSCursor::dragLinkCursor());
        capture_cursor(&mut cursor_hashes, "DragCopy", NSCursor::dragCopyCursor());
        capture_cursor(&mut cursor_hashes, "ContextualMenu", NSCursor::contextualMenuCursor());
        
        // Try to access current system cursor as well
        if let Some(current) = NSCursor::currentSystemCursor() {
            capture_cursor(&mut cursor_hashes, "CurrentSystem", current);
        }
        
        // Also get current cursor
        capture_cursor(&mut cursor_hashes, "Current", NSCursor::currentCursor());
    }
    
    // Print results in a format ready for insertion into from_hash function
    println!("Hash mappings for use in from_hash function:");
    println!("-------------------------------------------");
    
    for (name, (hash, hotspot)) in cursor_hashes {
        println!("\"{hash}\" => Self::{},  // {name}, hotspot: {hotspot:?}", 
                 if name.starts_with("Current") { "TahoeDefault" } else { &name });
    }
}

/// Captures a cursor and adds its hash to the collection if it's new
unsafe fn capture_cursor(
    hashes: &mut HashMap<String, (String, (f64, f64))>,
    name: &str,
    cursor: Retained<NSCursor>,
) {
    let image = cursor.image();
    
    let size = image.size();
    let hotspot = cursor.hotSpot();
    
    if let Some(image_data) = image.TIFFRepresentation() {
        let image_bytes = image_data.as_bytes_unchecked().to_vec();
        let hash = hex::encode(Sha256::digest(&image_bytes));
        
        let hotspot_normalized = (hotspot.x / size.width, hotspot.y / size.height);
        
        // Only add if we haven't seen this hash before
        if !hashes.contains_key(name) {
            println!("Captured cursor: {}", name);
            println!("  Hash: {}", hash);
            println!("  Hotspot: {:?}", hotspot_normalized);
            println!();
            
            hashes.insert(name.to_string(), (hash, hotspot_normalized));
        }
    } else {
        println!("Failed to get TIFF representation for cursor: {}", name);
    }
}
