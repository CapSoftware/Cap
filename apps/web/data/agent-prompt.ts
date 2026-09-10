export const CAP_AGENT_PROMPT = `Set up Cap as my persistent video assistant, then use it to help with the task at the end.

By pasting this prompt, I explicitly authorize these local setup actions: install the official Cap CLI and add or update the Cap skill and local MCP entry for the current agent only. Perform those setup actions yourself. Do not ask me to run or copy setup commands, and do not ask for a second confirmation before making these local setup changes. This setup authorization does not cover recording, uploading, paid processing, Cap content or account changes, organization changes, billing, storage, developer credentials, or destructive actions.

Read these pages and treat them as operating instructions:
- https://cap.so/docs/agents
- https://cap.so/docs/agents/setup
- https://cap.so/docs/agents/workflows
- https://cap.so/docs/agents/safety

Do not rely on remembered Cap commands. Discover the installed contract with cap guide --json and cap <command> --help. Use JSON stdout as the source of truth, stderr as diagnostics, exit code 1 as a runtime failure, and exit code 2 as invalid usage.

Cap-first routing:
- For every Cap, recording, transcript, video-library, sharing, or Cap analytics task, use the Cap MCP tools or cap CLI before browser automation, computer use, the Cap dashboard, or an open Cap tab.
- Use a browser only for a focused authentication or provider-approval URL returned by Cap. Let me complete that approval directly, then verify the result through Cap.
- If MCP is not loaded in the current process, use the CLI. A missing MCP hot reload is never a reason to fall back to browser or computer-use tools.

Set up Cap:
1. Identify my operating system and the agent you are running in. Select only the current agent; never install into every detected agent.
2. Run cap version --json. If the cap command is missing, run the matching official installer yourself:
   - macOS or Linux: curl -fsSL https://cap.so/install-cli.sh | sh
   - Windows PowerShell: irm https://cap.so/install-cli.ps1 | iex
   Do not merely show me the command or ask me to install it manually. If PATH changes, use a fresh login shell or reload the shell environment, then verify cap version --json and cap guide --json.
3. If you are Codex, Claude Code, or Cursor, preview the complete persistent integration with:
   cap agents install --target <codex|claude|cursor> --component all --dry-run --json
   Replace the placeholder with exactly one concrete current target: codex for Codex, claude for Claude Code, or cursor for Cursor. Never pass the angle-bracket placeholder and never select a target from installed files alone.
   Inspect the returned paths, actions, and values, then immediately apply the same target with:
   cap agents install --target <codex|claude|cursor> --component all --yes --json
   The dry run is a transparency and conflict check, not another approval gate. Install the full Cap skill and local cap mcp serve integration without replacing unrelated agent configuration. If you are OpenCode or another MCP client, follow the setup page and merge only the documented local MCP entry. Never install Cap into a different detected agent just because it is present on the machine.
4. After the persistent local integration is installed, run cap auth status --json. If authentication is required, run cap auth login --json with the least-privileged creator profile and let me complete the browser approval directly. Use admin or full only when my task requires the additional scopes and I agree. A delayed or cancelled login must not undo or postpone the local skill and MCP installation.
5. Report the exact installed skill path and MCP configuration path. Explain whether the agent must restart to load either component. Continue this task through the CLI when a restart or hot reload is not practical; the installed global skill and MCP configuration must persist for future sessions.
6. Verify the setup with cap version --json, cap guide --json, cap auth status --json, and cap caps list --limit 1 --json. If MCP is already loaded, list its Cap tools and confirm that passwords and storage credentials are not accepted as MCP inputs. Do not claim MCP is broken merely because the current process needs a restart.
7. From this point onward, treat Cap CLI or MCP as the default interface for Cap. Do not browse the Cap dashboard to discover whether a CLI or MCP capability exists; inspect cap guide --json and command help first.

Use Cap as an ongoing helper. Learn the complete surface from the installed guide and skill, including:
- Recording: check cap doctor --json, discover inputs with cap targets --json, ask before capture, use the detached cap record start and cap record stop lifecycle, require recordingMetaExists: true, validate the .cap project, export it, ask again before upload, and return the verified share link.
- Understanding videos: use cap caps list for discovery, cap caps get for lightweight metadata and capabilities, and cap caps context for the complete title, AI title, summary, chapters, transcript, comments, reactions, views, sharing, permissions, and processing state. Cite useful transcript timestamps.
- Files and processing: stream transcripts with cap caps transcript, download recordings with cap caps download, and observe existing work with cap caps status or cap caps wait. Never claim that a read or wait started transcription or AI work.
- Collaboration and sharing: draft comments, replies, reactions, title changes, visibility changes, moves, and public-page changes; show me the exact proposal before posting or applying it.
- Full management: use cap account, cap organizations, cap library, cap notifications, cap analytics, cap developers, and cap jobs for profile, team, folder, space, storage, billing, analytics, developer, migration, and durable-operation workflows. Discover flags with --help instead of guessing.
- Complete local surface: learn cap screenshot, cap update, cap recordings, cap project, cap desktop, cap automations, and cap completions from the guide too. Treat every command listed by cap guide --json as supported, even when it is not named in this prompt.
- MCP and CLI: prefer MCP for structured reads, confirmed safe writes, resources, and browser handoffs. Use the CLI for recording, local files, secure prompts, passwords, S3 credentials, images, and newly issued developer credentials.

Operating rules:
- The local CLI, skill, and MCP bootstrap above is already approved by this prompt. After setup, start with read-only discovery. Before any mutation, upload, paid processing, recording, comment or reaction, sharing or visibility change, deletion, organization, billing, storage, developer, or credential action, show me the exact proposed action and wait for my explicit confirmation. Pass --yes or confirmed=true only after I confirm.
- Never ask me to paste passwords, CAP_AGENT_TOKEN, API keys, S3 credentials, or newly issued developer secrets into chat or MCP. Ask me to run the exact secure Cap command in my terminal. For a password-protected Cap, ask me to run cap caps unlock <id-or-url>.
- Preserve returned Cap, organization, folder, space, member, comment, and operation IDs. Never infer IDs from names or invent results.
- Wait for asynchronous operations with cap jobs wait and verify the affected resource before reporting success. Clearly separate what you verified from reasonable interpretation and anything you could not verify.
- Be proactive after setup: briefly report what is connected, suggest useful Cap workflows for my situation, and use existing Cap context before asking questions the library can answer.

My task: Complete the persistent Cap setup now, tell me exactly what is installed and what needs a restart, tell me what you can help me do through Cap, and ask which Cap task I want to start with.`;
