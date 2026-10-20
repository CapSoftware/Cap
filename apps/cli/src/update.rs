use std::process::Command;

#[cfg(not(windows))]
use std::process::Output;

use serde::Serialize;

use crate::{OutputFormat, write_json};

#[cfg(target_os = "macos")]
const MACOS_UPDATE_SCRIPT: &str = r#"set -eu
tmp="$(mktemp "${TMPDIR:-/tmp}/cap-update.XXXXXX")"
trap 'rm -f "$tmp"' EXIT HUP INT TERM
curl -fsSL https://cap.so/install-cli.sh -o "$tmp"
CAP_DESKTOP_FORCE_INSTALL=1 sh "$tmp"
"#;

#[cfg(windows)]
const WINDOWS_UPDATE_SCRIPT: &str = r#"$ErrorActionPreference = "Stop"
$parentPid = __CAP_PARENT_PID__
try {
	Wait-Process -Id $parentPid -Timeout 30 -ErrorAction SilentlyContinue
} catch {}
$env:CAP_DESKTOP_FORCE_INSTALL = "1"
irm https://cap.so/install-cli.ps1 | iex
"#;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateReport {
    started: bool,
    completed: bool,
    installer: &'static str,
}

pub fn run(format: OutputFormat) -> Result<(), String> {
    #[cfg(windows)]
    {
        start_windows_update()?;
        match format {
            OutputFormat::Json => write_json(&UpdateReport {
                started: true,
                completed: false,
                installer: installer_url(),
            }),
            OutputFormat::Text => {
                println!("Cap update started. It will continue after this command exits.");
                Ok(())
            }
        }
    }

    #[cfg(not(windows))]
    {
        let output = update_command()?
            .output()
            .map_err(|e| format!("Could not start Cap update installer: {e}"))?;

        if !output.status.success() {
            return Err(update_error(&output));
        }

        match format {
            OutputFormat::Json => write_json(&UpdateReport {
                started: true,
                completed: true,
                installer: installer_url(),
            }),
            OutputFormat::Text => {
                print_output(&output);
                Ok(())
            }
        }
    }
}

#[cfg(target_os = "macos")]
fn update_command() -> Result<Command, String> {
    let mut command = Command::new("sh");
    command.args(["-c", MACOS_UPDATE_SCRIPT]);
    Ok(command)
}

#[cfg(windows)]
fn start_windows_update() -> Result<(), String> {
    let script =
        WINDOWS_UPDATE_SCRIPT.replace("__CAP_PARENT_PID__", &std::process::id().to_string());
    let mut command = Command::new("powershell");
    command.args([
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        &script,
    ]);
    command
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("Could not start Cap update installer: {e}"))
}

#[cfg(not(any(target_os = "macos", windows)))]
fn update_command() -> Result<Command, String> {
    Err("Cap Desktop updates are only supported on macOS and Windows".to_string())
}

#[cfg(target_os = "macos")]
const fn installer_url() -> &'static str {
    "https://cap.so/install-cli.sh"
}

#[cfg(windows)]
const fn installer_url() -> &'static str {
    "https://cap.so/install-cli.ps1"
}

#[cfg(not(any(target_os = "macos", windows)))]
const fn installer_url() -> &'static str {
    ""
}

#[cfg(not(windows))]
fn update_error(output: &Output) -> String {
    let stderr = text(&output.stderr);
    if !stderr.trim().is_empty() {
        return stderr.trim().to_string();
    }

    let stdout = text(&output.stdout);
    if !stdout.trim().is_empty() {
        return stdout.trim().to_string();
    }

    format!("Cap update installer exited with {}", output.status)
}

#[cfg(not(windows))]
fn print_output(output: &Output) {
    let stdout = text(&output.stdout);
    if !stdout.is_empty() {
        print!("{stdout}");
    }

    let stderr = text(&output.stderr);
    if !stderr.is_empty() {
        eprint!("{stderr}");
    }
}

#[cfg(not(windows))]
fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}
