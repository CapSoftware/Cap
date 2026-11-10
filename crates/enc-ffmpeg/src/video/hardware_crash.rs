//! Hardware encoders run their vendor's driver code inside Cap's process, so a
//! fault in one ends the app with nothing to fall back from, and the next
//! recording picks the same encoder and dies again. The host names the
//! encoders that crashed it (every H264 encoder order skips them) and can
//! observe which hardware encoders are live, so a crash can be blamed on one
//! at the next launch.

use std::sync::{OnceLock, PoisonError, RwLock};

static DISABLED: RwLock<Vec<String>> = RwLock::new(Vec::new());
static OBSERVER: OnceLock<fn(&str, bool)> = OnceLock::new();

/// Hardware encoders to skip for the rest of the process, by FFmpeg name.
/// `h264_mf` also covers the direct Media Foundation encoder, which loads the
/// same vendor transforms. Software encoders are never skipped.
pub fn set_disabled_hardware_encoders(names: Vec<String>) {
    *DISABLED.write().unwrap_or_else(PoisonError::into_inner) = names;
}

pub fn hardware_encoder_disabled(name: &str) -> bool {
    DISABLED
        .read()
        .unwrap_or_else(PoisonError::into_inner)
        .iter()
        .any(|disabled| disabled == name)
}

/// Registers a callback told `(name, true)` just before a hardware encoder's
/// driver code runs (the pre-flight self-test included) and `(name, false)`
/// once that encoder is released. Processes that never register get a no-op.
pub fn set_hardware_encoder_observer(observer: fn(&str, bool)) {
    let _ = OBSERVER.set(observer);
}

/// Keeps a hardware encoder reported as live. Owners declare it after the
/// encoder it covers, so it drops after the encoder's own teardown.
pub struct HardwareEncoderSession {
    name: String,
}

impl HardwareEncoderSession {
    pub fn begin(name: &str) -> Self {
        if let Some(observer) = OBSERVER.get() {
            observer(name, true);
        }
        Self {
            name: name.to_owned(),
        }
    }
}

impl Drop for HardwareEncoderSession {
    fn drop(&mut self) {
        if let Some(observer) = OBSERVER.get() {
            observer(&self.name, false);
        }
    }
}
