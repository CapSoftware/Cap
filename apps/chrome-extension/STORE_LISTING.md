# Chrome Web Store Listing

Everything below is ready to paste into the Chrome Web Store Developer Dashboard. Keep claims in sync with the extension version being submitted.

## Store Fields

Name: Cap - Screen Recorder & Screen Capture

Short name: Cap

Summary (132 char max, mirrors manifest description): Free, open source screen recorder. Capture your screen, tab, camera & mic in Chrome and share a video link the moment you stop.

Category: Productivity → Communication

Language: English

Website: https://cap.so

Support: https://cap.so/docs

Privacy policy: https://cap.so/privacy

## Detailed Description (paste as plain text)

Cap is the open source screen recorder for Chrome. Record your screen, a window, the current browser tab, or camera-only video. Your recording uploads while you record, so a shareable link is ready the moment you stop. No exports, no waiting, no switching tools.

WHY PEOPLE SWITCH TO CAP

Cap is a Loom alternative built on a simple idea: your recordings belong to you. Cap is fully open source, lets you connect your own storage, and gives you a fast, lightweight recorder that stays out of your way.

• Truly open source: inspect every line of code, contribute, or self-host the entire stack.
• Own your recordings: use Cap Cloud or connect your own S3 bucket. No vendor lock-in, ever.
• Instant share links: video uploads as you record, so the link is live the second you stop.
• Cap AI: auto-generated titles, summaries, clickable chapters, and searchable transcripts for every recording.
• Built for teams: comments, reactions, viewer analytics, password-protected shares, custom domains, and team workspaces.
• Switching from Loom? Import your existing Loom videos directly into Cap with the built-in importer.

WHAT YOU CAN RECORD

• Current browser tab: perfect for web app demos and bug reports.
• Full screen or a single window.
• Camera-only video for quick personal updates.
• Microphone audio, system audio (where Chrome supports it), and a webcam overlay for walkthroughs.

MADE FOR EVERYDAY VIDEO

Screen recording for async standups, code reviews, bug reports, product demos, customer support, onboarding, tutorials, design feedback, and sales outreach. Record once, share a link, and skip the meeting.

HOW IT WORKS

1. Click the Cap icon and pick tab, screen, window, or camera.
2. Choose your microphone and camera, then hit record.
3. Stop recording. Your video is already uploaded to your Cap workspace and the share link is ready.

CAP EVERYWHERE

The extension is part of the Cap platform: native desktop apps for macOS and Windows, a web recorder, and a shared library at cap.so. Recordings stay connected to your Cap account wherever you capture them.

Cap is free to get started. Upgrade to Cap Pro for unlimited recording length, Cap AI, custom domains, custom S3 storage, and team features.

Open source on GitHub: https://github.com/CapSoftware/Cap

## SEO Positioning

Primary keywords (use naturally in the description, never stuffed):

- screen recorder / screen recorder for Chrome
- screen capture / screen recording
- record browser tab
- screen recorder with camera and microphone
- webcam recorder
- video messaging / async video
- Loom alternative (used exactly once in the detailed description; never in the name, summary, or screenshot text)

Name strategy: "Cap - Screen Recorder & Screen Capture" leads with the brand and covers the two highest-volume queries, matching how the top competitor titles its listing without keyword spam.

Summary strategy: front-loads "free, open source screen recorder" (differentiator + keyword), lists capture surfaces, and ends on the instant-share-link benefit.

Review-safety notes:

- Keep every claim true for the submitted build (system audio is "where Chrome supports it").
- Do not mention competitor names in metadata fields other than the single description mention.
- Do not claim "unlimited free": free tier has limits; Pro removes them.

## Icons

`public/icons/` is generated from the brand mark `apps/web/public/logos/logo-solo.svg`:

- icon-16/32/48: full-bleed, used for toolbar and favicon contexts.
- icon-128: 96x96 artwork centered with 16px transparent padding, per Chrome Web Store icon guidelines (this is the store listing icon).
- icon-256: same padded treatment at 2x.

Regenerate with rsvg-convert:

```sh
cd apps/chrome-extension/public/icons
for s in 16 32 48; do rsvg-convert -w $s -h $s ../../../web/public/logos/logo-solo.svg -o icon-$s.png; done
rsvg-convert -w 96 -h 96 --page-width 128 --page-height 128 --top 16 --left 16 ../../../web/public/logos/logo-solo.svg -o icon-128.png
rsvg-convert -w 192 -h 192 --page-width 256 --page-height 256 --top 32 --left 32 ../../../web/public/logos/logo-solo.svg -o icon-256.png
```

## Promotional Images

Store sources live in `store-assets/`. PNGs are full-bleed with square corners, as the store requires.

- promo-small.png: 440x280 small promo tile (required).
- promo-marquee.png: 1400x560 marquee tile (optional, needed for feature placement).

The SVG sources use the Neue Montreal fonts bundled in `public/fonts`. Regenerate with a fontconfig file that points at that directory:

```sh
cat > /tmp/cap-fonts.conf <<'EOF'
<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <dir>/path/to/Cap/apps/chrome-extension/public/fonts</dir>
  <dir>/System/Library/Fonts</dir>
  <cachedir>/tmp/cap-fc-cache</cachedir>
</fontconfig>
EOF
cd apps/chrome-extension/store-assets
FONTCONFIG_FILE=/tmp/cap-fonts.conf rsvg-convert -w 440 -h 280 promo-small.svg -o promo-small.png
FONTCONFIG_FILE=/tmp/cap-fonts.conf rsvg-convert -w 1400 -h 560 promo-marquee.svg -o promo-marquee.png
```

## Screenshot Plan

Use 1280x800 PNG screenshots, full bleed, square corners, no padding. Capture against a real page, not a blank tab.

1. In-page recorder panel open with the recording mode selector (tab / screen / camera) visible.
2. Recording setup showing microphone and camera selectors plus the system audio toggle.
3. Recording in progress with the floating recording bar and webcam overlay on a real page.
4. Upload/completion state with the share-link handoff.
5. The Cap share page (player, transcript/chapters) after a recording is available.

## Review Notes: Permission Justifications

- activeTab and scripting: show the recording controls overlay on the page the user is recording.
- tabCapture: record the current browser tab when the user selects tab recording.
- offscreen: run capture, encoding, and upload outside the recorder panel so recordings survive closing it.
- storage: remember account session, selected devices, and recording preferences.
- identity: sign the user in to their Cap account.
- host permissions: inject the recording overlay and camera preview on pages the user chooses to record.

Submission checklist: icon present (128px padded), summary under 132 chars, at least one 1280x800 screenshot, small promo tile uploaded, privacy policy URL set, permission justifications filled in.
