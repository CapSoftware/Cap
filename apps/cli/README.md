# cap CLI

Cap screen recording, driven from the command line. The `cap` binary is built for automation and AI
coding agents (Claude Code, Codex, OpenCode, Cursor): every command speaks JSON, errors are
machine-readable, and recordings have an explicit start/stop lifecycle.

## Install

- **From Cap Desktop:** Settings → Command Line → Install CLI (links the bundled binary onto your PATH).
- **Script:** `curl -fsSL https://cap.so/install-cli.sh | sh` (Windows PowerShell: `irm https://cap.so/install-cli.ps1 | iex`; Command Prompt: `curl.exe -fsSL https://cap.so/install-cli.cmd -o "%TEMP%\cap-install-cli.cmd" && "%TEMP%\cap-install-cli.cmd"`). If Cap Desktop is missing, the script downloads and installs it first.

The desktop app and the CLI share the same binary, so the CLI is always in sync with the installed app.

## Agent integration

A ready-made skill lives at [`skill/cap/SKILL.md`](./skill/cap/SKILL.md). For Codex, Claude Code, or Cursor,
install the skill and local MCP server together for exactly one current agent:

```sh
cap agents install --target <codex|claude|cursor> --component all --dry-run --json
cap agents install --target <codex|claude|cursor> --component all --yes --json
```

Use one concrete target in both commands. The installer writes the global Cap skill and merges a local
`cap mcp serve` entry without replacing unrelated agent configuration. Restart the agent after installation
so new sessions load both components. The skill persistently routes Cap tasks through MCP or CLI before
browser automation or computer-use tools, while command details remain authoritative in `cap guide --json`.

OpenCode and other shell-capable agents can use the CLI directly. Follow the agent setup documentation to
merge the documented local MCP entry for clients that support stdio MCP servers.

## The output convention (read this first)

- Pass `--json` (a global flag) to **any** command for machine-readable JSON on **stdout**. A command's
  own `--format json` works too; `--json` is the order-insensitive shortcut (`cap --json targets` and
  `cap targets --json` both work).
- **stdout** is the authoritative result. **stderr** is human-readable logs plus a final
  `error: <message>` line on failure.
- Failures exit **non-zero**. In `--json` mode a final object/event carries an `error` string field, so
  a single `"error" in obj` check detects failure across every command. clap usage/parse errors exit `2`.
- `record` and `export` stream **newline-delimited JSON (NDJSON)** events on stdout.
- Fetch the full machine-readable contract any time with **`cap guide --json`**.

## Authentication

`cap upload` authenticates automatically by **reusing the login Cap Desktop already stored** — if the
user is signed into the desktop app, there is no key to fetch or set. Check with `cap auth status --json`
(`{"authenticated":true,"source":"desktop","server":"…","userId":"…"}`); it never prints the secret.

For headless/CI (or to override), set `CAP_API_KEY` to a Cap auth key from Settings. The target server
is taken from `CAP_SERVER_URL`, else Cap Desktop's configured server, else `https://cap.so`.

## Environment variables

| Variable                    | Used by                             | Notes                                                                                 |
| --------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------- |
| `CAP_API_KEY`               | `upload`                            | Overrides auth with a Cap auth key (Settings). Optional when signed into Cap Desktop. |
| `CAP_SERVER_URL`            | `upload`                            | Cap server base URL. Defaults to Cap Desktop's server, else `https://cap.so`.         |
| `CAP_NO_MODIFY_PATH`        | `desktop install-cli`               | Set to skip editing shell profiles / user PATH.                                       |
| `CAP_DESKTOP_FORCE_INSTALL` | `install-cli.sh`, `install-cli.ps1` | Force the installer script to replace Cap Desktop before linking the CLI.             |

## Typical agent workflow

```sh
cap doctor --json                          # verify permissions & capture readiness (exits 0; read `ok`/`captureReady`)
cap targets --json                         # discover screens/windows/cameras/mics (ids feed the next steps)
cap record start --screen <id> --json --detach  # start in the background -> {"type":"started","recordingId","pid","path"}
# ... the agent performs whatever it needs to capture ...
cap record stop --id <recordingId> --json  # finalize -> {"type":"stopped","path","recordingMetaExists":true}
cap project validate <path.cap> --json     # confirm the recording is complete before exporting
cap export <path.cap> --output out.mp4 --json
cap upload out.mp4 --json                   # -> {"type":"uploaded","id","link"} (auto-auth via Cap Desktop)
```

`cap upload <path.cap> --export --json` will export a project to its default output and upload it in one
step.

## Commands

- `cap record start` / `record stop` / `record status` — record (foreground, or `--detach` for background) and manage sessions.
- `cap export` — render a `.cap` project to mp4/gif/mov. Here `--format` selects the **container**; use `--json` for machine-readable output.
- `cap screenshot` — capture a still of a screen/window (`--json` → `{path,width,height}`).
- `cap targets` (`screens`/`windows`/`cameras`/`mics`) — enumerate capture inputs.
- `cap project inspect` / `validate` / `config get|set` — inspect and edit `.cap` projects.
- `cap recordings list` — list `.cap` recordings in the desktop library.
- `cap upload` — upload a `.cap` project or video file and get a shareable link.
- `cap update` — download and install the latest Cap Desktop bundle, then repair the `cap` shim.
- `cap doctor` / `version` / `guide` — diagnostics, version info, and the agent capability manifest.
- `cap automations list` — list the automation rules configured in Cap Desktop that the CLI honors.
- `cap desktop status|install-cli|uninstall-cli` — manage the `cap` shim on PATH.
- `cap completions <shell>` — shell completion scripts (bash/zsh/fish/powershell).

## Automations

Automations are `trigger → (conditions) → actions` rules authored in Cap Desktop (Settings →
Automations) and persisted to its store. Because the CLI shares that store (and the `cap-automation`
engine), it runs the same rules automatically after `cap screenshot`, a `cap record` finish, and
`cap upload` — e.g. "on screenshot, save a copy to `~/Shots` and POST a webhook". Clipboard, OCR,
notification, and open-editor actions are desktop-only and are skipped on the CLI; everything else
(save, export, upload, run command, webhook, reveal, apply preset, delete) runs. Inspect the active
rules with `cap automations list --json`.

Run `cap --help` or `cap <command> --help` for full flag documentation.
