# First-party analytics contract and rollout

## Decision contract

Cap analytics is at-least-once at the delivery boundary and exactly once for decision metrics. Every event carries a stable `event_id` and a SHA-256-derived payload fingerprint. Retry deliveries retain both values. The raw Tinybird datasource is append-only; health metrics preserve every accepted delivery. Canonical and decision snapshots group by `event_id`, count one event only when every accepted copy has the same fingerprint, and quarantine an ID when different fingerprints arrive.

The central registry is `packages/analytics/src/event-registry.ts`. It defines the version, authority, delivery class, permitted platforms, semantic, and property schema for every event. Contract CI rejects unknown literal names, templates, invalid property keys, missing emitters, and drift between the Rust desktop catalogue and the TypeScript registry. Invalid properties reject the whole event rather than being silently removed.

Critical server facts start a durable Vercel Workflow before the request succeeds. Each delivery step retries transient network, `429`, and `5xx` failures with the original ID. Permanent contract failures become visible failed workflow runs. Signup, share, and collaboration facts are also reconciled from authoritative database rows every day with deterministic event IDs, closing the database-commit to workflow-start gap. Stripe remains authoritative for purchases, trials, renewals, plan and seat changes, cancellation, churn, refunds, and payment failures; Stripe webhook retries close its enqueue gap.

Desktop critical events enter a bounded encrypted local outbox before network delivery. The encryption key is stored in the operating-system keyring, events survive restart and offline periods, retryable failures back off, permanent failures enter a bounded dead-letter queue, and counters expose accepted, retried, dropped, overflowed, and dead-lettered events. Mobile critical events enter a bounded atomic AsyncStorage outbox before capture returns; interrupted rotations recover the last valid backup, account-scoped queues are isolated, offline and restart delivery resumes with the original event ID, and terminal failures enter a bounded dead-letter ledger. Browser events are intentionally best effort: attempted, accepted, retried, dropped, overflowed, and oversize counts accompany later batches without recursively creating analytics events.

## Identity, sessions, attribution, and time

- Visitor: a first-party pseudonymous browser ID stored in a persistent cookie/local storage. It is not a claim that the actor is a person.
- Session: a browser visit shared across tabs and renewed after 30 minutes of inactivity. Reloads and SPA navigation retain the session; activity at 29 minutes extends it; a return after more than 30 minutes starts a new session. Hidden time is not engagement time.
- Actor: `user_id` when authenticated, otherwise the anonymous visitor ID, otherwise the session ID. A canonical `identity_linked` event maps pre-auth acquisition to signup, while a settled guest purchase may establish the same mapping from its preserved anonymous checkout identity. The privacy-safe funnel materialization returns cohort counts only and never exposes that mapping.
- User: an authenticated Cap account. Cross-device creator metrics use `user_id`.
- Organization: the authoritative organization attached to a server fact. Organization metrics never infer membership from an anonymous browser event.

Metric dates and cohort boundaries use UTC. First touch is the first campaign stored for the visitor. Session touch is captured only when a new 30-minute session begins. Last touch is the most recent campaign-bearing navigation. A new campaign during an existing session updates last touch but does not relabel session touch. Advertising click IDs are retained only as bounded attribution strings.

The activation metric is the first authoritative `share_link_created` event within seven UTC days of `user_signed_up`. It represents a creator who produced a shareable Cap, not a click, checkout, onboarding screen, or client-only intent. Onboarding milestones are diagnostic best-effort events and do not replace activation.

## Traffic and privacy model

Cap chose a persistent first-party pseudonymous visitor identifier, not Plausible's cookieless daily hash model. This supports returning-visitor, multi-tab session, anonymous-to-signup, and attribution analysis, but it requires transparent disclosure and the existing telemetry preference. The identifier contains no email, name, IP address, or device fingerprint.

