# Cap lifecycle email migration

Marketing source and shared branding now live in [emails/](../../emails/README.md). Start with the [email catalogue and flow maps](../../emails/CATALOG.md); regenerate it with `bun run emails:catalog`. Run `bun run emails:check` for local checks and `bun run emails:check-loops --structure-only` for read-only graph checks. Custom MJML content requires browser review; see the email library instructions.

This prepares Cap's Bento audience and replacement Loops journeys. Provisioning creates drafts only. Importing and syncing keep `capLifecycleEnabled=false`, `capOnboardingEligible=false`, and `capLifecycleStage=idle`. No script activates workflows, sends messages, or replays historical events.

The September 2026 repository audit found no Bento SDK, environment variable, or send call to replace. Bento's marketing automations were configured outside this repository. Existing Resend authentication, invitation, billing, notification, support, and BAA emails remain in place.

## Audience rules

| Audience              | Evidence                                                                                                                         | Draft journey                                                                   |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Independent free user | Independent signup or a matching personal organization created at signup, with no paid entitlement or uncertain customer history | Welcome, recording help on day 2, sharing help on day 5, plan guidance on day 9 |
| Customer              | Active/trialing/paid/past-due Cap Pro, a paid organization seat, or a currently valid desktop/self-hosted license                | Plan-specific welcome, a reusable recording idea on day 3, feedback on day 7    |
| Teammate              | Invitation, SSO, another owner's organization, third-party subscription, or a previously recorded teammate flag                  | Workspace setup, then handoff guidance on day 3; no promotional journey         |
| Former customer       | Canceled cloud subscription with no desktop/self-hosted license history                                                          | Feedback request after 14 days                                                  |
| Unknown               | Missing identity/origin, stale customer tags, expired license evidence, or ambiguous entitlement                                 | No journey or campaign audience                                                 |

Teammate evidence takes priority and is retained after membership changes. A future independently initiated purchase does not automatically erase that history. Customer classification uses Cap and the separate license database, not Bento's historical customer tag alone. A license's active flag is insufficient without a future renewal date.

The production enrollment policy is automatic addition to Loops on completed Cap signup, including completed teammate signup. No separate marketing opt-in checkbox or consent-evidence record is required by this product policy. Existing global unsubscribes, mailing-list opt-outs, bounces and suppressions still take precedence; another signup or profile update must not resubscribe an existing contact. Creating an invitation alone does not enroll its recipient. Teammates receive workspace help only, while independent users and customers receive their matching journeys.

The current draft journeys require a global subscription, `capConsent=subscribed`, the correct audience, and both enrollment flags. `capConsent` is a legacy migration guard; it must not introduce a separate consent-capture step for new signups. The audience filter applies downstream. Free/former promotional journeys also require `capTeammate=false` and `capPromotionalEligible=true`. Recording/sharing branches skip the corresponding reminder when the known cloud milestone is complete; local-only recordings cannot be observed by this sync.

All imported contacts remain held, including recent signups. Historical contacts must never be enrolled by replaying a contact-created event or bulk changing their lifecycle stage.

## Consent and private data

`prepare.ts` excludes source opt-outs, suppression flags, bounces, complaints, and conflicting negative subscription fields from the positive import. It also produces a normalized-email SHA-256 registry for every source row. Retain that registry even when excluded addresses are not created in Loops. Hashes are sensitive matching identifiers, not anonymous data.

Reconcile opt-outs already present in the destination by setting those existing records to unsubscribed. Do not import excluded addresses as new subscribed contacts. Loops-native global and mailing-list opt-outs must survive migration and later syncs. The normal sync never writes `subscribed=true` to an existing contact and never replaces mailing-list preferences. Missing imported contacts are not recreated.

Keep exports, prepared contacts, CSVs, registry files, receipts, database connection strings, and API keys outside Git, in a private directory. Do not expose license keys; the classifier only needs email, entitlement kind, active status, and renewal date.

## Commands

Run from the repository root with Bun 1.4. Supply `LOOPS_API_KEY` through the process environment. Every API command checks the exact expected team name. Cap's migration account is **Cap Software, Inc.**; a separate Loops account named **Cap** must not be used.

