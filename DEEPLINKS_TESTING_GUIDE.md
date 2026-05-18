# Cap Deeplinks Implementation & Testing Guide

## Overview

Cap now supports comprehensive deeplinks for recording control and device management. This enables external applications like Raycast to control Cap programmatically.

## Deeplink Protocol

**Base URL:** `cap-desktop://action`

**Format:** `cap-desktop://action?value=<json_encoded_action>`

## Supported Actions

### Recording Controls

#### Start Recording
```json
{
  "start_recording": {}
}
```

**Advanced options:**
```json
{
  "start_recording": {
    "capture_mode": {"screen": "Display Name"},
    "camera": {"device_id": "camera-id"},
    "mic_label": "Microphone Name",
    "capture_system_audio": true,
    "mode": "instant"
  }
}
```

#### Stop Recording
```json
{
  "stop_recording": null
}
```

#### Pause Recording
```json
{
  "pause_recording": null
}
```

#### Resume Recording
```json
{
  "resume_recording": null
}
```

#### Toggle Pause
```json
{
  "toggle_pause_recording": null
}
```

### Device Management

#### Switch Camera (Cycle to Next)
```json
{
  "switch_camera": null
}
```

#### Switch Microphone (Cycle to Next)
```json
{
  "switch_microphone": null
}
```

#### Set Specific Camera
```json
{
  "set_camera": {
    "device_id": {"device_id": "camera-device-id"}
  }
}
```

#### Set Specific Microphone
```json
{
  "set_microphone": {
    "label": "Microphone Name"
  }
}
```

### Other Actions

#### Open Editor
```json
{
  "open_editor": {
    "project_path": "/path/to/project"
  }
}
```

#### Open Settings
```json
{
  "open_settings": {
    "page": "recording"
  }
}
```

## Implementation Details

### Architecture

1. **Deeplink Handler** (`src/deeplink_actions.rs`)
   - Parses incoming URLs
   - Routes to appropriate action handlers
   - Manages error handling and validation

2. **Device Switching Logic**
   - `switch_to_next_camera()`: Cycles through available cameras
   - `switch_to_next_microphone()`: Cycles through available microphones
   - Wraps around when reaching the end of device list

3. **Integration Points**
   - Uses existing Tauri commands for recording control
   - Leverages device enumeration APIs for camera/mic switching
   - Maintains state consistency with the main app

### Error Handling

- **No devices available**: Returns user-friendly error message
- **Device disconnected**: Handles gracefully with appropriate feedback
- **Invalid action**: Logs and ignores malformed requests
- **App not ready**: Queues actions until app is ready

## Testing Guide

### Manual Testing

#### Prerequisites
1. Cap desktop app installed and running
2. Multiple cameras/microphones available (for device switching tests)

#### Basic Functionality Tests

**Recording Controls:**
1. ✅ Start recording via deeplink
2. ✅ Stop recording via deeplink
3. ✅ Pause recording via deeplink
4. ✅ Resume recording via deeplink
5. ✅ Toggle pause via deeplink

**Device Switching:**
1. ✅ Switch camera cycles through available cameras
2. ✅ Switch microphone cycles through available microphones
3. ✅ Wraps around when reaching end of device list
4. ✅ Handles single camera/microphone gracefully
5. ✅ Handles no cameras/microphones gracefully

**Error Conditions:**
1. ✅ Handles malformed JSON gracefully
2. ✅ Handles invalid action names
3. ✅ Provides user feedback for errors
4. ✅ Works when app is not running (should start app)

#### Integration Tests

**Raycast Extension:**
1. ✅ All commands available in Raycast
2. ✅ Commands execute without errors
3. ✅ Error messages display correctly
4. ✅ Icons and descriptions are accurate

**URL Scheme Registration:**
1. ✅ `cap-desktop://` URLs open Cap
2. ✅ Actions execute when app is running
3. ✅ App starts if not running
4. ✅ Multiple actions in sequence work

### Automated Testing

