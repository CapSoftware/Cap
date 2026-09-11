# Loops migration verification — 11 September 2026

All four production workflows and both campaign templates remain drafts. No actual customer received a test email. The four temporary QA workflows are paused, and all 36 owned QA contacts from the two test runs are held and globally unsubscribed.

## What was exercised

The controlled test used the real `classifyProfile` and `contactUpdate` logic with synthetic fixtures, wrote those properties to Loops, and received real workflow emails in owned Cap inbox aliases. Each QA flow required an exact recipient allowlist and a separate QA trigger property; production lifecycle stages stayed idle. Timers were compressed to two minutes, with the production audience guards and milestone branches retained.

| Scenario                                                                                                                                                       | Received             | Result                                                     |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | ---------------------------------------------------------- |
| Independent free user                                                                                                                                          | 4                    | Welcome, recording, sharing and plan guidance              |
| Customer                                                                                                                                                       | 3                    | Customer sequence only                                     |
| Teammate                                                                                                                                                       | 2                    | Workspace help only; no promotions                         |
| Former customer                                                                                                                                                | 1                    | Feedback request                                           |
| Recording and sharing milestones already complete                                                                                                              | 2                    | Both reminders skipped; welcome and plan guidance retained |
| Purchase after welcome                                                                                                                                         | 1                    | Later free-user promotions stopped                         |
| Invitation after welcome                                                                                                                                       | 1                    | Later free-user promotions stopped                         |
| Global unsubscribe after welcome                                                                                                                               | 1                    | Later messages stopped                                     |
| Mailing-list unsubscribe after welcome                                                                                                                         | 1                    | Later messages stopped                                     |
| Held, denied consent, list opt-out, unknown audience, customer in free flow, teammate in free flow, disabled lifecycle, ineligible onboarding, unknown consent | 0 across all 9 cases | No enrollment emails                                       |

Exactly 16 workflow emails arrived. Trigger replay during the journey and after completion did not produce extra mail. A later mailbox reconciliation still found exactly 16. Transitions happened before the next timer elapsed. This proves the tested Loops behavior when fresh properties reach Loops, not the latency or reliability of a production scheduler that has not been deployed.

An initial allowlist configuration prevented all sends. It was corrected to apply once at entry; the downstream production audience guards remained active. The initial run's contacts were held before the successful run. All test workflows were paused afterward and every QA contact was independently read back with lifecycle flags false, both stages idle and global subscription false.

## Copy and rendering

All 12 messages were reviewed against the private Bento sequence/broadcast archive and rewritten around one useful action. The [voice guide](VOICE.md) records each email's purpose. Prices, promotions and unsupported activity claims were removed. This is an editorial conversion hypothesis; no measured conversion lift is claimed.

The final drafts were uploaded as generated custom MJML and reviewed in the actual Loops editor for copy, links, subject, preview, sender, reply address, fallback values and one compact footer. Loops' native opt-in explanation is absent. A native line-height mistake was fixed: LMX interprets line height as a percentage, so `26` collapsed the footer; custom delivery now uses explicit 26px body and 19px footer line heights.

The final header exports the actual Cap component's vector paths, including its original wordmark, to a 486×160 PNG. It is displayed at 120px wide with its natural aspect ratio. The image's left edge and body copy start at 28px in the 600px email. The PNG is fully opaque with white backing so the original dark lettering remains legible against dark backgrounds. The final received email's logo bytes matched the local PNG by SHA-256. There is no replacement font or separate text approximation. Cross-client automatic dark-mode transformations and every mobile email client have not been exhaustively tested.

Controlled previews to `hello@cap.so` verified an absent name renders `Hey,`, a supplied name renders `Hey Richie,`, and the customer plan name and plan-specific prose appear correctly. The inbox preview text is retained. The final logo preview is separate from the earlier icon-only and temporary text-wordmark previews; use the newest preview when reviewing the design.

All 16 workflow messages and the inspected final-layout previews arrived in Gmail's inbox with SPF, DKIM and DMARC passing, plus one-click unsubscribe headers. Category placement varied. Authentication and these observed deliveries do not guarantee future inbox placement or eliminate spam complaints.

## Local regression checks

The profile replay used the archived 10 September snapshot at a fixed date: 64,288 source profiles, zero audience or consent changes, every profile held, and no customer or teammate made promotion-eligible. Greeting output was checked for every profile. This was a historical regression replay, not a fresh production reconciliation.

The local suite checks consent precedence, suppression preservation, customer and teammate classification, milestones, enrollment holds, missing/blank names, source variables, fallback contracts, footer uniqueness, preserved links and unsupported template blocks. Scoped TypeScript and formatting checks cover the touched scripts. The read-only Loops verifier checks graph structure and confirms all 12 emails use custom format. Custom MJML content cannot be fetched through the beta API; browser review is required, and the default full-content check fails explicitly rather than claiming parity.

## Remaining gate before switching

The deployed Cap signup/purchase/invite/opt-out path through an enrollment dispatcher and into an inbox has not been proven. The reviewed schema is not deployed, new explicit consent capture/enrollment and retry/deduplication dispatch need implementation, and the current sync intentionally keeps contacts held. Freshness expiry and scheduler monitoring are also required: an old `capVerifiedAt` value does not automatically prevent a Loops send.

Follow the [cutover runbook](../scripts/loops/README.md#before-any-activation). Test that deployed path using owned inboxes, including outages and retries, before requesting production activation. Keep imported history held, preserve all opt-outs, reconcile fresh Bento changes, check Resend overlap and disable duplicate Bento automation only during the approved cutover.

Private contact data, message bodies, action logs, API verification and import receipts remain outside Git. The [delivery receipt](delivery-receipt.json) records reviewed local archive hashes and draft identifiers; it is historical evidence, not live drift detection.
