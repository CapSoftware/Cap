//! Detects sessions that ended without a clean shutdown.
//!
//! A whole class of failures never reaches Sentry's panic hook because the process
//! is killed without panicking: a macOS WindowServer/GPU wedge that soft-restarts the
//! login session, an OOM kill, a force-quit, or power loss. We catch those after the
//! fact: every launch arms a sentinel file with this session's context, and a clean
//! shutdown disarms it. If a launch finds a sentinel left over from a previous run,
//! that run died unexpectedly — report it to Sentry with the captured context.

use std::{
    path::{Path, PathBuf},
    sync::Mutex,
};

use serde::{Deserialize, Serialize};

const SENTINEL_FILE: &str = "session-active.json";

#[derive(Serialize, Deserialize, Clone)]
struct SessionRecord {
    pid: u32,
    started_at: String,
    app_version: String,
    os: String,
    arch: String,
    #[serde(default)]
    liquid_glass: String,
}

struct ActiveSession {
    path: PathBuf,
    #[cfg(target_os = "macos")]
    record: SessionRecord,
}

static SESSION: Mutex<Option<ActiveSession>> = Mutex::new(None);

/// Arm the sentinel for this session and, if a previous session's sentinel survived,
/// report that unexpected termination to Sentry. Call once at startup, after Sentry
/// is initialised.
pub fn init(logs_dir: &Path, app_version: &str) {
    let path = logs_dir.join(SENTINEL_FILE);

    if let Ok(contents) = std::fs::read_to_string(&path) {
        match serde_json::from_str::<SessionRecord>(&contents) {
            // A live process still owns this sentinel — almost certainly a
            // single-instance double launch (this init runs before the
            // single-instance plugin loads), not a crash. Leave it untouched and
            // don't arm a competing sentinel for this about-to-exit instance.
            Ok(prev) if process_is_running(prev.pid) => return,
            Ok(prev) => report_unexpected_termination(&prev),
            Err(error) => {
                tracing::warn!(%error, "Found unreadable crash sentinel from previous session")
            }
        }
        let _ = std::fs::remove_file(&path);
    }

    let os = format!(
        "{} {}",
        tauri_plugin_os::platform(),
        tauri_plugin_os::version()
    );
    let arch = tauri_plugin_os::arch().to_string();

    let record = SessionRecord {
        pid: std::process::id(),
        started_at: chrono::Utc::now().to_rfc3339(),
        app_version: app_version.to_string(),
        os: os.clone(),
        arch: arch.clone(),
        liquid_glass: "unknown".to_string(),
    };

    write_record(&path, &record);

    sentry::configure_scope(|scope| {
        scope.set_tag("os.full", &os);
        scope.set_tag("arch", &arch);
        scope.set_tag("app.version", app_version);
    });

    *SESSION.lock().unwrap() = Some(ActiveSession {
        path,
        #[cfg(target_os = "macos")]
        record,
    });
}

/// Record the result of the macOS Liquid Glass material attempt so that, if this
/// session dies unexpectedly, the next-launch report names which cohort it was in.
/// `outcome` is one of "applied", "fallback", or "unsupported".
#[cfg(target_os = "macos")]
pub fn set_liquid_glass_outcome(outcome: &str) {
    if let Ok(mut guard) = SESSION.lock()
        && let Some(session) = guard.as_mut()
        && session.record.liquid_glass != outcome
    {
        session.record.liquid_glass = outcome.to_string();
        write_record(&session.path, &session.record);
    }

    sentry::configure_scope(|scope| {
        scope.set_tag("macos_liquid_glass", outcome);
    });
}

/// Disarm the sentinel after a fully graceful shutdown. If this is never reached (the
/// process was killed, or shutdown hung past the watchdog) the surviving sentinel is
/// what the next launch reports.
pub fn mark_clean_exit() {
    if let Ok(mut guard) = SESSION.lock()
        && let Some(session) = guard.take()
    {
        let _ = std::fs::remove_file(&session.path);
    }
}

fn report_unexpected_termination(prev: &SessionRecord) {
    tracing::error!(
        prev_pid = prev.pid,
        prev_started_at = %prev.started_at,
        prev_os = %prev.os,
        prev_liquid_glass = %prev.liquid_glass,
        "Previous Cap session terminated without a clean shutdown"
    );

    sentry::with_scope(
        |scope| {
            scope.set_tag("unexpected_termination", "true");
            scope.set_tag("prev.os", &prev.os);
            scope.set_tag("prev.arch", &prev.arch);
            scope.set_tag("prev.app_version", &prev.app_version);
            scope.set_tag("prev.macos_liquid_glass", &prev.liquid_glass);
            scope.set_extra("prev.pid", prev.pid.into());
            scope.set_extra("prev.started_at", prev.started_at.clone().into());
        },
        || {
            sentry::capture_message(
                "Cap session terminated unexpectedly (no clean shutdown)",
                sentry::Level::Error,
            );
        },
    );
}

fn process_is_running(pid: u32) -> bool {
    let pid = sysinfo::Pid::from_u32(pid);
    let mut system = sysinfo::System::new();
    system.refresh_processes(sysinfo::ProcessesToUpdate::Some(&[pid]), true);
    system.process(pid).is_some()
}

fn write_record(path: &Path, record: &SessionRecord) {
    match serde_json::to_string(record) {
        Ok(json) => {
            if let Err(error) = std::fs::write(path, json) {
                tracing::warn!(%error, "Failed to write crash sentinel");
            }
        }
        Err(error) => tracing::warn!(%error, "Failed to serialize crash sentinel"),
    }
}
