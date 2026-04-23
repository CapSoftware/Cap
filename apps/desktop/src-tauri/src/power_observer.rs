use std::sync::atomic::{AtomicBool, Ordering};
use tauri::AppHandle;
use tracing::info;

static SYSTEM_ASLEEP: AtomicBool = AtomicBool::new(false);

pub fn is_system_asleep() -> bool {
    SYSTEM_ASLEEP.load(Ordering::Acquire)
}

fn mark_sleeping() {
    SYSTEM_ASLEEP.store(true, Ordering::Release);
}

fn mark_awake() {
    SYSTEM_ASLEEP.store(false, Ordering::Release);
}

pub fn on_system_will_sleep(_app: &AppHandle) {
    mark_sleeping();
    info!("System going to sleep");
}

pub fn on_system_did_wake(app: &AppHandle) {
    mark_awake();
    info!("System woke from sleep; scheduling recovery refresh");
    crate::schedule_resume_recovery(app.clone());
}

pub fn install(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    macos::install(app);

    #[cfg(target_os = "windows")]
    windows::install(app);

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = app;
    }
}

pub fn uninstall(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    macos::uninstall(app);

    #[cfg(target_os = "windows")]
    windows::uninstall(app);

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = app;
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use super::{on_system_did_wake, on_system_will_sleep};
    use objc2::{
        AnyThread, DeclaredClass, define_class, msg_send,
        rc::{Retained, autoreleasepool},
        runtime::{AnyObject, NSObject},
    };
    use objc2_app_kit::NSWorkspace;
    use objc2_foundation::{NSNotification, ns_string};
    use std::sync::{Mutex, OnceLock};
    use tauri::AppHandle;
    use tracing::warn;

    struct ObserverIvars {
        app: AppHandle,
    }

    define_class!(
        #[unsafe(super(NSObject))]
        #[name = "CapPowerObserver"]
        #[ivars = ObserverIvars]
        struct CapPowerObserver;

        impl CapPowerObserver {
            #[unsafe(method(handleWillSleep:))]
            fn handle_will_sleep(&self, _notification: &NSNotification) {
                on_system_will_sleep(&self.ivars().app);
            }

            #[unsafe(method(handleDidWake:))]
            fn handle_did_wake(&self, _notification: &NSNotification) {
                on_system_did_wake(&self.ivars().app);
            }

            #[unsafe(method(handleScreensDidSleep:))]
            fn handle_screens_did_sleep(&self, _notification: &NSNotification) {
                on_system_will_sleep(&self.ivars().app);
            }

            #[unsafe(method(handleScreensDidWake:))]
            fn handle_screens_did_wake(&self, _notification: &NSNotification) {
                on_system_did_wake(&self.ivars().app);
            }
        }
    );

    impl CapPowerObserver {
        fn new(app: AppHandle) -> Retained<Self> {
            let this = Self::alloc().set_ivars(ObserverIvars { app });
            unsafe { msg_send![super(this), init] }
        }
    }

    static OBSERVER: OnceLock<Mutex<Option<Retained<CapPowerObserver>>>> = OnceLock::new();

    fn slot() -> &'static Mutex<Option<Retained<CapPowerObserver>>> {
        OBSERVER.get_or_init(|| Mutex::new(None))
    }

    pub fn install(app: &AppHandle) {
        let app = app.clone();
        let Err(err) = app.clone().run_on_main_thread(move || {
            autoreleasepool(|_| unsafe {
                let mut guard = slot().lock().unwrap_or_else(|e| e.into_inner());
                if guard.is_some() {
                    return;
                }

                let workspace = NSWorkspace::sharedWorkspace();
                let center = workspace.notificationCenter();
                let observer = CapPowerObserver::new(app.clone());

                let observer_obj: &AnyObject = &observer;

                center.addObserver_selector_name_object(
                    observer_obj,
                    objc2::sel!(handleWillSleep:),
                    Some(ns_string!("NSWorkspaceWillSleepNotification")),
                    None,
                );
                center.addObserver_selector_name_object(
                    observer_obj,
                    objc2::sel!(handleDidWake:),
                    Some(ns_string!("NSWorkspaceDidWakeNotification")),
                    None,
                );
                center.addObserver_selector_name_object(
                    observer_obj,
                    objc2::sel!(handleScreensDidSleep:),
                    Some(ns_string!("NSWorkspaceScreensDidSleepNotification")),
                    None,
                );
                center.addObserver_selector_name_object(
                    observer_obj,
                    objc2::sel!(handleScreensDidWake:),
                    Some(ns_string!("NSWorkspaceScreensDidWakeNotification")),
                    None,
                );

                *guard = Some(observer);
            });
        }) else {
            return;
        };
        warn!("Failed to install power observer on main thread: {err}");
    }

    pub fn uninstall(app: &AppHandle) {
        let Err(err) = app.clone().run_on_main_thread(move || {
            autoreleasepool(|_| unsafe {
                let mut guard = slot().lock().unwrap_or_else(|e| e.into_inner());
                if let Some(observer) = guard.take() {
                    let workspace = NSWorkspace::sharedWorkspace();
                    let center = workspace.notificationCenter();
                    let observer_obj: &AnyObject = &observer;
                    center.removeObserver(observer_obj);
                }
            });
        }) else {
            return;
        };
        warn!("Failed to uninstall power observer on main thread: {err}");
    }
}

