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

The new implementation uses native Stripe imports, a held SSO fallback, and `loops_sync_jobs` for durable enrichment. Local routing tests cover missing Stripe imports, incomplete billing bootstrap, teammate persistence, an existing account accepting a new invite, global/list opt-outs, missing list membership, replay, identity conflicts and imported holds. The email, profile, lifecycle and delivery-check suites now pass 65 tests; existing SSO and Stripe subscription suites passed another 83. Database and web TypeScript checks passed.

Nine integration checks passed on an isolated PlanetScale branch: transactional rollback, overlapping claims, expired lease recovery, newer work surviving older success/failure acknowledgements, an indexed due query, health classification, clearing recovered failures, and retry timing with replacement leases. A full `db:push` attempt hit the repository's unrelated storage prefix-index quoting bug; the exact generated Loops migration was then applied and independently checked on the empty test branch. No production schema or data changed. The first owned schema-only test branch was deleted after verification; a fresh empty branch was used for the expanded nine-test review run.

The worker was exercised from synthetic database records through the real Loops API, including a simulated HTTP 429 followed by a successful retry, free and SSO teammate classification, a free-to-teammate transition, and a later unsubscribe surviving a billing change. Separate live checks cover imported holds and list removals. Loops omits an API-removed list from the returned map; the runtime now treats missing membership as ineligible and never re-adds lists during updates. All owned test contacts were read back held and globally unsubscribed. These checks sent no email and kept production workflows in Draft.

The native Stripe integration is connected to Cap Software, Inc. and enabled for customer creation and updates only. A new owned live Stripe customer appeared in Loops; two later name changes updated that same contact. Name import and Product updates and tips list assignment were verified, and a global unsubscribe survived the final Stripe update. No payments, subscriptions or emails were created. The test contact remains held and globally unsubscribed. Both saved event mappings were checked after reload. A separate test-mode Stripe customer did not import through this live connection, is not counted as a passing native test, and was deleted after verification.

The independent GitHub delivery check is implemented but not deployed or enabled. Its local tests cover healthy operation, stale/unavailable health, manual hold, persistent holds after recovery, guarded manual resume, audience drift and partial provider failure. A real Loops API test applied the hold to all four production drafts, read back the downstream filters, and confirmed simulated recovery left them held. This sent no emails. It proves the API mutations on drafts, not the behavior of an already-running journey during a deployed outage. GitHub delays and a Loops API outage can delay or prevent the hold; scheduled campaigns remain a separate manual preflight and cancellation responsibility.

A separate recipient Preference Center test used an existing delivered QA message. The owned contact was globally subscribed with the Product updates and tips list selected, then the recipient switched that list off while leaving global subscription on. Updating the owned Stripe fixture delivered the new name to the same Loops contact and preserved its absent list membership. No new email, payment or subscription was created. The contact was held throughout and globally unsubscribed again afterward.

The deployed Cap signup/purchase/invite path has not yet been proven end to end. Production schema/code deployment, the final Bento suppression delta, and deployed scheduler monitoring remain cutover gates. The worker retries failed updates, but Loops still uses the last successfully synced values during an outage; `capVerifiedAt` is not a native expiry rule.

Follow the [cutover runbook](../scripts/loops/README.md#before-any-activation). Test that deployed path using owned inboxes, including outages and retries, before requesting production activation. Keep imported history held, preserve all opt-outs, reconcile fresh Bento changes, check Resend overlap and disable duplicate Bento automation only during the approved cutover.

Private contact data, message bodies, action logs, API verification and import receipts remain outside Git. The [delivery receipt](delivery-receipt.json) records reviewed local archive hashes and draft identifiers; it is historical evidence, not live drift detection.
