use std::sync::OnceLock;

use objc2::{
    ffi::class_addMethod,
    msg_send,
    runtime::{AnyClass, AnyObject, Bool, Imp, Sel},
    sel,
};

type OcclusionStateFn = unsafe extern "C-unwind" fn(*mut AnyObject, Sel) -> usize;

struct OcclusionShim {
    original: OnceLock<OcclusionStateFn>,
}

impl OcclusionShim {
    const fn new() -> Self {
        Self {
            original: OnceLock::new(),
        }
    }

    fn install(&self, class: &AnyClass, shim: OcclusionStateFn) -> Result<bool, String> {
        if self.original.get().is_some() {
            return Ok(false);
        }

        let selector = sel!(occlusionState);
        class
            .verify_sel::<(), usize>(selector)
            .map_err(|error| error.to_string())?;
        let method = class
            .instance_method(selector)
            .ok_or_else(|| "occlusionState implementation is missing".to_string())?;
        let original =
            unsafe { std::mem::transmute::<Imp, OcclusionStateFn>(method.implementation()) };
        if std::ptr::fn_addr_eq(original, shim) {
            return Err("occlusionState already points to the replacement".to_string());
        }

        // Save the original before publishing the override. Looking up a superclass
        // from the receiver can re-enter this shim through an AppKit dynamic subclass.
        if self.original.set(original).is_err() {
            return Ok(false);
        }
        let added = unsafe {
            class_addMethod(
                (class as *const AnyClass).cast_mut().cast(),
                selector,
                std::mem::transmute::<OcclusionStateFn, Imp>(shim),
                c"Q@:".as_ptr(),
            )
        };
        Ok(added.as_bool())
    }

    unsafe fn state(&self, receiver: *mut AnyObject, selector: Sel) -> usize {
        let Some(original) = self.original.get() else {
            return 0;
        };
        let raw = unsafe { original(receiver, selector) };
        reported_state(raw, ordered_out_windows_keep_raw_state(), || unsafe {
            is_visible(receiver)
        })
    }
}

/// macOS 27 also reports the undocumented bit for ordered-out windows, so
/// lending it the visible bit would keep a hidden window's display link
/// waking the main thread every vsync. `is_visible` is only asked when the
/// answer matters.
fn reported_state(
    raw: usize,
    ordered_out_keeps_raw_state: bool,
    is_visible: impl FnOnce() -> bool,
) -> usize {
    if raw != 0 && (!ordered_out_keeps_raw_state || is_visible()) {
        raw | 0x2
    } else {
        raw
    }
}

pub(super) fn ordered_out_windows_keep_raw_state() -> bool {
    static KEEP_RAW: OnceLock<bool> = OnceLock::new();
    *KEEP_RAW.get_or_init(|| macos_major_version().is_some_and(|major| major >= 27))
}

fn macos_major_version() -> Option<u32> {
    let mut buffer = [0u8; 32];
    let mut len = buffer.len();
    let result = unsafe {
        libc::sysctlbyname(
            c"kern.osproductversion".as_ptr(),
            buffer.as_mut_ptr().cast(),
            &mut len,
            std::ptr::null_mut(),
            0,
        )
    };
    if result != 0 {
        return None;
    }
    let version = std::str::from_utf8(buffer.get(..len)?).ok()?;
    version
        .trim_end_matches('\0')
        .split('.')
        .next()?
        .parse()
        .ok()
}

unsafe fn is_visible(receiver: *mut AnyObject) -> bool {
    let visible: Bool = unsafe { msg_send![receiver, isVisible] };
    visible.as_bool()
}

static WINDOW_SHIM: OcclusionShim = OcclusionShim::new();
static PANEL_SHIM: OcclusionShim = OcclusionShim::new();

unsafe extern "C-unwind" fn window_occlusion_state(
    receiver: *mut AnyObject,
    selector: Sel,
) -> usize {
    unsafe { WINDOW_SHIM.state(receiver, selector) }
}

unsafe extern "C-unwind" fn panel_occlusion_state(
    receiver: *mut AnyObject,
    selector: Sel,
) -> usize {
    unsafe { PANEL_SHIM.state(receiver, selector) }
}

