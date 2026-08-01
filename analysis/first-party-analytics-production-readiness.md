# First-party analytics contract and rollout

## Decision contract

Cap analytics is at-least-once at the delivery boundary and exactly once for decision metrics. Every event carries a stable `event_id` and a SHA-256-derived payload fingerprint. Retry deliveries retain both values. The raw Tinybird datasource is append-only; health metrics preserve every accepted delivery. Canonical and decision snapshots group by `event_id`, count one event only when every accepted copy has the same fingerprint, and quarantine an ID when different fingerprints arrive.

The central registry is `packages/analytics/src/event-registry.ts`. It defines the version, authority, delivery class, permitted platforms, semantic, and property schema for every event. Contract CI rejects unknown literal names, templates, invalid property keys, missing emitters, and drift between the Rust desktop catalogue and the TypeScript registry. Invalid properties reject the whole event rather than being silently removed.

Critical server facts start a durable Vercel Workflow before the request succeeds. Each delivery step retries transient network, `429`, and `5xx` failures with the original ID. Permanent contract failures become visible failed workflow runs. Signup, share, and collaboration facts are also reconciled from authoritative database rows every day with deterministic event IDs, closing the database-commit to workflow-start gap. Stripe remains authoritative for purchases, trials, renewals, plan and seat changes, cancellation, churn, refunds, and payment failures; Stripe webhook retries close its enqueue gap.

Desktop critical events enter a bounded encrypted local outbox before network delivery. The encryption key is stored in the operating-system keyring, events survive restart and offline periods, retryable failures back off, permanent failures enter a bounded dead-letter queue, and counters expose accepted, retried, dropped, overflowed, and dead-lettered events. Mobile critical events enter a bounded atomic AsyncStorage outbox before capture returns; interrupted rotations recover the last valid backup, account-scoped queues are isolated, offline and restart delivery resumes with the original event ID, and terminal failures enter a bounded dead-letter ledger. Browser events are intentionally best effort: attempted, accepted, retried, dropped, overflowed, and oversize counts accompany later batches without recursively creating analytics events.

## Identity, sessions, attribution, and time

- Visitor: a first-party pseudonymous browser ID stored in a persistent cookie/local storage. It is not a claim that the actor is a person.
- Session: a browser visit shared across tabs and renewed after 30 minutes of inactivity. Reloads and SPA navigation retain the session; activity at 29 minutes extends it; a return after more than 30 minutes starts a new session. Hidden time is not engagement time.
- Actor: `user_id` when authenticated, otherwise the anonymous visitor ID, otherwise the session ID. Anonymous and authenticated IDs are carried together during signup and checkout so the journey can be stitched without replacing the authenticated source of truth.
- User: an authenticated Cap account. Cross-device creator metrics use `user_id`.
- Organization: the authoritative organization attached to a server fact. Organization metrics never infer membership from an anonymous browser event.

Metric dates and cohort boundaries use UTC. First touch is the first campaign stored for the visitor. Session touch is captured only when a new 30-minute session begins. Last touch is the most recent campaign-bearing navigation. A new campaign during an existing session updates last touch but does not relabel session touch. Advertising click IDs are retained only as bounded attribution strings.

The activation metric is the first authoritative `share_link_created` event within seven UTC days of `user_signed_up`. It represents a creator who produced a shareable Cap, not a click, checkout, onboarding screen, or client-only intent. Onboarding milestones are diagnostic best-effort events and do not replace activation.

## Traffic and privacy model

Cap chose a persistent first-party pseudonymous visitor identifier, not Plausible's cookieless daily hash model. This supports returning-visitor, multi-tab session, anonymous-to-signup, and attribution analysis, but it requires transparent disclosure and the existing telemetry preference. The identifier contains no email, name, IP address, or device fingerprint.

The collector rejects unregistered events, unknown properties, raw error fields, invalid identifiers, excessive cardinality, and oversized requests. Raw customer content, filenames, transcripts, email addresses, raw errors, raw IP addresses, and raw user-agent strings are not analytics properties. IP and user-agent data are used only in the request process to derive internal/bot classification and coarse country, region, city, browser, device, and operating-system dimensions; raw values are not stored.

