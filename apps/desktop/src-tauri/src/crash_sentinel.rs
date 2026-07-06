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
    /// True while GPU adapter/device initialisation is in flight. If the process
    /// dies inside that window, the next launch treats the death as a
    /// graphics-init crash (the only case that justifies software-rendering
    /// recovery); a death at any other time says nothing about the GPU.
    #[serde(default)]
    gpu_init_phase: bool,
    /// True when this session was already running in software-graphics recovery
    /// mode, so a follow-up crash doesn't chain into recovery forever.
    #[serde(default)]
    graphics_recovery: bool,
    /// True while any camera-background-blur processor is alive (ONNX/DirectML
    /// session + dedicated GPU work), and for a linger period after the last
    /// one is released — deferred driver/D3D12 faults have been observed
    /// killing the process tens of seconds after blur teardown. Native crashes
    /// in that stack never reach a panic handler; if the process dies inside
    /// this window the next launch attributes the death to blur and disables it.
    #[serde(default)]
    blur_active: bool,
    /// True when this session already ran with blur disabled by crash recovery,
    /// for diagnostics on the next-launch report.
    #[serde(default)]
    blur_recovery: bool,
}

struct ActiveSession {
    path: PathBuf,
    record: SessionRecord,
    gpu_init_depth: u32,
    blur_session_depth: u32,
    /// Bumped on every blur enter/exit so a scheduled linger-disarm can tell
    /// whether blur activity happened after it was scheduled.
    blur_generation: u64,
}

static SESSION: Mutex<Option<ActiveSession>> = Mutex::new(None);

/// How the previous session died, as reconstructed from its surviving sentinel.
/// Only the Windows graphics-recovery path consumes the fields today.
#[derive(Clone, Copy)]
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub struct UnexpectedTermination {
    /// The process died while GPU adapter/device initialisation was in flight.
    pub during_gpu_init: bool,
    /// The session was already running in software-graphics recovery mode.
    pub in_graphics_recovery: bool,
    /// The process died while a camera-background-blur processor was alive.
    pub blur_active: bool,
}

