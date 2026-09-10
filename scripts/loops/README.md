# Cap lifecycle email migration

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

Every journey requires a global subscription, positive consent, the correct audience, and both enrollment flags. Its audience filter applies downstream. Free/former promotional journeys also require `capTeammate=false` and `capPromotionalEligible=true`. Recording/sharing branches skip the corresponding reminder when the known cloud milestone is complete; local-only recordings cannot be observed by this sync.

All imported contacts remain held, including recent signups. Historical contacts must never be enrolled by replaying a contact-created event or bulk changing their lifecycle stage.

## Consent and private data

`prepare.ts` excludes source opt-outs, suppression flags, bounces, complaints, and conflicting negative subscription fields from the positive import. It also produces a normalized-email SHA-256 registry for every source row. Retain that registry even when excluded addresses are not created in Loops. Hashes are sensitive matching identifiers, not anonymous data.

Reconcile opt-outs already present in the destination by setting those existing records to unsubscribed. Do not import excluded addresses as new subscribed contacts. Loops-native global and mailing-list opt-outs must survive migration and later syncs. The normal sync never writes `subscribed=true` to an existing contact and never replaces mailing-list preferences. Missing imported contacts are not recreated.

Keep exports, prepared contacts, CSVs, registry files, receipts, database connection strings, and API keys outside Git, in a private directory. Do not expose license keys; the classifier only needs email, entitlement kind, active status, and renewal date.

## Commands

Run from the repository root with Bun 1.4. Supply `LOOPS_API_KEY` through the process environment. Every API command checks the exact expected team name. Cap's migration account is **Cap Software, Inc.**; a separate Loops account named **Cap** must not be used.

```sh
bun scripts/loops/provision.ts --team 'Cap Software, Inc.' --dry-run
bun scripts/loops/provision.ts --team 'Cap Software, Inc.' --state "$LOOPS_PRIVATE_DIR/provision-state.json" --mailing-list "$LOOPS_MAILING_LIST_ID" --apply
bun scripts/loops/verify.ts --team 'Cap Software, Inc.' --state "$LOOPS_PRIVATE_DIR/provision-state.json" --mailing-list "$LOOPS_MAILING_LIST_ID"
bun scripts/loops/prepare.ts --sources "$LOOPS_PRIVATE_DIR" --output "$LOOPS_PRIVATE_DIR/import"
bun scripts/loops/import.ts --team 'Cap Software, Inc.' --contacts "$LOOPS_PRIVATE_DIR/import/contacts.json" --receipt "$LOOPS_PRIVATE_DIR/import/receipt.jsonl" --mailing-list "$LOOPS_MAILING_LIST_ID"
```

Review the dry-run counts, then add `--apply` to import. Use the same receipt to resume after interruption; existing identities are checked and enriched without resubscribing. Invalid rows are recorded privately. Correct their input before using `--retry-invalid`. A network-interrupted create may have succeeded, so reconcile through the same importer rather than deleting/recreating contacts.

The source directory must contain arrays in `bento-contacts.json`, `cap-users.json`, `cap-memberships.json`, `license-licenses.json`, `cap-invites.json`, `cap-sso.json`, and `cap-videos.json`. Their shapes are defined in `profile.ts`, `prepare.ts`, and `sources.ts`. Preserve original source CSVs. Fresh source snapshots are required; preparation refuses files older than 24 hours.

The native Loops CSV importer can be used for the reviewed positive file. Check every column mapping, select the migration mailing list, and leave **Trigger workflows** off. Loops matches user ID before email; resolve destination identity conflicts first. Export the destination afterward and reconcile all intended addresses, opt-outs, audience fields, and enrollment holds. Native CSV imports and API receipts are separate records.

Provisioning uses revision checks and a private receipt to resume partially created resources. Run `verify.ts` after every provisioning pass: it independently reads the actual graph, downstream filters, branch reconnections, timing, message text/links, fallback, campaign segments, mailing lists, draft states, and Guardian results. Investigate verification failures before editing a managed draft manually or reusing its receipt.

## Repository rollout

The generated migration adds `users.marketingOrigin` and `marketing_contacts`. Apply the schema through the normal reviewed PlanetScale deployment process **before deploying code that selects the new column**. No production database migration is performed by preparation or provisioning.

New signup, invite acceptance, and SSO provisioning record origin without subscribing anyone. Existing invitation/membership/SSO evidence supplements this field for the historical import. The registry has no user foreign key so an opt-out can survive account deletion.

After the schema is deployed, dry-run the registry seed:

```sh
bun scripts/loops/seed.ts --registry "$LOOPS_PRIVATE_DIR/import/consent-registry.json" --contacts "$LOOPS_PRIVATE_DIR/import/contacts.json"
```

Applying requires `DATABASE_URL`, `LOOPS_SYNC_ENABLED=true`, and `--apply`. Registry merges retain existing opt-outs and teammate history. Initial denied records store their hash without a raw email; an already stored email is retained when a later opt-out must be propagated.

The held-contact sync additionally requires read-only `LOOPS_LICENSE_DATABASE_URL`:

```sh
bun scripts/loops/sync.ts --team 'Cap Software, Inc.' --mailing-list "$LOOPS_MAILING_LIST_ID" --limit 100
```

Review the dry run before adding `--apply`. Use a single runner and bounded batches. The sync refreshes entitlement/origin/milestone fields, preserves consent, compares profile fingerprints, rechecks remote consent at least daily when drained, and refuses a source snapshot older than ten minutes. Repeated runs drain pending changes. It remains a held-contact sync, not an enrollment service.

## Before any activation

Activation is deliberately outside this migration's approved scope. These gates remain necessary:

1. Review actual draft copy and audiences, resolve the sending-domain DMARC warning, and configure rotated credentials in the intended environment.
2. Deploy the reviewed schema/code, seed the complete suppression registry, and prove the held sync with real free, paid, licensed, invited, SSO, unsubscribed, deleted, and changed-email cases.
3. Implement and verify explicit new-consent capture, lifecycle enrollment for new eligible contacts, bounded retries, duplicate prevention, and an observed sync schedule. This branch does not infer marketing consent from account creation.
4. Add a freshness mechanism and monitoring before live sends. Downstream filters use the last synced fields; `capVerifiedAt` is evidence, not a native expiry guarantee. Prove purchase/invite/opt-out transitions remove contacts before later promotional steps. Do not enable the current held sync alongside active enrollment because it deliberately returns contacts to idle.
5. Reconcile a fresh Bento delta at cutover. Confirm no campaign/flow is queued to send twice, then disable old Bento marketing automations only as part of the approved cutover. Preserve source history and opt-outs before retiring Bento.

## Validation

```sh
bun test scripts/loops/profile.test.ts
bun run biome check scripts/loops packages/database/schema.ts packages/database/auth/drizzle-adapter.ts packages/database/auth/sso.ts apps/web/app/api/invite/accept/route.ts
bun run tsc -b packages/database
bun run --cwd apps/web next typegen
bun run tsc -b apps/web
```

Unit tests cover consent conflicts, conservative customer classification, teammate suppression, imported enrollment holds, identity preservation, and stable sync fingerprints. They do not prove production email delivery or a live cutover.
