//! AppKit methods whose Objective-C exceptions would otherwise end the app.
//!
//! On Macs with a Touch Bar, AppKit's Touch Bar finder watches the key
//! window's responder chain with key-value observing. When it rebuilds that
//! observation during a display-cycle flush, `-[_NSTouchBarFinderObservation
//! invalidate]` can throw "Cannot remove an observer ... because it is not
//! registered as an observer", and AppKit crashes the app from the commit
//! handler (a MacBookPro16,3 report, every time a recording started). Cap
//! never shows anything on the Touch Bar, so a failed teardown of that
//! observation is dropped instead.
//!
//! The catch lives in `native/exception_guard.m`: an exception must not
//! unwind through a Rust frame, so the original method is called from there.

use std::sync::OnceLock;

use objc2::{
    ffi, msg_send,
    rc::Retained,
    runtime::{AnyClass, AnyObject, Imp, Sel},
    sel,
};

type VoidMethod = unsafe extern "C" fn(*mut AnyObject, Sel);

unsafe extern "C" {
    fn cap_call_void_imp_catching(
        imp: VoidMethod,
        receiver: *mut AnyObject,
        selector: Sel,
    ) -> *mut AnyObject;
}

struct GuardedMethod {
    original: OnceLock<VoidMethod>,
}

impl GuardedMethod {
    const fn new() -> Self {
        Self {
            original: OnceLock::new(),
        }
    }

    fn install(&self, class: &AnyClass, selector: Sel, guard: VoidMethod) -> bool {
        if self.original.get().is_some() || class.verify_sel::<(), ()>(selector).is_err() {
            return false;
        }
        let method = unsafe { ffi::class_getInstanceMethod(class, selector) };
        if method.is_null() {
            return false;
        }
        let guard_imp = unsafe { std::mem::transmute::<VoidMethod, Imp>(guard) };
        let Some(current) = (unsafe { ffi::method_getImplementation(method) }) else {
            return false;
        };
        if std::ptr::fn_addr_eq(current, guard_imp) {
            return false;
        }
        let original = unsafe { std::mem::transmute::<Imp, VoidMethod>(current) };
        if self.original.set(original).is_err() {
            return false;
        }
        let _ = unsafe { ffi::method_setImplementation(method, guard_imp) };
        true
    }

    unsafe fn call(&self, receiver: *mut AnyObject, selector: Sel) -> bool {
        let Some(original) = self.original.get().copied() else {
            return false;
        };
        let exception = unsafe { cap_call_void_imp_catching(original, receiver, selector) };
        let Some(exception) = (unsafe { Retained::from_raw(exception) }) else {
            return false;
        };
        tracing::warn!(
            exception = %describe(&exception),
            selector = %selector.name().to_string_lossy(),
            "ignored an AppKit exception that would have crashed the app"
        );
        true
    }
}

fn describe(exception: &AnyObject) -> String {
    fn utf8(value: *mut AnyObject) -> String {
        if value.is_null() {
            return String::new();
        }
        let text: *const std::ffi::c_char = unsafe { msg_send![value, UTF8String] };
        if text.is_null() {
            return String::new();
        }
        unsafe { std::ffi::CStr::from_ptr(text) }
            .to_string_lossy()
            .into_owned()
    }
    let name: *mut AnyObject = unsafe { msg_send![exception, name] };
    let reason: *mut AnyObject = unsafe { msg_send![exception, reason] };
    format!("{}: {}", utf8(name), utf8(reason))
}

static TOUCH_BAR_FINDER_INVALIDATE: GuardedMethod = GuardedMethod::new();

unsafe extern "C" fn touch_bar_finder_invalidate(receiver: *mut AnyObject, selector: Sel) {
    unsafe { TOUCH_BAR_FINDER_INVALIDATE.call(receiver, selector) };
}

/// Call once on the main thread, before the app's run loop starts.
pub(super) fn install() {
    let Some(class) = AnyClass::get(c"_NSTouchBarFinderObservation") else {
        tracing::info!("AppKit has no Touch Bar finder observation class; nothing to guard");
        return;
    };
    if TOUCH_BAR_FINDER_INVALIDATE.install(class, sel!(invalidate), touch_bar_finder_invalidate) {
        tracing::info!("guarded the Touch Bar finder's observation teardown");
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use objc2::{
        ClassType, msg_send,
        runtime::{ClassBuilder, NSObject},
    };

    use super::*;

    unsafe extern "C" {
        static cap_test_unbalanced_removal_calls: AtomicUsize;
        fn cap_test_unbalanced_kvo_removal(receiver: *mut AnyObject, selector: Sel);
    }

    static TEST_GUARD: GuardedMethod = GuardedMethod::new();

    unsafe extern "C" fn guarded(receiver: *mut AnyObject, selector: Sel) {
        unsafe { TEST_GUARD.call(receiver, selector) };
    }

    fn test_class() -> &'static AnyClass {
        static CLASS: OnceLock<&'static AnyClass> = OnceLock::new();
        CLASS.get_or_init(|| {
            let mut builder =
                ClassBuilder::new(c"CapExceptionGuardTestObservation", NSObject::class()).unwrap();
            unsafe {
                builder.add_method(
                    sel!(invalidate),
                    cap_test_unbalanced_kvo_removal as unsafe extern "C" fn(*mut AnyObject, Sel),
                );
            }
            builder.register()
        })
    }

    fn removal_calls() -> usize {
        unsafe { cap_test_unbalanced_removal_calls.load(Ordering::SeqCst) }
    }

    #[test]
    fn an_unbalanced_kvo_removal_throws_the_reported_exception() {
        let before = removal_calls();
        let exception = unsafe {
            cap_call_void_imp_catching(
                cap_test_unbalanced_kvo_removal,
                std::ptr::null_mut(),
                sel!(invalidate),
            )
        };
        let exception = unsafe { Retained::from_raw(exception) }
            .expect("removing an unregistered observer must throw");
        let description = describe(&exception);
        assert!(
            description.contains("Cannot remove an observer"),
            "{description}"
        );
        assert!(removal_calls() > before);
    }

    #[test]
    fn a_guarded_method_survives_the_exception_every_time() {
        let class = test_class();
        assert!(TEST_GUARD.install(class, sel!(invalidate), guarded));
        assert!(!TEST_GUARD.install(class, sel!(invalidate), guarded));

        let instance: Retained<NSObject> = unsafe { msg_send![class, new] };
        for _ in 0..3 {
            let before = removal_calls();
            let _: () = unsafe { msg_send![&instance, invalidate] };
            assert!(removal_calls() > before);
        }
    }

    #[test]
    fn appkit_still_has_the_touch_bar_finder_method_this_guards() {
        assert!(
            AnyClass::get(c"NSApplication").is_some(),
            "AppKit is not loaded"
        );
        let class = AnyClass::get(c"_NSTouchBarFinderObservation")
            .expect("AppKit renamed _NSTouchBarFinderObservation; re-check the guard");
        assert!(class.verify_sel::<(), ()>(sel!(invalidate)).is_ok());
    }

    #[test]
    fn a_method_the_class_lacks_is_not_guarded() {
        static MISSING: GuardedMethod = GuardedMethod::new();
        assert!(!MISSING.install(test_class(), sel!(capNoSuchMethod), guarded));
    }
}
