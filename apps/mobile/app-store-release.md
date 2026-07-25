# Cap iOS App Store release

Status date: 23 July 2026

Cap Mobile is currently an iPhone-only Expo app. Android remains outside this release because the native recorder has no Android implementation and the Expo configuration intentionally includes only iOS.

## Release blockers

- [x] Create the `cap-software-inc` Expo organization with `richiemcilroy` as its owner.
- [x] Link the app to the Cap-owned `cap-software-inc/cap-mobile` EAS project and commit its public project ID in `app.config.js`.
- [ ] Confirm that Apple Team `47B7FCLL43` owns bundle ID `so.cap.mobile`, then create or select the matching App Store Connect app.
- [ ] Configure Sign in with Apple for `cap.so`, set the production `APPLE_CLIENT_ID` and `APPLE_CLIENT_SECRET`, and verify the complete mobile OAuth callback on TestFlight.
- [x] Remove the external Cap Pro checkout action from the iOS account screen before review. Existing entitlements remain available in version 1.0.
- [x] Remove external purchase calls to action from Pro-gated Analytics and Loom Import states.
- [x] Let a signed-in user initiate permanent account deletion from Account settings.
- [x] Enforce the advertised five-minute free recording limit in both the recorder and the authenticated mobile API.
- [x] Let users report a Cap and block another Cap owner in-app.
- [ ] Deploy the mobile API changes before distributing the release build.
- [ ] Provide App Review contact details, a durable review account, and reviewer instructions in App Store Connect. Do not commit review credentials.
- [ ] Complete the current App Store age-rating, content-rights, Digital Services Act, export-compliance, and privacy questionnaires.
- [ ] Capture approved 6.9-inch iPhone screenshots with non-sensitive demo content.
- [ ] Pass a signed production EAS build, TestFlight smoke test on a physical iPhone, and App Store Connect upload validation.

## Verified foundation

- [x] Expo Doctor passes all 19 checks.
- [x] Expo SDK 55 package versions are aligned.
- [x] Mobile TypeScript validation passes.
- [x] The mobile test suite passes 34 files and 214 tests.
- [x] Xcode 26.2 is installed locally and satisfies the current iOS 26 SDK upload minimum.
- [x] The app icon is 1024 by 1024 pixels, fully opaque, and encoded without an alpha channel.
- [x] The app is phone-only, so iPad screenshots and tablet behavior are not in scope.
- [x] Camera, microphone, Photos import, and Photos save permission descriptions are configured.
- [x] Required-reason API declarations are present in the generated privacy manifest.
- [x] The iOS login surface offers Google, Apple, email-code, and enterprise SSO; Apple uses the system-provided button with the native capability enabled, and provider buttons appear only when their server credentials are available.
- [x] Help, support, privacy, and terms pages are available to signed-in users from Account settings.
- [x] Content reports are stored durably for support review, and blocked owners' Caps and comments are removed from the blocking user's mobile results.
- [x] The unused background-processing mode is removed.
- [x] Associated Domains are omitted by default while `cap.so` has no production association file.
- [x] Non-exempt encryption is declared false and the release Team ID is explicit in Expo configuration.
- [x] Version 1.0.0 uses a manual build-then-submit workflow.
- [x] The production privacy and terms pages return HTTP 200.
- [x] Production, preview, and development EAS build profiles exist, with remote build-number management and runtime-version isolation.
- [x] A clean prebuild, CocoaPods install, production JavaScript export, and Xcode 26.2 Release simulator build pass.
- [x] The built app launches from its embedded production bundle on an iPhone 17 Pro Max simulator.
- [x] The built app is phone-only, strips the development local-network permission, includes required permission copy, declares no non-exempt encryption, and contains an aggregated privacy manifest.

## Owner inputs

### Expo

1. Keep the app and its EAS subscription under the `cap-software-inc` Expo organization.
2. Use the linked `cap-software-inc/cap-mobile` EAS project for every build, update, and submission.
3. Confirm the EAS billing plan can run at least one production iOS build.

### Apple Developer and App Store Connect

1. Confirm that `so.cap.mobile` is the final bundle ID and Apple Team `47B7FCLL43` is the release team.
2. Ensure the Agreements, Tax, and Banking sections have no blocking agreements.
3. Give the submitting Apple account App Manager or Admin access plus Certificates, Identifiers & Profiles access.
4. Create the App Store Connect record and provide its numeric Apple ID for `eas.json` as `ascAppId`.
5. Provide the App Review contact name, email, and international-format phone number.
6. Create a durable review account containing safe sample Caps. Store its credentials only in App Store Connect.
7. Enable Sign in with Apple on App ID `so.cap.mobile`, create a Services ID for the web OAuth flow, associate it with the primary App ID, and register `https://cap.so/api/auth/callback/apple` as the return URL.
8. Generate an Apple client-secret JWT for the Services ID, store the Services ID as `APPLE_CLIENT_ID` and the JWT as `APPLE_CLIENT_SECRET` in the production web environment, and rotate the JWT before it expires.

### Account deletion operations

1. Assign an owner to monitor `hello@cap.so` and human-mode Messenger conversations for subjects named `[PENDING] Account deletion request`.
2. Complete deletion within 30 days: cancel any direct Cap subscription, remove the account and associated personal data and content, handle solely owned organizations, and remove access to shared organizations.
3. Email the user after completion, then change the durable request subject from `[PENDING]` to `[COMPLETED]`. Pending requests intentionally block every new mobile login.
4. Test the full process with a disposable account before App Review. Do not delete the durable review account.

