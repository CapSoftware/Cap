# Recorded PR review

Use a trusted Linux Daytona snapshot with a known-good Cap CLI, browser, and required native libraries. The helper sets `VNC_RESOLUTION=1920x1080` at creation and verifies the actual display. This setting applies to Linux container sandboxes; do not assume it changes Windows or VM geometry. Local upload uses the installed authenticated Cap CLI, so its credential never enters Daytona.

The runner dependency is pinned in this skill's package lock. Supply `DAYTONA_API_KEY` to the host process through existing secure configuration, not an argument or recipe. Recipe files and walkthrough code must be committed in the feature worktree. The sandbox receives `git archive` of the exact verified commit, not uncommitted local files. Review source provenance, the complete feature diff and dependency changes, and every setup/start/readiness/walkthrough command and network destination before trusting the capture. A tracked recipe or a passing test is not evidence that fork-controlled code is trusted.

Credentialed captures require a private review receipt before any sandbox is created. After actually completing that review, record `sha`, the recipe file's SHA-256 as `recipeHash`, the private session `environment.json` file's SHA-256 as `environmentHash`, `sourceTrusted: true`, `commandsReviewed: true`, `credentialScopesReviewed: true`, and an ISO `reviewedAt` timestamp in a private JSON file. Use `capture-review --session <id> --recipe <path> --evidence <file>` to bind the review to the exact source, recipe, and credential configuration. A later commit, recipe edit, credential rotation, or service-configuration change requires a new review. The helper rechecks the configuration fingerprint when loading the app's environment after waiting for the capture slot. Never generate this receipt just to pass the gate: verify that database and storage credentials are restricted to disposable synthetic fixtures. Untrusted forks remain on `database: false` without credentials or browser login state until independently reviewed.

The sandbox's initial environment and the setup, readiness, walkthrough, and recorder commands receive no configured credentials. Only the reviewed `start` command receives the session's development credentials, after setup completes; it runs in the background with private logs. Put credentialed application startup in `start`, not in setup or walkthrough commands. These phases share an OS user, so environment separation is defense in depth, not an OS boundary against malicious code. Do not approve untrusted source for this mode.

A recipe has this shape:

```json
{
	"version": 1,
	"platform": "linux",
	"snapshot": "daytona-small",
	"setup": ["bun install --frozen-lockfile"],
	"start": "bun run --cwd apps/web dev --port \"$PORT\" --hostname 127.0.0.1",
	"ready": "node scripts/feature-demo/wait-for-server.mjs",
	"walkthrough": "node scripts/feature-demo/walkthrough.mjs"
}
```

The paths above illustrate feature-owned scripts, not existing commands. Implement them for the feature. Their readiness checks must be bounded, and the walkthrough must fail on an incorrect outcome. Use Playwright for browser interaction and assertions, with a headed browser and a fixed viewport. Provide readable pauses around meaningful states, aiming for 20–60 seconds. Keep credentials, customer data, and unrelated windows off-screen.

The snapshot must already contain `cap` on PATH, or the recipe must install a reviewed, pinned release before capture. Inspect `cap guide --json`, `cap doctor --json`, and screen targets. The official installer is at `https://cap.so/install-cli.sh`, but do not execute an unreviewed downloaded installer or silently change the recorder version during retries. Record the recorder version in the verification notes.

`database` defaults to true. Set it false only for a demonstration that cannot access application data, such as a build-tooling smoke test. Otherwise the runner verifies the owned development branch and supplies its isolated configuration. External service fixtures must work from inside Daytona; host-local addresses are not reachable there.

Run `capture --session <id> --recipe <absolute-recipe-path>`. The helper starts Cap, executes the walkthrough, stops/finalizes the recording, validates and exports it, downloads the MP4, and checks video dimensions/duration using local `ffprobe`. It deletes the owned sandbox in cleanup and sets provider expiration limits as a backstop. Do not treat an MP4's existence as visual verification: watch the exported file and confirm the intended feature is visible and behaves correctly.

If sandbox creation has an uncertain result, locate the saved name and labels and run `sandbox-cleanup`; do not create a replacement until ownership is reconciled. If recording or a walkthrough fails, retain available artifacts and diagnose it. Failed evidence is never accepted as a passing capture. The helper's timeouts bound individual commands; provider TTL bounds abandoned sandboxes.

After creating a draft PR, record its URL using `pr`, then call `share`. Uploads are named `#<PR> — <feature> — <commit>` and moved into the personal root `PR's` folder within the user's default Cap organization. Folder creation, lookup, and the move all use the personal library; placement is verified through the Cap's own folder and organization fields. This does not create an organization share or change the recording's visibility. Folder identity is saved for retries. Never create duplicate folders or blindly retry an upload with an uncertain result. Reconcile by the saved title and metadata, then persist the discovered upload ID/link under the session lock.

Open the resulting Cap share page and verify playable video and intended reviewer access. Keep organization-private visibility if appropriate; public GitHub reviewers require a deliberately public recording containing only synthetic data. Setting visibility is separate from creating a share URL. Do not mark the PR ready with an inaccessible or unplayed recording.

Use the ELI5/recording/check template from `pr-body`, then add actual platform coverage and schema-deployment notes. The helper rejects stale SHA evidence. CI and review also need the current PR head. A later fix can require a new recording; retain prior Caps as historical evidence rather than deleting them.

After actually checking playback and reviewer access, save a private browser receipt with `sha`, `url`, `played: true`, `reviewerAccess: true`, and `observedAt`, then run `video-verified --evidence <file>`. This records observed browser evidence; do not fabricate it from upload metadata. Run `finish` as part of PR completion to release the database, server processes, and published worktree immediately. Retained source and seed recipes let `resume` rebuild a follow-up environment.

Cost defaults: one recording slot per local repository, 15-minute idle stop, 45-minute sandbox TTL, and deletion after artifact download. The SDK snapshots determine CPU/RAM allocation; use a small prepared Linux snapshot for browser demos, and opt into larger/native/GPU runners only for a concrete verification need. Keep expensive compilation out of the recording stage by preparing snapshots. Provider quotas may queue or reject work even when source worktrees are independent. Database passwords expire after seven days, but password expiry does not stop database billing: `finish` must delete the branch. On a blocked or abandoned run, reconcile and delete owned paid resources while retaining source and failed local evidence.
