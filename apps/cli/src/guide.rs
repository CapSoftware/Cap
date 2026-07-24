use serde::Serialize;

use crate::{OutputFormat, write_json};

const GUIDE_SCHEMA_VERSION: u32 = 3;

/// Machine-readable capability + schema manifest. `cap guide --json` is the single document an agent
/// can fetch to learn the output convention, env vars, exit codes, and the per-command output shape
/// without reverse-engineering each command by running it. `schemaVersion` versions this contract.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Guide {
    schema_version: u32,
    binary: &'static str,
    version: &'static str,
    description: &'static str,
    output_convention: OutputConvention,
    env: Vec<EnvVar>,
    exit_codes: Vec<ExitCode>,
    commands: Vec<CommandDoc>,
    notes: Vec<&'static str>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OutputConvention {
    json_flag: &'static str,
    stdout: &'static str,
    stderr: &'static str,
    errors: &'static str,
    streaming: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EnvVar {
    name: &'static str,
    required: bool,
    used_by: &'static str,
    description: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ExitCode {
    code: i32,
    meaning: &'static str,
}

#[derive(Serialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
enum OutputMode {
    /// A single JSON object on stdout when `--json`/`--format json` is set.
    SingleJson,
    /// Newline-delimited JSON events streamed to stdout.
    Ndjson,
    /// Always emits a single JSON object (no text mode).
    AlwaysJson,
    /// Human text only; no JSON form.
    TextOnly,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CommandDoc {
    command: &'static str,
    summary: &'static str,
    output_mode: OutputMode,
    /// For NDJSON streams: the set of `type` tag values emitted.
    #[serde(skip_serializing_if = "<[_]>::is_empty")]
    event_tags: &'static [&'static str],
    requires_tty: bool,
    requires_duration: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    notes: Option<&'static str>,
}

const fn cmd(
    command: &'static str,
    summary: &'static str,
    output_mode: OutputMode,
    event_tags: &'static [&'static str],
) -> CommandDoc {
    CommandDoc {
        command,
        summary,
        output_mode,
        event_tags,
        requires_tty: false,
        requires_duration: false,
        notes: None,
    }
}