/// Arm the sentinel for this session and, if a previous session's sentinel survived,
/// report that unexpected termination to Sentry. Call once at startup, after Sentry
/// is initialised. Returns details of the previous session's unexpected termination,
/// or `None` if the previous session shut down cleanly.
pub fn init(logs_dir: &Path, app_version: &str) -> Option<UnexpectedTermination> {
    let path = logs_dir.join(SENTINEL_FILE);
    let mut previous_termination = None;

    if let Ok(contents) = std::fs::read_to_string(&path) {
        match serde_json::from_str::<SessionRecord>(&contents) {
            // A live process still owns this sentinel — almost certainly a
            // single-instance double launch (this init runs before the
            // single-instance plugin loads), not a crash. Leave it untouched and
            // don't arm a competing sentinel for this about-to-exit instance.
            Ok(prev) if process_is_running(prev.pid) => return None,
            Ok(prev) => {
                report_unexpected_termination(&prev);
                previous_termination = Some(UnexpectedTermination {
                    during_gpu_init: prev.gpu_init_phase,
                    in_graphics_recovery: prev.graphics_recovery,
                    blur_active: prev.blur_active,
                });
            }
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
        gpu_init_phase: false,
        graphics_recovery: false,
        blur_active: false,
        blur_recovery: false,
    };

    write_record(&path, &record);

    sentry::configure_scope(|scope| {
        scope.set_tag("os.full", &os);
        scope.set_tag("arch", &arch);
        scope.set_tag("app.version", app_version);
    });

    *SESSION.lock().unwrap() = Some(ActiveSession {
        path,
        record,
        gpu_init_depth: 0,
        blur_session_depth: 0,
        blur_generation: 0,
    });

    previous_termination
}

/// Arm the GPU-init marker while adapter/device initialisation runs. If the process
/// dies inside this window the next launch sees `during_gpu_init` and can engage
/// graphics recovery. Nestable; the marker persists until the last exit call.
pub fn enter_gpu_init_phase() {
    if let Ok(mut guard) = SESSION.lock()
        && let Some(session) = guard.as_mut()
    {
        session.gpu_init_depth += 1;
        if !session.record.gpu_init_phase {
            session.record.gpu_init_phase = true;
            write_record(&session.path, &session.record);
        }
    }
}

/// Disarm the GPU-init marker once initialisation finished (successfully or not —
/// a survivable failure is not a crash).
pub fn exit_gpu_init_phase() {
    if let Ok(mut guard) = SESSION.lock()
        && let Some(session) = guard.as_mut()
    {
        session.gpu_init_depth = session.gpu_init_depth.saturating_sub(1);
        if session.gpu_init_depth == 0 && session.record.gpu_init_phase {
            session.record.gpu_init_phase = false;
            write_record(&session.path, &session.record);
        }
    }
}

/// How long `blur_active` stays armed after the last blur processor is
/// released. Deferred D3D12/DML/driver faults have been observed killing the
/// process up to ~50s after blur teardown finished (the fault surfaces
/// asynchronously); disarming immediately would miss exactly those deaths and
/// leave the crash loop unbroken.
const BLUR_DISARM_LINGER: std::time::Duration = std::time::Duration::from_secs(120);

/// Arm the blur marker while a camera-background-blur processor is alive. If the
/// process dies inside this window the next launch sees `blur_active` and can
/// disable blur. Nestable (editor render + camera preview can overlap); the
/// marker persists until a linger period after the last exit call.
pub fn enter_blur_session() {
    if let Ok(mut guard) = SESSION.lock()
        && let Some(session) = guard.as_mut()
    {
        session.blur_session_depth += 1;
        session.blur_generation = session.blur_generation.wrapping_add(1);
        if !session.record.blur_active {
            session.record.blur_active = true;
            write_record(&session.path, &session.record);
        }
    }
}

/// Schedule the blur marker to disarm once the linger window passes with no new
/// blur session. The generation check makes a stale disarm from an earlier
/// exit a no-op if blur was re-armed in the meantime.
pub fn exit_blur_session() {
    let scheduled_generation = {
        let Ok(mut guard) = SESSION.lock() else {
            return;
        };
        let Some(session) = guard.as_mut() else {
            return;
        };
        session.blur_session_depth = session.blur_session_depth.saturating_sub(1);
        session.blur_generation = session.blur_generation.wrapping_add(1);
        if session.blur_session_depth != 0 || !session.record.blur_active {
            return;
        }
        session.blur_generation
    };

    std::thread::spawn(move || {
        std::thread::sleep(BLUR_DISARM_LINGER);
        if let Ok(mut guard) = SESSION.lock()
            && let Some(session) = guard.as_mut()
            && session.blur_generation == scheduled_generation
            && session.blur_session_depth == 0
            && session.record.blur_active
        {
            session.record.blur_active = false;
            write_record(&session.path, &session.record);
        }
    });
}

/// Record that this session is running with camera background blur disabled by
/// crash recovery, for diagnostics on a follow-up unexpected-termination report.
pub fn mark_blur_recovery() {
    if let Ok(mut guard) = SESSION.lock()
        && let Some(session) = guard.as_mut()
        && !session.record.blur_recovery
    {
        session.record.blur_recovery = true;
        write_record(&session.path, &session.record);
    }

    sentry::configure_scope(|scope| {
        scope.set_tag("camera_blur_recovery", "true");
    });
}

/// Record that this session is running in software-graphics recovery mode, so an
/// unexpected termination of *this* session doesn't chain into recovery again.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub fn mark_graphics_recovery() {
    if let Ok(mut guard) = SESSION.lock()
        && let Some(session) = guard.as_mut()
        && !session.record.graphics_recovery
    {
        session.record.graphics_recovery = true;
        write_record(&session.path, &session.record);
    }

    sentry::configure_scope(|scope| {
        scope.set_tag("graphics_recovery", "true");
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
        prev_gpu_init_phase = prev.gpu_init_phase,
        prev_graphics_recovery = prev.graphics_recovery,
        prev_blur_active = prev.blur_active,
        prev_blur_recovery = prev.blur_recovery,
        "Previous Cap session terminated without a clean shutdown"
    );

    sentry::with_scope(
        |scope| {
            scope.set_tag("unexpected_termination", "true");
            scope.set_tag("prev.os", &prev.os);
            scope.set_tag("prev.arch", &prev.arch);
            scope.set_tag("prev.app_version", &prev.app_version);
            scope.set_tag("prev.macos_liquid_glass", &prev.liquid_glass);
            scope.set_tag("prev.gpu_init_phase", prev.gpu_init_phase.to_string());
            scope.set_tag("prev.graphics_recovery", prev.graphics_recovery.to_string());
            scope.set_tag("prev.blur_active", prev.blur_active.to_string());
            scope.set_tag("prev.blur_recovery", prev.blur_recovery.to_string());
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
