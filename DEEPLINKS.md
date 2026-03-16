# Cap Deeplinks Documentation

Cap supports deeplink URLs that allow external applications to control recordings programmatically.

## URL Scheme

Cap uses the `cap-desktop://` URL scheme with the following format:

```
cap-desktop://action?value=<JSON_OR_STRING>
```

## Available Actions

### 1. Start Recording

Start a new recording with specified parameters:

```
cap-desktop://action?value={"start_recording":{"capture_mode":{"screen":"Primary"},"camera":null,"mic_label":null,"capture_system_audio":false,"mode":"studio"}}
```

**Parameters:**
- `capture_mode`: Object with either `screen` (display name) or `window` (window name)
- `camera`: Optional camera device ID or model ID
- `mic_label`: Optional microphone label
- `capture_system_audio`: Boolean for system audio capture
- `mode`: Either `"studio"` or `"instant"`

### 2. Stop Recording

Stop the current recording:

```
cap-desktop://action?value="stop_recording"
```

### 3. Pause Recording

Pause the current recording:

```
cap-desktop://action?value="pause_recording"
```

### 4. Resume Recording

Resume a paused recording:

```
cap-desktop://action?value="resume_recording"
```

### 5. Toggle Microphone

Toggle microphone on/off during a studio recording:

```
cap-desktop://action?value="toggle_mic"
```

**Note:** Only supported for studio recordings. Instant recordings do not support this action.

### 6. Toggle Camera

Toggle camera on/off during a studio recording:

```
cap-desktop://action?value="toggle_camera"
```

**Note:** Only supported for studio recordings. Instant recordings do not support this action.

## Example Usage

### From Shell/Terminal

**macOS:**
```bash
open "cap-desktop://action?value=\"stop_recording\""
```

**Windows:**
```powershell
Start-Process "cap-desktop://action?value=\"stop_recording\""
```

### From JavaScript/TypeScript

```typescript
const action = "stop_recording";
const url = `cap-desktop://action?value="${action}"`;
window.open(url);
```

### From AppleScript (macOS)

```applescript
open location "cap-desktop://action?value=\"pause_recording\""
```

## Raycast Extension

A Raycast extension is included in the `raycast-extension/` directory that provides quick commands for:

- Start Recording
- Stop Recording
- Pause Recording
- Resume Recording
- Toggle Microphone
- Toggle Camera

See `raycast-extension/README.md` for installation and usage instructions.

## Security Considerations

- Deeplinks can be triggered by any application with the appropriate permissions
- Consider implementing user confirmation for sensitive actions in production use
- The current implementation does not require authentication

## Implementation Details

The deeplink handler is implemented in:
- `apps/desktop/src-tauri/src/deeplink_actions.rs` - Action definitions and execution
- `apps/desktop/src-tauri/src/lib.rs` - Deeplink event handler registration

The handler:
1. Parses incoming deeplink URLs
2. Deserializes the JSON action payload
3. Executes the corresponding recording action
4. Returns success or error messages

## Future Enhancements

Potential improvements for future versions:

- Add query recording status action
- Support enabling camera/mic with specific device selection
- Add screenshot capture action
- Implement authentication/authorization for deeplinks
- Add webhooks for recording events
- Support batch operations
