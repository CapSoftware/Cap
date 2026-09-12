# Free onboarding runtime

The `free-v2` journey uses the templates and conditional delays in `flows.ts`. The existing `free` journey remains available. Assignment is disabled by default.

## Enrollment

`LOOPS_FREE_EXPERIMENT_ENABLED=true` enables new assignments for signups on or after `LOOPS_FREE_EXPERIMENT_AFTER`. Configure a future boundary only after verifying the deployed code, contact properties, workflow, and custom email uploads.

A deterministic user-ID bucket assigns eligible independent free accounts equally between the two journeys. Loops stores the experiment ID, variant, and assignment timestamp together with the first lifecycle-stage update. Assignment survives later purchases and unsubscribes; subsequent updates do not replace it.

Existing enrolled users, imports, customers, invitees, teammate history, incomplete signups, and unsubscribed accounts cannot enter. The `free-v2` downstream guard additionally requires `capLifecycleStage=free-v2`. Consent, list membership, and audience guards apply throughout delivery. Product and billing changes use the existing durable sync queue.

## Activation signals

Accounts created from September 12, 2026 UTC use the new readiness query in either journey. Older accounts retain their existing queries and profile fingerprints. This fixed signal boundary is independent of the enrollment switch.

A completed cloud video requires positive duration, no screenshot flag or upload row, and a verified processing job or explicit published output/legacy completion marker with no processing job. Pending or failed uploads and processing suppress Pro and sharing follow-ups, including when an older video is complete.

`capHasSharedVideo` uses `firstViewEmailSentAt` on a completed video as a proxy for a non-owner page visit. It does not prove playback, and notification preferences can make it undercount. Local Studio recordings are not observed. Imported or uploaded videos can establish cloud readiness.

Follow-ups are suppressed for 24 hours after the latest synchronized application-notification signal. Profiles refresh hourly for new accounts, so this is not an atomic frequency lock across Loops and Resend; a refresh-to-delivery race remains possible. The configured journey allows at most three lifecycle messages in seven days, separated by at least 24 hours.

Pro links preserve the organization-billing destination through the existing login `next` parameter. Opening a link does not initiate payment.

## Verification and recovery

Create a new custom-email workflow with `scripts/loops/provision.ts --new-journey free-v2`, using the required private receipt, verified team and mailing list. New-journey mode refuses unrelated existing workflows. Export with `bun run emails:export --output <private directory>`, upload the archives in Loops, and review metadata, fallbacks, body, images, and footer. Store only nonsecret resource IDs in `resources.json`.

Run `bun run emails:check-loops --structure-only --allow-live` to verify remote structure and state. Omit `--allow-live` when only drafts are expected. API checks cannot establish custom-MJML content parity; browser review remains necessary. Every registered journey is included in the independent watchdog.

To stop new assignments, set `LOOPS_FREE_EXPERIMENT_ENABLED=false` and deploy. Existing assignments continue their journeys. Pause the corresponding Loops workflow when delivery itself must stop. Do not change the fixed activation boundary or reset assignment properties.

Before reverting to code without variant-aware routing, pause both free workflows and reconcile enrolled contacts: older code would route treatment contacts back to `free`. Never bulk resubscribe, re-enroll, or clear imported holds during recovery.
