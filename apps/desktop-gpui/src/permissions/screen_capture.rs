//! Whether ScreenCaptureKit can actually capture, on top of
//! `CGPreflightScreenCaptureAccess`.
//!
//! The preflight can report a grant that ScreenCaptureKit does not honour (a
//! stale TCC entry after an update, or a grant made in this session that
//! needs a relaunch): every capture then fails or comes back empty. The Tauri
//! app treated that state as "not granted" so onboarding sent the user back
//! through the grant and relaunch path; this is the same check
//! (`macos_screen_recording_available` in `src-tauri/src/permissions.rs`).
//!
//! `SCShareableContent` materialises the whole window/display graph, so it is
//! never polled: a success is cached for the life of the process (a later
//! revocation is caught by the preflight, and macOS relaunches the app when
//! the grant changes), a failure is retried at most once per
//! [`RETRY_INTERVAL`], and each query runs bounded by [`TIMEOUT`] inside an
//! autorelease pool on a thread of its own.

use std::{
    sync::{
        Mutex,
        atomic::{AtomicBool, AtomicU8, Ordering},
        mpsc,
    },
    time::{Duration, Instant},
};

const RETRY_INTERVAL: Duration = Duration::from_secs(5);
const TIMEOUT: Duration = Duration::from_secs(4);

const UNKNOWN: u8 = 0;
const OK: u8 = 1;
const FAILED: u8 = 2;

static VALIDATED: AtomicBool = AtomicBool::new(false);
static LAST_OUTCOME: AtomicU8 = AtomicU8::new(UNKNOWN);
static IN_FLIGHT: AtomicBool = AtomicBool::new(false);
static QUERIES_ALIVE: AtomicU8 = AtomicU8::new(0);
const MAX_QUERIES_ALIVE: u8 = 3;
static LAST_ATTEMPT: Mutex<Option<Instant>> = Mutex::new(None);

pub(super) fn available(preflight_granted: bool) -> bool {
    available_with(
        preflight_granted,
        VALIDATED.load(Ordering::Acquire),
        LAST_OUTCOME.load(Ordering::Acquire),
        objc2_foundation::MainThreadMarker::new().is_some(),
        spawn_validation,
        validate,
    )
}

/// SCShareableContent's completion needs the main run loop, so the main
/// thread never waits on it: it gets the last strict answer, optimistic until
/// one has failed, and a validation is started in the background.
fn available_with(
    preflight_granted: bool,
    validated: bool,
    last_outcome: u8,
    on_main_thread: bool,
    spawn_validation: impl FnOnce(),
    validate: impl FnOnce() -> bool,
) -> bool {
    if !preflight_granted {
        return false;
    }
    if validated {
        return true;
    }
    if on_main_thread {
        spawn_validation();
        return last_outcome != FAILED;
    }
    validate()
}

struct InFlightReset;

impl Drop for InFlightReset {
    fn drop(&mut self) {
        IN_FLIGHT.store(false, Ordering::Release);
    }
}

fn spawn_validation() {
    if IN_FLIGHT.swap(true, Ordering::AcqRel) {
        return;
    }
    let spawned = std::thread::Builder::new()
        .name("cap-screen-capture-check".into())
        .spawn(|| {
            let _reset = InFlightReset;
            validate();
        });
    if spawned.is_err() {
        IN_FLIGHT.store(false, Ordering::Release);
    }
}

fn validate() -> bool {
    // Concurrent callers wait for the attempt in flight instead of tripping
    // the backoff and reading a grant as a denial.
    let mut last_attempt = LAST_ATTEMPT
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if VALIDATED.load(Ordering::Acquire) {
        return true;
    }
    if last_attempt.is_some_and(|attempted| attempted.elapsed() < RETRY_INTERVAL) {
        return false;
    }
    *last_attempt = Some(Instant::now());

    let validated = query_displays(TIMEOUT).is_some_and(|displays| displays > 0);
    if validated {
        VALIDATED.store(true, Ordering::Release);
    } else {
        tracing::warn!(
            "screen recording is granted, but ScreenCaptureKit has no displays to capture"
        );
    }
    LAST_OUTCOME.store(if validated { OK } else { FAILED }, Ordering::Release);
    // An attempt can take the whole timeout, so the backoff starts at its end.
    *last_attempt = Some(Instant::now());
    validated
}

