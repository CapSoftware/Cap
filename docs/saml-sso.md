# SAML SSO

Cap uses WorkOS Single Sign-On with its existing NextAuth sessions. Each Cap organization has its own paid SSO entitlement and an explicit WorkOS organization mapping. SSO billing is independent of Cap Pro seats and the Signed BAA add-on.

## Customer flow

1. An organization owner opens **Settings → Organization → Security & Compliance** and purchases the monthly SAML SSO add-on. Checkout displays the configured USD, GBP, or EUR amount from Stripe.
2. Once payment is confirmed, owners and admins can use **Verify domain**. Cap creates or reuses that organization's WorkOS organization and opens the hosted domain-verification flow. Organizations whose domains are already verified skip this step.
3. After domain verification, **Set up SAML SSO** opens WorkOS's SSO setup flow for the IT administrator to configure the identity provider. **Verify domains** remains available if additional domains need verification. Payment alone never verifies a domain.
4. Team members choose SAML SSO on the sign-in page, enter their work email/domain, or follow the organization's sign-in link. An IdP-initiated visit to `/login?connection_id=...` starts the same protected authorization flow.
5. Successful sign-in links the verified identity and adds the user to that specific Cap organization. New members receive the `member` role without a Pro seat. Existing roles, seats, and default organizations are preserved; the SSO organization becomes active.

An existing Cap account can enter SSO explicitly using `/login?sso=1`. Organization and IdP sign-in links also work while already signed in, but an SSO identity cannot be attached to a different currently signed-in account. That user must sign out first.

## Configuration

Set these server-only variables in the deployment environment:

| Variable                                     | Requirement                                                                          |
| -------------------------------------------- | ------------------------------------------------------------------------------------ |
| `WORKOS_API_KEY`                             | A working key for the intended WorkOS environment.                                   |
| `WORKOS_CLIENT_ID`                           | The client ID from that same environment.                                            |
| `WEB_URL`, `NEXTAUTH_URL`                    | The canonical HTTPS deployment origin.                                               |
| `NEXTAUTH_SECRET`                            | The existing strong session secret; also signs short-lived SSO intents.              |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Matching Stripe environment and webhook endpoint credentials.                        |
| `STRIPE_SAML_SSO_PRICE_ID`                   | Optional production override; required for a separate test/development Stripe price. |

The default production price is `price_1UBJpTFJxA1XpeSsQmAOhibr`. Its supported currency amounts are read from Stripe, not converted in the browser. The legacy SAML price remains recognized without upgrading or repricing existing subscriptions. Use a monthly, quantity-one test price and a test Stripe key outside production; production price IDs do not exist in Stripe test mode.

Configure WorkOS redirect settings for the same environment:

| Purpose                               | Production URL                                            |
| ------------------------------------- | --------------------------------------------------------- |
| OAuth callback / redirect URI         | `https://cap.so/api/auth/callback/workos`                 |
| SSO sign-in / initiate-login endpoint | `https://cap.so/login`                                    |
| Admin Portal return/success base      | `https://cap.so/dashboard/settings/organization/security` |

Cap supplies organization-scoped Admin Portal return and success URLs. API-generated links are short-lived bearer capabilities and should be opened immediately, never stored or logged. Use an HTTPS preview origin for a full Admin Portal test.

Configure the Vercel Firewall SDK rule `rl_auth_sso_start`, for example 20 attempts per minute per IP. The shared rate-limit helper is best-effort and fails open when the rule is missing or the firewall is unavailable; merely deploying the rule ID does not enable rate limiting. Self-hosted deployments should provide equivalent perimeter protection.

## Billing and recovery

`organization_sso` stores the organization, purchaser, Stripe customer/subscription, payment-confirmed access period, and a durable checkout reservation. Only owners can purchase or manage billing. Owners and admins can configure WorkOS; members cannot obtain Admin Portal links.

Entitlement requires a supported SAML subscription and a paid invoice line belonging to that subscription and item. Active access ends at the confirmed paid-through date. Previously paid `past_due` subscriptions receive a seven-day grace period; unpaid, incomplete, trialing, canceled, and expired subscriptions do not grant access. A scheduled end-of-period cancellation keeps access through the paid period.

Stripe webhooks and settings/sign-in refreshes reconcile current Stripe state rather than trusting event order. SSO subscriptions are routed separately before Pro/BAA handling, including subscriptions already bound in the database whose Stripe metadata later changes. Renewal uses matching paid invoice periods. Retry failures return non-success responses so Stripe can redeliver them.

Checkout retries reuse the persisted attempt and Stripe idempotency key. A currency change expires the exact prior open session before creating another attempt. An uncertain response never silently starts another payment. A reservation older than 23 hours without a known Stripe session requires support reconciliation because Stripe can prune idempotency keys. Do not clear such a reservation until the earlier payment/session has been found or proven absent.

For a previously paid, unlinked customer:

