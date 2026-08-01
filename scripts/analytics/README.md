# Cap Analytics Infrastructure

Run the complete local analytics setup with:

```bash
pnpm analytics:local
```

This starts only the optional Tinybird Local Docker profile, waits for readiness, builds every checked-in datafile, shifts deterministic fixtures into the current three-day window, rebuilds each copy-backed aggregate, verifies the typed endpoints, and writes the two `PRODUCT_ANALYTICS_TINYBIRD_*` values used by Cap to the gitignored `.env.analytics.local` file. Re-running the command is safe because decision aggregates deduplicate repeated fixture deliveries and local raw rows remain inside the bounded retention window.

Tinybird Local persists ClickHouse and metadata in named Docker volumes. Normal `pnpm docker:up` and the public self-hosted Compose setup do not start analytics.

## Commands

| Command | Purpose |
| --- | --- |
| `pnpm analytics:validate` | Validate schemas, tokens, fixtures, retention, deduplication, and existing viewer resources without Docker |
| `pnpm analytics:test` | Run the shared contract, web, desktop, billing regression, infrastructure, and static validation suites |
| `pnpm analytics:local` | Start, build, test, and write the local runtime environment |
| `pnpm analytics:local:test` | Run Tinybird fixture tests against Tinybird Local |
| `pnpm analytics:local:tokens` | Discover the deployed append-only token and write it with the local runtime host to `.env.analytics.local` |
| `pnpm analytics:local:stop` | Stop Tinybird Local while preserving its volumes |
| `pnpm analytics:deploy:check` | Validate a cloud deployment without promoting it |
| `pnpm analytics:deploy` | Run the cloud deployment check, deploy, and wait for completion |
| `pnpm analytics:check` | Compare live Tinybird resources with the checked-in datafiles |
| `pnpm analytics:query -- daily start_date=2026-07-01 event_name=purchase_completed payment_status=paid` | Query paid purchases from the bounded daily aggregate with an agent read token |
| `pnpm analytics:query -- health start_time=2026-07-01T00:00:00 end_time=2026-07-02T00:00:00` | Query hourly delivery health for an explicit window |

## Production credentials

Cloud deployment requires:

- `TINYBIRD_DEPLOY_TOKEN`: a CI token limited to `WORKSPACE:DEPLOY`.
- `TINYBIRD_URL`: the regional Tinybird API URL.
- `TINYBIRD_WORKSPACE_ID`: the production Workspace UUID verified before every cloud check or deployment.

The deployed datafiles create four runtime tokens:

- `product_events_ingest`: append-only access to `product_events_v1`.
- `product_events_agent_read`: read-only access to privacy-safe product endpoints. It has no raw identity datasource or Copy Pipe scope.
- `product_events_copy_runner`: execution-only access to the eight reviewed Copy Pipes. It cannot query endpoints or raw identity data.
- `product_events_erasure_lookup`: read-only access to `product_events_v1` and `product_events_canonical_v1` for bounded identity erasure. It cannot query decision endpoints, append rows, or execute Copy Pipes.

Set the append token as `PRODUCT_ANALYTICS_TINYBIRD_TOKEN` in the application. Give agents the read token, never the deployment or append token.

Staging also requires `TINYBIRD_STAGING_SCHEDULER_TOKEN`, a protected token with schedule-control access only to the eight reviewed Copy Pipes. The destructive erasure phase cancels and pauses those schedules before deleting rows, runs each replacement Copy exactly once, proves completion with scoped state transitions or copy-run markers, and resumes every schedule in an always-run recovery step. A failed or ambiguous Copy submission is never retried automatically.

The staging workflow validates candidate ingestion, duplicate/conflict visibility, live isolation, and every typed endpoint through the exact numeric deployment ID before promotion. Tinybird's Copy service does not reliably route an on-demand Copy mutation to a deployment candidate, so CI refuses that path. After the exact candidate is promoted inside the staging workspace, CI triggers the reviewed Copy Pipes through Tinybird's direct Copy API with the protected `product_events_copy_runner` token. `tb copy run` performs a workspace-level lookup that rejects otherwise sufficient per-pipe read scopes. Tinybird does not grant either the resource token or the deployment token access to the resulting Jobs API record, so CI proves terminal completion from canonical, daily, and health state transitions plus a unique zero-valued marker written by every other aggregate Copy. A real browser drives the exact-SHA preview through reload, shared-tab, inactivity, SPA retry, and unload behavior. A preview-only authenticated route starts durable server workflows for deduplicated activation and paid-purchase facts. Registry-validated synthetic fixtures separately prove exact anonymous-to-authenticated, guest checkout, cross-device checkout, lifecycle revenue, and public endpoint values while remaining excluded from normal queries. Performance compares shared endpoints with the retained deployment, applies absolute budgets to a newly introduced endpoint that has no honest historical baseline, and validates mixed 1,000-row and 10,000-row traffic, activation, retention, identity, adoption, and revenue corpora before timing them. Before the prior deployment can be deleted, CI switches it live, executes the shared typed data plane, proves the exact-SHA admin client gracefully degrades only the identity endpoint absent from that rollback target, restores the candidate, and repeats the full synthetic business and health assertions.

Set `TINYBIRD_AGENT_TOKEN` and `TINYBIRD_URL` for the query command. Set a separate `TINYBIRD_READ_TOKEN` with workspace metadata access when running `pnpm analytics:check`; the append and deployment tokens are intentionally rejected for that task.

## Agent access

Tinybird exposes published endpoints through its hosted MCP server. Copy `scripts/analytics/tinybird-mcp.example.json` into your agent configuration, replace the two placeholders with the resource-scoped `product_events_agent_read` token and regional API host, and keep the resulting file out of version control. The MCP setup is documented at <https://www.tinybird.co/docs/forward/query-data/mcp>.

Agents should use `product_events_daily` for funnels and trends, and `product_events_health` for delivery checks. The daily endpoint defaults to the latest 30 days, caps results at 1,000 groups, returns newest dates first, and exposes payment and subscription status so paid purchases are not conflated with trials. Health is hourly and rejects windows over 31 days.

The Analytics GitHub workflow runs static tests, Docker Compose validation, a complete Tinybird Local build, and fixture tests on relevant pull requests. Merges to `main` deploy only after those gates pass.

## Performance boundaries

- `product_events_v1` appends every delivery attempt; the canonical copy deduplicates stable `event_id` values and quarantines conflicting payload hashes.
- Monthly partitions and a shared 800-day raw, canonical, and decision horizon support complete year-over-year windows while keeping erasure rebuilds complete for every retained contribution. Health detail retains 90 days.
- Common event trends use `product_events_daily_exact`; they do not scan raw events.
- Daily counts use unique event states, so retried deliveries cannot inflate the rollup.
- Raw health queries require explicit start and end times.
- Event properties are stored as JSON strings and fixtures enforce a 16 KiB ceiling.
- The infrastructure contains no autocapture or session-replay path.

Routine commands refuse destructive deployment, workspace-clear, datasource-delete, and datasource-truncate arguments. Destructive recovery is intentionally outside the normal workflow and requires separate review.

Tinybird row deletion currently requires the general `DATASOURCES:CREATE` scope rather than a resource-scoped delete permission. Keep the dedicated erasure operator in a protected environment, give it no read or deployment scope, and expose it only to the reviewed deletion workflow. The application uses separate protected credentials for bounded raw/canonical identity lookup, reviewed Copy execution, aggregate marker reads, and Copy schedule cancellation/resumption. This provider limitation means the delete credential can technically mutate other datasources in its workspace even though Cap's workflow accepts only validated identity conditions.
