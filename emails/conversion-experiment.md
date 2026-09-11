# New free-user conversion experiment

The hypothesis is that a simpler first recording task and earlier, relevant Pro offers increase first paid Pro purchases. The six `free-v2-*` templates form one treatment, compared with the existing four-email `free` journey. This tests the combined journey, not individual subject lines. No conversion lift has been established.

## Enrollment and delivery

`LOOPS_FREE_EXPERIMENT_AFTER` is the earliest eligible signup date. `LOOPS_FREE_EXPERIMENT_ENABLED=true` enables new assignments. Start with a future date after the code, contact properties, workflow and custom email uploads are verified. A SHA-256 bucket of the user ID and experiment ID assigns independent free accounts 50/50. Loops stores `capFreeOnboardingExperiment`, `capFreeOnboardingVariant` and `capFreeOnboardingAssignedAt` in the same update that first enters the journey. Both arms retain their assignment after purchase or unsubscribe; subsequent updates do not replace it.

Existing enrolled users, imports, customers, invitees, teammate history, incomplete signups and opted-out/list-unsubscribed accounts cannot enter the test. No export/import or historical replay is needed. The treatment's downstream guard also requires `capLifecycleStage=free-v2`. All normal consent, list, audience and paid/teammate exclusions remain in force. Product and billing changes reach Loops through the existing durable queue.

| Day from entry | Email                                            | Eligibility at the branch                                                                     |
| -------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| 0              | Your first Cap only needs 30 seconds             | Eligible new free treatment account                                                           |
| 1              | One small thing to record today                  | No completed cloud video and no recent activation notification signal                         |
| 3              | Some explanations need more than five minutes    | Completed cloud video, no pending upload/processing, no recent activation notification signal |
| 8              | Put your recording to work                       | Same readiness gate, without observed external-view notification evidence                     |
| 10             | Record the walkthrough. Skip the extra write-up. | Same Pro readiness gate; also reaches users who became active after day 3                     |
| 12             | Anything getting in the way?                     | Same recording-help gate as day 1                                                             |

The schedule allows at most three lifecycle emails in any rolling seven days and separates planned sends by at least 24 hours. Pro and sharing follow-ups are suppressed when the latest synchronized first-link creation or first-view notification signal is less than 24 hours old. This is a conservative suppression rule, not an atomic frequency lock across Loops and Resend. Existing application notifications remain unchanged. Profile refreshes are hourly for new accounts; races between a profile refresh and delivery remain possible.

## Activation evidence

For accounts created from September 12, 2026 UTC, both arms use the new readiness query. Historical accounts retain their existing fingerprint and queries, avoiding a rewrite of the imported audience. The fixed activation date is independent of stopping experiment enrollment.

A cloud video must have positive duration, not be a screenshot, have no upload row, and have either a verified processing job or an explicit published output/legacy completion marker with no processing job. Queued jobs whose upload row has been removed do not count. The query uses the owner index and primary-key joins. Pending or failed uploads/processing suppress sales even if an older video is complete.

`capHasSharedVideo` for these new accounts means a completed video with `firstViewEmailSentAt` evidence. This is a conservative proxy for a non-owner page visit, including private videos. It is not proof of playback, and notification preferences can make it undercount. Do not use it as the primary conversion metric or claim it detects local Studio use. Imported/uploaded videos can establish cloud readiness; novelty of recording is not inferred. Copy avoids telling recipients that they have never recorded or shared.

The Pro links use the existing login `next` mechanism to reach organization billing, where the independent owner can open the monthly-first Pro offer. No checkout or payment occurs merely by opening an email link. UTMs survive the login destination. Teammates and existing buyers are excluded from sales upstream.

## Measurement contract

Keep a private, timestamped Loops export containing all assigned accounts, including later unsubscribers and customers. Deduplicate by Cap `userId`; do not filter by current audience, delivery, opens, clicks, activation or continued subscription. Match `users.stripeCustomerId` and the paying account to Stripe invoices/payments for the verified Pro product. Retain assignment timestamp and variant for every denominator row. Never interpret a seat grant, trial, license purchase or `capCustomer` flag as a new paid Pro purchase.

Primary outcome: the proportion of all assigned eligible accounts with a first successfully collected, nonzero Pro purchase within 30 days of assignment. Require a live paid invoice/payment, exclude out-of-band/uncollected payments and zero-price grants, and verify Pro line items. Report refunds separately. Analyze only assignment cohorts whose full 30-day window has elapsed, keeping both arms' acquisition windows identical.

Secondary outcomes: actual Pro collections per assigned account over 30 and 60 days, successful cloud readiness at 24 hours/7 days, repeat use, and external viewing separately. Keep currencies separate or declare a fixed conversion method. Report annual cash collections separately from monthly subscriptions. Guardrails: opt-outs, complaints, bounces, duplicate sends, support problems and Desktop-license revenue displacement. Snapshot retention at equal cohort age; annual renewal is not observable after 60 days.

Before choosing a winner, refresh the eligible signup rate and mature baseline, define the minimum useful lift and sample size, then allow the full outcome window. Early opens/clicks are diagnostic only. Preserve invoice IDs and payment timestamps in the private analysis for auditability. No scheduled statistical readout is implied by this file.

## Operation and recovery

Create a new workflow only with `scripts/loops/provision.ts --new-journey free-v2 --apply --state <private receipt> --team "Cap Software, Inc." --mailing-list <verified list>`. This mode refuses unrelated existing workflows and initializes new draft emails before custom upload. It does not edit existing MJML. Export with `bun run emails:export --output <private directory>` and upload the six archives in Code. Review metadata, fallbacks, body, loaded logo and the single footer for every email. Reconcile resource IDs into `resources.json` and include the new workflow in watchdog checks.

Verify with `bun run emails:check-loops --structure-only --allow-live`; omit `--allow-live` when only drafts should exist. API checks do not prove custom MJML parity. The source tests include opt-outs, immutable assignment, purchases, delayed notification suppression, SQL nulls, screenshots, incomplete processing and known completion. SQL fixture tests use CTEs with synthetic rows and perform no database writes.

To stop new experiment assignments, set `LOOPS_FREE_EXPERIMENT_ENABLED=false` and deploy. Existing assignments continue their own journeys. Do not change the fixed activation signal date or reset contact assignment properties. Pause the treatment in Loops if delivery itself must stop. Before reverting to code without variant-aware routing, pause both free workflows and reconcile enrolled contacts, since older code would route treatment contacts back to `free`. Never bulk resubscribe, re-enroll, or clear imported holds as a recovery step.
