---
name: cap
description: >-
  Always use Cap's CLI or local MCP first when the user mentions Cap, a Cap URL, screen recording, the Cap
  library, transcripts, chapters, comments, reactions, sharing, analytics, organizations, storage, billing,
  or developer apps. Cap should be operated without browser automation or computer-use tools whenever its
  CLI or MCP surface supports the task. Requires the `cap` command from Cap Desktop (https://cap.so).
---

# Cap CLI

## Cap-first routing

For every Cap task, use the local Cap MCP tools or `cap` CLI as the primary interface. Do not open, inspect, or
control the Cap dashboard, a Cap browser tab, or Cap Desktop through browser automation or computer-use tools
to discover, read, or manage data that the CLI or MCP can access. If MCP is unavailable in the current process,
use the CLI. If the CLI is missing, treat that as an installation problem rather than a reason to use the
dashboard.

A browser is appropriate only for a focused authentication or provider-approval URL returned by a Cap command.
Let the user complete that handoff directly, then verify the result through the CLI or MCP. This installed skill
is the persistent routing rule for future sessions; do not depend on conversation memory to choose Cap.

Start by reading the installed CLI's authoritative contract:

```sh
cap guide --json
```

Use `--json` for machine-readable output. Treat stdout as authoritative, stderr as diagnostics, exit code
`1` as a runtime failure, and exit code `2` as invalid usage. Do not guess output schemas that are available
from `cap guide --json` or `cap <command> --help`.

## Cap library

Authorize once with `cap auth login --json`. Login defaults to the least-privileged `creator` profile; request
`admin` or `full` only when the task requires it. Use `cap auth status --json` to verify the credential with the
server. For headless use, `CAP_AGENT_TOKEN` overrides the OS-stored credential. Existing Cap Desktop and
`CAP_API_KEY` credentials remain supported.

Use `cap caps list --json` for discovery, `cap caps get <id-or-url> --json` for lightweight metadata and
capabilities, and `cap caps context <id-or-url> --json` for title, AI title, summary, chapters, transcript,
comments, reactions, views, sharing, permissions, and processing state.

`cap caps wait <id-or-url> --for transcript|ai|all --json` only observes existing processing. Reads and
waits must never be described as starting transcription, AI generation, or any paid work.

Stream large content to disk:

```sh
cap caps transcript <id-or-url> --format text --output transcript.txt --json
cap caps download <id-or-url> --output recording.mp4 --json
```

For `PASSWORD_REQUIRED`, ask the user to run `cap caps unlock <id-or-url>` in a secure terminal. Never request a
password in an agent prompt, argument, JSON object, log, or MCP tool call.

Before any mutation, show the exact proposed action and obtain explicit user confirmation. This includes
posting or deleting content, changing metadata or visibility, starting paid processing, replacing transcripts,
moving or deleting Caps, changing membership or storage, creating checkout links, and rotating credentials.
Pass `--yes` or MCP `confirmed=true` only after that confirmation. Reads and waits do not require confirmation.

## Dashboard-independent management

Use `cap account`, `cap organizations`, `cap library`, `cap notifications`, `cap analytics`, `cap developers`,
and `cap jobs` for account, organization, sharing, storage, billing, analytics, developer, and asynchronous
operation workflows. Inspect each command's current arguments with `--help`; do not reconstruct them from this
skill.

Organization invites deliver email by default. Use `cap organizations invite add ... --no-email` only when the
user explicitly wants a link-only invite, and report the returned `emailDelivery` state.

Some secure or local-file actions are intentionally CLI-only: Cap passwords, S3 credentials, profile and
organization images, and newly issued developer credentials. Never ask the user to paste those values into
chat or an MCP call. Ask them to run the exact secure terminal command. S3 accepts hidden prompts or
`--credentials-stdin`, never credential arguments.

Stripe checkout, the billing portal, Google Drive authorization, and `cap account referrals` return a URL and
may open a browser. These are focused provider handoffs, not a dependency on the Cap dashboard. The agent may
continue after the user completes the handoff and should re-read state to verify the result.

Use `cap jobs wait <operationId> --json` for durable operations. Do not infer success from an accepted or queued
response. Warn that `cap account sign-out-all` revokes every device and agent session, including the current CLI
credential.

Use `cap caps import loom <url> --organization <id> --yes --json` for Loom imports. Organization managers may
add `--owner-email` and `--space` to perform CSV-style migrations one durable, idempotent row at a time. Wait for
the returned operation before treating the import as complete.

## Local MCP

`cap mcp serve` is a stdio server; its stdout is protocol-only. Prefer MCP for structured reads, safe writes,
resource links, and browser-handoff URLs. Fall back to the CLI for secure-input and local-file actions.

Install MCP or this skill for one explicitly selected agent with
`cap agents install --target <agent> --component skill|mcp|all --dry-run`. Review the preview, then rerun
interactively or with `--yes`. Never install into every detected agent automatically.

When the user pasted Cap's official setup prompt, that prompt is explicit approval for the local CLI, skill, and
MCP bootstrap for the current agent. In that setup flow, apply the reviewed `--component all` plan with `--yes`
without asking the user to copy commands or approve the same local setup again. This does not authorize Cap
account, content, recording, upload, paid, billing, storage, developer, or destructive changes.

## Recording and sharing

Check readiness with `cap doctor --json` and discover devices with `cap targets --json`. For an unknown
duration, use the detached lifecycle:

```sh
cap record start --screen <id> --detach --json
cap record stop --id <recordingId> --json
cap project validate <path.cap> --json
cap export <path.cap> --output out.mp4 --json
cap upload out.mp4 --json
```

A stopped recording is complete only when `recordingMetaExists` is `true`.