The collector rejects unregistered events, unknown properties, raw error fields, invalid identifiers, excessive cardinality, and oversized requests. Raw customer content, filenames, transcripts, email addresses, raw errors, raw IP addresses, and raw user-agent strings are not analytics properties. IP and user-agent data are used only in the request process to derive internal/bot classification and coarse country, region, city, browser, device, and operating-system dimensions; raw values are not stored.

Known bots, crawlers, previews, internal IP hashes, and synthetic runs are visible to health monitoring but excluded from decision snapshots. Anonymous write tokens are rate-limited by both source IP and anonymous ID. Replay and automation can be made expensive and observable, but public traffic analytics cannot cryptographically guarantee a human browser. Signup, organization, billing, and other business outcomes therefore remain server-authoritative.

Vercel request-IP buckets use only the platform-owned forwarding header and retain only its SHA-256 hash in process memory. A self-hosted deployment does not trust forwarding headers by default, so product-event collection and legacy public view tracking return `503` until `CAP_ANALYTICS_TRUST_PROXY=1` is configured. That setting uses the first `x-forwarded-for` address and is safe only behind a reverse proxy that overwrites, rather than appends or passes through, that header. Do not set it on Vercel. Client-controlled anonymous IDs and authorization strings never become network rate-limit keys.

The desktop critical-event outbox uses AES-256-GCM. Its stable random key is stored in the OS keyring and in a separate app-local recovery-key file so queued events remain recoverable during temporary keyring outages; Unix recovery-key permissions are `0600`, while Windows relies on the per-user app-data ACL. This protects queue contents from accidental store disclosure but does not claim protection from a process or local account with access to both app-data files. An upgrade may read the earlier application-store fallback-key shape only to decrypt and re-encrypt pending queues, then removes that legacy value after both primary and recovery queues are safely consolidated.

Account and organization deletion writes its durable pending marker or tombstone before erasure begins. Delivery and reconciliation reject marked identities, then deletion waits longer than the bounded in-flight delivery attempt before removing matching raw rows with a dedicated erasure token and rebuilding every replace-mode canonical, traffic, activation, retention, and health snapshot. This closes the race where a workflow that passed its identity check could otherwise append after a completed erasure. Deletion fails closed if the erasure credential or any rebuild is unavailable. The staging suite deletes a synthetic user and organization, proves their raw-health and decision state is gone, and proves an out-of-scope row sharing the anonymous ID remains until final test cleanup. Tinybird's row-deletion API currently requires the general `DATASOURCES:CREATE` scope and rejects resource-scoped creation of that operator; the token therefore has no read or deployment scope, lives only in the protected staging environment, and is used by code that accepts bounded validated deletion predicates. Its broader same-workspace mutation capability is an explicit provider limitation rather than a least-privilege claim.

Raw, canonical, and decision data share an 800-day TTL. This supports two complete 365-day comparison windows plus a rebuild buffer for year-over-year decisions. The identity-bearing source is intentionally retained for the same horizon as its exact aggregates so a later account or organization deletion can still retract every historical contribution. Keeping only irreversible long-lived counts would use less storage but would break the derived-erasure guarantee. Health-detail aggregates remain limited to 90 days. This retention choice requires privacy-owner approval before production rollout and must be disclosed with the persistent first-party identifier model.

## Data quality and performance gates

The staging workflow is restricted to PR 2003 and `codex/first-party-analytics`, hard-codes the staging Tinybird workspace ID, checks the exact Git SHA, waits for the exact-SHA Vercel preview, creates an isolated Tinybird staging deployment, runs fixture and synthetic tests, and promotes only a verified deployment inside that staging workspace. Candidate reads use the exact numeric deployment ID and prove raw delivery, isolation, endpoint execution, and absolute latency before promotion. Tinybird's Copy API does not reliably route an on-demand Copy mutation into a candidate, so Copy mutations are prohibited until the exact candidate is live in staging. The prior staging deployment remains available until promoted Copy results, public business values, retained-deployment and representative-volume performance, erasure, cleanup, and a live rollback-and-restoration drill pass. The first rollout of a new endpoint compares only shared endpoints to the retained deployment, records the new endpoint as having no historical baseline, and still applies candidate and representative absolute budgets. The rollback drill executes every shared typed endpoint while the prior deployment is live; the exact-SHA admin client treats only an absent identity-funnel endpoint as optional, then the drill restores the candidate and re-proves the full endpoint suite, health, and synthetic business responses. Ambiguous live-switch responses are reconciled against the exact deployment pair before recovery continues. Any earlier failure restores a data-plane-proven prior deployment and removes the rejected candidate. The workflow has no push trigger, production environment, production token, or production deployment command.