```sh
bun scripts/loops/provision.ts --team 'Cap Software, Inc.' --dry-run
bun scripts/loops/verify.ts --team 'Cap Software, Inc.' --state "$LOOPS_PRIVATE_DIR/provision-state.json" --mailing-list "$LOOPS_MAILING_LIST_ID" --structure-only
bun scripts/loops/prepare.ts --sources "$LOOPS_PRIVATE_DIR" --output "$LOOPS_PRIVATE_DIR/import"
bun scripts/loops/import.ts --team 'Cap Software, Inc.' --contacts "$LOOPS_PRIVATE_DIR/import/contacts.json" --receipt "$LOOPS_PRIVATE_DIR/import/receipt.jsonl" --mailing-list "$LOOPS_MAILING_LIST_ID"
```

Review the dry-run counts, then add `--apply` to import. Use the same receipt to resume after interruption; existing identities are checked and enriched without resubscribing. Invalid rows are recorded privately. Correct their input before using `--retry-invalid`. A network-interrupted create may have succeeded, so reconcile through the same importer rather than deleting/recreating contacts.

The source directory must contain arrays in `bento-contacts.json`, `cap-users.json`, `cap-memberships.json`, `license-licenses.json`, `cap-invites.json`, `cap-sso.json`, and `cap-videos.json`. Their shapes are defined in `profile.ts`, `prepare.ts`, and `sources.ts`. Preserve original source CSVs. Fresh source snapshots are required; preparation refuses files older than 24 hours.

The native Loops CSV importer can be used for the reviewed positive file. Check every column mapping, select the migration mailing list, and leave **Trigger workflows** off. Loops matches user ID before email; resolve destination identity conflicts first. Export the destination afterward and reconcile all intended addresses, opt-outs, audience fields, and enrollment holds. Native CSV imports and API receipts are separate records.

The legacy native provisioner uses revision checks and a private receipt, but now refuses `--apply` because managed emails use custom MJML. Generate uploads with `emails:export` and review them in the browser. `verify.ts --structure-only` checks graphs, downstream filters, reconnections, timing, segments, mailing lists, draft status and custom format. The beta API cannot read MJML content or verify its Guardian results. Never treat a structure check as content parity.

## Repository rollout

Normal completed signups create or reuse a Stripe customer. The native Loops Stripe integration is connected and enabled for `customer.created` and `customer.updated`. Both import names and assign the Product updates and tips list; additional custom events are blank. All other Stripe event types are disabled and production email workflows remain drafts. Cap then supplies the audience, greeting, paid/license entitlement and recording milestones. A contact cannot enter onboarding until Cap has completed its billing bootstrap and supplied the audience. SSO skips Stripe, so the worker creates those contacts directly, held and marked as teammates before enrollment.

`users.marketingOrigin` permanently identifies teammates. Invitation provisioning excludes sales immediately in local state; accepting an invite queues helpful onboarding. SSO provisioning does the same when a membership or onboarding is new. An existing imported account accepting a new invite after cutover can receive teammate help; importing historical records alone never starts a sequence. Every workflow has re-entry disabled and checks its audience downstream. Teammates cannot move back into a sales audience after leaving an organisation or buying a plan.

There is no `marketing_contacts` table. The small `loops_sync_jobs` table stores a user ID, pending revision, retry/lease state, a profile hash, the last synced email and a teammate-join timestamp. It is operational delivery state, not a second subscription database. Queue writes are transactional with signup/invite/SSO changes. Billing webhooks queue updates after persisting billing state; Stripe retries an unsuccessful webhook. Interrupted workers release through expiring leases; completing an older job cannot discard a newer request.

`/api/cron/sync-loops` runs every minute with `CRON_SECRET` authentication. A run has a bounded processing window and stops on rate limiting. Failures stay pending with exponential backoff up to an hour; failed runs return HTTP 500 and log a user ID and a nonsecret reason. Fresh source queries run hourly for recent signups and daily for older accounts, providing reconciliation for milestones and external license changes. Unchanged profile hashes avoid redundant Loops requests. Signup, invite, SSO and billing hooks make relevant changes due immediately. This is eventual synchronization; configure backlog/failure alerts and prove latency before activation. Loops does not automatically expire `capVerifiedAt`. The independent delivery check below closes the four downstream journey guards when the queue becomes unhealthy; it is an additional safeguard, not a real-time expiry guarantee.

