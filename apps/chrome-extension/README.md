# Cap Chrome Extension

A Chrome extension for Cap that enables instant screen, tab, and camera recording directly from your browser.

## Features

- **Multiple Recording Modes**
  - Screen recording (entire screen or specific window)
  - Tab recording (current browser tab)
  - Camera recording (webcam only)

- **Recording Controls**
  - Start/stop recording 
  - Pause/resume during recording
  - Real-time recording timer
  - On-page recording indicator

- **Audio Options**
  - Optional microphone audio
  - System audio capture (for tab recording)
  - High-quality audio encoding

- **Seamless Integration**
  - Automatic upload to Cap
  - Direct link to recorded video
  - Progress tracking during upload
  - Multipart upload for large files

## Installation

### From Source

1. Install dependencies:
   ```bash
   pnpm install
   ```

2. Build the extension:
   ```bash
   pnpm build
   ```

3. Load in Chrome:
   - Open Chrome and navigate to `chrome://extensions/`
   - Enable "Developer mode" (toggle in top right)
   - Click "Load unpacked"
   - Select the `dist` folder


## Usage

### First Time Setup

1. Click the Cap extension icon in your browser toolbar
2. Click "Sign In to Cap" to authenticate
3. You'll be redirected to Cap's authentication page
4. Once authenticated, you're ready to record!

### Recording

1. Click the Cap extension icon
2. Select your recording mode (Screen, Tab, or Camera)
3. Configure audio options:
   - Enable/disable microphone
   - Enable/disable camera overlay
4. Click "Start Recording"
5. Grant necessary permissions when prompted
6. Record your content
7. Click "Stop" when finished
8. Your recording will automatically upload to Cap


### Adding New Features

1. Update the appropriate component file
2. If adding new permissions, update `manifest.json`
3. Test thoroughly in development mode
4. Build and test the production version

## Browser Compatibility

- Chrome 100+
- Edge 100+
- Other Chromium-based browsers

## Permissions

The extension requires the following permissions:

- **`storage`**: Store authentication tokens and user preferences
- **`tabs`**: Access tab information for tab recording
- **`activeTab`**: Capture current tab content
- **`scripting`**: Inject content script for recording indicator
- **`offscreen`**: Create offscreen document for media capture

## Contributing

Contributions are welcome! Please follow the existing code style and test thoroughly before submitting PRs.

## License

See the main Cap repository for license information.
