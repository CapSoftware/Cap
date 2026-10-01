# Directory Sync provisioning

Directory Sync adds identity-provider provisioning alongside the existing WorkOS SAML integration. It uses the same WorkOS organization mapping and keeps NextAuth. WorkOS handles SCIM endpoints and provider configuration; Cap consumes the ordered Events API and reconciles directory snapshots.

## Rollout

1. Deploy generated migration `0050_optimal_cerise` before deploying the application. Authorization queries use the new tables even while synchronization is disabled. Verify both tables and their indexes exist.
2. Keep `WORKOS_DIRECTORY_SYNC_ENABLED=false` until staging acceptance passes. Configure WorkOS staging credentials and the existing `CRON_SECRET`; never use production directories for tests.
3. Set `WORKOS_DIRECTORY_SYNC_ENABLED=true` and put approved Cap organization IDs in `WORKOS_DIRECTORY_SYNC_ORGANIZATION_IDS` (comma-separated). This allowlist controls setup access, independently of SAML and Pro billing. Configure commercial access manually for the initial rollout.
4. An organization owner or admin opens **Organization settings → Security → User provisioning** and follows the WorkOS setup portal. The organization must already have its WorkOS mapping and a verified email domain.
5. Confirm the authenticated minute cron reaches `/api/cron/sync-directory`. Verify a real staging provider creates a member before first login, updates their identity metadata, deactivates them, and reactivates the same account. Check SAML login, an existing web session, and desktop/API access after removal.
6. Enable one approved production organization after review. Check synchronization health and identity conflicts before expanding the allowlist.

## Membership and billing

Provisioned users become ordinary members. Existing roles, profiles, personal organizations, subscriptions, and assigned seats are preserved. New accounts receive no personal organization, Stripe customer, or automatic Pro seat. Administrators assign roles and Pro seats in Cap. Group-to-role mapping is not included. Membership changes refresh lifecycle profiles for existing signed-up users; pre-login provisioning does not enroll a new account in messaging.

Inactive or deleted directory users lose organization and space membership. Their recordings and memberships in other organizations remain. Explicit shares through another organization or its spaces remain viewable under that organization's access rules; this does not restore ownership-based editing. Organization-scoped authorization also blocks ownership shortcuts and existing sessions; the account itself remains usable elsewhere. Public links retain anonymous access under existing sharing rules. Previously issued media URLs remain valid until their existing expiry.

Stable directory and provider identity IDs bind a directory user to the Cap account. An initial email must belong to a verified WorkOS organization domain. Subsequent email changes, missing emails, or conflicting identity bindings require review rather than silently moving access to another account. Synced names are kept on the directory record; existing global profiles are not overwritten.

Deleting a directory denies access immediately when observed and retires its users in resumable batches. An inactive directory denies managed access while retaining memberships for recovery. A replacement directory requires support reconciliation; reconnecting does not silently transfer old identity bindings.

## Reliability and recovery

The worker uses expiring database leases, fencing tokens, per-user version checks, and atomic event checkpoints. It saves progress through paginated snapshots and reconciles at least hourly when processing capacity permits. Missing snapshot users are checked individually before removal. Old event cursors are reset into the retained event window and followed by reconciliation.

Synchronization errors remain visible in Security settings and retry automatically. Removing an organization from the setup allowlist does not stop an existing directory's lifecycle updates. The global flag stops the worker, including new deprovisioning; it does not erase existing access restrictions. Use it only as a temporary incident control with a manual offboarding process. Do not delete directory records to bypass restrictions.

For rollback, retain the additive schema and directory records. Rolling application code back past the new authorization checks would restore ownership shortcuts for removed users; do not treat a code rollback as a safe offboarding rollback.

## Verification

The database integration suite is explicitly opt-in through `CAP_DIRECTORY_SYNC_DATABASE_TESTS=true` and requires an owned building-session database. It covers provisioning, existing accounts and billing, duplicate and stale delivery, stable-identity reactivation, tenant mismatches, identity conflicts, preserved recordings, cross-organization access, directory deletion, reconciliation, and lease fencing. The normal SSO and authorization unit suites cover unchanged behavior and prevention of SAML membership recreation.

Live WorkOS/IdP verification and hosted cron verification remain deployment gates. Synthetic tests do not establish provider delivery timing or production behavior.
