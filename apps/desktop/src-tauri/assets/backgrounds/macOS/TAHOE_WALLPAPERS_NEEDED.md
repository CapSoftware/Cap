# macOS Tahoe Wallpapers Needed

This document outlines the macOS Tahoe wallpapers that need to be added to complete issue #1100.

## Required Wallpapers

The following macOS Tahoe wallpapers should be added to this directory:

1. **tahoe-dark.jpg** - Dark variant of macOS Tahoe default wallpaper
2. **tahoe-light.jpg** - Light variant of macOS Tahoe default wallpaper

## Wallpaper Specifications

- **Format**: JPEG (.jpg)
- **Recommended Resolution**: At least 3840x2160 (4K) or higher
- **Quality**: High quality, preferably from official macOS Tahoe beta/release
- **Style**: Should match the "Liquid Glass" design language introduced in macOS Tahoe

## How to Obtain Wallpapers

### For Users with macOS Tahoe Access:

1. The wallpapers can be found in:
   ```
   /System/Library/Desktop Pictures/
   ```

2. Or extract from system resources using:
   ```bash
   # Example command (exact location may vary)
   find /System/Library -name "*Tahoe*" -o -name "*tahoe*"
   ```

### Alternative Sources:

- Download from Apple's official macOS Tahoe resources (when publicly available)
- Extract from macOS Tahoe Developer Beta (requires Apple Developer Program membership)
- Community-shared high-quality recreations matching the Tahoe aesthetic

## Adding the Wallpapers

Once you have the wallpaper files:

1. Add `tahoe-dark.jpg` and `tahoe-light.jpg` to this directory
2. Ensure file names match exactly (lowercase)
3. Delete this `TAHOE_WALLPAPERS_NEEDED.md` file
4. Test that the wallpapers appear in the Cap editor's background selector

## Integration Notes

The wallpapers have already been added to the wallpaper selector in:
- `apps/desktop/src/routes/editor/ConfigSidebar.tsx`

The entries are:
- `"macOS/tahoe-dark"`
- `"macOS/tahoe-light"`

These entries will automatically work once the corresponding `.jpg` files are added to this directory.

## Quality Guidelines

- Images should be authentic macOS Tahoe wallpapers or high-quality recreations
- Resolution should be sufficient for modern displays (4K minimum recommended)
- Color accuracy is important to match the macOS Tahoe aesthetic
- Compression should be balanced (high quality but reasonable file size)

## Testing

After adding the wallpapers:

1. Launch Cap in development mode
2. Open the editor
3. Navigate to the background selection
4. Verify that "Tahoe Dark" and "Tahoe Light" appear in the macOS section
5. Select each wallpaper and confirm it displays correctly
6. Test on both Retina and non-Retina displays if possible

---

**Related Issue**: #1100 - Add support for macOS Tahoe Icons
**PR**: TBD
