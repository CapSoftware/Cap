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
    #[cfg(windows)]
    windows::install(cx);
    #[cfg(target_os = "linux")]
    linux::install(cx);
}

/// Windows and Linux: a meeting stops for sleep and is offered back on
/// wake, as on macOS. Screen recordings keep their own handling there.
#[cfg(not(target_os = "macos"))]
fn forward_sleep(sleeping: flume::Receiver<bool>, cx: &mut App) {
    cx.spawn(async move |cx| {
        while let Ok(sleeping) = sleeping.recv_async().await {
            cx.update(|cx| {
                if sleeping {
                    tracing::info!("system going to sleep");
                    crate::meetings::Meetings::system_will_sleep(cx);
                } else {
                    tracing::info!("system woke from sleep");
                    crate::meetings::Meetings::system_did_wake(cx);
                }
            });
        }
    })
    .detach();
}

#[cfg(windows)]
mod windows {
    use std::{ffi::c_void, sync::OnceLock};

    use gpui::App;
    use windows_sys::Win32::{
        System::Power::{
            DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS, PowerRegisterSuspendResumeNotification,
        },
        UI::WindowsAndMessaging::{DEVICE_NOTIFY_CALLBACK, PBT_APMRESUMEAUTOMATIC, PBT_APMSUSPEND},
    };

    static EVENTS: OnceLock<flume::Sender<bool>> = OnceLock::new();

    /// Runs on a system thread; Windows waits for it, so it only forwards.
    unsafe extern "system" fn on_power(_: *const c_void, kind: u32, _: *const c_void) -> u32 {
        let sleeping = match kind {
            PBT_APMSUSPEND => true,
            PBT_APMRESUMEAUTOMATIC => false,
            _ => return 0,
        };
        if let Some(events) = EVENTS.get() {
            let _ = events.send(sleeping);
        }
        0
    }

    pub(super) fn install(cx: &mut App) {
        let (tx, rx) = flume::unbounded();
        if EVENTS.set(tx).is_err() {
            return;
        }
        // Windows keeps the pointer for as long as the registration lives,
        // which is as long as the app does.
        let params = Box::leak(Box::new(DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS {
            Callback: Some(on_power),
            Context: std::ptr::null_mut(),
        }));
        let mut registration = std::ptr::null_mut();
        let result = unsafe {
            PowerRegisterSuspendResumeNotification(
                DEVICE_NOTIFY_CALLBACK,
                std::ptr::from_mut(params).cast(),
                &mut registration,
            )
        };
        if result != 0 {
            tracing::warn!(result, "no sleep notifications");
            return;
        }
        super::forward_sleep(rx, cx);
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn suspend_and_resume_are_forwarded_and_nothing_else() {
            let (tx, rx) = flume::unbounded();
            assert!(EVENTS.set(tx).is_ok());
            for kind in [PBT_APMSUSPEND, 7, PBT_APMRESUMEAUTOMATIC, 10] {
                assert_eq!(
                    unsafe { on_power(std::ptr::null(), kind, std::ptr::null()) },
                    0
                );
            }
            assert_eq!(rx.try_iter().collect::<Vec<_>>(), vec![true, false]);
        }

        #[test]
        fn windows_takes_the_registration() {
            let params = Box::new(DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS {
                Callback: Some(on_power),
                Context: std::ptr::null_mut(),
            });
            let mut registration = std::ptr::null_mut();
            let result = unsafe {
                PowerRegisterSuspendResumeNotification(
                    DEVICE_NOTIFY_CALLBACK,
                    std::ptr::from_ref(params.as_ref()).cast_mut().cast(),
                    &mut registration,
                )
            };
            assert_eq!(result, 0);
            assert!(!registration.is_null());
            unsafe {
                windows_sys::Win32::System::Power::PowerUnregisterSuspendResumeNotification(
                    registration as isize,
                )
            };
        }
    }
}

#[cfg(target_os = "linux")]
mod linux {
    use ashpd::zbus;
    use futures_util::StreamExt;
    use gpui::App;