1. Independently identify the exact Cap owner and organization. A matching email domain alone is not enough, and must not bulk-join existing domain users.
2. Verify the Stripe subscription/customer, supported SAML price, quantity, paid invoice, and paid-through period. Preserve the agreed price. A historical payment-link customer may differ from the owner's Pro customer.
3. Verify the exact WorkOS organization and its domain proof. Do not adopt a similarly named organization or mark a pending domain verified from an untrusted request.
4. After the schema and safe webhook code are deployed, create the explicit `organization_sso` binding and set `organizations.workosOrganizationId`, then reconcile the subscription. Use compare-and-set predicates and verify the resulting rows.
5. If the old webhook overwrote the owner's Pro reference, independently verify the original Pro subscription, customer, and seat quantity before restoring those fields. Never place the SAML subscription in the user's Pro subscription fields.

New WorkOS organizations use the Cap organization ID as `externalId`. An explicitly verified legacy mapping can retain its existing WorkOS external ID. Billing ownership/customer changes require support reconciliation; the application refuses to silently transfer an earlier payment to a different payer. Do not add SSO metadata to a legacy subscription while the old Pro-only webhook is still deployed.

## Security boundaries

The authorization start signs the Cap organization, WorkOS organization, connection, current user, and safe return path into a ten-minute HttpOnly cookie. NextAuth also validates OAuth state and PKCE. The callback checks the raw WorkOS profile IDs, live connection state, verified email domain, existing account binding, and paid organization before issuing a session.

WorkOS authorization receives only the verified `connection` selector. Its `connection`, `organization`, and `provider` selectors are mutually exclusive; organization ownership remains bound and validated in Cap's signed intent rather than adding a second selector to the provider request.

Membership provisioning is transactional and repeatable, using organization/user row locks and a deterministic WorkOS account key. Only invitations for the SSO organization are accepted. SSO-created users do not receive an unrelated personal organization or Stripe customer during signup. Membership is committed before the session token is issued.

An ambiguous default connection blocks domain-based discovery but leaves settings accessible for repair; an explicit active IdP connection is still checked against the mapped organization. Settings and sign-in query WorkOS directly, so disabling/resetting a connection is recognized without a connection webhook cache.

This feature does **not** enforce SSO-only login, implement SCIM/deprovisioning, revoke existing Cap sessions when a user leaves the IdP, or provide SAML single logout. Standard Cap sign-in remains available. Do not present these as delivered enterprise controls.

## Rollout and verification

Before applying `0041_saml_sso`, pause changes to WorkOS organization bindings and run this read-only preflight on the exact target database's primary connection:

```sql
SELECT COUNT(*) AS duplicate_mapping_groups
FROM (
	SELECT workosOrganizationId
	FROM organizations
	WHERE workosOrganizationId IS NOT NULL
	GROUP BY workosOrganizationId
	HAVING COUNT(*) > 1
) AS duplicate_mappings;
```

The result **must be zero immediately before any schema deployment**. This checks all organizations, including tombstoned rows and empty-string bindings, because the unique constraint applies to them too. If the query fails or returns a nonzero count, stop before applying any migration DDL. Independently verify the conflicting Cap and WorkOS identities and reconcile their bindings with compare-and-set updates; never automatically delete, merge, or reassign organizations. Repeat the query after reconciliation, and keep binding writes paused until the unique constraint is installed.

After that gate passes, deploy the additive migration before the application changes. Reconcile existing mapped organizations rather than silently granting them unpaid access. A successful preflight in one environment or at an earlier time does not authorize another deployment. Do not push schema directly to a shared local or production database as part of a test.

The migration is generated from `packages/database/schema.ts` with `pnpm db:generate --name=saml_sso`. Commit its generated SQL and snapshot/journal metadata together; do not hand-edit the SQL. Migration `0041` follows the existing recording-jobs migration and retains its snapshot ancestry.

Focused tests live under `apps/web/__tests__/unit/sso-*.test.ts`, alongside the existing auth, mobile, Pro, BAA, and webhook regression suites. `apps/web/__tests__/integration/sso-database.test.ts` uses actual MySQL and requires `CAP_SSO_TEST_DATABASE_URL` to point to a local, session-scoped database named `cap_sso_*` with the generated schema. It refuses production/non-local URLs and retains its synthetic fixtures for inspection.

Before enabling a customer, verify a real WorkOS flow on the candidate deployment: owner purchase/confirmation, admin setup and domain verification, SP-initiated and IdP-initiated sign-in, a new member, an existing account, repeat/concurrent sign-ins, wrong-domain/organization rejection, and native app return. Check cancellation, failed renewal, webhook retries, and Pro/BAA isolation in Stripe test mode. Unit tests, mocks, and local database tests do not prove a live IdP roundtrip.

## WorkOS references

- [SSO quick start](https://workos.com/docs/sso)
- [Authorization URL API and connection selectors](https://workos.com/docs/reference/sso/get-authorization-url)
- [Login flows](https://workos.com/docs/sso/login-flows) and [redirect URIs](https://workos.com/docs/sso/redirect-uris)
- [Organization domains and profile validation](https://workos.com/docs/sso/domains)
- [Admin Portal](https://workos.com/docs/admin-portal) and [domain verification](https://workos.com/docs/domain-verification)
- [JIT provisioning](https://workos.com/docs/sso/jit-provisioning)
- [SSO testing](https://workos.com/docs/sso/test-sso) and [launch checklist](https://workos.com/docs/sso/launch-checklist)
- [SAML security](https://workos.com/docs/sso/saml-security) and [single logout](https://workos.com/docs/sso/single-logout)