#[cfg(target_os = "windows")]
mod windows {
    use super::{on_system_did_wake, on_system_will_sleep};
    use ::windows::Win32::Foundation::{HANDLE, WIN32_ERROR};
    use ::windows::Win32::System::Power::{
        DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS, HPOWERNOTIFY, PowerRegisterSuspendResumeNotification,
        PowerUnregisterSuspendResumeNotification,
    };
    use ::windows::Win32::UI::WindowsAndMessaging::{
        DEVICE_NOTIFY_CALLBACK, PBT_APMRESUMEAUTOMATIC, PBT_APMSUSPEND,
    };
    use std::ffi::c_void;
    use std::sync::{Mutex, OnceLock};
    use tauri::AppHandle;
    use tracing::warn;

    struct RegistrationHandle {
        handle: HPOWERNOTIFY,
        app: Box<AppHandle>,
    }

    unsafe impl Send for RegistrationHandle {}
    unsafe impl Sync for RegistrationHandle {}

    static REGISTRATION: OnceLock<Mutex<Option<RegistrationHandle>>> = OnceLock::new();

    fn slot() -> &'static Mutex<Option<RegistrationHandle>> {
        REGISTRATION.get_or_init(|| Mutex::new(None))
    }

    unsafe extern "system" fn power_callback(
        context: *const c_void,
        event_type: u32,
        _setting: *const c_void,
    ) -> u32 {
        if context.is_null() {
            return 0;
        }
        let app = unsafe { &*(context as *const AppHandle) };
        match event_type {
            PBT_APMSUSPEND => on_system_will_sleep(app),
            PBT_APMRESUMEAUTOMATIC => on_system_did_wake(app),
            _ => {}
        }
        0
    }

    pub fn install(app: &AppHandle) {
        let mut guard = slot().lock().unwrap_or_else(|e| e.into_inner());
        if guard.is_some() {
            return;
        }

        let boxed_app = Box::new(app.clone());
        let context = Box::as_ref(&boxed_app) as *const AppHandle as *mut c_void;

        let params = DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS {
            Callback: Some(power_callback),
            Context: context,
        };

        let mut raw_handle: *mut c_void = std::ptr::null_mut();
        let result = unsafe {
            PowerRegisterSuspendResumeNotification(
                DEVICE_NOTIFY_CALLBACK,
                HANDLE(&params as *const _ as *mut c_void),
                &mut raw_handle,
            )
        };

        if result != WIN32_ERROR(0) {
            warn!(
                code = result.0,
                "PowerRegisterSuspendResumeNotification failed"
            );
            return;
        }

        *guard = Some(RegistrationHandle {
            handle: HPOWERNOTIFY(raw_handle as isize),
            app: boxed_app,
        });
    }

    pub fn uninstall(_app: &AppHandle) {
        let mut guard = slot().lock().unwrap_or_else(|e| e.into_inner());
        if let Some(reg) = guard.take() {
            let _ = unsafe { PowerUnregisterSuspendResumeNotification(reg.handle) };
            drop(reg.app);
        }
    }
}