    pub(super) fn install(cx: &mut App) {
        let (tx, rx) = flume::unbounded();
        gpui_tokio::Tokio::spawn(cx, async move {
            let listen = async {
                let connection = zbus::Connection::system().await?;
                let manager = zbus::Proxy::new(
                    &connection,
                    "org.freedesktop.login1",
                    "/org/freedesktop/login1",
                    "org.freedesktop.login1.Manager",
                )
                .await?;
                let mut signals = manager.receive_signal("PrepareForSleep").await?;
                while let Some(signal) = signals.next().await {
                    if let Ok(sleeping) = signal.body().deserialize::<bool>()
                        && tx.send(sleeping).is_err()
                    {
                        break;
                    }
                }
                Ok::<(), zbus::Error>(())
            };
            if let Err(error) = listen.await {
                tracing::info!(%error, "no sleep notifications from logind");
            }
        })
        .detach();
        super::forward_sleep(rx, cx);
    }
}

/// Keeps the computer out of idle sleep while it lives, the display free to
/// sleep: a meeting in a room has no one at the keyboard, and a call app's
/// own hold ends with its call. Released when dropped.
pub struct StayAwake {
    #[cfg(target_os = "macos")]
    assertion: Option<u32>,
    #[cfg(windows)]
    held: bool,
    #[cfg(target_os = "linux")]
    _release: Option<tokio::sync::oneshot::Sender<()>>,
}

impl StayAwake {
    pub fn hold(reason: &str, cx: &App) -> Self {
        #[cfg(target_os = "macos")]
        {
            let _ = cx;
            let assertion = macos::hold_system_awake(reason);
            Self { assertion }
        }
        #[cfg(windows)]
        {
            let _ = (cx, reason);
            use windows_sys::Win32::System::Power::{
                ES_CONTINUOUS, ES_SYSTEM_REQUIRED, SetThreadExecutionState,
            };
            // Per thread: made and dropped on the main thread with the meeting.
            let held = unsafe { SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED) } != 0;
            if !held {
                tracing::warn!("could not hold off idle sleep");
            }
            Self { held }
        }
        #[cfg(target_os = "linux")]
        {
            let (release, released) = tokio::sync::oneshot::channel::<()>();
            let reason = reason.to_string();
            gpui_tokio::Tokio::spawn(cx, async move {
                use ashpd::desktop::inhibit::{InhibitFlags, InhibitProxy};
                let request = match InhibitProxy::new().await {
                    Ok(proxy) => proxy
                        .inhibit(None, InhibitFlags::Suspend | InhibitFlags::Idle, &reason)
                        .await
                        .map_err(|error| error.to_string()),
                    Err(error) => Err(error.to_string()),
                };
                let _ = released.await;
                match request {
                    Ok(request) => {
                        let _ = request.close().await;
                    }
                    Err(error) => tracing::debug!(%error, "could not hold off idle sleep"),
                }
            })
            .detach();
            Self {
                _release: Some(release),
            }
        }
    }
}

impl Drop for StayAwake {
    fn drop(&mut self) {
        #[cfg(target_os = "macos")]
        if let Some(id) = self.assertion.take() {
            macos::release(id);
        }
        #[cfg(windows)]
        if std::mem::take(&mut self.held) {
            use windows_sys::Win32::System::Power::{ES_CONTINUOUS, SetThreadExecutionState};
            unsafe { SetThreadExecutionState(ES_CONTINUOUS) };
        }
    }
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

    /// A hold on idle system sleep (the display may still sleep), or none if
    /// macOS refused it.
    pub(super) fn hold_system_awake(reason: &str) -> Option<u32> {
        let kind = CFString::new("PreventUserIdleSystemSleep");
        let name = CFString::new(reason);
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
            tracing::info!(reason, "holding off idle sleep");
            Some(id)
        } else {
            tracing::warn!(result, reason, "could not hold off idle sleep");
            None
        }
    }

    pub(super) fn release(id: u32) {
        unsafe { IOPMAssertionRelease(id) };
        tracing::info!("released an idle sleep hold");
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
                crate::meetings::Meetings::system_will_sleep(cx);
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
                crate::meetings::Meetings::system_did_wake(cx);
                session.update(cx, |session, cx| session.woke_from_sleep(cx));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "macos")]
    #[test]
    fn a_meeting_hold_keeps_the_mac_awake_until_released() {
        let reason = format!("Cap test hold {}", std::process::id());
        let listed = || {
            let out = std::process::Command::new("pmset")
                .args(["-g", "assertions"])
                .output()
                .expect("pmset runs");
            String::from_utf8_lossy(&out.stdout).lines().any(|line| {
                line.contains("PreventUserIdleSystemSleep") && line.contains(reason.as_str())
            })
        };
        let hold = macos::hold_system_awake(&reason).expect("macOS grants the hold");
        assert!(listed(), "the hold is listed");
        macos::release(hold);
        assert!(!listed(), "the hold is gone once released");
    }

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
