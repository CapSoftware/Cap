//! Recording and upload errors stay English where they are made: they are
//! logged, matched to classify failures and saved with the upload state.
//! `localize` translates the ones Cap writes itself where they are shown.
//! Text it does not know, such as an engine error, passes through unchanged.

use super::tr;
use crate::permissions::OSPermission;

#[cfg(test)]
pub(super) const KEY_PREFIX: &str = "message.";

const EXACT: &[(&str, fn() -> &'static str)] = &[
    ("Recording task failed.", tr::message::recording::task_failed),
    ("Recording startup failed", tr::message::recording::startup_failed),
    ("Recording ended unexpectedly.", tr::message::recording::ended_unexpectedly),
    ("Stop task failed.", tr::message::recording::stop_task_failed_plain),
    ("Capture stop was not acknowledged", tr::message::recording::stop_not_acknowledged),
    ("Timed out confirming capture state", tr::message::recording::capture_state_timed_out),
    (
        "Capture did not acknowledge the requested pause state",
        tr::message::recording::pause_not_acknowledged,
    ),
    (
        "Capture cleanup is unconfirmed. Local files are preserved; use Ctrl+Shift+F9 to retry Stop.",
        tr::message::recording::cleanup_unconfirmed_files_kept,
    ),
    (
        "Capture cleanup is unconfirmed; retry Stop.",
        tr::message::recording::cleanup_unconfirmed_retry,
    ),
    (
        "Studio discard stop was not acknowledged; local recording retained",
        tr::message::recording::discard_not_acknowledged,
    ),
    (
        "The window is still being resized. Try starting again.",
        tr::message::recording::window_still_resizing,
    ),
    (
        "Recording startup cancelled; local files preserved",
        tr::message::recording::startup_cancelled,
    ),
    (
        "Instant capture cleanup is unconfirmed; local files preserved",
        tr::message::recording::instant_cleanup_unconfirmed,
    ),
    (
        "Recording finalization ended without a result. Your files were retained.",
        tr::message::recording::finalization_no_result,
    ),
    (
        "Capture stopped, but stopped metadata could not be saved; local files preserved",
        tr::message::recording::stopped_metadata_unsaved,
    ),
    (
        "Studio discard stop is unconfirmed; local files preserved",
        tr::message::recording::discard_stop_unconfirmed,
    ),
    (
        "Studio discard is unconfirmed; local files preserved",
        tr::message::recording::discard_unconfirmed,
    ),
    (
        "Cap closed before this recording captured anything.",
        tr::message::recording::crashed_before_capture,
    ),
    ("offline", tr::message::upload::offline),
    ("Authentication expired", tr::message::upload::authentication_expired),
    (
        "This older recording has no saved audio intent; review it before retrying",
        tr::message::upload::no_audio_intent_review,
    ),
    (
        "This older upload has no saved account and audio intent. Its local recording is preserved.",
        tr::message::upload::legacy_no_account,
    ),
    (
        "Cloud verification timed out; the local recording is preserved",
        tr::message::upload::verification_timed_out,
    ),
    (
        "Cloud verification failed; the saved recording will upload again",
        tr::message::upload::verification_failed_retry,
    ),
    (
        "Recording must be saved locally before its upload can resume",
        tr::message::upload::must_save_first,
    ),
    (
        "Sign in to the original recording account and server to retry",
        tr::message::upload::sign_in_original,
    ),
    ("Sign in again to upload this recording", tr::message::upload::sign_in_again),
    ("Instant recording requires an upgraded plan", tr::message::upload::needs_upgrade),
    ("The local recording changed during upload", tr::message::upload::changed_during),
    (
        "The local recording changed after upload; it has been preserved",
        tr::message::upload::changed_after,
    ),
    ("This recording is already queued for upload", tr::message::upload::already_queued),
    ("Upload paused; the local recording is preserved", tr::message::upload::paused),
    (
        "The upload worker failed; the local recording is preserved",
        tr::message::upload::worker_failed,
    ),
    ("The saved recording is empty", tr::message::upload::empty),
    (
        "This recording has no resumable upload state",
        tr::message::upload::no_resumable_state,
    ),
];

/// `prefix{inner}suffix`. `nested` translates the inner part too, for an
/// inner part that is itself one of these messages.
struct Wrapped {
    prefix: &'static str,
    suffix: &'static str,
    nested: bool,
    translate: fn(String) -> String,
}

const WRAPPED: &[Wrapped] = &[
    Wrapped {
        prefix: "",
        suffix: ". Capture cleanup is unconfirmed. Use Ctrl+Shift+F9 to retry Stop.",
        nested: true,
        translate: |error| tr::message::recording::then_cleanup_unconfirmed_shortcut(error),
    },
    Wrapped {
        prefix: "",
        suffix: ". Capture cleanup is unconfirmed. Use your recording Stop control to retry.",
        nested: true,
        translate: |error| tr::message::recording::then_cleanup_unconfirmed_control(error),
    },
    Wrapped {
        prefix: "",
        suffix: ". Studio shutdown remains unconfirmed; recording and files retained.",
        nested: true,
        translate: |error| tr::message::recording::then_shutdown_unconfirmed(error),
    },
    Wrapped {
        prefix: "",
        suffix: ". Use Stop if recording cannot continue safely.",
        nested: true,
        translate: |error| tr::message::recording::then_use_stop_if_unsafe(error),
    },
    Wrapped {
        prefix: "",
        suffix: ". Use your recording Stop control to stop recording.",
        nested: true,
        translate: |error| tr::message::recording::then_use_stop_control(error),
    },
    Wrapped {
        prefix: "",
        suffix: "; discard/restart stopped, local recording retained",
        nested: true,
        translate: |error| tr::message::recording::then_discard_stopped(error),
    },
    Wrapped {
        prefix: "",
        suffix: ". Failed recording files were preserved.",
        nested: true,
        translate: |error| tr::message::recording::then_files_preserved(error),
    },
    Wrapped {
        prefix: "Cancel task failed: ",
        suffix: ". Cleanup is unconfirmed; retry Stop.",
        nested: true,
        translate: |error| tr::message::recording::cancel_task_failed(error),
    },
    Wrapped {
        prefix: "",
        suffix: ". Cleanup is unconfirmed; retry Stop.",
        nested: true,
        translate: |error| tr::message::recording::then_cleanup_retry(error),
    },
    Wrapped {
        prefix: "Studio discard task failed: ",
        suffix: "; cleanup is unconfirmed",
        nested: true,
        translate: |error| tr::message::recording::discard_task_failed(error),
    },
    Wrapped {
        prefix: "Could not confirm capture state: ",
        suffix: "",
        nested: true,
        translate: |error| tr::message::recording::capture_state_failed(error),
    },
    Wrapped {
        prefix: "Recording completion task failed: ",
        suffix: "",
        nested: true,
        translate: |error| tr::message::recording::completion_task_failed(error),
    },
    Wrapped {
        prefix: "Stop task failed: ",
        suffix: "",
        nested: true,
        translate: |error| tr::message::recording::stop_task_failed(error),
    },
    Wrapped {
        prefix: "Capture control task failed: ",
        suffix: "",
        nested: true,
        translate: |error| tr::message::recording::control_task_failed(error),
    },
    Wrapped {
        prefix: "Restart could not hide Cap windows: ",
        suffix: "",
        nested: true,
        translate: |error| tr::message::recording::restart_hide_failed(error),
    },
    Wrapped {
        prefix: "Low storage. Your recording files are preserved at ",
        suffix: ". Free up space, then recover the recording in Cap.",
        nested: false,
        translate: |path| tr::message::recording::low_storage_preserved(path),
    },
    Wrapped {
        prefix: "Bundled CLI binary not found at ",
        suffix: "",
        nested: false,
        translate: |path| tr::message::cli::binary_missing(path),
    },
    Wrapped {
        prefix: "Recording verification failed: ",
        suffix: "",
        nested: false,
        translate: |status| tr::message::upload::verification_failed(status),
    },
];

/// Wrappers nest only a few deep; the bound keeps hostile text cheap.
const MAX_DEPTH: u8 = 4;

pub fn localize(message: &str) -> String {
    localize_at(message, 0)
}

fn localize_at(message: &str, depth: u8) -> String {
    if let Some((_, translate)) = EXACT.iter().find(|(english, _)| *english == message) {
        return translate().to_string();
    }
    if let Some(permission) = OSPermission::ALL
        .iter()
        .find(|permission| permission.unavailable_message() == message)
    {
        return tr::message::permission::unavailable(permission.display_name());
    }
    if depth < MAX_DEPTH {
        for wrapped in WRAPPED {
            let Some(inner) = message
                .strip_prefix(wrapped.prefix)
                .and_then(|rest| rest.strip_suffix(wrapped.suffix))
            else {
                continue;
            };
            if inner.is_empty() {
                continue;
            }
            let inner = if wrapped.nested {
                localize_at(inner, depth + 1)
            } else {
                inner.to_string()
            };
            return (wrapped.translate)(inner);
        }
    }
    message.to_string()
}

#[cfg(test)]
mod tests;
