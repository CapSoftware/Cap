//! Whether this computer is too slow for live local captions.
//!
//! Measured: a Mac without Apple silicon runs Whisper (no Parakeet), and
//! Whisper small's finals fall minutes behind there; Windows and Linux with
//! 2 cores and a call app open show a handful of captions a minute. A
//! 3-core Apple silicon Mac keeps up, so Apple silicon is never slow by this
//! rule.

use std::sync::OnceLock;

/// `1` treats this computer as too slow (as the slow kind it would be),
/// `intel` or `cores` as that kind, `0` as capable (screenshots and tests on
/// any machine).
pub const SLOW_ENV: &str = "CAP_GPUI_MEETING_SLOW_DEVICE";

/// Below this many logical cores, Windows and Linux are too slow.
const MIN_CORES: usize = 4;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Os {
    MacOS,
    Windows,
    Linux,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Class {
    Capable,
    /// A Mac without Apple silicon.
    IntelMac,
    /// Windows or Linux with fewer than 4 logical cores.
    FewCores,
}

/// The rule: every Mac without Apple silicon (`intel`), and Windows or
/// Linux with fewer than 4 logical cores. An unknown core count is capable.
pub fn class_for(os: Os, intel: bool, cores: Option<usize>) -> Class {
    match os {
        Os::MacOS if intel => Class::IntelMac,
        Os::MacOS => Class::Capable,
        Os::Windows | Os::Linux if cores.is_some_and(|cores| cores < MIN_CORES) => Class::FewCores,
        Os::Windows | Os::Linux => Class::Capable,
    }
}

/// The override: `native` is the slow kind this computer would be.
fn from_env(value: Option<&str>, native: Class) -> Option<Class> {
    match value?.trim() {
        "1" | "true" => Some(native),
        "intel" => Some(Class::IntelMac),
        "cores" => Some(Class::FewCores),
        "0" | "false" => Some(Class::Capable),
        _ => None,
    }
}

/// This computer, worked out once. Tests see a capable computer unless
/// they say otherwise (`TEST_CLASS`), whatever runner they are on.
pub fn class() -> Class {
    #[cfg(test)]
    {
        TEST_CLASS.with(std::cell::Cell::get)
    }
    #[cfg(not(test))]
    {
        detected_class()
    }
}

pub fn slow() -> bool {
    class() != Class::Capable
}

#[cfg(test)]
thread_local! {
    pub static TEST_CLASS: std::cell::Cell<Class> = const { std::cell::Cell::new(Class::Capable) };
}

#[cfg_attr(test, allow(dead_code))]
pub(crate) fn detected_class() -> Class {
    static CLASS: OnceLock<Class> = OnceLock::new();
    *CLASS.get_or_init(|| {
        // The chip, not whether Parakeet runs: an Apple silicon Mac whose macOS
        // cannot load ONNX Runtime is still fast.
        let intel = !crate::transcription::parakeet_built();
        let native = if intel {
            Class::IntelMac
        } else {
            Class::FewCores
        };
        if let Some(class) = from_env(std::env::var(SLOW_ENV).ok().as_deref(), native) {
            return class;
        }
        let os = if cfg!(target_os = "macos") {
            Os::MacOS
        } else if cfg!(windows) {
            Os::Windows
        } else {
            Os::Linux
        };
        let cores = std::thread::available_parallelism().ok().map(|n| n.get());
        class_for(os, intel, cores)
    })
}

/// This computer as the app sees it, outside tests too (the harness).
#[cfg_attr(test, allow(dead_code))]
pub(crate) fn detected() -> bool {
    detected_class() != Class::Capable
}

#[cfg(test)]
mod tests;