/// Display count, or `None` on an error or timeout. A wedged `replayd` can
/// leave the query unresolved forever, so it runs on a thread of its own that
/// is abandoned at the timeout. An abandoned query that answers later still
/// records the grant, and at most [`MAX_QUERIES_ALIVE`] are left waiting, so a
/// replayd that never recovers strands a bounded number of threads.
fn query_displays(timeout: Duration) -> Option<usize> {
    if QUERIES_ALIVE
        .fetch_update(Ordering::AcqRel, Ordering::Acquire, |alive| {
            (alive < MAX_QUERIES_ALIVE).then_some(alive + 1)
        })
        .is_err()
    {
        tracing::debug!("ScreenCaptureKit shareable content queries are still pending");
        return None;
    }
    let (sender, receiver) = mpsc::sync_channel(1);
    let spawned = std::thread::Builder::new()
        .name("cap-screen-capture-query".into())
        .spawn(move || {
            struct AliveReset;
            impl Drop for AliveReset {
                fn drop(&mut self) {
                    QUERIES_ALIVE.fetch_sub(1, Ordering::AcqRel);
                }
            }
            let _alive = AliveReset;
            let displays = objc2::rc::autoreleasepool(|_| {
                let runtime = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .ok()?;
                runtime.block_on(async {
                    match cidre::sc::ShareableContent::current().await {
                        Ok(content) => Some(content.displays().len()),
                        Err(error) => {
                            tracing::debug!(error = ?error, "ScreenCaptureKit shareable content unavailable");
                            None
                        }
                    }
                })
            });
            if displays.is_some_and(|displays| displays > 0) {
                VALIDATED.store(true, Ordering::Release);
                LAST_OUTCOME.store(OK, Ordering::Release);
            }
            let _ = sender.send(displays);
        });
    if spawned.is_err() {
        QUERIES_ALIVE.fetch_sub(1, Ordering::AcqRel);
        return None;
    }
    match receiver.recv_timeout(timeout) {
        Ok(displays) => displays,
        Err(_) => {
            tracing::warn!(
                timeout_ms = timeout.as_millis() as u64,
                "ScreenCaptureKit shareable content query timed out"
            );
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;

    use super::*;

    fn decide(
        preflight: bool,
        validated: bool,
        last: u8,
        main: bool,
        validation: bool,
    ) -> (bool, bool, bool) {
        let spawned = Cell::new(false);
        let validated_inline = Cell::new(false);
        let available = available_with(
            preflight,
            validated,
            last,
            main,
            || spawned.set(true),
            || {
                validated_inline.set(true);
                validation
            },
        );
        (available, spawned.get(), validated_inline.get())
    }

    #[test]
    fn a_denied_preflight_never_queries_screen_capture_kit() {
        for main in [false, true] {
            assert_eq!(
                decide(false, false, UNKNOWN, main, true),
                (false, false, false)
            );
        }
    }

    #[test]
    fn a_cached_validation_short_circuits() {
        for main in [false, true] {
            assert_eq!(
                decide(true, true, FAILED, main, false),
                (true, false, false)
            );
        }
    }

    #[test]
    fn the_main_thread_never_validates_inline_and_reports_the_last_strict_outcome() {
        assert_eq!(
            decide(true, false, UNKNOWN, true, false),
            (true, true, false)
        );
        assert_eq!(decide(true, false, OK, true, false), (true, true, false));
        assert_eq!(
            decide(true, false, FAILED, true, true),
            (false, true, false)
        );
    }

    #[test]
    fn other_threads_take_the_strict_answer() {
        assert_eq!(
            decide(true, false, UNKNOWN, false, true),
            (true, false, true)
        );
        assert_eq!(decide(true, false, OK, false, false), (false, false, true));
    }

    #[test]
    fn the_query_timeout_fits_inside_the_retry_backoff() {
        assert!(TIMEOUT < RETRY_INTERVAL);
    }
}
