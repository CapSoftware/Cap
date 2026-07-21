# Cap Mobile

Cap Mobile is an iOS Expo app built with Expo Router and Continuous Native Generation. Native projects are generated locally or by EAS and are not committed.

Run every command in this directory unless noted otherwise.

## Local development

From the repository root, `pnpm dev:mobile` starts the existing Cap web stack and launches the iOS development build. To run only the mobile client against an already-running backend:

```sh
pnpm dev
```

For a physical iPhone, use:

```sh
pnpm dev:device
```

## One-time EAS setup

An Expo account with access to the `cap` organization must link this app to its EAS project:

```sh
pnpm dlx eas-cli@21.0.2 project:init
```

Keep the generated EAS project ID in `app.config.js`. It is a public identifier and is required for EAS Build and EAS Update. Configure `EXPO_PUBLIC_CAP_WEB_URL` in the development, preview, and production EAS environments when a profile should use a backend other than the production default at `https://cap.so`.

EAS manages iOS signing credentials remotely. The first device or production build may ask an authorized Apple Developer account to create or select the distribution certificate, provisioning profile, and App Store Connect API key.

## Builds and App Store submission

Create a simulator development client:

```sh
pnpm build:development
```

Create an internal iPhone build:

```sh
pnpm build:preview
```

Build the production app and submit it to App Store Connect:

```sh
pnpm build:production
```

Production build numbers are managed and incremented by EAS. To resubmit the latest production build without rebuilding it:

```sh
pnpm submit:production
```

## Updates

Preview an over-the-air JavaScript or asset update first:

```sh
pnpm update:preview -- --message "Describe the update"
```

After verification, publish the same commit to production:

```sh
pnpm update:production -- --message "Describe the update"
```

Updates are isolated by channel and app version. When native dependencies or Expo configuration change, increment `version` in `app.config.js` and ship a new production build instead of publishing an incompatible update.