### Cap Pro purchase

Version 1.0 should display the user's server-authoritative Free or Cap Pro status without offering external Stripe checkout. This is the smallest compliant release path and preserves features for customers who already subscribe on another Cap platform.

For native purchasing in a later release, the recommended Expo path is RevenueCat with `react-native-purchases`, a `pro` entitlement, monthly and yearly auto-renewable subscription products, restore purchases, and authenticated server synchronization that updates the same entitlement used by web and desktop. The owner must create the App Store subscription group and products, accept the Paid Apps agreement, and provide the public RevenueCat iOS API key through the production EAS environment. No private App Store or RevenueCat key belongs in the repository.

### Content safety operations

1. Assign an owner to monitor `hello@cap.so` and human-mode Messenger conversations for subjects named `[PENDING] Mobile content report`.
2. Review each report promptly against Cap's Terms of Service, remove violating content, respond to the reporter when appropriate, and change the durable request subject from `[PENDING]` to `[COMPLETED]`.
3. Keep the App Review explanation accurate: the native app has no public discovery feed or anonymous chat, and Caps are visible only to the owner or authenticated members of an organization or space with access. Public share links are not browsable from a public mobile catalog.
4. Maintain organization member-removal and content-removal procedures as the service-level moderation controls. Test report and block behavior with two disposable accounts before review.

### Product and legal approval

Approve the copy in `store.config.json` and confirm:

- Cap Software, Inc. owns the app and has rights to distribute its bundled assets.
- Users retain responsibility and rights for videos, images, audio, comments, and Loom imports they upload.
- The app is not made for children.
- The privacy policy accurately covers the mobile app, its account-deletion flow, retention, processors, and subscription entitlements.
- Manual release after approval is desired for version 1.0.

## Draft App Privacy answers

These answers must be reviewed against production server behavior and every third-party SDK before publishing them in App Store Connect.

| Data type | Linked to user | Tracking | Purpose |
| --- | --- | --- | --- |
| Name and email address | Yes | No | Account and app functionality |
| User ID | Yes | No | Authentication and app functionality |
| Photos, videos, and audio | Yes | No | Recording, upload, playback, and sharing |
| Other user content | Yes | No | Titles, comments, reactions, and imported content |
| Purchase history | Yes | No | Subscription entitlement and support |
| Product interaction | Yes | No | Viewer analytics and app functionality |

The current mobile package includes no advertising SDK and does not request App Tracking Transparency permission.

## Store listing

`store.config.json` contains the English App Store name, subtitle, description, keywords, category, URLs, copyright, and manual-release policy. EAS Metadata is currently beta, so compare every field with App Store Connect after pushing it.

Recommended screenshot set:

1. My Caps library with personal and space navigation.
2. Native camera recorder and teleprompter.
3. Import media and upload progress.
4. Cap playback, sharing controls, and comments.
5. Viewer analytics and reactions.
6. Account, organization, and Cap Pro status.

Use one of Apple's accepted 6.9-inch portrait sizes, remove all alpha channels, and avoid real customer names, emails, recordings, or analytics.

## App Review notes

Tell the reviewer:

- Cap requires an account because the primary experience is a private personal or organization video library.
- Email-code sign-in and the supplied review account can access every reviewable feature without relying on the reviewer's personal identity provider.
- Google and Apple login are available on iOS when their production OAuth credentials are configured; users can also sign in with email code or enterprise SSO.
- The iPhone recorder captures camera and microphone video; it does not capture the iPhone screen.
- Photos and Files access is requested only when the user chooses an import or save action.
- Free accounts can record for up to five minutes.
- Account deletion is under Account settings, signs the user out immediately, blocks re-login, and explains the 30-day deletion and direct-subscription cancellation process before confirmation.
- Existing Cap Pro entitlements are recognized in Account settings; version 1.0 does not sell digital features in the app.
- Cap is an authenticated collaboration tool without a public discovery feed or anonymous chat. Every Cap detail screen includes in-app reporting and blocking; reports enter the monitored support queue for prompt review.
- The production API and media-processing services will remain available for the full review window.

## Final verification sequence

Run these from `apps/mobile` after EAS and Apple access are configured:

```sh
pnpm dlx eas-cli@21.0.2 project:info --non-interactive
pnpm dlx eas-cli@21.0.2 config --platform ios --profile production
pnpm dlx expo-doctor@latest
pnpm typecheck
pnpm test
pnpm exec expo prebuild --platform ios --clean --no-install
pnpm dlx eas-cli@21.0.2 build --platform ios --profile production
```

After the build reaches App Store Connect:

1. Confirm the matching mobile API changes are deployed to production.
2. Install the exact build through TestFlight on a physical iPhone.
3. Test fresh install, Google, Apple, email, and SSO login, recording permissions, a five-minute boundary, background and interrupted uploads, imports, playback, comments, analytics, existing Pro recognition, content reporting and blocking with two disposable accounts, and account deletion with a disposable account.
4. Verify the app icon, privacy manifest, export-compliance status, screenshots, metadata, privacy answers, age rating, review account, and review notes.
5. Submit manually and release manually after approval.