fn build() -> Guide {
    Guide {
        schema_version: GUIDE_SCHEMA_VERSION,
        binary: env!("CARGO_PKG_NAME"),
        version: env!("CARGO_PKG_VERSION"),
        description: "Cap screen recording, driven from the command line. Add --json to any command \
                      for machine-readable output.",
        output_convention: OutputConvention {
            json_flag: "--json (global) or a command's --format json",
            stdout: "Authoritative result. JSON when --json/--format json is set.",
            stderr: "Human-readable logs and the final `error: <message>` line on failure.",
            errors: "Failures exit non-zero. In JSON mode a final object/event carries an \"error\" \
                     string field. clap usage/parse errors exit 2.",
            streaming: "record and export emit newline-delimited JSON (NDJSON) events on stdout.",
        },
        env: vec![
            EnvVar {
                name: "CAP_API_KEY",
                required: false,
                used_by: "upload",
                description: "Overrides auth for upload (Cap auth key from Settings). Optional when signed into Cap Desktop, which the CLI reuses automatically.",
            },
            EnvVar {
                name: "CAP_SERVER_URL",
                required: false,
                used_by: "upload, auth login, caps, mcp",
                description: "Cap server base URL. Defaults to https://cap.so.",
            },
            EnvVar {
                name: "CAP_AGENT_TOKEN",
                required: false,
                used_by: "caps, mcp",
                description: "Overrides the OS-stored Cap agent credential for headless use.",
            },
            EnvVar {
                name: "CAP_NO_MODIFY_PATH",
                required: false,
                used_by: "desktop install-cli",
                description: "Set to skip editing shell profiles / user PATH during install.",
            },
            EnvVar {
                name: "CAP_DESKTOP_FORCE_INSTALL",
                required: false,
                used_by: "install-cli.sh, install-cli.ps1, update",
                description: "Force the installer scripts to replace Cap Desktop before linking the CLI.",
            },
        ],
        exit_codes: vec![
            ExitCode {
                code: 0,
                meaning: "Success, or a diagnostic/report ran (inspect `ok`/`valid`/`captureReady`).",
            },
            ExitCode {
                code: 1,
                meaning: "Runtime failure. See the JSON `error` field or the stderr `error:` line.",
            },
            ExitCode {
                code: 2,
                meaning: "Usage / argument parse error (from clap).",
            },
        ],
        commands: vec![
            cmd(
                "doctor",
                "Environment + capture-readiness diagnostics. Exits 0 even when checks fail; branch on `ok`/`captureReady`.",
                OutputMode::SingleJson,
                &[],
            ),
            cmd(
                "targets",
                "List screens/windows/cameras/mics. `id` (screen/window), `deviceId` (camera) and `name` (mic) feed back into record/screenshot.",
                OutputMode::SingleJson,
                &[],
            ),
            CommandDoc {
                requires_duration: false,
                notes: Some(
                    "The `started` then `stopped` sequence applies to the foreground run. With `--detach` the stream emits only `started` (or `error`) and returns immediately with recordingId+pid; the `stopped` event is delivered by `cap record stop`.",
                ),
                ..cmd(
                    "record start",
                    "Start a recording. Foreground emits `started` then `stopped` (success requires recordingMetaExists:true); see notes for `--detach`.",
                    OutputMode::Ndjson,
                    &["started", "stopped", "error"],
                )
            },
            cmd(
                "record stop",
                "Finalize a detached recording by recordingId (or --path).",
                OutputMode::Ndjson,
                &["stopped", "error"],
            ),
            cmd(
                "record status",
                "List active detached recording sessions.",
                OutputMode::SingleJson,
                &[],
            ),
            CommandDoc {
                notes: Some(
                    "EXCEPTION: export NDJSON uses PascalCase `type` tags and snake_case fields \
                     (rendered_count, total_frames) for desktop compatibility. --format selects the \
                     CONTAINER (mp4/gif/mov), NOT output mode; use --json for machine-readable output.",
                ),
                ..cmd(
                    "export",
                    "Render a .cap project to a video file.",
                    OutputMode::Ndjson,
                    &["Progress", "Completed", "Error"],
                )
            },
            cmd(
                "screenshot",
                "Capture a still of a screen/window. JSON emits {path,width,height}.",
                OutputMode::SingleJson,
                &[],
            ),
            cmd(
                "upload",
                "Upload a .cap project or video file; returns a shareable link. Authenticates via Cap Desktop's login or CAP_API_KEY.",
                OutputMode::SingleJson,
                &[],
            ),
            cmd(
                "update",
                "Download and install the latest Cap Desktop bundle, then repair the `cap` shim.",
                OutputMode::SingleJson,
                &[],
            ),
            cmd(
                "auth status",
                "Report credential presence and verify Cap CLI agent credentials with the configured server.",
                OutputMode::SingleJson,
                &[],
            ),
            cmd(
                "auth login|logout",
                "Authorize with browser approval and PKCE, or revoke the OS-stored Cap agent credential.",
                OutputMode::SingleJson,
                &[],
            ),
            cmd(
                "caps list|get|context|status",
                "Read the authenticated Cap library. `get` is lightweight; `context` includes content and activity.",
                OutputMode::SingleJson,
                &[],
            ),
            cmd(
                "caps wait",
                "Wait for existing transcript or AI processing with backoff. Never starts processing.",
                OutputMode::SingleJson,
                &[],
            ),
            cmd(
                "caps transcript|download",
                "Stream a transcript or video to a temporary file and atomically rename it to --output.",
                OutputMode::SingleJson,
                &[],
            ),
            cmd(
                "caps process|transcript-replace",
                "Explicitly start owner-authorized processing or replace a transcript with optimistic revision checking.",
                OutputMode::SingleJson,
                &[],
            ),
            cmd(
                "caps import loom",
                "Start a durable Loom import. Optional owner and space assignment provide a retry-safe per-row primitive for migration batches.",
                OutputMode::SingleJson,
                &[],
            ),
            cmd(
                "caps duplicate|delete|password",
                "Run confirmed Cap lifecycle operations or securely set and clear Cap passwords. Duplicate and delete can be observed with jobs wait.",
                OutputMode::SingleJson,
                &[],
            ),
            cmd(
                "caps unlock",
                "Securely unlock a password-protected Cap with an interactive prompt or --password-stdin; stores only a short-lived access grant.",
                OutputMode::SingleJson,
                &[],
            ),
            cmd(
                "caps comments|reactions|update|sharing",
                "Create idempotent feedback or change an owner Cap title or visibility. Capabilities remain server-enforced.",
                OutputMode::SingleJson,
                &[],
            ),
            cmd(
                "account get|update|image|referrals|sign-out-all",
                "Read and manage the authenticated Cap profile, image, default organization, referral provider handoff, and active sessions. Image files and global sign-out require confirmed CLI commands.",
                OutputMode::SingleJson,
                &[],
            ),
            cmd(
                "organizations list|get|members|invites",
                "Inspect organizations, membership, invitations, billing state, and storage integrations.",
                OutputMode::SingleJson,
                &[],
            ),
            cmd(
                "organizations create|update|icon|shareable-icon|settings|invite|member|domain|delete",
                "Manage organization lifecycle, branding, preferences, email-delivered or link-only invitations, roles, membership, Pro seats, custom domains, and durable deletion jobs.",
                OutputMode::SingleJson,
                &[],
            ),
            cmd(
                "organizations billing get|checkout|portal",
                "Inspect billing or create a confirmed browser handoff for Cap Pro checkout and the billing portal.",
                OutputMode::SingleJson,
                &[],
            ),
            cmd(
                "organizations storage list|s3|provider|google-drive",
                "Inspect and manage S3 or Google Drive storage. S3 credentials are accepted only by secure CLI input; Google OAuth uses a browser handoff.",
                OutputMode::SingleJson,
                &[],
            ),
            cmd(
                "library folders|spaces",
                "List and manage folders, spaces, public collection pages and logos, sharing locations, and space membership.",
                OutputMode::SingleJson,
                &[],
            ),
            cmd(
                "notifications list|preferences|read",
                "Read notifications, update notification preferences, or mark notifications read.",
                OutputMode::SingleJson,
                &[],
            ),
            cmd(
                "analytics get",
                "Read organization, space, or Cap analytics for a bounded time range.",
                OutputMode::SingleJson,
                &[],
            ),
            cmd(
                "developers list|get|create|update|delete|domains|keys|auto-top-up|credits|videos|transactions",
                "Manage developer apps, SDK videos, credit history, domains, credentials, auto top-up, and credit checkout. New credentials are returned only by confirmed CLI commands.",
                OutputMode::SingleJson,
                &[],
            ),
            cmd(
                "jobs get|wait",
                "Inspect or wait for asynchronous Cap operations without starting new work.",
                OutputMode::SingleJson,
                &[],
            ),
            cmd(
                "mcp serve",
                "Run the local stdio MCP server. Stdout is reserved exclusively for protocol traffic.",
                OutputMode::TextOnly,
                &[],
            ),
            cmd(
                "agents install",
                "Preview and install the Cap skill, MCP configuration, or both for one explicit agent target.",
                OutputMode::SingleJson,
                &[],
            ),
            cmd(
                "recordings list",
                "List .cap recordings in the desktop library (or --dir).",
                OutputMode::SingleJson,
                &[],
            ),
            cmd(
                "project inspect",
                "Print project metadata + editor config. `meta` is RecordingMeta (snake_case passthrough).",
                OutputMode::SingleJson,
                &[],
            ),
            cmd(
                "project validate",
                "Verify a project's metadata + media files exist. Exits non-zero when invalid.",
                OutputMode::AlwaysJson,
                &[],
            ),
            cmd(
                "project config get|set",
                "Read/replace a project's editor configuration (project-config.json).",
                OutputMode::SingleJson,
                &[],
            ),
            cmd(
                "version",
                "CLI version + execution context (distribution, bundled binaries).",
                OutputMode::SingleJson,
                &[],
            ),
            cmd(
                "desktop status|install-cli|uninstall-cli",
                "Inspect or manage the `cap` shim on PATH.",
                OutputMode::SingleJson,
                &[],
            ),
            cmd(
                "automations list",
                "List the automation rules configured in Cap Desktop (Settings > Automations) that the CLI honors after screenshot/record/upload.",
                OutputMode::SingleJson,
                &[],
            ),
            cmd(
                "completions",
                "Print a shell completion script for bash/zsh/fish/powershell.",
                OutputMode::TextOnly,
                &[],
            ),
        ],
        notes: vec![
            "Wrapper JSON keys are camelCase. Shapes shared with the desktop (RecordingMeta, \
             ProjectConfiguration, export NDJSON) preserve their original field casing.",
            "`cap completions <shell>` prints a shell completion script.",
            "Recording without --duration requires either --detach or an interactive terminal.",
            "Automations authored in Cap Desktop run automatically after `cap screenshot`, `cap record` \
             finishes, and `cap upload`. Clipboard/OCR/notification/editor actions are desktop-only and \
             are skipped on the CLI. List them with `cap automations list`.",
            "Cap library reads and waits never start transcription, AI generation, or other paid processing.",
            "MCP never accepts passwords, S3 credentials, image files, or newly issued developer credentials. Use confirmed secure CLI commands for those values.",
        ],
    }
}

pub fn run(format: OutputFormat) -> Result<(), String> {
    let guide = build();
    match format {
        OutputFormat::Json => write_json(&guide),
        OutputFormat::Text => {
            println!(
                "{} {} — agent capability manifest",
                guide.binary, guide.version
            );
            println!("\n{}", guide.description);
            println!("\nOutput: {}", guide.output_convention.stdout);
            println!("Errors: {}", guide.output_convention.errors);
            println!("\nEnvironment:");
            for env in &guide.env {
                let req = if env.required { "required" } else { "optional" };
                println!(
                    "  {} ({req}, {}): {}",
                    env.name, env.used_by, env.description
                );
            }
            println!("\nCommands:");
            for command in &guide.commands {
                println!("  {} — {}", command.command, command.summary);
            }
            println!("\nRun `cap guide --json` for the full machine-readable manifest.");
            Ok(())
        }
    }
}
