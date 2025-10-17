# Input Specification Patterns

This document compares the three ways to specify input sources in the multi-recorder CLI.

## Pattern 1: Simple Identifier

**When to use**: Quick recordings, defaults are fine, minimal configuration needed.

### Display
```bash
--display 0 output.mp4
--display primary output.mp4
```

### Camera
```bash
--camera 0 output.mp4
--camera default output.mp4
```

### Microphone
```bash
--microphone "Blue Yeti" output.mp4
--microphone default output.mp4
```

**Characteristics**:
- ✅ Fastest to type
- ✅ No JSON knowledge required
- ✅ Uses global defaults (`--fps`, `--cursor`)
- ❌ No per-source customization

## Pattern 2: Inline JSON

**When to use**: Need per-source settings, one-off configurations, don't want separate files.

### Display
```bash
--display '{"id":0,"settings":{"fps":60,"show_cursor":true}}' output.mp4
```

### Camera
```bash
--camera '{"id":0,"settings":{"resolution":{"width":1920,"height":1080},"fps":30}}' output.mp4
```

### Microphone
```bash
--microphone '{"label":"Blue Yeti","settings":{}}' output.mp4
```

### Area (requires JSON)
```bash
--display '{"type":"area","screen":0,"bounds":{"x":100,"y":100,"width":1920,"height":1080},"settings":{"fps":60}}' output.mp4
```

**Characteristics**:
- ✅ Full control over settings
- ✅ Self-contained in command
- ✅ Can override global defaults per-source
- ❌ Verbose for complex settings
- ❌ Error-prone (JSON syntax)
- ❌ Not reusable across commands

## Pattern 3: File Reference

**When to use**: Reusable configurations, complex settings, team sharing, version control.

### Display
Create `high-quality-display.json`:
```json
{
  "id": 0,
  "settings": {
    "fps": 60,
    "show_cursor": true
  }
}
```

Use it:
```bash
--display @high-quality-display.json output.mp4
```

### Camera
Create `1080p-camera.json`:
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

Use it:
```bash
--camera @configs/1080p-camera.json output.mp4
```

### Area Capture
Create `game-window.json`:
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
    "fps": 120,
    "show_cursor": false
  }
}
```

Use it:
```bash
--display @game-window.json gameplay.mp4
```

**Characteristics**:
- ✅ Reusable across commands
- ✅ Easier to maintain complex configs
- ✅ Team can share via git
- ✅ Readable and documented
- ✅ Can use comments (in YAML)
- ❌ Extra file management
- ❌ Requires file path knowledge

## Mixing Patterns

You can mix patterns in the same command:

```bash
cap-multi-recorder record \
  --display 0 screen-default.mp4 \
  --display '{"id":0,"settings":{"fps":60}}' screen-60fps.mp4 \
  --display @high-quality-display.json screen-hq.mp4 \
  --camera @1080p-camera.json webcam.mp4 \
  --microphone "Blue Yeti" audio.mp4
```

This creates 5 outputs:
- `screen-default.mp4`: Display 0 with defaults
- `screen-60fps.mp4`: Display 0 at 60fps
- `screen-hq.mp4`: Display 0 with settings from file
- `webcam.mp4`: Camera from config file
- `audio.mp4`: Microphone with defaults

## Comparison Table

| Feature | Simple ID | Inline JSON | File Reference |
|---------|-----------|-------------|----------------|
| Speed | ⭐⭐⭐ | ⭐ | ⭐⭐ |
| Readability | ⭐⭐⭐ | ⭐ | ⭐⭐⭐ |
| Per-source settings | ❌ | ✅ | ✅ |
| Reusability | ❌ | ❌ | ✅ |
| Version control | N/A | ❌ | ✅ |
| Team sharing | N/A | ❌ | ✅ |
| Area capture | ❌ | ✅ | ✅ |
| Error-prone | ❌ | ⭐⭐⭐ | ⭐ |
| Setup required | ❌ | ❌ | ✅ |

## Recommendations

### Use Simple ID when:
- Recording quick tests or demos
- Default settings are sufficient
- Learning the tool
- Minimal configuration needed

### Use Inline JSON when:
- Need specific settings for one-off recording
- Don't want to create separate files
- Settings are simple enough to type
- Documenting exact command in README

### Use File Reference when:
- Same configuration used repeatedly
- Complex settings (area bounds, resolutions)
- Working in a team
- Want version-controlled configs
- Building library of reusable configurations

## Full Config File

For very complex scenarios with multiple inputs and outputs, use a full config file instead:

```bash
cap-multi-recorder record streaming-setup.json
```

Where `streaming-setup.json`:
```json
{
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
    }
  },
  "outputs": {
    "recording.mp4": {
      "video": "main_display",
      "audio": ["mic"]
    }
  }
}
```

See [PLAN-JSON-CONFIG.md](./PLAN-JSON-CONFIG.md) for full config file format.

## Best Practices

1. **Start Simple**: Begin with simple IDs, add complexity as needed
2. **Organize Configs**: Keep reusable configs in a `configs/` directory
3. **Name Descriptively**: Use clear names like `60fps-display.json`, `1080p-camera.json`
4. **Document Settings**: Add comments in YAML files explaining non-obvious settings
5. **Version Control**: Commit reusable configs to git
6. **Team Templates**: Share common configs with team members
7. **Validate First**: Use `cap-multi-recorder validate` to check configs before recording

## Examples Collection

### Gaming Setup
```bash
cap-multi-recorder record \
  --display @configs/gaming-display-120fps.json gameplay.mp4 \
  --camera @configs/facecam-720p.json facecam.mp4 \
  --microphone "Blue Yeti" gameplay.mp4 facecam.mp4 \
  --system-audio gameplay.mp4
```

### Presentation Recording
```bash
cap-multi-recorder record \
  --display 0 presentation.mp4 \
  --camera @configs/webcam-corner.json presentation.mp4 \
  --microphone "MacBook Pro Microphone" presentation.mp4
```

### Multi-Monitor Workspace
```bash
cap-multi-recorder record \
  --display '{"id":0,"settings":{"fps":30}}' left-monitor.mp4 \
  --display '{"id":1,"settings":{"fps":30}}' right-monitor.mp4 \
  --microphone default both-monitors.mp4
```

Wait, that last example shows `both-monitors.mp4` which isn't defined. Let me fix it:

```bash
cap-multi-recorder record \
  --display '{"id":0,"settings":{"fps":30}}' left-monitor.mp4 \
  --display '{"id":1,"settings":{"fps":30}}' right-monitor.mp4 \
  --microphone default left-monitor.mp4 right-monitor.mp4
```

### Podcast Recording
```bash
cap-multi-recorder record \
  --microphone "Host Microphone" host.ogg mixed.ogg \
  --microphone "Guest Microphone" guest.ogg mixed.ogg \
  --system-audio mixed.ogg
```