The redacted evidence artifact records the Git SHA, GitHub run, Vercel and Tinybird deployment IDs, hashed synthetic-run identity, delivery attempts, ingestion throughput, endpoint and full-dashboard p50/p95/p99, measured-baseline regressions, visibility time, health totals, decision-dedup assertions, conflict quarantine, least-privilege token checks, scoped identity erasure, and cleanup. Synthetic rows are excluded from normal metrics and cleanup is verified after every promoted run.

Required live gates are:

- duplicate deliveries remain visible in health while one non-conflicting event reaches the decision assertion;
- the same ID with different payloads is visible as a conflict and contributes zero decision events;
- unique load events remain complete and conflict-free;
- ingestion visibility is within the measured SLO;
- representative endpoint p95 is within the measured baseline budget;
- raw and all derived synthetic state is removed successfully;
- an erased identity disappears from raw and derived results while an out-of-scope control remains;
- aggregate read tokens cannot query raw identifiers or append, and append/cleanup tokens cannot read aggregate endpoints;
- a bounded five-event fixture produces exact non-zero traffic, page, activation, and retention values while remaining absent from normal decision endpoints;
- a populated-table performance pass measures every typed decision endpoint and full dashboard fanout after materialization;
- wrong workspace, stale SHA, missing credentials, partial execution, failed promotion, and failed cleanup all fail closed.

Copy-backed decision tables rebuild on serialized eight-minute schedules to avoid competing for the same Tinybird worker pool. Exact-SHA staging runs invoke the eight copies in dependency order after an exact candidate is promoted, after identity erasure, and after final cleanup. A no-op deployment invokes them immediately after seeding. Candidate ingestion visibility is measured directly against the exact candidate and promoted Copy visibility is measured separately, so neither proof waits for the periodic schedule. Dashboard freshness exposes product, traffic, retention, and identity-funnel aggregate timestamps; scheduled production freshness is therefore bounded by the documented copy cadence plus provider execution time.

The staging run records absolute ingestion budgets, compares shared typed endpoints and dashboard fanout against the retained prior deployment, and separately measures bounded 1,000-row and 10,000-row mixed high-cardinality corpora with nonzero traffic, activation, retention, identity, product, and revenue assertions. It measures exact-SHA browser main-thread cost and append-batch p50, p95, p99, error rate, and throughput. A newly introduced endpoint without an honest prior baseline is labeled as such and must pass measured and representative absolute budgets. It reports p50, p95, and p99 for baseline, measured, and representative samples, and applies retained-baseline regression budgets to representative samples wherever a baseline exists. A green static/unit run alone is not rollout evidence.

## Production rollout checklist

Production remains prohibited until the final staging artifact, relevant CI, security/data/performance reviews, and Greptile are green for the same branch SHA.

The preview-only `/api/analytics/staging-test` route must not receive a production secret. Its `CAP_ANALYTICS_STAGING_TEST_SECRET` exists only in the Vercel Preview environment and the protected GitHub staging environment; the route returns `404` outside `VERCEL_ENV=preview` and requires the exact Vercel Git SHA.

