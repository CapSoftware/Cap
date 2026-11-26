use std::{ffi::c_void, sync::OnceLock, time::Duration};

use cidre::{blocks, cf};

use super::system_tap::{SystemAudioTap, system_tap_supported};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AudioCapturePermission {
    Granted,
    Denied,
    NotDetermined,
    Unknown,
    NotNeeded,
}

type Preflight = unsafe extern "C" fn(service: &cf::String, options: *const c_void) -> i32;
type Request = unsafe extern "C" fn(
    service: &cf::String,
    options: *const c_void,
    callback: &mut blocks::Block<fn(u8), blocks::Send>,
);

fn tcc_symbol(name: &std::ffi::CStr) -> Option<usize> {
    static HANDLE: OnceLock<usize> = OnceLock::new();
    let handle = *HANDLE.get_or_init(|| unsafe {
        libc::dlopen(
            c"/System/Library/PrivateFrameworks/TCC.framework/Versions/A/TCC".as_ptr(),
            libc::RTLD_LAZY,
        ) as usize
    });
    if handle == 0 {
        return None;
    }
    let symbol = unsafe { libc::dlsym(handle as *mut c_void, name.as_ptr()) };
    (!symbol.is_null()).then_some(symbol as usize)
}

fn preflight_fn() -> Option<Preflight> {
    static PREFLIGHT: OnceLock<Option<usize>> = OnceLock::new();
    PREFLIGHT
        .get_or_init(|| tcc_symbol(c"TCCAccessPreflight"))
        .map(|symbol| unsafe { std::mem::transmute::<usize, Preflight>(symbol) })
}

fn request_fn() -> Option<Request> {
    static REQUEST: OnceLock<Option<usize>> = OnceLock::new();
    REQUEST
        .get_or_init(|| tcc_symbol(c"TCCAccessRequest"))
        .map(|symbol| unsafe { std::mem::transmute::<usize, Request>(symbol) })
}

/// The process keeps its own copy of this answer: an answer given to a
/// prompt that Core Audio raised for a tap never reaches it (measured on
/// macOS 27: preflight stays "not determined" after Allow until relaunch).
/// `request_audio_capture_permission` and `refresh_audio_capture_permission`
/// bring it up to date.
pub fn audio_capture_permission() -> AudioCapturePermission {
    if !system_tap_supported() {
        return AudioCapturePermission::NotNeeded;
    }
    let Some(preflight) = preflight_fn() else {
        return AudioCapturePermission::Unknown;
    };
    from_preflight(unsafe { preflight(cf::str!(c"kTCCServiceAudioCapture"), std::ptr::null()) })
}

fn from_preflight(value: i32) -> AudioCapturePermission {
    match value {
        0 => AudioCapturePermission::Granted,
        1 => AudioCapturePermission::Denied,
        2 => AudioCapturePermission::NotDetermined,
        _ => AudioCapturePermission::Unknown,
    }
}

fn needs_answer(state: AudioCapturePermission) -> bool {
    matches!(
        state,
        AudioCapturePermission::NotDetermined | AudioCapturePermission::Unknown
    )
}

/// What the request settled on: the system's answer when it came, otherwise
/// whatever the process can see now.
fn settle(answer: Option<bool>, now: AudioCapturePermission) -> AudioCapturePermission {
    match answer {
        Some(true) => AudioCapturePermission::Granted,
        Some(false) => AudioCapturePermission::Denied,
        None => now,
    }
}

const ANSWER_TIMEOUT: Duration = Duration::from_secs(90);
const UNKNOWN_HOLD: Duration = Duration::from_secs(3);
const ANSWER_POLL: Duration = Duration::from_millis(200);

/// Asks TCC directly. The system shows its "record your system audio" prompt
/// (or answers at once when the person already did), and the answer also
/// refreshes this process's copy. `None` when the request is unavailable or
/// nobody answered within `wait`; a late answer still refreshes the copy.
fn ask(wait: Duration) -> Option<Option<bool>> {
    let request = request_fn()?;
    let (tx, rx) = flume::bounded::<bool>(1);
    let mut callback = blocks::SendBlock::<fn(u8)>::new1(move |granted: u8| {
        let _ = tx.try_send(granted != 0);
    });
    unsafe {
        request(
            cf::str!(c"kTCCServiceAudioCapture"),
            std::ptr::null(),
            &mut callback,
        )
    };
    Some(rx.recv_timeout(wait).ok())
}

/// Blocks until the person answers the system prompt (or about 90 seconds
/// pass), so call it off the main thread.
pub fn request_audio_capture_permission() -> AudioCapturePermission {
    let before = audio_capture_permission();
    if !needs_answer(before) {
        return before;
    }
    let started = std::time::Instant::now();
    let after = match ask(ANSWER_TIMEOUT) {
        Some(answer) => settle(answer, audio_capture_permission()),
        None => request_with_tap(before),
    };
    tracing::info!(
        ?before,
        ?after,
        waited_ms = started.elapsed().as_millis() as u64,
        "system audio permission request finished"
    );
    after
}

/// A tap started before the person answered raises the prompt through Core
/// Audio, and that answer never reaches this process. Call after a tap
/// starts (the start waits for the answer): when the copy still says "not
/// determined" this asks again, which returns at once without a prompt.
pub fn refresh_audio_capture_permission() {
    if needs_answer(audio_capture_permission()) {
        let _ = ask(Duration::from_secs(5));
    }
}

/// Fallback when `TCCAccessRequest` is missing: a running tap holds the
/// prompt up, and the process polls for an answer it may never see.
fn request_with_tap(before: AudioCapturePermission) -> AudioCapturePermission {
    let tap = match SystemAudioTap::start(true, |_| {}) {
        Ok(tap) => tap,
        Err(error) => {
            tracing::warn!(
                ?error,
                "system audio permission request could not start a tap"
            );
            return audio_capture_permission();
        }
    };
    let limit = if before == AudioCapturePermission::Unknown {
        UNKNOWN_HOLD
    } else {
        ANSWER_TIMEOUT
    };
    let started = std::time::Instant::now();
    let mut now = before;
    while started.elapsed() < limit {
        std::thread::sleep(ANSWER_POLL);
        now = audio_capture_permission();
        if !needs_answer(now) {
            break;
        }
    }
    drop(tap);
    now
}

#[cfg(test)]
mod tests {
    use super::*;
    use AudioCapturePermission::*;

    #[test]
    fn preflight_values_map_to_states() {
        assert_eq!(from_preflight(0), Granted);
        assert_eq!(from_preflight(1), Denied);
        assert_eq!(from_preflight(2), NotDetermined);
        assert_eq!(from_preflight(7), Unknown);
    }

    #[test]
    fn only_unanswered_states_are_asked() {
        assert!(needs_answer(NotDetermined));
        assert!(needs_answer(Unknown));
        assert!(!needs_answer(Granted));
        assert!(!needs_answer(Denied));
        assert!(!needs_answer(NotNeeded));
    }

    #[test]
    fn the_answer_wins_over_a_stale_copy() {
        // The case Richie hit: Allow pressed, the process still reads
        // "not determined".
        assert_eq!(settle(Some(true), NotDetermined), Granted);
        assert_eq!(settle(Some(false), NotDetermined), Denied);
        assert_eq!(settle(Some(true), Unknown), Granted);
    }

    #[test]
    fn no_answer_keeps_what_the_process_sees() {
        assert_eq!(settle(None, NotDetermined), NotDetermined);
        assert_eq!(settle(None, Granted), Granted);
        assert_eq!(settle(None, Denied), Denied);
    }
}
