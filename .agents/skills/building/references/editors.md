# Editor setup

Keep the skill named `building` and the helper named `building.mjs`. The repository source is `.agents/skills/building/`. Install one persistent copy at `~/.agents/skills/building/`, including its scripts, references, package manifest, and lockfile. Never point a personal installation at a disposable worktree.

| Editor | Personal discovery path | Invocation |
| --- | --- | --- |
| Cursor | `~/.cursor/skills/building` → `../../.agents/skills/building` | `/building <feature>` |
| Codex | `~/.agents/skills/building` | `$building <feature>` |
| Claude Code | `~/.claude/skills/building` → `../../.agents/skills/building` | `/building <feature>` |

An existing `~/.codex/skills/building` installation can remain as a compatibility symlink to the shared directory so earlier absolute helper paths continue to resolve. Check existing destinations before adding links; never overwrite an unrelated skill. Resolve each editor's `SKILL.md` and helper to verify that they read the same files. Reopen a session if its skill list has not refreshed.

Install the helper's pinned packages once with `npm ci --prefix ~/.agents/skills/building --ignore-scripts --no-audit --no-fund`. The helper uses Node, Git, and the provider CLIs/SDK, not editor-specific tool APIs. Configure provider credentials and MCP connections in the editor or runner being used. Prefer PlanetScale MCP when available and retain the CLI fallback. Browser verification can use that editor's browser tools or Playwright with the session's isolated profile.

All three editors must operate through the same helper and Git-common session state, so their locks, port allocations, resource ownership checks, and cleanup coordinate across editors. Resume an existing session by ID; do not run two agents against the same session or create an editor-specific registry.

These paths configure local editors. Remote/cloud workers need the skill package, dependencies, and scoped credentials installed on that worker; a local symlink does not provision a remote environment. Do not copy local secret files as part of the skill package.

Discovery references: [Cursor](https://cursor.com/help/customization/skills), [Codex](https://learn.chatgpt.com/docs/build-skills), and [Claude Code](https://code.claude.com/docs/en/skills).