1. Create production Tinybird resources from the reviewed datafiles with a deploy credential scoped only to the production workspace. Run `deployment create --check`, review destructive/schema changes, create an isolated deployment, run fixture tests, rebuild every copy, query all aggregate endpoints, then promote. Record the deployment ID. Do not reuse the staging workspace or tokens.
2. Create least-privilege Tinybird tokens:
   - append-only token for `product_events_v1`;
   - aggregate endpoint read token with no raw or canonical datasource access;
   - resource-scoped copy token for the eight reviewed copy pipes, with no raw identity datasource access;
   - erasure-lookup token limited to read access on `product_events_v1` and `product_events_canonical_v1`, protected from all agent and admin surfaces;
   - schedule-controller token limited to cancelling, pausing, and resuming the eight reviewed Copy Pipes;
   - dedicated erasure token with Tinybird's required `DATASOURCES:CREATE` scope, no read/deploy scopes, protected as a high-impact operational secret until Tinybird offers resource-scoped row deletion;
   - deployment token used only by the controlled production release path.
3. Set these Vercel production variables without copying values into logs or artifacts:
   - `PRODUCT_ANALYTICS_TINYBIRD_HOST`
   - `PRODUCT_ANALYTICS_TINYBIRD_TOKEN`
   - `PRODUCT_ANALYTICS_TINYBIRD_READ_TOKEN`
   - `PRODUCT_ANALYTICS_TINYBIRD_ERASURE_TOKEN`
   - `PRODUCT_ANALYTICS_TINYBIRD_ERASURE_LOOKUP_TOKEN`
   - `PRODUCT_ANALYTICS_TINYBIRD_COPY_TOKEN`
   - `PRODUCT_ANALYTICS_TINYBIRD_SCHEDULER_TOKEN`
   - `PRODUCT_ANALYTICS_INTERNAL_IP_HASHES`
   - `CRON_SECRET`
   - `NEXTAUTH_SECRET` (existing application secret used to sign the short-lived anonymous browser token; do not create an analytics-specific duplicate)
   For a self-hosted release only, set `CAP_ANALYTICS_TRUST_PROXY=1` after verifying that the fronting reverse proxy overwrites `x-forwarded-for`. Omit it on Vercel.
4. Configure the Vercel firewall rule referenced by the collector so `/api/events` has the verified per-IP limit. The collector also applies the same rule by anonymous-ID key. Verify normal navigation is usable, the documented burst test receives `429`, forged forwarding headers do not bypass classification, and preview hostnames are excluded from decision metrics.
5. Deploy the web application through the normal production release process. Confirm the Vercel deployment Git SHA exactly matches the reviewed commit and confirm the configured Tinybird deployment ID before sending any test event.
6. Run a uniquely tagged production smoke test only if separately approved. Do not use customer identifiers. Confirm ingestion, health, decision deduplication, admin freshness, and strictly scoped cleanup.
7. Enable dashboards only after freshness, duplicates, conflicts, missing identity, clock skew, late events, queue drops, dead letters, and ingestion lag are healthy. Reconcile signup and billing totals against database and Stripe source-of-truth counts before using conversion or revenue decisions.

Rollback is fail closed: disable collection by removing the app append token or route feature switch, roll Vercel back to the recorded prior deployment, and promote the recorded prior Tinybird deployment if schema/query behavior is implicated. Do not delete raw data during rollback. Keep reconciliation paused until the prior collector contract is confirmed compatible, retain health visibility, and record the rollback SHA and deployment IDs. Token rotation follows containment, and erasure credentials must remain available for pending deletion requests.

## Honest limitations

- Browser delivery can be dropped by process termination, blockers, or network policy; loss is bounded and observable only when a later request reaches Cap.
- Persistent first-party identity improves retention and attribution analysis but is not cookieless analytics.
- Anonymous traffic is abuse-resistant rather than proof of a human.
- Database reconciliation proves stored signup, share, and collaboration facts; Stripe remains the source of truth for money and subscription state.
- Aggregated actor counts summed across days are actor-days, not period-unique people. The admin UI labels this explicitly.
- Tinybird requires workspace-wide `DATASOURCES:CREATE` for row deletion; Cap narrows accepted predicates and isolates the credential, but the provider cannot technically restrict it to `product_events_v1` today.
- No production rollout is authorized by this document or by a green staging workflow.
