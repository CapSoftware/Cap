# Cap Cursor Info

A cross-platform Rust crate for detecting cursor shapes and providing accurate cursor assets with hotspot information.

## Features

- 🖱️ **Cross-platform cursor detection** - Support for macOS and Windows
- 🎯 **Accurate hotspot information** - Precise cursor positioning data
- 🎨 **High-quality SVG assets** - Scalable cursor graphics for all supported shapes
- 🔍 **Real-time cursor monitoring** - Track cursor changes as they happen
- 📦 **Serialization support** - Built-in serde and specta support
- 🛠️ **Development tools** - Interactive viewer and CLI monitoring

## Installation

Add this to your `Cargo.toml`:

```toml
[dependencies]
cap-cursor-info = "0.0.0"
```

### Platform-specific dependencies

The crate automatically includes platform-specific dependencies:

- **macOS**: Uses `objc2` and `objc2-app-kit` for cursor detection
- **Windows**: Uses `windows` crate for Win32 API integration

## Usage

### Basic Usage

```rust
use cap_cursor_info::{CursorShape, CursorShapeMacOS, CursorShapeWindows};

// Create a cursor shape
let cursor = CursorShape::MacOS(CursorShapeMacOS::Arrow);

// Resolve to get SVG asset and hotspot
if let Some(resolved) = cursor.resolve() {
    println!("SVG: {}", resolved.raw);
    println!("Hotspot: ({}, {})", resolved.hotspot.0, resolved.hotspot.1);
}

// Display cursor information
println!("Cursor: {}", cursor); // Output: "MacOS|Arrow"
```

### Platform-specific Detection

#### macOS

```rust
#[cfg(target_os = "macos")]
use cap_cursor_info::CursorShapeMacOS;

// Detect cursor from hash (macOS uses image hashing)
let hash = "de2d1f4a81e520b65fd1317b845b00a1c51a4d1f71cca3cd4ccdab52b98d1ac9";
if let Some(cursor) = CursorShapeMacOS::from_hash(hash) {
    println!("Detected cursor: {:?}", cursor);
}
```

#### Windows

```rust
#[cfg(target_os = "windows")]
use cap_cursor_info::CursorShape;
use windows::Win32::UI::WindowsAndMessaging::HCURSOR;

// Convert from Windows HCURSOR
let hcursor: HCURSOR = get_current_cursor(); // Your implementation
if let Ok(cursor) = CursorShape::try_from(&hcursor) {
    println!("Detected cursor: {}", cursor);
}
```

### Serialization

The crate supports serde serialization:

```rust
use cap_cursor_info::CursorShape;
use serde_json;

let cursor = CursorShape::MacOS(CursorShapeMacOS::Arrow);
let json = serde_json::to_string(&cursor).unwrap();
println!("{}", json); // "MacOS|Arrow"

let deserialized: CursorShape = serde_json::from_str(&json).unwrap();
```

## Supported Cursors

### macOS Cursors

- `Arrow` - Standard arrow pointer
- `ContextualMenu` - Context menu indicator
- `ClosedHand` - Closed hand for dragging
- `Crosshair` - Precision crosshair
- `DragCopy` - Copy operation indicator
- `DragLink` - Link operation indicator
- `IBeam` - Text selection cursor
- `IBeamVerticalForVerticalLayout` - Vertical text cursor
- `OpenHand` - Open hand for grabbable items
- `OperationNotAllowed` - Prohibited operation
- `PointingHand` - Clickable link pointer
- `ResizeDown/Up/Left/Right` - Directional resize cursors
- `ResizeLeftRight/UpDown` - Bidirectional resize cursors

### Windows Cursors

- `Arrow` - Standard arrow pointer
- `IBeam` - Text selection cursor
- `Wait` - Loading/busy indicator
- `Cross` - Crosshair cursor
- `UpArrow` - Vertical selection
- `SizeNWSE/NESW/WE/NS/All` - Various resize cursors
- `No` - Prohibited operation
- `Hand` - Clickable link pointer
- `AppStarting` - Application loading
- `Help` - Help/question cursor
- `Pin/Person` - Specialized cursors
- `Pen` - Drawing/writing cursor

## Development Tools

### Interactive Cursor Viewer

Open `cursors.html` in your browser to:
- View all cursor assets with accurate scaling
- See hotspot positions visually
- Copy hotspot coordinates for development
- Test cursor appearance on different backgrounds

### CLI Monitoring Tool

Run the example to monitor cursor changes in real-time:

```bash
cargo run --example cli
```

This will:
- Display current cursor information
- Show hash values (macOS) or handle info (Windows)
- Update in real-time as you move between applications

## Platform Details

### macOS Implementation

macOS cursor detection uses SHA-256 hashing of the cursor's TIFF image data. This approach is necessary because:
- `NSCursor` instances cannot be compared directly
- Cursors are resolution-independent
- Hash comparison provides reliable identification

### Windows Implementation

Windows cursor detection uses `HCURSOR` handle comparison with a cached lookup table of system cursors loaded at runtime.

## Asset Information

All cursor assets are:
- **Format**: SVG for scalability
- **Quality**: High-fidelity reproductions of system cursors
- **Hotspots**: Precisely measured for accurate positioning
- **License**: See individual asset licenses in `assets/` directories

### Hotspot Coordinates

Hotspot coordinates are normalized (0.0 to 1.0) relative to the cursor's dimensions:
- `(0.0, 0.0)` = Top-left corner
- `(1.0, 1.0)` = Bottom-right corner
- `(0.5, 0.5)` = Center

## Contributing

We welcome contributions! Please:

1. Test on both macOS and Windows when possible
2. Include hotspot measurements for new cursor assets
3. Update the HTML viewer when adding new cursors
4. Run the CLI example to verify cursor detection

## License

This project is released under the Apple User Agreement for macOS assets. See individual license files in the assets directories for specific terms.