//! Whether this computer is too slow for live local captions.
//!
//! Measured: a Mac without Apple silicon runs Whisper small (no Parakeet),
//! and its finals fall minutes behind; Windows and Linux with 2 cores and a
//! call app open show a handful of captions a minute. A 3-core Apple
//! silicon Mac keeps up, so Apple silicon is never slow by this rule.

use std::sync::OnceLock;

/// `1` treats this computer as too slow, `0` as capable (screenshots and
/// tests on any machine).
pub const SLOW_ENV: &str = "CAP_GPUI_MEETING_SLOW_DEVICE";

/// Below this many logical cores, Windows and Linux are too slow.
const MIN_CORES: usize = 4;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Os {
    MacOS,
    Windows,
    Linux,
}

/// The rule: every Mac without Apple silicon (`intel`), and Windows or
/// Linux with fewer than 4 logical cores. An unknown core count is capable.
pub fn too_slow(os: Os, intel: bool, cores: Option<usize>) -> bool {
    match os {
        Os::MacOS => intel,
        Os::Windows | Os::Linux => cores.is_some_and(|cores| cores < MIN_CORES),
    }
}

fn from_env(value: Option<&str>) -> Option<bool> {
    match value?.trim() {
        "1" | "true" => Some(true),
        "0" | "false" => Some(false),
        _ => None,
    }
}

/// This computer, worked out once. Tests see a capable computer unless
/// they say otherwise (`TEST_SLOW`), whatever runner they are on.
pub fn slow() -> bool {
    #[cfg(test)]
    {
        TEST_SLOW.with(std::cell::Cell::get)
    }
    #[cfg(not(test))]
    {
        detected()
    }
}

#[cfg(test)]
thread_local! {
    pub static TEST_SLOW: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

#[cfg_attr(test, allow(dead_code))]
pub(crate) fn detected() -> bool {
    static SLOW: OnceLock<bool> = OnceLock::new();
    *SLOW.get_or_init(|| {
        if let Some(slow) = from_env(std::env::var(SLOW_ENV).ok().as_deref()) {
            return slow;
        }
        let os = if cfg!(target_os = "macos") {
            Os::MacOS
        } else if cfg!(windows) {
            Os::Windows
        } else {
            Os::Linux
        };
        let cores = std::thread::available_parallelism().ok().map(|n| n.get());
        too_slow(os, !crate::transcription::supports_parakeet(), cores)
    })
}

#[cfg(test)]
mod tests;
