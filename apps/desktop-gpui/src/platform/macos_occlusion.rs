use std::sync::OnceLock;

use objc2::{
    ffi::class_addMethod,
    runtime::{AnyClass, AnyObject, Bool, Imp, Sel},
    sel,
};

type OcclusionStateFn = unsafe extern "C" fn(*mut AnyObject, Sel) -> usize;

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
                selector.as_ptr(),
                Some(std::mem::transmute::<
                    OcclusionStateFn,
                    unsafe extern "C" fn(),
                >(shim)),
                c"Q@:".as_ptr(),
            )
        };
        Ok(Bool::from_raw(added).as_bool())
    }

    unsafe fn state(&self, receiver: *mut AnyObject, selector: Sel) -> usize {
        let Some(original) = self.original.get() else {
            return 0;
        };
        let raw = unsafe { original(receiver, selector) };
        if raw != 0 { raw | 0x2 } else { raw }
    }
}

static WINDOW_SHIM: OcclusionShim = OcclusionShim::new();
static PANEL_SHIM: OcclusionShim = OcclusionShim::new();

unsafe extern "C" fn window_occlusion_state(receiver: *mut AnyObject, selector: Sel) -> usize {
    unsafe { WINDOW_SHIM.state(receiver, selector) }
}

unsafe extern "C" fn panel_occlusion_state(receiver: *mut AnyObject, selector: Sel) -> usize {
    unsafe { PANEL_SHIM.state(receiver, selector) }
}

pub(super) fn install() {
    for (name, state, implementation) in [
        (
            "GPUIWindow",
            &WINDOW_SHIM,
            window_occlusion_state as OcclusionStateFn,
        ),
        (
            "GPUIPanel",
            &PANEL_SHIM,
            panel_occlusion_state as OcclusionStateFn,
        ),
    ] {
        let Some(class) = AnyClass::get(name) else {
            continue;
        };
        match state.install(class, implementation) {
            Ok(true) => tracing::info!("installed macOS occlusion shim on {name}"),
            Ok(false) => {}
            Err(error) => tracing::warn!(%error, name, "could not install macOS occlusion shim"),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;

    use objc2::{
        ClassType, msg_send, msg_send_id,
        rc::Id,
        runtime::{ClassBuilder, NSObject},
    };

    use super::*;

    thread_local! {
        static RAW_STATE: Cell<usize> = const { Cell::new(0) };
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

    unsafe extern "C" fn native_window_state(_receiver: *mut AnyObject, _selector: Sel) -> usize {
        WINDOW_CALLS.set(WINDOW_CALLS.get() + 1);
        RAW_STATE.get()
    }

    unsafe extern "C" fn native_panel_state(_receiver: *mut AnyObject, _selector: Sel) -> usize {
        PANEL_CALLS.set(PANEL_CALLS.get() + 1);
        RAW_STATE.get()
    }

    unsafe extern "C" fn overriding_window_state(
        receiver: *mut AnyObject,
        _selector: Sel,
    ) -> usize {
        unsafe { msg_send![super(receiver, classes().window), occlusionState] }
    }

    unsafe extern "C" fn overriding_panel_state(receiver: *mut AnyObject, _selector: Sel) -> usize {
        unsafe { msg_send![super(receiver, classes().panel), occlusionState] }
    }

    fn inherit(name: &str, superclass: &AnyClass) -> &'static AnyClass {
        ClassBuilder::new(name, superclass).unwrap().register()
    }

    fn with_method(
        name: &str,
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
            let native_window = with_method(
                "CapOcclusionTestNativeWindow",
                NSObject::class(),
                native_window_state,
            );
            let native_panel = with_method(
                "CapOcclusionTestNativePanel",
                native_window,
                native_panel_state,
            );
            let window = inherit("CapOcclusionTestWindow", native_window);
            let panel = inherit("CapOcclusionTestPanel", native_panel);
            assert!(WINDOW_SHIM.install(window, window_occlusion_state).unwrap());
            assert!(PANEL_SHIM.install(panel, panel_occlusion_state).unwrap());

            let mut inherited_window = window;
            let mut inherited_panel = panel;
            for depth in 0..4 {
                inherited_window = inherit(
                    &format!("CapOcclusionTestWindowSubclass{depth}"),
                    inherited_window,
                );
                inherited_panel = inherit(
                    &format!("CapOcclusionTestPanelSubclass{depth}"),
                    inherited_panel,
                );
            }
            let window_override = with_method(
                "CapOcclusionTestWindowOverride",
                window,
                overriding_window_state,
            );
            let panel_override = with_method(
                "CapOcclusionTestPanelOverride",
                panel,
                overriding_panel_state,
            );
            Classes {
                window,
                panel,
                inherited_window,
                inherited_panel,
                overridden_window: inherit(
                    "CapOcclusionTestInheritedWindowOverride",
                    window_override,
                ),
                overridden_panel: inherit("CapOcclusionTestInheritedPanelOverride", panel_override),
            }
        })
    }

    fn verify_states(class: &AnyClass, expected_window_calls: usize, expected_panel_calls: usize) {
        let instance: Id<NSObject> = unsafe { msg_send_id![class, new] };
        for raw in [0, 0x2, 0x2000, 0x2002] {
            RAW_STATE.set(raw);
            WINDOW_CALLS.set(0);
            PANEL_CALLS.set(0);
            let state: usize = unsafe { msg_send![&*instance, occlusionState] };
            assert_eq!(state, if raw != 0 { raw | 0x2 } else { raw });
            assert_eq!(WINDOW_CALLS.get(), expected_window_calls);
            assert_eq!(PANEL_CALLS.get(), expected_panel_calls);
        }
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
        let instance: Id<NSObject> = unsafe { msg_send_id![classes.window, new] };
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
        unsafe extern "C" fn wrong_signature(_receiver: *mut AnyObject, _selector: Sel) -> f64 {
            0.0
        }

        let state = OcclusionShim::new();
        let mut builder =
            ClassBuilder::new("CapOcclusionTestWrongSignature", NSObject::class()).unwrap();
        unsafe {
            builder.add_method(
                sel!(occlusionState),
                wrong_signature as unsafe extern "C" fn(_, _) -> _,
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
            "CapOcclusionTestExistingOverride",
            NSObject::class(),
            native_window_state,
        );
        assert!(!state.install(class, window_occlusion_state).unwrap());
        let instance: Id<NSObject> = unsafe { msg_send_id![class, new] };
        RAW_STATE.set(0x2000);
        let raw: usize = unsafe { msg_send![&*instance, occlusionState] };
        assert_eq!(raw, 0x2000);
    }

    #[test]
    fn missing_native_method_does_not_install_a_shim() {
        let state = OcclusionShim::new();
        let class = inherit("CapOcclusionTestMissingMethod", NSObject::class());
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