#### Unit Tests (to be implemented)
```rust
// Example test structure
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_deeplink_action() {
        let url = Url::parse("cap-desktop://action?value={\"start_recording\":{}}").unwrap();
        let action = DeepLinkAction::try_from(&url).unwrap();
        assert!(matches!(action, DeepLinkAction::StartRecording { .. }));
    }

    #[test]
    fn test_switch_camera_with_no_cameras() {
        // Test error handling when no cameras available
    }

    #[test]
    fn test_switch_microphone_cycling() {
        // Test microphone switching logic
    }
}
```

#### Integration Tests (to be implemented)
```typescript
// Example Raycast extension test
import { describe, it, expect } from '@jest/globals';

describe('Cap Raycast Extension', () => {
    it('should construct correct deeplink for start recording', () => {
        const action = { start_recording: {} };
        const deeplink = `cap-desktop://action?value=${encodeURIComponent(JSON.stringify(action))}`;
        expect(deeplink).toContain('cap-desktop://action');
        expect(deeplink).toContain('start_recording');
    });

    it('should handle device switching actions', () => {
        const cameraAction = { switch_camera: null };
        const micAction = { switch_microphone: null };
        
        expect(cameraAction).toHaveProperty('switch_camera');
        expect(micAction).toHaveProperty('switch_microphone');
    });
});
```

## Usage Examples

### Command Line Testing
```bash
# macOS
open "cap-desktop://action?value=%7B%22start_recording%22%3A%7B%7D%7D"

# Linux
xdg-open "cap-desktop://action?value=%7B%22stop_recording%22%3Anull%7D"

# Windows
start "cap-desktop://action?value=%7B%22switch_camera%22%3Anull%7D"
```

### JavaScript/TypeScript
```typescript
function executeCapAction(action: any) {
    const deeplink = `cap-desktop://action?value=${encodeURIComponent(JSON.stringify(action))}`;
    window.open(deeplink);
}

// Usage
executeCapAction({ start_recording: {} });
executeCapAction({ switch_camera: null });
```

### Python
```python
import urllib.parse
import json
import webbrowser

def execute_cap_action(action):
    json_str = json.dumps(action)
    encoded = urllib.parse.quote(json_str)
    deeplink = f"cap-desktop://action?value={encoded}"
    webbrowser.open(deeplink)

# Usage
execute_cap_action({"start_recording": {}})
execute_cap_action({"switch_microphone": None})
```

## Security Considerations

1. **Action Validation**: All actions are validated before execution
2. **Device Access**: Only available devices can be selected
3. **No Arbitrary Code**: Actions are limited to predefined set
4. **Error Sanitization**: Error messages don't expose system details

## Performance Considerations

1. **Async Execution**: All actions are non-blocking
2. **Device Enumeration**: Cached when possible
3. **Error Recovery**: Graceful degradation on failures
4. **Resource Cleanup**: Proper cleanup on errors

## Future Enhancements

1. **Advanced Recording Options**
   - Custom recording quality settings
   - Timer-based recording
   - Region selection via deeplink

2. **Enhanced Device Control**
   - Device-specific settings
   - Audio level control
   - Camera format selection

3. **Status Queries**
   - Recording status via deeplink
   - Device availability queries
   - Current settings retrieval

4. **Batch Operations**
   - Multiple actions in single request
   - Conditional operations
   - Action sequences

## Troubleshooting

### Common Issues

1. **Deeplinks not working**
   - Verify Cap is installed
   - Check URL scheme registration
   - Ensure app is not blocking deeplinks

2. **Device switching fails**
   - Verify devices are connected
   - Check permissions (camera/microphone)
   - Review device enumeration

3. **Recording control issues**
   - Verify recording state before actions
   - Check for conflicting operations
   - Review error logs

### Debug Information

Enable debug logging to see deeplink processing:
```bash
# Set environment variable for debug logging
export RUST_LOG=debug
```

## Conclusion

The deeplinks implementation provides a robust foundation for external control of Cap. The combination of recording controls and device switching enables powerful integrations like the Raycast extension while maintaining security and reliability.