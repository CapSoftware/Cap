#[macro_export]
macro_rules! panel_delegate {
    ($delegate_name:ident { $($fn_name:ident),* $(,)* }) => {{
        use $crate::objc::{
            class,
            declare::ClassDecl,
            msg_send,
            runtime::{self, Class, Object, Protocol, Sel},
            sel, sel_impl, Message,
        };
        use $crate::cocoa::base::{id, nil, BOOL, NO};
        use $crate::objc_foundation::INSObject;
        use $crate::objc_id::{Id, ShareId};
        use $crate::raw_nspanel::RawNSPanel;
        use $crate::tauri::Runtime;
        use $crate::block::ConcreteBlock;
        use std::ffi::{c_void, c_char};

        macro_rules! snake_to_camel {
            ($input:ident) => {{
                let mut camel_case = String::new();
                let mut chars = $input.chars().peekable();
                while let Some(c) = chars.next() {
                    if c == '_' {
                        if let Some(next) = chars.peek() {
                            camel_case.push(next.to_ascii_uppercase());
                            chars.next();
                        }
                    } else {
                        camel_case.push(c);
                    }
                }
                camel_case
            }};
        }

        macro_rules! sel_from_func {
            ($func:ident) => ({
                let func_str = stringify!($func);
                let sel_str = snake_to_camel!(func_str);
                sel_impl!(format!("{}:{}", sel_str, '\0').as_str())
            });
        }

        #[allow(dead_code)]
        const DELEGATE_CLS_NAME: &str = stringify!($delegate_name);

        #[allow(dead_code)]
        struct $delegate_name;

        impl $delegate_name {
             #[allow(dead_code)]
            fn get_class() -> &'static Class {
                Class::get(DELEGATE_CLS_NAME).unwrap_or_else(Self::define_class)
            }

            #[allow(dead_code)]
            fn define_class() -> &'static Class {
                let mut cls = ClassDecl::new(DELEGATE_CLS_NAME, class!(NSObject))
                    .unwrap_or_else(|| panic!("Unable to register {} class", DELEGATE_CLS_NAME));

                cls.add_protocol(
                    Protocol::get("NSWindowDelegate").expect("Failed to get NSWindowDelegate protocol"),
                );

                unsafe {
                    cls.add_ivar::<*mut c_void>("_listener");

                    cls.add_method(
                        sel!(setListener:),
                        Self::handle_set_listener as extern "C" fn(&mut Object, Sel, *mut c_void),
                    );

                    $(
                        cls.add_method(
                            sel_from_func!($fn_name),
                            Self::$fn_name as extern "C" fn(&Object, Sel, id),
                        );
                    )*

                    cls.add_method(
                        sel!(dealloc),
                        Self::dealloc as extern "C" fn(&mut Object, Sel),
                    );
                }

                cls.register()
            }

            extern "C" fn handle_set_listener(this: &mut Object, _: Sel, listener: *mut c_void) {
                unsafe { this.set_ivar::<*mut c_void>("_listener", listener) };
            }

            $(
                extern "C" fn $fn_name(this: &Object, _: Sel, _: id) {
                    let delegate_name = std::ffi::CString::new(stringify!($fn_name)).unwrap();
                    let delegate_name_ptr = delegate_name.as_ptr();

                    let listener: *mut c_void = unsafe { *this.get_ivar("_listener") };
                    let listener = listener as *const ConcreteBlock<(*const c_char, BOOL, *mut Object, *mut Sel, *mut c_void), (), ()>;

                    unsafe {
                        (*listener).call((delegate_name_ptr, NO, std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null_mut()));
                    }
                }
            )*

            extern "C" fn dealloc(this: &mut Object, _cmd: Sel) {
                unsafe {
                    let superclass = class!(NSObject);
                    let dealloc: extern "C" fn(&mut Object, Sel) =
                        msg_send![super(this, superclass), dealloc];
                    dealloc(this, _cmd);
                }
            }
        }

        unsafe impl Message for $delegate_name {}

        impl INSObject for $delegate_name {
            fn class() -> &'static runtime::Class {
                Self::get_class()
            }
        }

        impl $delegate_name {
            pub fn set_listener(&self, callback: Box<dyn Fn(String)>) {
                let block = ConcreteBlock::new(move |_delegate_name: *const c_char| {
                    let delegate_name = unsafe { std::ffi::CStr::from_ptr(_delegate_name).to_string_lossy().into_owned() };
                    callback(delegate_name);
                });
                let block = block.copy();
                let _: () = unsafe { msg_send![self, setListener: block] };
            }
        }

        $delegate_name::new()
    }};
}
