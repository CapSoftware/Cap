# Cap Chrome Extension

A Chrome extension that launches Cap's web-based recorder for instant screen, tab, and camera recording.

## Features

- **Quick Access**: One-click launcher to open Cap's web recorder
- **Smart Tab Management**: Reuses existing recorder tabs instead of creating duplicates
- **Full Recording Suite**: Access to all Cap recording features via the web app:
  - Multiple recording modes (screen, window, tab, camera)
  - Recording controls (start/stop, pause/resume)
  - Device selection (camera and microphone)
  - Real-time recording timer
  - Automatic upload to Cap

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

- **`tabs`**: Access tab information for tab recording

## Contributing

Contributions are welcome! Please follow the existing code style and test thoroughly before submitting PRs.

## License

See the main Cap repository for license information.
