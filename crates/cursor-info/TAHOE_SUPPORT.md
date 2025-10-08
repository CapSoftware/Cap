# macOS Tahoe Cursor Support Guide

## Overview

This guide explains how to add support for macOS Tahoe (macOS 16) cursors to the Cap cursor-info crate. macOS Tahoe introduces a new "Liquid Glass" design language which may include updated cursor icon designs.

## Current Status

- ✅ Code structure prepared for Tahoe cursor support
- ✅ Documentation added for Tahoe cursor extraction process
- ✅ Wallpaper support added for macOS Tahoe backgrounds
- ⏳ Pending: Actual Tahoe cursor hashes (requires macOS Tahoe access)
- ⏳ Pending: Updated cursor SVG assets (if designs have changed)

## Why Tahoe Support May Be Needed

macOS Tahoe features a refreshed visual design system called "Liquid Glass" which includes:
- Updated app icons with refined appearance
- Transparent menu bars and controls
- Refined visual elements throughout the OS

If Apple has updated the cursor designs to match this new aesthetic, the cursor image data will be different, resulting in new SHA-256 hashes. This means existing cursors may not be detected properly on macOS Tahoe.

## How to Add Tahoe Cursor Support

### Prerequisites

- Access to a macOS Tahoe (macOS 16) system (beta or release)
- Basic familiarity with running Rust projects
- Understanding of SHA-256 hashing

### Step 1: Extract Cursor Hashes

1. On a macOS Tahoe system, open `crates/cursor-info/cursors.html` in a web browser

2. The page will display all system cursors with their current hashes

3. For each cursor type, note the hash value displayed

4. Compare these hashes with the existing hashes in `src/macos.rs` (line ~138+)

5. Document any hashes that differ from the current implementation

### Step 2: Determine If Visual Changes Occurred

1. If hashes are identical to existing ones: No changes needed! Tahoe uses the same cursor designs.

2. If hashes differ: Cursor designs have changed and need to be extracted

### Step 3: Extract Updated Cursor SVGs (If Needed)

If cursor hashes have changed, you'll need to extract the new cursor graphics:

1. Use the provided CLI tool to capture cursor images:
   ```bash
   cd crates/cursor-info
   cargo run --example cli
   ```

2. As you hover over different UI elements to trigger different cursors, the tool will display cursor information

3. For each cursor type, you'll need to:
   - Capture the cursor's visual appearance
   - Convert it to SVG format
   - Measure the hotspot coordinates
   - Save to `assets/mac/[cursor-name].svg`

4. Alternatively, use macOS system tools to extract cursor resources:
   ```bash
   # Cursor resources may be located in:
   # /System/Library/Frameworks/AppKit.framework/Resources/
   # Exact location and extraction method may vary
   ```

### Step 4: Update the Code

1. **Update cursor hashes in `src/macos.rs`:**

   Add Tahoe-specific hashes to the `from_hash()` function. You can either:
   
   - Replace existing hashes if ALL macOS versions now use the new design
   - Add additional hash entries if different versions have different designs
   
   Example of adding alternative hashes:
   ```rust
   pub fn from_hash(hash: &str) -> Option<Self> {
       Some(match hash {
           // Original hash (pre-Tahoe)
           "de2d1f4a81e520b65fd1317b845b00a1c51a4d1f71cca3cd4ccdab52b98d1ac9" => Self::Arrow,
           // Tahoe hash (if different)
           "NEW_TAHOE_HASH_HERE" => Self::Arrow,
           // ... rest of hashes
       })
   }
   ```

2. **Update SVG assets** (if cursor designs changed):
   
   Replace or add new files in `assets/mac/` with the Tahoe cursor designs

3. **Update hotspot coordinates** (if needed):
   
   If cursor visual designs changed, hotspot positions may need adjustment in the `resolve()` function

### Step 5: Test

1. **On macOS Tahoe:**
   ```bash
   cargo test
   cargo run --example cli
   ```
   
   Verify all cursors are detected correctly

2. **On pre-Tahoe macOS** (if possible):
   
   Ensure backward compatibility - existing cursors should still work

3. **Integration test:**
   
   Run Cap's screen recorder and verify cursor capture works correctly

### Step 6: Update Documentation

1. Update this file to mark Tahoe support as complete
2. Update version compatibility notes in README.md
3. Add any version-specific notes if needed

## Technical Details

### Cursor Hash Generation

The hash is generated from the cursor's TIFF image data:
```rust
use sha2::{Sha256, Digest};

let hash = format!("{:x}", Sha256::digest(&image_data));
```

### Hotspot Coordinates

Hotspots are normalized (0.0 to 1.0) relative to cursor dimensions:
- `(0.0, 0.0)` = Top-left corner
- `(1.0, 1.0)` = Bottom-right corner
- `(0.5, 0.5)` = Center

The hotspot indicates where the "active point" of the cursor is.

### SVG Format

Cursor SVGs should:
- Be high-quality vector reproductions
- Match the exact visual appearance of system cursors
- Be appropriately sized (typically 32x32 or 64x64 base dimensions)
- Include proper viewBox attributes

## Fallback Behavior

If a Tahoe cursor hash is not recognized, the system will:
1. Return `None` from `from_hash()`
2. Cap will use a default cursor representation
3. Cursor may not match the user's actual cursor appearance

This is why adding Tahoe support is important for the best user experience.

## Related Files

- `src/macos.rs` - Main cursor detection logic
- `assets/mac/` - Cursor SVG assets
- `cursors.html` - Interactive cursor hash viewer
- `examples/cli.rs` - CLI cursor monitoring tool
- `README.md` - General crate documentation

## Questions or Issues?

If you encounter any problems while adding Tahoe support:

1. Check that you're running the latest macOS Tahoe version
2. Verify the cursors.html page loads correctly
3. Ensure SHA-256 hashes are being generated correctly
4. Compare with existing cursor hash patterns

For questions, please comment on issue #1100 or contact the Cap development team.

## Completion Checklist

When Tahoe support is added, update this checklist:

- [ ] Tahoe cursor hashes extracted and documented
- [ ] Cursor visual changes identified (if any)
- [ ] New cursor hashes added to `src/macos.rs`
- [ ] Cursor SVG assets updated (if needed)
- [ ] Hotspot coordinates verified (if needed)
- [ ] Tests pass on macOS Tahoe
- [ ] Backward compatibility verified on pre-Tahoe macOS
- [ ] Documentation updated
- [ ] PR created and reviewed
- [ ] Issue #1100 closed

---

**Related Issue**: #1100 - Add support for macOS Tahoe Icons
**Created**: 2025-10-08
**Status**: Awaiting macOS Tahoe cursor assets
