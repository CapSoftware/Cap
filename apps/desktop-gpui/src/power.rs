//! Recording across sleep. While a recording runs, idle sleep is held off, so
//! a long recording of a still screen keeps going. When the Mac sleeps anyway
//! (lid closed, Sleep chosen, battery empty) the recording is paused first, so
//! capture never dies inside sleep, and it waits paused for the user on wake.

use gpui::App;

use crate::session::Phase;

pub(crate) fn holds_off_idle_sleep(phase: Phase) -> bool {
    phase != Phase::Idle
}

pub fn install(cx: &mut App) {
    #[cfg(target_os = "macos")]
    macos::install(cx);
    #[cfg(not(target_os = "macos"))]
    let _ = cx;
}

#[cfg(target_os = "macos")]
mod macos {
    use std::{
        ffi::c_void,
        sync::{
            OnceLock,
            atomic::{AtomicU32, Ordering},
        },
        time::{Duration, Instant},
    };

    use core_foundation::{
        base::TCFType,
        runloop::{CFRunLoop, CFRunLoopSource, kCFRunLoopCommonModes},
        string::{CFString, CFStringRef},
    };
    use gpui::{App, AppContext as _, Global};

    use super::holds_off_idle_sleep;
    use crate::session::RecordingSession;

    const SLEEP_PAUSE_TIMEOUT: Duration = Duration::from_secs(5);

    type IoConnect = u32;
    type IoObject = u32;
    type IoNotificationPortRef = *mut c_void;
    type IoServiceInterestCallback =
        extern "C" fn(refcon: *mut c_void, service: IoObject, message: u32, argument: *mut c_void);

    const CAN_SYSTEM_SLEEP: u32 = 0xE000_0270;
    const SYSTEM_WILL_SLEEP: u32 = 0xE000_0280;
    const SYSTEM_HAS_POWERED_ON: u32 = 0xE000_0300;
    const ASSERTION_LEVEL_ON: u32 = 255;

    #[link(name = "IOKit", kind = "framework")]
    unsafe extern "C" {
        fn IORegisterForSystemPower(
            refcon: *mut c_void,
            port: *mut IoNotificationPortRef,
            callback: IoServiceInterestCallback,
            notifier: *mut IoObject,
        ) -> IoConnect;
        fn IONotificationPortGetRunLoopSource(
            port: IoNotificationPortRef,
        ) -> core_foundation::runloop::CFRunLoopSourceRef;
        fn IOAllowPowerChange(kernel_port: IoConnect, notification: isize) -> i32;
        fn IOPMAssertionCreateWithName(
            assertion_type: CFStringRef,
            level: u32,
            name: CFStringRef,
            assertion: *mut u32,
        ) -> i32;
        fn IOPMAssertionRelease(assertion: u32) -> i32;
    }

    #[derive(Clone, Copy, Debug)]
    enum PowerEvent {
        WillSleep(isize),
        DidWake,
    }

    static ROOT_PORT: AtomicU32 = AtomicU32::new(0);
    static EVENTS: OnceLock<flume::Sender<PowerEvent>> = OnceLock::new();

    fn allow_power_change(notification: isize) {
        let port = ROOT_PORT.load(Ordering::Acquire);
        if port != 0 {
            unsafe { IOAllowPowerChange(port, notification) };
        }
    }

    extern "C" fn power_callback(
        _refcon: *mut c_void,
        _service: IoObject,
        message: u32,
        argument: *mut c_void,
    ) {
        let notification = argument as isize;
        match message {
            CAN_SYSTEM_SLEEP => allow_power_change(notification),
            SYSTEM_WILL_SLEEP => {
                let queued = EVENTS
                    .get()
                    .is_some_and(|events| events.send(PowerEvent::WillSleep(notification)).is_ok());
                if !queued {
                    allow_power_change(notification);
                }
            }
            SYSTEM_HAS_POWERED_ON => {
                if let Some(events) = EVENTS.get() {
                    let _ = events.send(PowerEvent::DidWake);
                }
            }
            _ => {}
        }
    }

