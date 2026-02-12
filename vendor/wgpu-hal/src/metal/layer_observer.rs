//! A rewrite of `raw-window-metal` using `objc` instead of `objc2`.
//!
//! See that for details: <https://docs.rs/raw-window-metal/1.1.0/>
//!
//! This should be temporary, see <https://github.com/gfx-rs/wgpu/pull/6210>.

use core::ffi::{c_void, CStr};
use core_graphics_types::base::CGFloat;
use core_graphics_types::geometry::CGRect;
use objc::declare::ClassDecl;
use objc::rc::StrongPtr;
use objc::runtime::{Class, Object, Sel, BOOL, NO};
use objc::{class, msg_send, sel, sel_impl};
use std::sync::OnceLock;

#[link(name = "Foundation", kind = "framework")]
extern "C" {
    static NSKeyValueChangeNewKey: &'static Object;
}

#[allow(non_upper_case_globals)]
const NSKeyValueObservingOptionNew: usize = 0x01;
#[allow(non_upper_case_globals)]
const NSKeyValueObservingOptionInitial: usize = 0x04;

const CONTENTS_SCALE: &CStr = c"contentsScale";
const BOUNDS: &CStr = c"bounds";

/// Create a new custom layer that tracks parameters from the given super layer.
///
/// Same as <https://docs.rs/raw-window-metal/1.1.0/src/raw_window_metal/observer.rs.html#74-132>.
pub unsafe fn new_observer_layer(root_layer: *mut Object) -> StrongPtr {
    let this: *mut Object = unsafe { msg_send![class(), new] };

    // Add the layer as a sublayer of the root layer.
    let _: () = unsafe { msg_send![root_layer, addSublayer: this] };

    // Register for key-value observing.
    let key_path: *const Object =
        unsafe { msg_send![class!(NSString), stringWithUTF8String: CONTENTS_SCALE.as_ptr()] };
    let _: () = unsafe {
        msg_send![
            root_layer,
            addObserver: this
            forKeyPath: key_path
            options: NSKeyValueObservingOptionNew | NSKeyValueObservingOptionInitial
            context: context_ptr()
        ]
    };

    let key_path: *const Object =
        unsafe { msg_send![class!(NSString), stringWithUTF8String: BOUNDS.as_ptr()] };
    let _: () = unsafe {
        msg_send![
            root_layer,
            addObserver: this
            forKeyPath: key_path
            options: NSKeyValueObservingOptionNew | NSKeyValueObservingOptionInitial
            context: context_ptr()
        ]
    };

    // Uncomment when debugging resize issues.
    // extern "C" {
    //     static kCAGravityTopLeft: *mut Object;
    // }
    // let _: () = unsafe { msg_send![this, setContentsGravity: kCAGravityTopLeft] };

    unsafe { StrongPtr::new(this) }
}

/// Same as <https://docs.rs/raw-window-metal/1.1.0/src/raw_window_metal/observer.rs.html#74-132>.
fn class() -> &'static Class {
    static CLASS: OnceLock<&'static Class> = OnceLock::new();

    CLASS.get_or_init(|| {
        let superclass = class!(CAMetalLayer);
        let class_name = format!("WgpuObserverLayer@{:p}", &CLASS);
        let mut decl = ClassDecl::new(&class_name, superclass).unwrap();

        // From NSKeyValueObserving.
        let sel = sel!(observeValueForKeyPath:ofObject:change:context:);
        let method: extern "C" fn(
            &Object,
            Sel,
            *mut Object,
            *mut Object,
            *mut Object,
            *mut c_void,
        ) = observe_value;
        unsafe { decl.add_method(sel, method) };

        let sel = sel!(dealloc);
        let method: extern "C" fn(&Object, Sel) = dealloc;
        unsafe { decl.add_method(sel, method) };

        decl.register()
    })
}

/// The unique context pointer for this class.
fn context_ptr() -> *mut c_void {
    let ptr: *const Class = class();
    ptr.cast_mut().cast()
}

/// Same as <https://docs.rs/raw-window-metal/1.1.0/src/raw_window_metal/observer.rs.html#74-132>.
extern "C" fn observe_value(
    this: &Object,
    _cmd: Sel,
    key_path: *mut Object,
    object: *mut Object,
    change: *mut Object,
    context: *mut c_void,
) {
    // An unrecognized context must belong to the super class.
    if context != context_ptr() {
        // SAFETY: The signature is correct, and it's safe to forward to
        // the superclass' method when we're overriding the method.
        return unsafe {
            msg_send![
                super(this, class!(CAMetalLayer)),
                observeValueForKeyPath: key_path
                ofObject: object
                change: change
                context: context
            ]
        };
    }

    assert!(!change.is_null());

    let key = unsafe { NSKeyValueChangeNewKey };
    let new: *mut Object = unsafe { msg_send![change, objectForKey: key] };
    assert!(!new.is_null());

    let to_compare: *const Object =
        unsafe { msg_send![class!(NSString), stringWithUTF8String: CONTENTS_SCALE.as_ptr()] };
    let is_equal: BOOL = unsafe { msg_send![key_path, isEqual: to_compare] };
    if is_equal != NO {
        // `contentsScale` is a CGFloat, and so the observed value is always a NSNumber.
        let scale_factor: CGFloat = if cfg!(target_pointer_width = "64") {
            unsafe { msg_send![new, doubleValue] }
        } else {
            unsafe { msg_send![new, floatValue] }
        };

        // Set the scale factor of the layer to match the root layer.
        let _: () = unsafe { msg_send![this, setContentsScale: scale_factor] };
        return;
    }

    let to_compare: *const Object =
        unsafe { msg_send![class!(NSString), stringWithUTF8String: BOUNDS.as_ptr()] };
    let is_equal: BOOL = unsafe { msg_send![key_path, isEqual: to_compare] };
    if is_equal != NO {
        // `bounds` is a CGRect, and so the observed value is always a NSNumber.
        let bounds: CGRect = unsafe { msg_send![new, rectValue] };

        // Set `bounds` and `position` to match the root layer.
        //
        // This differs from just setting the `bounds`, as it also takes into account any
        // translation that the superlayer may have that we'd want to preserve.
        let _: () = unsafe { msg_send![this, setFrame: bounds] };
        return;
    }

    panic!("unknown observed keypath {key_path:?}");
}

extern "C" fn dealloc(this: &Object, _cmd: Sel) {
    // Load the root layer if it still exists, and deregister the observer.
    //
    // This is not entirely sound, as the ObserverLayer _could_ have been
    // moved to another layer; but Wgpu doesn't do that, so it should be fine.
    //
    // `raw-window-metal` uses a weak instance variable to do it correctly:
    // https://docs.rs/raw-window-metal/1.1.0/src/raw_window_metal/observer.rs.html#74-132
    // (but that's difficult to do with `objc`).
    let root_layer: *mut Object = unsafe { msg_send![this, superlayer] };
    if !root_layer.is_null() {
        let key_path: *const Object =
            unsafe { msg_send![class!(NSString), stringWithUTF8String: CONTENTS_SCALE.as_ptr()] };
        let _: () = unsafe { msg_send![root_layer, removeObserver: this forKeyPath: key_path] };

        let key_path: *const Object =
            unsafe { msg_send![class!(NSString), stringWithUTF8String: BOUNDS.as_ptr()] };
        let _: () = unsafe { msg_send![root_layer, removeObserver: this forKeyPath: key_path] };
    }
}
