# Raycast Extension Implementation Details

This document describes the implementation of the Cap Raycast extension for issue #1540.

## Overview

This implementation adds a complete Raycast extension for Cap that enables users to control screen recording directly from Raycast. The extension communicates with the Cap desktop app using deeplinks.

## Changes Made

### 1. Raycast Extension (`raycast-extension/`)

Created a complete Raycast extension with the following structure:

```
raycast-extension/
├── package.json          # Extension manifest and dependencies
├── tsconfig.json         # TypeScript configuration
├── .eslintrc.json        # ESLint configuration
├── .gitignore           # Git ignore rules
├── README.md            # User documentation
├── IMPLEMENTATION.md    # This file
└── src/
    ├── start-recording.tsx           # Quick start recording command
    ├── start-recording-window.tsx    # Select window to record
    ├── stop-recording.tsx            # Stop current recording
    ├── toggle-pause.tsx              # Pause/resume recording
    ├── switch-camera.tsx             # Switch camera input
    ├── switch-microphone.tsx         # Switch microphone input
    └── open-settings.tsx             # Open Cap settings
```

### 2. Enhanced Deeplink Actions (`apps/desktop/src-tauri/src/deeplink_actions.rs`)

Extended the existing deeplink implementation with new actions:

- **PauseRecording**: Pause the current recording
- **ResumeRecording**: Resume a paused recording
- **SwitchCamera**: Change camera input during recording
- **SwitchMicrophone**: Change microphone input during recording

These additions complement the existing actions:
- StartRecording
- StopRecording
- OpenEditor
- OpenSettings

## Deeplink Protocol

The extension uses the `cap://action?value=<encoded_json>` protocol to communicate with Cap.

### Action Format

Actions are JSON objects that are URL-encoded and passed as the `value` parameter:

```typescript
// Start Recording
{
  "start_recording": {
    "capture_mode": { "screen": "Built-in Display" },
    "camera": null,
    "mic_label": null,
    "capture_system_audio": true,
    "mode": "desktop"
  }
}

// Stop Recording
"stop_recording"

// Pause Recording
"pause_recording"

// Resume Recording
"resume_recording"

// Switch Camera
{
  "switch_camera": {
    "camera": "camera_id"
  }
}

// Switch Microphone
{
  "switch_microphone": {
    "mic_label": "microphone_name"
  }
}

// Open Settings
{
  "open_settings": {
    "page": null
  }
}
```

## Commands

### 1. Start Recording (`start-recording.tsx`)
- **Mode**: no-view (executes immediately)
- **Action**: Starts recording the primary display with system audio
- **Deeplink**: Uses `start_recording` action with screen capture mode

### 2. Start Recording Window (`start-recording-window.tsx`)
- **Mode**: view (shows window selection list)
- **Action**: Lists all open windows and starts recording the selected one
- **Features**: 
  - Uses AppleScript to enumerate windows
  - Searchable list interface
  - Shows app name for each window

### 3. Stop Recording (`stop-recording.tsx`)
- **Mode**: no-view (executes immediately)
- **Action**: Stops the current recording
- **Deeplink**: Uses `stop_recording` action

### 4. Toggle Pause (`toggle-pause.tsx`)
- **Mode**: no-view (executes immediately)
- **Action**: Pauses or resumes the current recording
- **Deeplink**: Uses `pause_recording` action
- **Note**: State management is handled by the Cap app

### 5. Switch Camera (`switch-camera.tsx`)
- **Mode**: view (shows camera selection list)
- **Action**: Lists available cameras and switches to the selected one
- **Features**:
  - Uses `system_profiler` to enumerate cameras
  - Searchable list interface
  - Fallback to built-in camera

### 6. Switch Microphone (`switch-microphone.tsx`)
- **Mode**: view (shows microphone selection list)
- **Action**: Lists available microphones and switches to the selected one
- **Features**:
  - Uses `system_profiler` to enumerate audio inputs
  - Searchable list interface
  - Fallback to built-in microphone

### 7. Open Settings (`open-settings.tsx`)
- **Mode**: no-view (executes immediately)
- **Action**: Opens the Cap settings window
- **Deeplink**: Uses `open_settings` action

## Technical Implementation

### Deeplink Execution Flow

1. User triggers command in Raycast
2. Extension constructs action JSON object
3. JSON is serialized and URL-encoded
4. Deeplink URL is constructed: `cap://action?value=<encoded_json>`
5. URL is opened using Raycast's `open()` API
6. Cap app receives and parses the deeplink
7. Action is executed in the Cap app
8. User receives HUD notification in Raycast

### Device Enumeration

The extension uses macOS system utilities to enumerate devices:

- **Cameras**: `system_profiler SPCameraDataType`
- **Microphones**: `system_profiler SPAudioDataType`
- **Windows**: AppleScript via `osascript`

### Error Handling

All commands include try-catch blocks and show appropriate HUD messages:
- ✅ Success messages with action details
- ❌ Error messages when operations fail
- Console logging for debugging

## Dependencies

### Runtime Dependencies
- `@raycast/api`: ^1.65.0 - Core Raycast API
- `@raycast/utils`: ^1.12.0 - Utility hooks and helpers

### Development Dependencies
- `@raycast/eslint-config`: ^1.0.8 - ESLint configuration
- `@types/node`: 20.8.10 - Node.js type definitions
- `@types/react`: 18.2.27 - React type definitions
- `eslint`: ^8.51.0 - Linting
- `prettier`: ^3.0.3 - Code formatting
- `typescript`: ^5.2.2 - TypeScript compiler

## Testing

To test the extension:

1. Install dependencies: `npm install`
2. Run in development mode: `npm run dev`
3. Open Raycast and search for Cap commands
4. Test each command with Cap running

## Future Enhancements

Potential improvements for future iterations:

1. **Recording Status**: Show current recording status in Raycast
2. **Recent Recordings**: Quick access to recent recordings
3. **Recording Presets**: Save and load recording configurations
4. **Keyboard Shortcuts**: Add default keyboard shortcuts for common actions
5. **Recording Timer**: Display recording duration
6. **Quick Share**: Share recordings directly from Raycast

## Notes

- The extension requires Cap to be installed and running
- Deeplink actions require Cap version with the enhanced deeplink support
- Some features (pause/resume, switch camera/mic) require the Rust backend changes to be merged
- The extension is designed for macOS (uses system_profiler and AppleScript)

## Bounty Requirements

This implementation fulfills the bounty requirements:

✅ Deeplinks support for:
- Recording (start/stop)
- Pause/Resume
- Camera switching
- Microphone switching
- Settings access

✅ Raycast Extension with:
- Complete command set
- User-friendly interface
- Proper error handling
- Documentation

## Related Files

- Issue: #1540
- Deeplink Implementation: `apps/desktop/src-tauri/src/deeplink_actions.rs`
- Extension Source: `raycast-extension/src/`
- Documentation: `raycast-extension/README.md`
