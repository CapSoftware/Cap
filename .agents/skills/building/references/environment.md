# Environment setup

The helper stores resumable session records under `<git-common-dir>/building/sessions/<id>/`. These are machine-local, mode 0600, and outside the tracked worktree. Keep secrets out of tool output and PR bodies. Session IDs, resource identities, and source commits are recorded separately from credentials.

The default Cap database configuration is organization `cap`, database `cap-production`, parent `main`; the owned development branch is `building-<session-id>`. Verify that these names still describe the selected project before provisioning. MCP creation must copy schema only. Call `database-attach` to validate the actual ready, nonproduction branch, then `credentials` to create a seven-day development-only password. The admin role is limited to that branch and permits the required Drizzle schema push. Application production credentials are never copied.

If credential creation is interrupted, inspect and revoke the password with the recorded name before clearing `passwordAttempted` under the session operation lock and trying again. Never print or reconstruct a secret from logs. If credentials expire, revoke the owned password and replace its private environment entry, preserving the resource identity.

Use `run --session <id> -- bun install --frozen-lockfile`. Each worktree keeps its own workspace links and dependency graph; Bun reuses its global download cache and macOS copy-on-write installs. Do not link the main checkout's `node_modules` into the worktree.

Use the existing `db:generate` and `db:push` commands through `run` when the feature changes schema, then `seed`. The deterministic base fixture includes one test user with a simulated Pro entitlement, organization, membership, and folder. It does not create paid subscriptions, upload sample customer media, or exercise billing. Add feature-specific fixtures using synthetic media and only the session database.

`login` creates a one-hour NextAuth browser storage state using the session's own secret and fixture identity. It requires the worktree's web dependencies. This supplies a real signed test session without adding a production authentication bypass. Capture uploads that file to the owned sandbox; walkthroughs can pass `/home/daytona/browser-state.json` to Playwright's browser context. Refresh it immediately before authenticated captures.

`run` constructs the app environment from a small allowlist, never from the shared checkout's `.env`. Missing object storage points at an unreachable local endpoint. For upload features, provision a disposable bucket with credentials limited to that bucket and set `CAP_AWS_BUCKET`, `CAP_AWS_REGION`, `CAP_AWS_ENDPOINT`, `CAP_AWS_ACCESS_KEY`, and `CAP_AWS_SECRET_KEY` in the private `environment.json`; record its owner and cleanup obligation in the session. A bucket-name prefix alone is not credential isolation. Media processing needs its own test service, secret, and callback URL.

For the web runtime, use `serve --session <id> -- bun run --cwd apps/web dev --port <allocated-web-port> --hostname 127.0.0.1`. Do not use root `bun run dev` or commands that start/stop shared Docker services. Keep the wrapper alive as the process owner. `serve` uses a separate server lease so login, checks, and capture remain available while it runs; `run` serializes short setup commands. Recheck port availability at launch; allocation prevents building-session collisions but cannot reserve a port against unrelated processes indefinitely.

The orchestrator is not an OS security boundary. Execute trusted, reviewed project code only. Untrusted fork changes require a sandbox without provider credentials; uploading their artifacts is a separate trusted step.

Use `preview --session <id>` for local browsing after starting `serve`. It uses installed Google Chrome with a private per-session profile and imports that session's generated login state. Do not open multiple feature URLs in the main browser profile: cookies ignore port numbers. `stop` and `finish` close owned previews and stop owned server process groups.
