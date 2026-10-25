//! Breaks the camera background blur crash loop on Windows.
//!
//! A native DirectML, D3D12 or driver fault in the blur pipeline never reaches
//! a panic handler, and the blur setting lives in the project and the camera
//! preview, so without this every launch that opens the camera or the editor
//! repeats the crash. When the previous session died with blur active (see
//! [`crate::crash_capture::UncleanEnd`]), blur stays off until the next app
//! version, which gets one retry. Same rule and store key as the Tauri app's
//! `configure_camera_blur_recovery`, so the two apps agree on one store.

use serde_json::Value;

use crate::crash_capture::{self, UncleanEnd};

const DISABLED_BY_CRASH: &str = "cameraBlurDisabledByCrash";

/// Call once at startup, after [`crash_capture::begin_session`] and before any
/// camera or editor window can start a blur session.
pub fn configure(previous: Option<UncleanEnd>) {
    // Keep the marker in step with live blur processors (camera preview and
    // editor render alike), so a native blur crash is attributable next launch.
    cap_camera_effects::set_blur_session_observer(|active| {
        if active {
            crash_capture::enter_blur_session();
        } else {
            crash_capture::exit_blur_session();
        }
    });

    if !cfg!(target_os = "windows") {
        return;
    }
    let current = env!("CARGO_PKG_VERSION");
    let stored = crate::store::store_section(crate::store::GENERAL_SETTINGS)
        .get(DISABLED_BY_CRASH)
        .and_then(Value::as_str)
        .map(str::to_owned);
    let next = next_disabled_version(stored.as_deref(), previous, current);
    if next != stored {
        let value = next.clone().map_or(Value::Null, Value::String);
        if !crate::store::set_store_setting(
            crate::store::GENERAL_SETTINGS,
            DISABLED_BY_CRASH,
            value,
        ) {
            tracing::warn!("could not save the camera blur crash recovery state");
        }
    }
    match (&next, &stored) {
        (Some(_), None) => {
            cap_camera_effects::set_blur_disabled(true);
            tracing::error!(
                "the previous Cap session died with camera background blur active; blur is off until the next app update"
            );
        }
        (Some(_), Some(_)) => {
            cap_camera_effects::set_blur_disabled(true);
            tracing::warn!("camera background blur stays off after a crash in this app version");
        }
        (None, Some(previous)) => tracing::info!(
            previous_version = %previous,
            "app version changed; camera background blur gets another try"
        ),
        (None, None) => {}
    }
}

/// A fresh death with blur active disables blur at this version, even over an
/// older disable; an existing disable carries over within the same version;
/// an update clears it.
fn next_disabled_version(
    stored: Option<&str>,
    previous: Option<UncleanEnd>,
    current: &str,
) -> Option<String> {
    if previous.is_some_and(|previous| previous.blur_active) {
        return Some(current.to_owned());
    }
    stored
        .filter(|version| *version == current)
        .map(str::to_owned)
}

#[cfg(test)]
mod tests {
    use super::{UncleanEnd, next_disabled_version};

    #[test]
    fn only_a_death_with_blur_disables_it_and_an_update_retries() {
        let with_blur = Some(UncleanEnd { blur_active: true });
        let without_blur = Some(UncleanEnd { blur_active: false });

        assert_eq!(next_disabled_version(None, None, "0.6.2"), None);
        assert_eq!(next_disabled_version(None, without_blur, "0.6.2"), None);
        assert_eq!(
            next_disabled_version(None, with_blur, "0.6.2"),
            Some("0.6.2".into())
        );
        assert_eq!(
            next_disabled_version(Some("0.6.2"), None, "0.6.2"),
            Some("0.6.2".into())
        );
        assert_eq!(next_disabled_version(Some("0.6.2"), None, "0.6.3"), None);
        assert_eq!(
            next_disabled_version(Some("0.6.2"), with_blur, "0.6.3"),
            Some("0.6.3".into())
        );
    }
}
