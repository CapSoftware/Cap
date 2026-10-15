//! Diagnostic event log (scratch branch only): one line per event, host
//! time first, appended to `$CAP_DIAG_DIR/recording.log`.

use std::{fs::File, io::Write, sync::Mutex, sync::OnceLock};

use cap_timestamp::Timestamp;

static FILE: OnceLock<Option<Mutex<File>>> = OnceLock::new();

pub fn line(args: std::fmt::Arguments) {
    let file = FILE.get_or_init(|| {
        let dir = std::env::var_os("CAP_DIAG_DIR")?;
        std::fs::create_dir_all(&dir).ok()?;
        File::options()
            .create(true)
            .append(true)
            .open(std::path::Path::new(&dir).join("recording.log"))
            .ok()
            .map(Mutex::new)
    });
    if let Some(file) = file
        && let Ok(mut f) = file.lock()
    {
        #[cfg(target_os = "macos")]
        let now = cidre::mach::abs_time();
        #[cfg(not(target_os = "macos"))]
        let now = 0u64;
        let _ = writeln!(f, "{now} {args}");
    }
}

/// Mach host nanoseconds of a timestamp (-1 when not a host time).
pub fn ts_ns(timestamp: &Timestamp) -> i128 {
    match timestamp {
        #[cfg(target_os = "macos")]
        Timestamp::MachAbsoluteTime(m) => m
            .duration_since(cap_timestamp::MachAbsoluteTimestamp::new(0))
            .as_nanos() as i128,
        _ => -1,
    }
}

#[macro_export]
macro_rules! diag {
    ($($t:tt)*) => { $crate::diag::line(format_args!($($t)*)) };
}
