# Quick Reference Guide

Fast reference for common multi-recorder CLI patterns.

## Basic Commands

### List Available Sources
```bash
cap-multi-recorder list
cap-multi-recorder list --displays
cap-multi-recorder list --cameras
cap-multi-recorder list --microphones
```

### Simple Recording
```bash
cap-multi-recorder record --display 0 output.mp4
```

### Validate Config
```bash
cap-multi-recorder validate config.json
```

## Source Types

| Type | Simple ID | Example |
|------|-----------|---------|
| Display | `0`, `1`, `"primary"` | `--display 0 out.mp4` |
| Window | Window ID (number) | `--window 12345 out.mp4` |
| Camera | `0`, `1`, `"default"` | `--camera 0 out.mp4` |
| Microphone | Device label or `"default"` | `--microphone "Blue Yeti" out.mp4` |
| System Audio | N/A | `--system-audio out.mp4` |

## Routing Patterns

### One Source → One Output
```bash
--display 0 output.mp4
```

### One Source → Multiple Outputs
```bash
--display 0 backup1.mp4 backup2.mp4
```

### Multiple Sources → One Output
```bash
--display 0 out.mp4 \
--camera 0 out.mp4 \
--microphone "Blue Yeti" out.mp4
```

### Each Source → Separate Output
```bash
--display 0 screen.mp4 \
--camera 0 webcam.mp4 \
--microphone "Blue Yeti" audio.ogg
```

### Mixed Routing
```bash
--display 0 screen.mp4 full.mp4 \
--camera 0 webcam.mp4 full.mp4 \
--microphone "Blue Yeti" full.mp4
```

## Input Specification

### Simple ID
```bash
--display 0 output.mp4
```

### Inline JSON
```bash
--display '{"id":0,"settings":{"fps":60,"show_cursor":true}}' output.mp4
```

### File Reference
```bash
--display @config.json output.mp4
```

## Common Settings

### Display/Window Settings
```json
{
  "id": 0,
  "settings": {
    "fps": 60,
    "show_cursor": true
  }
}
```

### Camera Settings
```json
{
  "id": 0,
  "settings": {
    "resolution": {
      "width": 1920,
      "height": 1080
    },
    "fps": 30
  }
}
```

### Area Capture (JSON Only)
```json
{
  "type": "area",
  "screen": 0,
  "bounds": {
    "x": 100,
    "y": 100,
    "width": 1920,
    "height": 1080
  },
  "settings": {
    "fps": 60,
    "show_cursor": false
  }
}
```

## Global Options

```bash
--fps 60              # Default FPS for all video sources
--cursor              # Default cursor visibility
--duration 300        # Auto-stop after 5 minutes
```

## Output Formats

| Extension | Format | Video | Audio | Notes |
|-----------|--------|-------|-------|-------|
| `.mp4` | MP4 | ✅ | ✅ | Requires video or audio |
| `.ogg` | Ogg Vorbis | ❌ | ✅ | Audio only |

## Full Config File

### Minimal Example
```json
{
  "inputs": {
    "screen": {
      "type": "display",
      "id": 0,
      "settings": {}
    }
  },
  "outputs": {
    "recording.mp4": {
      "video": "screen"
    }
  }
}
```

### Complete Example
```json
{
  "settings": {
    "fps": 30,
    "show_cursor": true
  },
  "inputs": {
    "main_display": {
      "type": "display",
      "id": 0,
      "settings": {"fps": 60}
    },
    "webcam": {
      "type": "camera",
      "id": 0,
      "settings": {}
    },
    "mic": {
      "type": "microphone",
      "label": "Blue Yeti",
      "settings": {}
    },
    "sys": {
      "type": "system-audio",
      "settings": {}
    }
  },
  "outputs": {
    "full.mp4": {
      "video": "main_display",
      "audio": ["mic", "sys"]
    },
    "webcam.mp4": {
      "video": "webcam",
      "audio": ["mic"]
    },
    "audio.ogg": {
      "audio": ["mic"]
    }
  }
}
```

## Common Recipes

### Presentation Recording
```bash
cap-multi-recorder record \
  --display 0 presentation.mp4 \
  --camera 0 presentation.mp4 \
  --microphone "MacBook Pro Microphone" presentation.mp4
```

### Gaming with Facecam
```bash
cap-multi-recorder record \
  --display '{"id":0,"settings":{"fps":120}}' gameplay.mp4 \
  --camera 0 facecam.mp4 \
  --microphone "Blue Yeti" gameplay.mp4 facecam.mp4 \
  --system-audio gameplay.mp4
```

### Podcast with Backup
```bash
cap-multi-recorder record \
  --microphone "Host Mic" host.ogg mixed.ogg backup.ogg \
  --microphone "Guest Mic" guest.ogg mixed.ogg backup.ogg
```

### Multi-Monitor Recording
```bash
cap-multi-recorder record \
  --display 0 left.mp4 \
  --display 1 right.mp4 \
  --microphone default left.mp4 right.mp4
```

### Screen + Webcam to Separate Files + Combined
```bash
cap-multi-recorder record \
  --display 0 screen-only.mp4 combined.mp4 \
  --camera 0 webcam-only.mp4 combined.mp4 \
  --microphone "Blue Yeti" combined.mp4
```

## Tips

1. **Start Simple**: Use simple IDs first, add JSON as needed
2. **Test First**: Use `--duration 5` for quick tests
3. **Validate**: Use `validate` command before long recordings
4. **Save Configs**: Reuse complex setups via config files
5. **Check Sources**: Run `list` to see available inputs
6. **Watch Paths**: Outputs are relative to current directory
7. **System Audio**: May require permissions on macOS/Windows

## Troubleshooting

### "No input sources specified"
Add at least one `--display`, `--camera`, or `--microphone` flag.

### "Output has no sources"
Ensure each output file is referenced by at least one source.

### "Multiple video sources for one output"
Each output can only have one video source (display/camera).
Split into separate outputs or use config file.

### "Invalid JSON"
Check JSON syntax, especially quotes and braces.
Use `@file.json` for complex configs.

### "Input not found"
Run `cap-multi-recorder list` to see available inputs.
Check display/camera IDs and microphone labels.

### "Permission denied"
On macOS: Grant screen recording permissions in System Preferences.
On Windows: Run as administrator if needed.

## See Also

- [PLAN.md](./PLAN.md) - Full implementation plan
- [PLAN-UNIFIED.md](./PLAN-UNIFIED.md) - Unified approach details
- [INPUT-PATTERNS.md](./INPUT-PATTERNS.md) - Pattern comparison
- [README.md](./README.md) - Project overview
