## Cap Loom Importer

This is a Chrome extension that allows you to import your Loom videos into Cap.

## Structure

```
├── src
│   ├── background.ts # Background script for handling auth
│   ├── content_scripts
│   │   └── main.tsx # Import UI injected on Loom's website
│   ├── popup
│       └── popup.tsx # Popup for the extension (shown when the extension is clicked)
└── vite.config.ts
```

## Development

Go to chrome://extensions/ and click "Load unpacked" and select the `dist` folder.
