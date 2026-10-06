# Cap Mobile

Cap Mobile is an iOS Expo app built with Expo Router and Continuous Native Generation. Native projects are generated locally or by EAS and are not committed.

Run every command in this directory unless noted otherwise.

## Local development

From the repository root, `bun run dev:mobile` starts the Cap web stack and launches the iOS simulator:

```sh
bun run dev:mobile
```

To start the web stack and install the development build on a connected iPhone, use:

```sh
bun run dev:mobile:physical
```

The physical-device command discovers the Mac's current private LAN address and uses it for both the Cap API and Metro. Override it with `CAP_MOBILE_DEVICE_API_URL` only when the iPhone should use a different backend.

To run only the mobile client against an already-running backend:

```sh
bun run dev
```

For a physical iPhone without starting the web stack, use:

```sh
bun run dev:physical
```

## One-time EAS setup

An Expo account with access to the `cap` organization must link this app to its EAS project:

```sh
bunx eas-cli@21.0.2 project:init
```

Keep the generated EAS project ID in `app.config.js`. It is a public identifier and is required for EAS Build and EAS Update. Configure `EXPO_PUBLIC_CAP_WEB_URL` in the development, preview, and production EAS environments when a profile should use a backend other than the production default at `https://cap.so`.

EAS manages iOS signing credentials remotely. The first device or production build may ask an authorized Apple Developer account to create or select the distribution certificate, provisioning profile, and App Store Connect API key.

## Builds and App Store submission

Create a simulator development client:

```sh
bun run build:development
```

Create an internal iPhone build:

```sh
bun run build:preview
```

Build the production app:

```sh
bun run build:production
```

Production build numbers are managed and incremented by EAS. After the build has passed release verification, submit the latest production build and the metadata in `store.config.json` to App Store Connect:

```sh
bun run submit:production
```

## Updates

Preview an over-the-air JavaScript or asset update first:

```sh
bun run update:preview -- --message "Describe the update"
```

After verification, publish the same commit to production:

```sh
bun run update:production -- --message "Describe the update"
```

Updates are isolated by channel and app version. When native dependencies or Expo configuration change, increment `version` in `app.config.js` and ship a new production build instead of publishing an incompatible update.