    struct IdleSleepAssertion(Option<u32>);

    impl Global for IdleSleepAssertion {}

    impl IdleSleepAssertion {
        fn hold(&mut self, wanted: bool) {
            match (wanted, self.0) {
                (true, None) => {
                    let kind = CFString::new("PreventUserIdleDisplaySleep");
                    let name = CFString::new("Cap is recording");
                    let mut id = 0;
                    let result = unsafe {
                        IOPMAssertionCreateWithName(
                            kind.as_concrete_TypeRef(),
                            ASSERTION_LEVEL_ON,
                            name.as_concrete_TypeRef(),
                            &mut id,
                        )
                    };
                    if result == 0 {
                        tracing::info!("holding off idle sleep while recording");
                        self.0 = Some(id);
                    } else {
                        tracing::warn!(result, "could not hold off idle sleep while recording");
                    }
                }
                (false, Some(id)) => {
                    unsafe { IOPMAssertionRelease(id) };
                    tracing::info!("released the idle sleep hold");
                    self.0 = None;
                }
                _ => {}
            }
        }
    }

    pub(super) fn install(cx: &mut App) {
        let session = RecordingSession::global(cx);
        cx.set_global(IdleSleepAssertion(None));
        cx.observe(&session, |session, cx| {
            let wanted = holds_off_idle_sleep(session.read(cx).phase);
            cx.global_mut::<IdleSleepAssertion>().hold(wanted);
        })
        .detach();

        let (events, received) = flume::unbounded();
        if EVENTS.set(events).is_err() {
            return;
        }
        let mut port: IoNotificationPortRef = std::ptr::null_mut();
        let mut notifier: IoObject = 0;
        let root = unsafe {
            IORegisterForSystemPower(
                std::ptr::null_mut(),
                &mut port,
                power_callback,
                &mut notifier,
            )
        };
        if root == 0 || port.is_null() {
            tracing::warn!("could not register for sleep notifications");
            return;
        }
        ROOT_PORT.store(root, Ordering::Release);
        let source = unsafe {
            CFRunLoopSource::wrap_under_get_rule(IONotificationPortGetRunLoopSource(port))
        };
        CFRunLoop::get_main().add_source(&source, unsafe { kCFRunLoopCommonModes });

        cx.spawn(async move |cx| {
            while let Ok(event) = received.recv_async().await {
                cx.update(|cx| handle(event, cx));
            }
        })
        .detach();
    }

    fn handle(event: PowerEvent, cx: &mut App) {
        let session = RecordingSession::global(cx);
        match event {
            PowerEvent::WillSleep(notification) => {
                tracing::info!("system going to sleep");
                let started = Instant::now();
                cx.spawn(async move |cx| {
                    let mut dispatched = false;
                    while started.elapsed() < SLEEP_PAUSE_TIMEOUT {
                        let settling = cx.update(|cx| session.read(cx).sleep_should_wait());
                        if !settling {
                            let acted = cx.update(|cx| {
                                session.update(cx, |session, cx| session.prepare_for_sleep(cx))
                            });
                            if !acted {
                                break;
                            }
                            dispatched = true;
                        }
                        cx.background_executor()
                            .timer(Duration::from_millis(25))
                            .await;
                    }
                    tracing::info!(
                        dispatched,
                        paused = cx.update(|cx| session.read(cx).is_paused()),
                        waited_ms = started.elapsed().as_millis() as u64,
                        "recording ready for sleep"
                    );
                    allow_power_change(notification);
                })
                .detach();
            }
            PowerEvent::DidWake => {
                tracing::info!("system woke from sleep");
                session.update(cx, |session, cx| session.woke_from_sleep(cx));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn idle_sleep_is_held_off_for_the_whole_recording_lifecycle() {
        assert!(!holds_off_idle_sleep(Phase::Idle));
        for phase in [
            Phase::Starting,
            Phase::Recording { paused: false },
            Phase::Recording { paused: true },
            Phase::Stopping,
        ] {
            assert!(holds_off_idle_sleep(phase), "{phase:?}");
        }
    }
}
