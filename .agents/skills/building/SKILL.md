---
name: building
description: Build Cap features in isolated Git worktrees with PlanetScale development branches, shared dependency caches, recorded feature demonstrations, and plain-language pull requests. Use for /building or $building requests, including resuming an existing building session. Ordinary coding requests do not select this publishing workflow.
---

# Building Cap

Use `/building <request>` in Cursor or Claude Code, or `$building <request>` in Codex. Each invocation authorizes implementing the feature in a new worktree, provisioning its disposable development resources, running verification, recording and uploading a demonstration into the user's `PR's` Cap folder, and opening a pull request. Honor narrower user instructions. Merging and production deployment remain separate actions.

Use the repository containing the requested Cap project. Keep the original checkout, its index, branches, running services, and recordings untouched. This workflow replaces the shared-checkout mechanics of `$build`; do not invoke that skill inside this workflow.

The helper is `scripts/building.mjs` relative to this skill. Use its absolute path when working in a newly created worktree, which might predate the repository copy of this skill. Run `npm ci --prefix <skill-directory> --ignore-scripts --no-audit --no-fund` once if the provider dependencies are missing. `node <helper> help` lists commands. Read [editors.md](references/editors.md) when installing or checking discovery in another editor; all editors use the same scripts and session registry.

## Publication privacy

Use neutral GitHub metadata. Branch names, commit messages, PR titles/descriptions, comments, release notes, and demo titles must not mention Codex, Cursor, Claude, model names, or automated authorship. Use `building/<feature>-<id>` branches and conventional commit titles describing the actual change. Never add tool signatures, generated-by text, co-author trailers, or other attribution. This naming rule applies whichever editor runs the workflow.

Never put secrets, sensitive information, or real people's personal data in committed content, filenames, commit messages, GitHub PR titles/descriptions, comments, attachments, or linked demonstrations. This includes credentials, tokens, cookies, signed URLs, connection strings, customer names, email addresses, phone numbers, account identifiers, recordings, and private support or billing details. Choose public-safe feature names before creating branches, recipes, or video titles. Use synthetic fixtures and reserved example domains. Keep raw logs, local absolute paths, database/provider receipts, and session state out of Git and GitHub text; a private repository is not an exception.

Before every commit, inspect the exact staged diff and proposed message. Before every push, review all outgoing commits, including intermediate versions that a later commit removes. Before each GitHub write or Cap upload, inspect the final text or media actually being published. Summarize test outcomes in safe language instead of pasting commands or raw output; inspect screenshots, video frames, and audio too. Use an available secret scanner as an additional check, never as proof that personal data is absent. Use the user's established public Git identity and GitHub no-reply email rather than publishing a private author or committer email; do not alter shared Git configuration.

If anything sensitive appears or cannot be confidently classified, sanitize or replace it before proceeding. Do not publish first and clean it up later. If exposure has already occurred, stop further publication, report the affected artifact without repeating the value, and coordinate credential revocation and history cleanup rather than silently force-pushing. Do not silently redact application behavior or required source values; use configuration or synthetic fixtures and preserve the intended feature.

## Prepare and resume

Read the selected repository's instructions. Fetch the remote default branch without moving the original checkout. Run `new --repo <repo> --name <short-feature-name> --target web|desktop|gpui|fullstack --base <remote-default-ref>` and use the returned worktree for every source edit, generator, command, commit, and push. Resume with the existing session ID; do not create replacement resources after an uncertain response.

Read [environment.md](references/environment.md) before provisioning. Prefer the PlanetScale MCP to create the exact development branch named in the session, then run `database-attach`. The authenticated `database-create` helper is the fallback when that MCP is unavailable. Never attach production, staging, another session's branch, or production credentials. Create expiring credentials and seed the owned development branch. Generate migrations through Cap's existing generator; never edit generated SQL or metadata by hand.

Run short commands through the helper's `run` wrapper and long-lived servers through `serve` so inherited production integration credentials and unmanaged dotenv files cannot accidentally configure the feature. Explicitly configure only required test services. There is no automatic production fallback for storage, payments, email, OAuth, or media processing.

Read [desktop.md](references/desktop.md) when native crates or desktop applications are involved. Use Bun's shared package cache and private installations. Warm private native/build directories using copy-on-write only from a matching, idle checkout. Never symlink a writable `target`, whole `node_modules`, app profile, or user recording directory between worktrees.

## Implement and verify

Make the smallest complete change, trace its callers and platform behavior, and apply repository checks to the affected scope. Preserve an acceptance checklist including error states, permissions, and old data. Establish the demo's expected behavior before implementation; assertions must test that behavior, not just successful page loading.

Commit coherent changes in the owned worktree. Run final checks through `check` so successful results are bound to the committed SHA. Recheck against current remote main, including generated migration conflicts and deployment ordering. A successful Git merge simulation does not prove runtime compatibility.

Read [recording.md](references/recording.md) for the Daytona/Cap path. Use a tracked, reviewed feature recipe and an assertion-driven walkthrough of the actual change. Before credentialed capture, independently inspect source provenance, changed code and dependencies, recipe commands, and credential scope, then record the actual SHA-bound review with `capture-review`. Untrusted or fork-controlled code receives no credentials until that review is complete. Verify the resulting video's content and reviewer access in a browser before calling it a successful demonstration. Use `preview` for local feature browsing: each session gets a separate Chrome profile, preventing cookies and local storage from colliding across ports. Preserve failed evidence; never replace a failed Cap CLI capture with a different recorder without reporting the change.

For macOS/Windows-specific behavior, obtain evidence on that OS. Linux browser or native demonstrations do not establish other-platform behavior. Infrastructure-only changes can give a concrete nonvisual explanation and relevant test evidence instead of a staged visual demo.

## Publish

Create or reuse a draft PR for the owned branch, then record its URL using `pr`. Push only the feature branch without force. Keep the PR draft while required verification, video playback, native checks, or review remain incomplete. Do not let fork PR code run with provider or publishing credentials in privileged CI.

Upload the verified capture using `share`; the helper finds or creates `PR's` and moves the video there. An uncertain upload must be reconciled by its recorded title/ID, never blindly repeated. Write a short ELI5 file explaining the previous problem, the new behavior, and its benefit. `pr-body --eli5 <file>` produces a starting body with the recording and current-SHA checks. Add factual migration notes, platform coverage, and remaining limitations; remove limitations only after verification. Use `gh pr edit --body-file`, preserving unrelated reviewer-authored content.

Use the installed `greptile-pr-loop` skill when available, fixing actionable findings through its stop condition. Any changed commit invalidates old evidence: rerun affected checks, update the recording, and review the final PR head. In Codex, attach the created PR to the current task using `attach_artifact` when available; Cursor and Claude Code can report the GitHub URL directly. These editor integrations are optional; resource management uses the shared CLI. Mark it ready only after the required gates pass; otherwise report the concrete blocker and keep the draft.

## Finish

Delete owned Daytona sandboxes after evidence is downloaded; the helper also sets expiry limits. After the PR is published, required checks pass, and the Cap upload is verified playable and accessible, run `finish` automatically. It stops owned server processes and removes the disposable development database and clean, published worktree while the PR remains open. Do not keep paid previews running unless the user asks for one. Keep recordings, Git branches, receipts, and shared caches. `resume` recreates the worktree from its retained feature branch; reprovision and reseed its development database for follow-up work. `close` also supports cleanup after a PR is merged or closed. Never delete resources based on age alone or break a lock without checking its host, process, and pending operation.

Report the PR, Cap link, actual checks, unverified platforms, and retained resources. Do not call a scaffold, a passing compile, or an accepted upload end-to-end success.
