//! New-instance-wins single instancing.
//!
//! The app lives in the tray: closing the main window hides it, the process
//! stays. Without a guard, a `cargo run` after an edit launches a second
//! instance next to the stale one, and the tray icon and level-100 window the
//! user is looking at may still belong to the *old* build -- which reads as
//! "my change only applied on the second run". The Tauri app's single-instance
//! plugin keeps the old instance and exits the new one; for a parallel
//! implementation that is mostly launched to see fresh code, the useful
//! polarity is the reverse: the new instance terminates the old one and takes
//! over. A capture killed this way lands in the bundle's `InProgress` /
//! `NeedsRemux` recovery path rather than being lost.
//!
//! The pidfile lives in [`crate::store::app_data_dir`], so a harness run
//! pointed at a `CAP_GPUI_APP_DATA_DIR` sandbox never kills the dev app.

use std::path::PathBuf;

fn pidfile() -> PathBuf {
    crate::store::app_data_dir().join("cap-gpui.pid")
}

pub fn acquire() {
    let path = pidfile();
    #[cfg(unix)]
    if let Ok(raw) = std::fs::read_to_string(&path)
        && let Ok(pid) = raw.trim().parse::<i32>()
        && pid > 0
        && pid != std::process::id() as i32
        && is_cap_gpui(pid)
    {
        tracing::info!(pid, "terminating the previous instance");
        unsafe {
            libc::kill(pid, libc::SIGTERM);
        }
        for _ in 0..40 {
            if unsafe { libc::kill(pid, 0) } != 0 {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        if unsafe { libc::kill(pid, 0) } == 0 {
            tracing::warn!(pid, "previous instance ignored SIGTERM; killing it");
            unsafe {
                libc::kill(pid, libc::SIGKILL);
            }
        }
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).ok();
    }
    if let Err(error) = std::fs::write(&path, std::process::id().to_string()) {
        tracing::warn!(%error, "could not write the instance pidfile");
    }
}

/// Guard against pid reuse: only ever signal a process that is actually this
/// binary. `comm` is the executable path on macOS and the (15-char) image
/// name on Linux; `cap-gpui` fits both.
#[cfg(unix)]
fn is_cap_gpui(pid: i32) -> bool {
    if unsafe { libc::kill(pid, 0) } != 0 {
        return false;
    }
    std::process::Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "comm="])
        .output()
        .is_ok_and(|output| String::from_utf8_lossy(&output.stdout).contains("cap-gpui"))
}
