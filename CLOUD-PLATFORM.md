# Worm platform

Worm owns its recording workflow, identity and cloud protocol. Local recording works without an account. Users choose whether to share and which compatible server stores their media. The desktop presents no Cap subscription, commercial-license activation or paid quality gate. Required upstream attribution and source licenses remain intact.

## Shipping foundation

The native GPUI recorder/editor, UX Walk evidence collector, provider configuration and library stay in their existing paths. The new Sharing settings and shared Rust client extend those paths. Instant records locally, with its existing capture/finalization pipeline and recovery ownership; it no longer needs a remote video reservation. Share is an explicit action after capture/export.

The standalone apps/cloud service uses Workers for the API, private R2 for media and metadata, and Workers Static Assets for the viewer. The Jacks Unlimited, Inc. project keeps its original deployment name. Its current origin is https://capux.jaxtrell.workers.dev. demo.jacks.med is a possible future custom domain; no existing demo route or DNS record is changed by this implementation.

There is one server-owner upload credential today. Viewing links are expiring unlisted capabilities. This is suitable for our own use and self-hosted deployments; public account registration is deliberately a subsequent capability, not a simulated signup screen. The native app can use any compatible origin and does not hardcode our instance as its upload default.

## Accounts and workspaces

Extend the server's authorization boundary to return a stable user/workspace principal. Each recording, upload session, share, credential and issue destination must belong to that principal. Request bodies must never choose an unchecked owner. Token rotation must preserve ownership and revocation rights.

Use an established authentication implementation with verified sessions, recovery and a native/CLI authorization flow. Store account/workspace membership, share ownership, consent and connection metadata in a database such as D1; keep media in private R2. Add account-isolation tests before enabling signup. A personal user's media must not become discoverable through object paths, guessed ids, lists, viewer cookies or another workspace's credential.

Before opening registration, implement user-scoped credentials, quotas, abuse/rate limits, account export/deletion, incident visibility and a retention policy. Preserve the self-hosted owner mode and local-only desktop behavior. There is no need for a subscription surface to deliver these capabilities.

## One recording to one handoff

The current UX Walk journal, browser capture, native processor, local report and agent prompt are the foundation. Extend them rather than introducing another recorder or separate transcript application.

Feedback from using a real meeting recording and external transcript exposed clock resets, mixed audio, speaker merges, inconsistent name spellings and missing screen context. The next capture contract is:

- Record the actual shared/interacted window and preserve separate microphone and system/call audio sources alongside a playable composite. Collect participant-specific audio only where the selected call integration actually supplies it.
- Maintain one manifest for wall time, active recording time, pauses, capture segments, call boundaries and imported transcript offsets. An imported transcript's zero must map explicitly to the recording timeline.
- Collect the attendee list and product glossary once. Normalize spellings with traceable corrections. Keep source words, speaker ids, confidence and uncertain spans available; do not present diarization guesses as established identities.
- Associate each narrated finding with the window URL/route, frame, click target, console exception or failed request and request/job identifiers when captured. Show partial or unavailable evidence explicitly.
- Keep raw evidence local until a user-selected sharing policy permits it. Offer a reviewable exclusion/redaction list for secrets on screen and sensitive conversation before publishing.
- Finish in one summary page: decisions, action items with owners and timestamps, open questions, evidence links, transcript and a copyable agent prompt.
- Prepare issue candidates with title, observed behavior, expected behavior, quote, speaker/confidence, recording timestamp, route and evidence. Deduplicate against the selected Beads or Linear project. File only through the configured destination and authorized automation policy; report created ids and failures in the same package.

The feedback-driven follow-up is tracked as oncall-7r3pm.1. Separate source tracks, confidence review, transcript import alignment and automatic destination filing are not claimed by the first sharing-server release.

## Cloud processing later

Add asynchronous processing behind the existing local processing contract, preserving the user's provider choice. A job should carry the recording manifest version, selected inputs, provider and output contract; retries must not create duplicate shares or issues. Durable processing, a queue and progress events can deliver the same summary page after the app closes.

Provider credentials stay local by default. Hosted processing needs its own explicit configuration, scoped secret storage and a clear statement of which media leaves the computer. A production session-replay pipeline is a separate opt-in capability with its own capture and privacy boundaries; it is not implied by using the desktop recorder.