Known bots, crawlers, previews, internal IP hashes, and synthetic runs are visible to health monitoring but excluded from decision snapshots. Anonymous write tokens are rate-limited by both source IP and anonymous ID. Replay and automation can be made expensive and observable, but public traffic analytics cannot cryptographically guarantee a human browser. Signup, organization, billing, and other business outcomes therefore remain server-authoritative.

Vercel request-IP buckets use only the platform-owned forwarding header. A self-hosted deployment does not trust forwarding headers by default, so legacy public view tracking returns `503` until `CAP_ANALYTICS_TRUST_PROXY=1` is configured. That setting uses the first `x-forwarded-for` address and is safe only behind a reverse proxy that overwrites, rather than appends or passes through, that header. Do not set it on Vercel.

Account and organization deletion writes its durable pending marker or tombstone before erasure begins. Delivery and reconciliation reject marked identities, then deletion waits longer than the bounded in-flight delivery attempt before removing matching raw rows with a dedicated erasure token and rebuilding every replace-mode canonical, traffic, activation, retention, and health snapshot. This closes the race where a workflow that passed its identity check could otherwise append after a completed erasure. Deletion fails closed if the erasure credential or any rebuild is unavailable. The staging suite deletes a synthetic user and organization, proves their raw-health and decision state is gone, and proves an out-of-scope row sharing the anonymous ID remains until final test cleanup.

## Data quality and performance gates

The staging workflow is restricted to PR 2003 and `codex/first-party-analytics`, hard-codes the staging Tinybird workspace ID, checks the exact Git SHA, waits for the exact-SHA Vercel preview, creates an isolated Tinybird staging deployment, runs fixture and synthetic tests, promotes only a verified deployment inside that staging workspace, and discards an unpromoted deployment on failure. It has no push trigger, production environment, production token, or production deployment command.

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
- wrong workspace, stale SHA, missing credentials, partial execution, failed promotion, and failed cleanup all fail closed.

Copy-backed decision tables rebuild on serialized eight-minute schedules to avoid competing for the same Tinybird worker pool. Exact-SHA staging runs invoke the seven copies in dependency order immediately after seeding, promotion, identity erasure, and final cleanup, so the staging visibility SLO measures the deployed data path rather than waiting for the periodic schedule. Dashboard freshness exposes the most recent aggregate timestamps; scheduled production freshness is therefore bounded by the documented copy cadence plus provider execution time.

The first staging run establishes absolute ingestion and endpoint baselines on the exact deployed code. The final branch must then commit regression budgets derived from those measurements and rerun at representative and larger bounded volumes. A green static/unit run alone is not rollout evidence.

## Production rollout checklist

Production remains prohibited until the final staging artifact, relevant CI, security/data/performance reviews, and Greptile are green for the same branch SHA.

1. Create production Tinybird resources from the reviewed datafiles with a deploy credential scoped only to the production workspace. Run `deployment create --check`, review destructive/schema changes, create an isolated deployment, run fixture tests, rebuild every copy, query all aggregate endpoints, then promote. Record the deployment ID. Do not reuse the staging workspace or tokens.
2. Create least-privilege Tinybird tokens:
   - append-only token for `product_events_v1`;
   - aggregate endpoint read token with no raw or canonical datasource access;
   - erasure token limited to raw deletion, job status, and the seven reviewed copy rebuild pipes;
   - deployment token used only by the controlled production release path.
3. Set these Vercel production variables without copying values into logs or artifacts:
   - `PRODUCT_ANALYTICS_TINYBIRD_HOST`
   - `PRODUCT_ANALYTICS_TINYBIRD_TOKEN`
   - `PRODUCT_ANALYTICS_TINYBIRD_READ_TOKEN`
   - `PRODUCT_ANALYTICS_TINYBIRD_ERASURE_TOKEN`
   - `PRODUCT_ANALYTICS_INTERNAL_IP_HASHES`
   - `CRON_SECRET`
   - `NEXTAUTH_SECRET` (existing application secret used to sign the short-lived anonymous browser token; do not create an analytics-specific duplicate)
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
- No production rollout is authorized by this document or by a green staging workflow.