pub(super) fn install() {
    for (name, state, implementation) in [
        (
            c"GPUIWindow",
            &WINDOW_SHIM,
            window_occlusion_state as OcclusionStateFn,
        ),
        (
            c"GPUIPanel",
            &PANEL_SHIM,
            panel_occlusion_state as OcclusionStateFn,
        ),
    ] {
        let Some(class) = AnyClass::get(name) else {
            continue;
        };
        match state.install(class, implementation) {
            Ok(true) => {
                tracing::info!(name = %name.to_string_lossy(), "installed macOS occlusion shim")
            }
            Ok(false) => {}
            Err(error) => {
                tracing::warn!(%error, name = %name.to_string_lossy(), "could not install macOS occlusion shim")
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::{
        cell::Cell,
        ffi::{CStr, CString},
    };

    use objc2::{
        ClassType, msg_send,
        rc::Retained,
        runtime::{ClassBuilder, NSObject},
    };

    use super::*;

    thread_local! {
        static RAW_STATE: Cell<usize> = const { Cell::new(0) };
        static VISIBLE: Cell<bool> = const { Cell::new(true) };
        static WINDOW_CALLS: Cell<usize> = const { Cell::new(0) };
        static PANEL_CALLS: Cell<usize> = const { Cell::new(0) };
    }

    struct Classes {
        window: &'static AnyClass,
        panel: &'static AnyClass,
        inherited_window: &'static AnyClass,
        inherited_panel: &'static AnyClass,
        overridden_window: &'static AnyClass,
        overridden_panel: &'static AnyClass,
    }

    unsafe extern "C-unwind" fn native_window_state(
        _receiver: *mut AnyObject,
        _selector: Sel,
    ) -> usize {
        WINDOW_CALLS.set(WINDOW_CALLS.get() + 1);
        RAW_STATE.get()
    }

    unsafe extern "C-unwind" fn native_is_visible(
        _receiver: *mut AnyObject,
        _selector: Sel,
    ) -> Bool {
        Bool::new(VISIBLE.get())
    }

    unsafe extern "C-unwind" fn native_panel_state(
        _receiver: *mut AnyObject,
        _selector: Sel,
    ) -> usize {
        PANEL_CALLS.set(PANEL_CALLS.get() + 1);
        RAW_STATE.get()
    }

    unsafe extern "C-unwind" fn overriding_window_state(
        receiver: *mut AnyObject,
        _selector: Sel,
    ) -> usize {
        unsafe { msg_send![super(receiver, classes().window), occlusionState] }
    }

    unsafe extern "C-unwind" fn overriding_panel_state(
        receiver: *mut AnyObject,
        _selector: Sel,
    ) -> usize {
        unsafe { msg_send![super(receiver, classes().panel), occlusionState] }
    }

    fn inherit(name: &CStr, superclass: &AnyClass) -> &'static AnyClass {
        ClassBuilder::new(name, superclass).unwrap().register()
    }

    fn with_method(
        name: &CStr,
        superclass: &AnyClass,
        implementation: OcclusionStateFn,
    ) -> &'static AnyClass {
        let mut builder = ClassBuilder::new(name, superclass).unwrap();
        unsafe { builder.add_method(sel!(occlusionState), implementation) };
        builder.register()
    }

    fn classes() -> &'static Classes {
        static CLASSES: OnceLock<Classes> = OnceLock::new();
        CLASSES.get_or_init(|| {
            let native_window = {
                let mut builder =
                    ClassBuilder::new(c"CapOcclusionTestNativeWindow", NSObject::class()).unwrap();
                unsafe {
                    builder.add_method(
                        sel!(occlusionState),
                        native_window_state as OcclusionStateFn,
                    );
                    builder.add_method(
                        sel!(isVisible),
                        native_is_visible as unsafe extern "C-unwind" fn(_, _) -> _,
                    );
                }
                builder.register()
            };
            let native_panel = with_method(
                c"CapOcclusionTestNativePanel",
                native_window,
                native_panel_state,
            );
            let window = inherit(c"CapOcclusionTestWindow", native_window);
            let panel = inherit(c"CapOcclusionTestPanel", native_panel);
            assert!(WINDOW_SHIM.install(window, window_occlusion_state).unwrap());
            assert!(PANEL_SHIM.install(panel, panel_occlusion_state).unwrap());

            let mut inherited_window = window;
            let mut inherited_panel = panel;
            for depth in 0..4 {
                let window_name =
                    CString::new(format!("CapOcclusionTestWindowSubclass{depth}")).unwrap();
                inherited_window = inherit(&window_name, inherited_window);
                let panel_name =
                    CString::new(format!("CapOcclusionTestPanelSubclass{depth}")).unwrap();
                inherited_panel = inherit(&panel_name, inherited_panel);
            }
            let window_override = with_method(
                c"CapOcclusionTestWindowOverride",
                window,
                overriding_window_state,
            );
            let panel_override = with_method(
                c"CapOcclusionTestPanelOverride",
                panel,
                overriding_panel_state,
            );
            Classes {
                window,
                panel,
                inherited_window,
                inherited_panel,
                overridden_window: inherit(
                    c"CapOcclusionTestInheritedWindowOverride",
                    window_override,
                ),
                overridden_panel: inherit(
                    c"CapOcclusionTestInheritedPanelOverride",
                    panel_override,
                ),
            }
        })
    }

    fn verify_states(class: &AnyClass, expected_window_calls: usize, expected_panel_calls: usize) {
        let instance: Retained<NSObject> = unsafe { msg_send![class, new] };
        for visible in [true, false] {
            VISIBLE.set(visible);
            for raw in [0, 0x2, 0x2000, 0x2002] {
                RAW_STATE.set(raw);
                WINDOW_CALLS.set(0);
                PANEL_CALLS.set(0);
                let state: usize = unsafe { msg_send![&*instance, occlusionState] };
                let expected =
                    reported_state(raw, ordered_out_windows_keep_raw_state(), || visible);
                assert_eq!(state, expected);
                assert_eq!(WINDOW_CALLS.get(), expected_window_calls);
                assert_eq!(PANEL_CALLS.get(), expected_panel_calls);
            }
        }
        VISIBLE.set(true);
    }

    #[test]
    fn an_ordered_out_window_keeps_the_raw_state_only_under_the_macos_27_policy() {
        for raw in [0x2, 0x2000, 0x2002] {
            assert_eq!(reported_state(raw, true, || false), raw);
            assert_eq!(reported_state(raw, true, || true), raw | 0x2);
            assert_eq!(reported_state(raw, false, || false), raw | 0x2);
            assert_eq!(reported_state(raw, false, || true), raw | 0x2);
        }
        for keep_raw in [true, false] {
            for visible in [true, false] {
                assert_eq!(reported_state(0, keep_raw, || visible), 0);
            }
        }
    }

    #[test]
    fn visibility_is_only_queried_under_the_macos_27_policy() {
        let asked = Cell::new(0);
        let ask = || {
            asked.set(asked.get() + 1);
            true
        };
        reported_state(0x2000, false, ask);
        reported_state(0, true, ask);
        assert_eq!(asked.get(), 0);
        reported_state(0x2000, true, ask);
        assert_eq!(asked.get(), 1);
    }

    #[test]
    fn windows_and_panels_keep_their_own_native_implementation() {
        verify_states(classes().window, 1, 0);
        verify_states(classes().panel, 0, 1);
    }

    #[test]
    fn inherited_shims_do_not_recurse() {
        verify_states(classes().inherited_window, 1, 0);
        verify_states(classes().inherited_panel, 0, 1);
    }

    #[test]
    fn inherited_overrides_can_call_super_without_reentering_themselves() {
        verify_states(classes().overridden_window, 1, 0);
        verify_states(classes().overridden_panel, 0, 1);
    }

    #[test]
    fn repeated_installation_keeps_the_original_implementation() {
        let classes = classes();
        for _ in 0..10 {
            assert!(
                !WINDOW_SHIM
                    .install(classes.window, window_occlusion_state)
                    .unwrap()
            );
            assert!(
                !PANEL_SHIM
                    .install(classes.panel, panel_occlusion_state)
                    .unwrap()
            );
        }
        verify_states(classes.overridden_window, 1, 0);
        verify_states(classes.overridden_panel, 0, 1);
    }

    #[test]
    fn promoting_a_window_switches_to_the_panel_implementation() {
        let classes = classes();
        let instance: Retained<NSObject> = unsafe { msg_send![classes.window, new] };
        RAW_STATE.set(0x2000);
        WINDOW_CALLS.set(0);
        PANEL_CALLS.set(0);
        let before: usize = unsafe { msg_send![&*instance, occlusionState] };
        assert_eq!(before, 0x2002);

        assert_eq!(
            classes.window.instance_size(),
            classes.panel.instance_size()
        );
        unsafe { AnyObject::set_class(&instance, classes.panel) };
        let after: usize = unsafe { msg_send![&*instance, occlusionState] };
        assert_eq!(after, 0x2002);
        assert_eq!(WINDOW_CALLS.get(), 1);
        assert_eq!(PANEL_CALLS.get(), 1);
    }

    #[test]
    fn incompatible_native_method_does_not_install_a_shim() {
        unsafe extern "C-unwind" fn wrong_signature(
            _receiver: *mut AnyObject,
            _selector: Sel,
        ) -> f64 {
            0.0
        }

        let state = OcclusionShim::new();
        let mut builder =
            ClassBuilder::new(c"CapOcclusionTestWrongSignature", NSObject::class()).unwrap();
        unsafe {
            builder.add_method(
                sel!(occlusionState),
                wrong_signature as unsafe extern "C-unwind" fn(_, _) -> _,
            );
        }
        let class = builder.register();
        assert!(state.install(class, window_occlusion_state).is_err());
        assert!(state.original.get().is_none());
    }

    #[test]
    fn existing_class_override_is_not_replaced() {
        let state = OcclusionShim::new();
        let class = with_method(
            c"CapOcclusionTestExistingOverride",
            NSObject::class(),
            native_window_state,
        );
        assert!(!state.install(class, window_occlusion_state).unwrap());
        let instance: Retained<NSObject> = unsafe { msg_send![class, new] };
        RAW_STATE.set(0x2000);
        let raw: usize = unsafe { msg_send![&*instance, occlusionState] };
        assert_eq!(raw, 0x2000);
    }

    #[test]
    fn missing_native_method_does_not_install_a_shim() {
        let state = OcclusionShim::new();
        let class = inherit(c"CapOcclusionTestMissingMethod", NSObject::class());
        assert!(state.install(class, window_occlusion_state).is_err());
        assert!(state.original.get().is_none());
        assert!(class.instance_method(sel!(occlusionState)).is_none());
    }

    #[test]
    fn an_uninitialized_shim_returns_no_visibility() {
        let state = OcclusionShim::new();
        assert_eq!(
            unsafe { state.state(std::ptr::null_mut(), sel!(occlusionState)) },
            0
        );
    }
}