Loops owns subscription preferences. Normal updates never send `subscribed: true` or change list membership. API list removal can disappear from the returned `mailingLists` map; absence is treated as a hold, never an invitation to re-add the list. Configure list assignment for native imports and retain unsubscribe records in Loops. An SSO contact joins the list only in its initial create request. Keep the private Bento suppression archive and reconcile all negative records into Loops before enabling email workflows. Native contact imports are already enabled; imported contacts cannot enter the managed draft journeys without Cap eligibility fields. Contacts that were removed after a successful sync are not recreated. Changed/deleted Cap identities have their previously synced Loops contact held and are surfaced for reconciliation.

Deploy the generated schema before code that selects the new columns. The unshipped migration containing `marketing_contacts` was replaced using Drizzle's migration tooling; no production table was dropped. The implementation is currently behind disabled environment gates:

| Variable                        | Purpose                                                                  |
| ------------------------------- | ------------------------------------------------------------------------ |
| `LOOPS_SYNC_ENABLED=true`       | Enables queue writes and processing; otherwise both are off              |
| `LOOPS_SYNC_MODE=test`          | Default mode; restricts processing to the explicit owned-email allowlist |
| `LOOPS_TEST_EMAILS`             | Comma-separated owned test addresses                                     |
| `LOOPS_API_KEY`                 | Loops API key for Cap Software, Inc.                                     |
| `LOOPS_MAILING_LIST_ID`         | Product updates and tips list                                            |
| `LOOPS_LICENSE_DATABASE_URL`    | Read-only license database connection                                    |
| `LOOPS_ENROLLMENT_AFTER`        | Explicit ISO cutover timestamp; historical signups stay held             |
| `LOOPS_ENROLLMENT_ENABLED=true` | Allows eligible lifecycle stages; leave false until approved cutover     |
| `CRON_SECRET`                   | Authenticates the scheduled endpoint                                     |
| `LOOPS_HEALTH_SECRET`           | Separate read-only credential for the independent delivery check         |

With the schema available and test configuration set, `bun scripts/loops/seed.ts` reports how many completed signups would be queued. `--apply` queues them without sending anything. `bun scripts/loops/sync.ts --apply` processes a bounded batch using the same worker as the cron route. Test mode fails closed without an allowlist. Set `LOOPS_SYNC_MODE=production` only as part of the reviewed cutover. Seed old completed accounts once after the final suppression reconciliation; subsequent signups enter the queue through the application.

## Independent delivery check

`.github/workflows/loops-safety.yml` runs every five minutes, independently of the Cap cron worker. It is disabled until the repository variable `LOOPS_WATCHDOG_ENABLED` is explicitly set to `true`. Configure GitHub secrets `LOOPS_API_KEY` and `LOOPS_HEALTH_SECRET`, and configure the same health secret in Cap. Scheduled Actions run from the default branch, so this protection is not deployed while the PR remains unmerged.

The authenticated, read-only `/api/cron/sync-loops/health` endpoint reports queue counts without contact data. It reports unhealthy when production sync or enrollment is disabled, the queue is empty, a due job is over five minutes late, or a job has failed three times. Expected holds for incomplete signup and removed/changed identities do not count as delivery failures. An unchanged successful refresh clears old failures; a newly queued change does not inherit an older attempt's retry delay.

The checker rejects unavailable, malformed or stale health responses. On failure or audience drift it adds mutually exclusive subscription conditions to each journey's first audience guard, with scope set to all following nodes, then reads the guards back. One failed update does not stop attempts on the other journeys. An update failure or existing hold fails the Action so it remains visible. Assign an owner to GitHub Actions failure notifications and verify that notification before activation.

The hold persists after recovery. It does not change workflow status, contact subscriptions or campaign schedules. The current four production drafts have this hold applied and independently verified. To inspect them without writes:

```sh
bun run emails:check-loops --structure-only --require-held
```

For an emergency hold, with the Loops API key in the environment:

```sh
bun scripts/loops/watchdog.ts --hold --apply
```

Only after synchronization is healthy and cutover or recovery has been approved, remove the exact known hold with:

```sh
bun scripts/loops/watchdog.ts --resume --apply
```

Resume requires a fresh authenticated health response and refuses changed audience rules. It does not start a draft or unpause a workflow. Contacts that have already exited because of a hold are not automatically replayed; assess recovery separately without bulk re-enrolling history.

GitHub scheduling can be delayed, and a Loops API outage can prevent guard updates. A message already being sent may still arrive. Test a running owned-account journey across an outage in the deployed environment before relying on this protection. Manually pause Loops if the check cannot apply a hold. Campaigns require a fresh health check before scheduling and manual cancellation or pause during an outage; the checker only guards the four registered journeys.

## Before any activation

### Optional sender profile picture

On September 11, 2026, `mail.cap.so` was added in Google Workspace as a **user alias domain for cap.so**. Google verified it automatically without a DNS change or a new paid seat. Richie's existing `richie@cap.so` photo was already visible to anyone. Gmail was not activated for the alias domain; incoming mail still uses Cloudflare Email Routing, and Loops' SES envelope MX/SPF and the inherited DMARC policy were independently checked unchanged after setup.

The existing photo was visibly confirmed beside `Richie from Cap <richie@mail.cap.so>` on the received `[PREVIEW] Take another look at Cap` email in Richie's Gmail inbox after setup. No additional email was sent for this check. Avatar display remains client-specific, and other recipients may see a cached picture until their client updates. See [Loops' sending-avatar guide](https://loops.so/docs/deliverability/adding-a-sending-avatar). This setup did not activate any Loops flow or change the production cutover gates below.

### Production cutover

Activation is deliberately outside this migration's approved scope. These gates remain necessary:

1. Review the final custom drafts and audiences, and configure rotated credentials in the intended environment. September 11 controlled deliveries passed SPF, DKIM and DMARC with inherited `p=quarantine`; the earlier DMARC warning is no longer an observed blocker. Recheck sending-domain status at cutover.
2. The native Stripe connection passed an owned live-customer creation/update test, including name sync, list assignment and global unsubscribe preservation. Independently test a recipient Preference Center list opt-out across a Stripe update; the separate Cap-worker API list-removal check is not proof of that native behavior. Import/reconcile the remaining Bento negative records with workflows off. Then deploy the reviewed schema/code in test mode and prove the actual signup, purchase and invite routes with owned accounts.
3. Set the explicit cutover timestamp, verify the cron schedule and permissions in the deployed environment, and seed the completed-account sync jobs. Keep enrollment disabled while inspecting the resulting contacts. Preserve existing opt-outs and suppressions; no separate consent-capture step is needed.
4. Configure and enable the independent delivery check above, verify its deployed health endpoint and failure notifications, and prove purchase/invite/opt-out transitions remove contacts before later promotional steps. Exercise its hold and explicit recovery with an owned-account journey. Downstream filters use the last synced fields; `capVerifiedAt` is not a native expiry guarantee. Pause workflows manually if the checker cannot reach Loops, and handle scheduled campaigns separately.
5. Reconcile a fresh Bento delta at cutover, including all opt-outs and changed entitlements. Confirm no campaign/flow is queued to send twice, check overlap with Resend recording emails, then disable old Bento marketing automations only as part of the approved cutover. Preserve source history and suppression evidence.
6. Test the deployed Cap signup/purchase/invite/opt-out path through Loops to an owned inbox, including a sync outage and retries. The completed synthetic profile-to-Loops tests do not replace this production integration check.
7. After explicit activation approval, enable one small cohort of new Cap signups without an existing opt-out or suppression, monitor deliveries, complaints, opt-outs and duplicate suppression, then expand. Do not bulk enroll imported history. Rollback stops new enrollment and pauses Loops before considering re-enabling Bento; never run both senders for the same journey. Retire Bento and rotate remaining credentials after reconciliation.

## Validation

```sh
bun test scripts/emails scripts/loops/profile.test.ts scripts/loops/lifecycle.test.ts scripts/loops/watchdog.test.ts
bun run biome check scripts/loops packages/database/schema.ts packages/database/auth/drizzle-adapter.ts packages/database/auth/sso.ts apps/web/app/api/invite/accept/route.ts
bun run tsc -b packages/database
bun run --cwd apps/web next typegen
bun run tsc -b apps/web
```

Unit tests cover consent conflicts, conservative customer classification, teammate suppression, imported enrollment holds, identity preservation, and stable sync fingerprints. They do not prove production email delivery or a live cutover.

See [QA results and remaining limitations](../../emails/QA.md) for the controlled live Loops tests and the separate production integration gate.
