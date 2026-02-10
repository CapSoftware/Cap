#![allow(clippy::std_instead_of_alloc, clippy::std_instead_of_core)]

use std::{
    ffi,
    mem::ManuallyDrop,
    os::raw,
    ptr,
    rc::Rc,
    string::String,
    sync::{Arc, LazyLock},
    time::Duration,
    vec::Vec,
};

use glow::HasContext;
use hashbrown::HashMap;
use parking_lot::{MappedMutexGuard, Mutex, MutexGuard, RwLock};

/// The amount of time to wait while trying to obtain a lock to the adapter context
const CONTEXT_LOCK_TIMEOUT_SECS: u64 = 1;

const EGL_CONTEXT_FLAGS_KHR: i32 = 0x30FC;
const EGL_CONTEXT_OPENGL_DEBUG_BIT_KHR: i32 = 0x0001;
const EGL_CONTEXT_OPENGL_ROBUST_ACCESS_EXT: i32 = 0x30BF;
const EGL_PLATFORM_WAYLAND_KHR: u32 = 0x31D8;
const EGL_PLATFORM_X11_KHR: u32 = 0x31D5;
const EGL_PLATFORM_ANGLE_ANGLE: u32 = 0x3202;
const EGL_PLATFORM_ANGLE_NATIVE_PLATFORM_TYPE_ANGLE: u32 = 0x348F;
const EGL_PLATFORM_ANGLE_DEBUG_LAYERS_ENABLED: u32 = 0x3451;
const EGL_PLATFORM_SURFACELESS_MESA: u32 = 0x31DD;
const EGL_GL_COLORSPACE_KHR: u32 = 0x309D;
const EGL_GL_COLORSPACE_SRGB_KHR: u32 = 0x3089;

type XOpenDisplayFun =
    unsafe extern "system" fn(display_name: *const raw::c_char) -> *mut raw::c_void;

type XCloseDisplayFun = unsafe extern "system" fn(display: *mut raw::c_void) -> raw::c_int;

type WlDisplayConnectFun =
    unsafe extern "system" fn(display_name: *const raw::c_char) -> *mut raw::c_void;

type WlDisplayDisconnectFun = unsafe extern "system" fn(display: *const raw::c_void);

#[cfg(not(Emscripten))]
type EglInstance = khronos_egl::DynamicInstance<khronos_egl::EGL1_4>;

#[cfg(Emscripten)]
type EglInstance = khronos_egl::Instance<khronos_egl::Static>;

type WlEglWindowCreateFun = unsafe extern "system" fn(
    surface: *const raw::c_void,
    width: raw::c_int,
    height: raw::c_int,
) -> *mut raw::c_void;

type WlEglWindowResizeFun = unsafe extern "system" fn(
    window: *const raw::c_void,
    width: raw::c_int,
    height: raw::c_int,
    dx: raw::c_int,
    dy: raw::c_int,
);

type WlEglWindowDestroyFun = unsafe extern "system" fn(window: *const raw::c_void);

type EglLabel = *const raw::c_void;

#[allow(clippy::upper_case_acronyms)]
type EGLDEBUGPROCKHR = Option<
    unsafe extern "system" fn(
        error: khronos_egl::Enum,
        command: *const raw::c_char,
        message_type: u32,
        thread_label: EglLabel,
        object_label: EglLabel,
        message: *const raw::c_char,
    ),
>;

const EGL_DEBUG_MSG_CRITICAL_KHR: u32 = 0x33B9;
const EGL_DEBUG_MSG_ERROR_KHR: u32 = 0x33BA;
const EGL_DEBUG_MSG_WARN_KHR: u32 = 0x33BB;
const EGL_DEBUG_MSG_INFO_KHR: u32 = 0x33BC;

type EglDebugMessageControlFun = unsafe extern "system" fn(
    proc: EGLDEBUGPROCKHR,
    attrib_list: *const khronos_egl::Attrib,
) -> raw::c_int;

unsafe extern "system" fn egl_debug_proc(
    error: khronos_egl::Enum,
    command_raw: *const raw::c_char,
    message_type: u32,
    _thread_label: EglLabel,
    _object_label: EglLabel,
    message_raw: *const raw::c_char,
) {
    let log_severity = match message_type {
        EGL_DEBUG_MSG_CRITICAL_KHR | EGL_DEBUG_MSG_ERROR_KHR => log::Level::Error,
        EGL_DEBUG_MSG_WARN_KHR => log::Level::Warn,
        EGL_DEBUG_MSG_INFO_KHR => log::Level::Info,
        _ => log::Level::Debug,
    };
    let command = unsafe { ffi::CStr::from_ptr(command_raw) }.to_string_lossy();
    let message = if message_raw.is_null() {
        "".into()
    } else {
        unsafe { ffi::CStr::from_ptr(message_raw) }.to_string_lossy()
    };

    log::log!(
        log_severity,
        "EGL '{}' code 0x{:x}: {}",
        command,
        error,
        message,
    );
}

/// A simple wrapper around an X11 or Wayland display handle.
/// Since the logic in this file doesn't actually need to directly
/// persist a wayland connection handle, the only load-bearing
/// enum variant is the X11 variant
#[derive(Debug)]
enum DisplayRef {
    X11(ptr::NonNull<raw::c_void>),
    Wayland,
}

impl DisplayRef {
    /// Convenience for getting the underlying pointer
    fn as_ptr(&self) -> *mut raw::c_void {
        match *self {
            Self::X11(ptr) => ptr.as_ptr(),
            Self::Wayland => unreachable!(),
        }
    }
}

/// DisplayOwner ties the lifetime of the system display handle
/// to that of the loaded library.
/// It implements Drop to ensure that the display handle is closed
/// prior to unloading the library so that we don't leak the
/// associated file descriptors
#[derive(Debug)]
struct DisplayOwner {
    library: libloading::Library,
    display: DisplayRef,
}

impl Drop for DisplayOwner {
    fn drop(&mut self) {
        match self.display {
            DisplayRef::X11(ptr) => unsafe {
                let func: libloading::Symbol<XCloseDisplayFun> =
                    self.library.get(c"XCloseDisplay".to_bytes()).unwrap();
                func(ptr.as_ptr());
            },
            DisplayRef::Wayland => {}
        }
    }
}

fn open_x_display() -> Option<DisplayOwner> {
    log::debug!("Loading X11 library to get the current display");
    unsafe {
        let library = find_library(&["libX11.so.6", "libX11.so"])?;
        let func: libloading::Symbol<XOpenDisplayFun> =
            library.get(c"XOpenDisplay".to_bytes()).unwrap();
        let result = func(ptr::null());
        ptr::NonNull::new(result).map(|ptr| DisplayOwner {
            display: DisplayRef::X11(ptr),
            library,
        })
    }
}

unsafe fn find_library(paths: &[&str]) -> Option<libloading::Library> {
    for path in paths {
        match unsafe { libloading::Library::new(path) } {
            Ok(lib) => return Some(lib),
            _ => continue,
        };
    }
    None
}

fn test_wayland_display() -> Option<DisplayOwner> {
    /* We try to connect and disconnect here to simply ensure there
     * is an active wayland display available.
     */
    log::debug!("Loading Wayland library to get the current display");
    let library = unsafe {
        let client_library = find_library(&["libwayland-client.so.0", "libwayland-client.so"])?;
        let wl_display_connect: libloading::Symbol<WlDisplayConnectFun> = client_library
            .get(c"wl_display_connect".to_bytes())
            .unwrap();
        let wl_display_disconnect: libloading::Symbol<WlDisplayDisconnectFun> = client_library
            .get(c"wl_display_disconnect".to_bytes())
            .unwrap();
        let display = ptr::NonNull::new(wl_display_connect(ptr::null()))?;
        wl_display_disconnect(display.as_ptr());
        find_library(&["libwayland-egl.so.1", "libwayland-egl.so"])?
    };
    Some(DisplayOwner {
        library,
        display: DisplayRef::Wayland,
    })
}

#[derive(Clone, Copy, Debug)]
enum SrgbFrameBufferKind {
    /// No support for SRGB surface
    None,
    /// Using EGL 1.5's support for colorspaces
    Core,
    /// Using EGL_KHR_gl_colorspace
    Khr,
}

/// Choose GLES framebuffer configuration.
fn choose_config(
    egl: &EglInstance,
    display: khronos_egl::Display,
    srgb_kind: SrgbFrameBufferKind,
) -> Result<(khronos_egl::Config, bool), crate::InstanceError> {
    //TODO: EGL_SLOW_CONFIG
    let tiers = [
        (
            "off-screen",
            &[
                khronos_egl::SURFACE_TYPE,
                khronos_egl::PBUFFER_BIT,
                khronos_egl::RENDERABLE_TYPE,
                khronos_egl::OPENGL_ES2_BIT,
            ][..],
        ),
        (
            "presentation",
            &[khronos_egl::SURFACE_TYPE, khronos_egl::WINDOW_BIT][..],
        ),
        #[cfg(not(target_os = "android"))]
        (
            "native-render",
            &[khronos_egl::NATIVE_RENDERABLE, khronos_egl::TRUE as _][..],
        ),
    ];

    let mut attributes = Vec::with_capacity(9);
    for tier_max in (0..tiers.len()).rev() {
        let name = tiers[tier_max].0;
        log::debug!("\tTrying {}", name);

        attributes.clear();
        for &(_, tier_attr) in tiers[..=tier_max].iter() {
            attributes.extend_from_slice(tier_attr);
        }
        // make sure the Alpha is enough to support sRGB
        match srgb_kind {
            SrgbFrameBufferKind::None => {}
            _ => {
                attributes.push(khronos_egl::ALPHA_SIZE);
                attributes.push(8);
            }
        }
        attributes.push(khronos_egl::NONE);

        match egl.choose_first_config(display, &attributes) {
            Ok(Some(config)) => {
                if tier_max == 1 {
                    //Note: this has been confirmed to malfunction on Intel+NV laptops,
                    // but also on Angle.
                    log::warn!("EGL says it can present to the window but not natively",);
                }
                // Android emulator can't natively present either.
                let tier_threshold =
                    if cfg!(target_os = "android") || cfg!(windows) || cfg!(target_env = "ohos") {
                        1
                    } else {
                        2
                    };
                return Ok((config, tier_max >= tier_threshold));
            }
            Ok(None) => {
                log::warn!("No config found!");
            }
            Err(e) => {
                log::error!("error in choose_first_config: {:?}", e);
            }
        }
    }

    // TODO: include diagnostic details that are currently logged
    Err(crate::InstanceError::new(String::from(
        "unable to find an acceptable EGL framebuffer configuration",
    )))
}

#[derive(Clone, Debug)]
struct EglContext {
    instance: Arc<EglInstance>,
    version: (i32, i32),
    display: khronos_egl::Display,
    raw: khronos_egl::Context,
    pbuffer: Option<khronos_egl::Surface>,
}

impl EglContext {
    fn make_current(&self) {
        self.instance
            .make_current(self.display, self.pbuffer, self.pbuffer, Some(self.raw))
            .unwrap();
    }

    fn unmake_current(&self) {
        self.instance
            .make_current(self.display, None, None, None)
            .unwrap();
    }
}

/// A wrapper around a [`glow::Context`] and the required EGL context that uses locking to guarantee
/// exclusive access when shared with multiple threads.
pub struct AdapterContext {
    glow: Mutex<ManuallyDrop<glow::Context>>,
    egl: Option<EglContext>,
}

unsafe impl Sync for AdapterContext {}
unsafe impl Send for AdapterContext {}

impl AdapterContext {
    pub fn is_owned(&self) -> bool {
        self.egl.is_some()
    }

    /// Returns the EGL instance.
    ///
    /// This provides access to EGL functions and the ability to load GL and EGL extension functions.
    pub fn egl_instance(&self) -> Option<&EglInstance> {
        self.egl.as_ref().map(|egl| &*egl.instance)
    }

    /// Returns the EGLDisplay corresponding to the adapter context.
    ///
    /// Returns [`None`] if the adapter was externally created.
    pub fn raw_display(&self) -> Option<&khronos_egl::Display> {
        self.egl.as_ref().map(|egl| &egl.display)
    }

    /// Returns the EGL version the adapter context was created with.
    ///
    /// Returns [`None`] if the adapter was externally created.
    pub fn egl_version(&self) -> Option<(i32, i32)> {
        self.egl.as_ref().map(|egl| egl.version)
    }

    pub fn raw_context(&self) -> *mut raw::c_void {
        match self.egl {
            Some(ref egl) => egl.raw.as_ptr(),
            None => ptr::null_mut(),
        }
    }
}

impl Drop for AdapterContext {
    fn drop(&mut self) {
        struct CurrentGuard<'a>(&'a EglContext);
        impl Drop for CurrentGuard<'_> {
            fn drop(&mut self) {
                self.0.unmake_current();
            }
        }

        // Context must be current when dropped. See safety docs on
        // `glow::HasContext`.
        //
        // NOTE: This is only set to `None` by `Adapter::new_external` which
        // requires the context to be current when anything that may be holding
        // the `Arc<AdapterShared>` is dropped.
        let _guard = self.egl.as_ref().map(|egl| {
            egl.make_current();
            CurrentGuard(egl)
        });
        let glow = self.glow.get_mut();
        // SAFETY: Field not used after this.
        unsafe { ManuallyDrop::drop(glow) };
    }
}

struct EglContextLock<'a> {
    instance: &'a Arc<EglInstance>,
    display: khronos_egl::Display,
}

/// A guard containing a lock to an [`AdapterContext`], while the GL context is kept current.
pub struct AdapterContextLock<'a> {
    glow: MutexGuard<'a, ManuallyDrop<glow::Context>>,
    egl: Option<EglContextLock<'a>>,
}

impl<'a> std::ops::Deref for AdapterContextLock<'a> {
    type Target = glow::Context;

    fn deref(&self) -> &Self::Target {
        &self.glow
    }
}

impl<'a> Drop for AdapterContextLock<'a> {
    fn drop(&mut self) {
        if let Some(egl) = self.egl.take() {
            egl.instance
                .make_current(egl.display, None, None, None)
                .unwrap();
        }
    }
}

impl AdapterContext {
    /// Get's the [`glow::Context`] without waiting for a lock
    ///
    /// # Safety
    ///
    /// This should only be called when you have manually made sure that the current thread has made
    /// the EGL context current and that no other thread also has the EGL context current.
    /// Additionally, you must manually make the EGL context **not** current after you are done with
    /// it, so that future calls to `lock()` will not fail.
    ///
    /// > **Note:** Calling this function **will** still lock the [`glow::Context`] which adds an
    /// > extra safe-guard against accidental concurrent access to the context.
    pub unsafe fn get_without_egl_lock(&self) -> MappedMutexGuard<glow::Context> {
        let guard = self
            .glow
            .try_lock_for(Duration::from_secs(CONTEXT_LOCK_TIMEOUT_SECS))
            .expect("Could not lock adapter context. This is most-likely a deadlock.");
        MutexGuard::map(guard, |glow| &mut **glow)
    }

    /// Obtain a lock to the EGL context and get handle to the [`glow::Context`] that can be used to
    /// do rendering.
    #[track_caller]
    pub fn lock<'a>(&'a self) -> AdapterContextLock<'a> {
        let glow = self
            .glow
            // Don't lock forever. If it takes longer than 1 second to get the lock we've got a
            // deadlock and should panic to show where we got stuck
            .try_lock_for(Duration::from_secs(CONTEXT_LOCK_TIMEOUT_SECS))
            .expect("Could not lock adapter context. This is most-likely a deadlock.");

        let egl = self.egl.as_ref().map(|egl| {
            egl.make_current();
            EglContextLock {
                instance: &egl.instance,
                display: egl.display,
            }
        });

        AdapterContextLock { glow, egl }
    }
}

#[derive(Debug)]
struct Inner {
    /// Note: the context contains a dummy pbuffer (1x1).
    /// Required for `eglMakeCurrent` on platforms that doesn't supports `EGL_KHR_surfaceless_context`.
    egl: EglContext,
    #[allow(unused)]
    version: (i32, i32),
    supports_native_window: bool,
    config: khronos_egl::Config,
    #[cfg_attr(Emscripten, allow(dead_code))]
    wl_display: Option<*mut raw::c_void>,
    #[cfg_attr(Emscripten, allow(dead_code))]
    force_gles_minor_version: wgt::Gles3MinorVersion,
    /// Method by which the framebuffer should support srgb
    srgb_kind: SrgbFrameBufferKind,
}

// Different calls to `eglGetPlatformDisplay` may return the same `Display`, making it a global
// state of all our `EglContext`s. This forces us to track the number of such context to prevent
// terminating the display if it's currently used by another `EglContext`.
static DISPLAYS_REFERENCE_COUNT: LazyLock<Mutex<HashMap<usize, usize>>> =
    LazyLock::new(Default::default);

fn initialize_display(
    egl: &EglInstance,
    display: khronos_egl::Display,
) -> Result<(i32, i32), khronos_egl::Error> {
    let mut guard = DISPLAYS_REFERENCE_COUNT.lock();
    *guard.entry(display.as_ptr() as usize).or_default() += 1;

    // We don't need to check the reference count here since according to the `eglInitialize`
    // documentation, initializing an already initialized EGL display connection has no effect
    // besides returning the version numbers.
    egl.initialize(display)
}

fn terminate_display(
    egl: &EglInstance,
    display: khronos_egl::Display,
) -> Result<(), khronos_egl::Error> {
    let key = &(display.as_ptr() as usize);
    let mut guard = DISPLAYS_REFERENCE_COUNT.lock();
    let count_ref = guard
        .get_mut(key)
        .expect("Attempted to decref a display before incref was called");

    if *count_ref > 1 {
        *count_ref -= 1;

        Ok(())
    } else {
        guard.remove(key);

        egl.terminate(display)
    }
}

impl Inner {
    fn create(
        flags: wgt::InstanceFlags,
        egl: Arc<EglInstance>,
        display: khronos_egl::Display,
        force_gles_minor_version: wgt::Gles3MinorVersion,
    ) -> Result<Self, crate::InstanceError> {
        let version = initialize_display(&egl, display).map_err(|e| {
            crate::InstanceError::with_source(
                String::from("failed to initialize EGL display connection"),
                e,
            )
        })?;
        let vendor = egl
            .query_string(Some(display), khronos_egl::VENDOR)
            .unwrap();
        let display_extensions = egl
            .query_string(Some(display), khronos_egl::EXTENSIONS)
            .unwrap()
            .to_string_lossy();
        log::debug!("Display vendor {:?}, version {:?}", vendor, version,);
        log::debug!(
            "Display extensions: {:#?}",
            display_extensions.split_whitespace().collect::<Vec<_>>()
        );

        let srgb_kind = if version >= (1, 5) {
            log::debug!("\tEGL surface: +srgb");
            SrgbFrameBufferKind::Core
        } else if display_extensions.contains("EGL_KHR_gl_colorspace") {
            log::debug!("\tEGL surface: +srgb khr");
            SrgbFrameBufferKind::Khr
        } else {
            log::warn!("\tEGL surface: -srgb");
            SrgbFrameBufferKind::None
        };

        if log::max_level() >= log::LevelFilter::Trace {
            log::trace!("Configurations:");
            let config_count = egl.get_config_count(display).unwrap();
            let mut configurations = Vec::with_capacity(config_count);
            egl.get_configs(display, &mut configurations).unwrap();
            for &config in configurations.iter() {
                log::trace!("\tCONFORMANT=0x{:X}, RENDERABLE=0x{:X}, NATIVE_RENDERABLE=0x{:X}, SURFACE_TYPE=0x{:X}, ALPHA_SIZE={}",
                    egl.get_config_attrib(display, config, khronos_egl::CONFORMANT).unwrap(),
                    egl.get_config_attrib(display, config, khronos_egl::RENDERABLE_TYPE).unwrap(),
                    egl.get_config_attrib(display, config, khronos_egl::NATIVE_RENDERABLE).unwrap(),
                    egl.get_config_attrib(display, config, khronos_egl::SURFACE_TYPE).unwrap(),
                    egl.get_config_attrib(display, config, khronos_egl::ALPHA_SIZE).unwrap(),
                );
            }
        }

        let (config, supports_native_window) = choose_config(&egl, display, srgb_kind)?;

        let supports_opengl = if version >= (1, 4) {
            let client_apis = egl
                .query_string(Some(display), khronos_egl::CLIENT_APIS)
                .unwrap()
                .to_string_lossy();
            client_apis
                .split(' ')
                .any(|client_api| client_api == "OpenGL")
        } else {
            false
        };
        egl.bind_api(if supports_opengl {
            khronos_egl::OPENGL_API
        } else {
            khronos_egl::OPENGL_ES_API
        })
        .unwrap();

        let needs_robustness = true;
        let mut khr_context_flags = 0;
        let supports_khr_context = display_extensions.contains("EGL_KHR_create_context");

        let mut context_attributes = vec![];
        let mut gl_context_attributes = vec![];
        let mut gles_context_attributes = vec![];
        gl_context_attributes.push(khronos_egl::CONTEXT_MAJOR_VERSION);
        gl_context_attributes.push(3);
        gl_context_attributes.push(khronos_egl::CONTEXT_MINOR_VERSION);
        gl_context_attributes.push(3);
        if supports_opengl && force_gles_minor_version != wgt::Gles3MinorVersion::Automatic {
            log::warn!("Ignoring specified GLES minor version as OpenGL is used");
        }
        gles_context_attributes.push(khronos_egl::CONTEXT_MAJOR_VERSION);
        gles_context_attributes.push(3); // Request GLES 3.0 or higher
        if force_gles_minor_version != wgt::Gles3MinorVersion::Automatic {
            gles_context_attributes.push(khronos_egl::CONTEXT_MINOR_VERSION);
            gles_context_attributes.push(match force_gles_minor_version {
                wgt::Gles3MinorVersion::Automatic => unreachable!(),
                wgt::Gles3MinorVersion::Version0 => 0,
                wgt::Gles3MinorVersion::Version1 => 1,
                wgt::Gles3MinorVersion::Version2 => 2,
            });
        }
        if flags.contains(wgt::InstanceFlags::DEBUG) {
            if version >= (1, 5) {
                log::debug!("\tEGL context: +debug");
                context_attributes.push(khronos_egl::CONTEXT_OPENGL_DEBUG);
                context_attributes.push(khronos_egl::TRUE as _);
            } else if supports_khr_context {
                log::debug!("\tEGL context: +debug KHR");
                khr_context_flags |= EGL_CONTEXT_OPENGL_DEBUG_BIT_KHR;
            } else {
                log::debug!("\tEGL context: -debug");
            }
        }
        if needs_robustness {
            //Note: the core version can fail if robustness is not supported
            // (regardless of whether the extension is supported!).
            // In fact, Angle does precisely that awful behavior, so we don't try it there.
            if version >= (1, 5) && !display_extensions.contains("EGL_ANGLE_") {
                log::debug!("\tEGL context: +robust access");
                context_attributes.push(khronos_egl::CONTEXT_OPENGL_ROBUST_ACCESS);
                context_attributes.push(khronos_egl::TRUE as _);
            } else if display_extensions.contains("EGL_EXT_create_context_robustness") {
                log::debug!("\tEGL context: +robust access EXT");
                context_attributes.push(EGL_CONTEXT_OPENGL_ROBUST_ACCESS_EXT);
                context_attributes.push(khronos_egl::TRUE as _);
            } else {
                //Note: we aren't trying `EGL_CONTEXT_OPENGL_ROBUST_ACCESS_BIT_KHR`
                // because it's for desktop GL only, not GLES.
                log::warn!("\tEGL context: -robust access");
            }
        }
        if khr_context_flags != 0 {
            context_attributes.push(EGL_CONTEXT_FLAGS_KHR);
            context_attributes.push(khr_context_flags);
        }
        context_attributes.push(khronos_egl::NONE);

        gl_context_attributes.extend(&context_attributes);
        gles_context_attributes.extend(&context_attributes);

        let context = if supports_opengl {
            egl.create_context(display, config, None, &gl_context_attributes)
                .or_else(|_| {
                    egl.bind_api(khronos_egl::OPENGL_ES_API).unwrap();
                    egl.create_context(display, config, None, &gles_context_attributes)
                })
                .map_err(|e| {
                    crate::InstanceError::with_source(
                        String::from("unable to create OpenGL or GLES 3.x context"),
                        e,
                    )
                })
        } else {
            egl.create_context(display, config, None, &gles_context_attributes)
                .map_err(|e| {
                    crate::InstanceError::with_source(
                        String::from("unable to create GLES 3.x context"),
                        e,
                    )
                })
        }?;

        // Testing if context can be binded without surface
        // and creating dummy pbuffer surface if not.
        let pbuffer = if version >= (1, 5)
            || display_extensions.contains("EGL_KHR_surfaceless_context")
            || cfg!(Emscripten)
        {
            log::debug!("\tEGL context: +surfaceless");
            None
        } else {
            let attributes = [
                khronos_egl::WIDTH,
                1,
                khronos_egl::HEIGHT,
                1,
                khronos_egl::NONE,
            ];
            egl.create_pbuffer_surface(display, config, &attributes)
                .map(Some)
                .map_err(|e| {
                    crate::InstanceError::with_source(
                        String::from("error in create_pbuffer_surface"),
                        e,
                    )
                })?
        };

        Ok(Self {
            egl: EglContext {
                instance: egl,
                display,
                raw: context,
                pbuffer,
                version,
            },
            version,
            supports_native_window,
            config,
            wl_display: None,
            srgb_kind,
            force_gles_minor_version,
        })
    }
}

impl Drop for Inner {
    fn drop(&mut self) {
        if let Err(e) = self
            .egl
            .instance
            .destroy_context(self.egl.display, self.egl.raw)
        {
            log::warn!("Error in destroy_context: {:?}", e);
        }

        if let Err(e) = terminate_display(&self.egl.instance, self.egl.display) {
            log::warn!("Error in terminate: {:?}", e);
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum WindowKind {
    Wayland,
    X11,
    AngleX11,
    Unknown,
}

#[derive(Clone, Debug)]
struct WindowSystemInterface {
    display_owner: Option<Rc<DisplayOwner>>,
    kind: WindowKind,
}

pub struct Instance {
    wsi: WindowSystemInterface,
    flags: wgt::InstanceFlags,
    options: wgt::GlBackendOptions,
    inner: Mutex<Inner>,
}

impl Instance {
    pub fn raw_display(&self) -> khronos_egl::Display {
        self.inner
            .try_lock()
            .expect("Could not lock instance. This is most-likely a deadlock.")
            .egl
            .display
    }

    /// Returns the version of the EGL display.
    pub fn egl_version(&self) -> (i32, i32) {
        self.inner
            .try_lock()
            .expect("Could not lock instance. This is most-likely a deadlock.")
            .version
    }

    pub fn egl_config(&self) -> khronos_egl::Config {
        self.inner
            .try_lock()
            .expect("Could not lock instance. This is most-likely a deadlock.")
            .config
    }
}

unsafe impl Send for Instance {}
unsafe impl Sync for Instance {}

impl crate::Instance for Instance {
    type A = super::Api;

    unsafe fn init(desc: &crate::InstanceDescriptor) -> Result<Self, crate::InstanceError> {
        profiling::scope!("Init OpenGL (EGL) Backend");
        #[cfg(Emscripten)]
        let egl_result: Result<EglInstance, khronos_egl::Error> =
            Ok(khronos_egl::Instance::new(khronos_egl::Static));

        #[cfg(not(Emscripten))]
        let egl_result = if cfg!(windows) {
            unsafe {
                khronos_egl::DynamicInstance::<khronos_egl::EGL1_4>::load_required_from_filename(
                    "libEGL.dll",
                )
            }
        } else if cfg!(target_vendor = "apple") {
            unsafe {
                khronos_egl::DynamicInstance::<khronos_egl::EGL1_4>::load_required_from_filename(
                    "libEGL.dylib",
                )
            }
        } else {
            unsafe { khronos_egl::DynamicInstance::<khronos_egl::EGL1_4>::load_required() }
        };
        let egl = match egl_result {
            Ok(egl) => Arc::new(egl),
            Err(e) => {
                return Err(crate::InstanceError::with_source(
                    String::from("unable to open libEGL"),
                    e,
                ));
            }
        };

        let client_extensions = egl.query_string(None, khronos_egl::EXTENSIONS);

        let client_ext_str = match client_extensions {
            Ok(ext) => ext.to_string_lossy().into_owned(),
            Err(_) => String::new(),
        };
        log::debug!(
            "Client extensions: {:#?}",
            client_ext_str.split_whitespace().collect::<Vec<_>>()
        );

        let wayland_library = if client_ext_str.contains("EGL_EXT_platform_wayland") {
            test_wayland_display()
        } else {
            None
        };
        let x11_display_library = if client_ext_str.contains("EGL_EXT_platform_x11") {
            open_x_display()
        } else {
            None
        };
        let angle_x11_display_library = if client_ext_str.contains("EGL_ANGLE_platform_angle") {
            open_x_display()
        } else {
            None
        };

        #[cfg(not(Emscripten))]
        let egl1_5 = egl.upcast::<khronos_egl::EGL1_5>();

        #[cfg(Emscripten)]
        let egl1_5: Option<&Arc<EglInstance>> = Some(&egl);

        let (display, display_owner, wsi_kind) =
            if let (Some(library), Some(egl)) = (wayland_library, egl1_5) {
                log::info!("Using Wayland platform");
                let display_attributes = [khronos_egl::ATTRIB_NONE];
                let display = unsafe {
                    egl.get_platform_display(
                        EGL_PLATFORM_WAYLAND_KHR,
                        khronos_egl::DEFAULT_DISPLAY,
                        &display_attributes,
                    )
                }
                .unwrap();
                (display, Some(Rc::new(library)), WindowKind::Wayland)
            } else if let (Some(display_owner), Some(egl)) = (x11_display_library, egl1_5) {
                log::info!("Using X11 platform");
                let display_attributes = [khronos_egl::ATTRIB_NONE];
                let display = unsafe {
                    egl.get_platform_display(
                        EGL_PLATFORM_X11_KHR,
                        display_owner.display.as_ptr(),
                        &display_attributes,
                    )
                }
                .unwrap();
                (display, Some(Rc::new(display_owner)), WindowKind::X11)
            } else if let (Some(display_owner), Some(egl)) = (angle_x11_display_library, egl1_5) {
                log::info!("Using Angle platform with X11");
                let display_attributes = [
                    EGL_PLATFORM_ANGLE_NATIVE_PLATFORM_TYPE_ANGLE as khronos_egl::Attrib,
                    EGL_PLATFORM_X11_KHR as khronos_egl::Attrib,
                    EGL_PLATFORM_ANGLE_DEBUG_LAYERS_ENABLED as khronos_egl::Attrib,
                    usize::from(desc.flags.contains(wgt::InstanceFlags::VALIDATION)),
                    khronos_egl::ATTRIB_NONE,
                ];
                let display = unsafe {
                    egl.get_platform_display(
                        EGL_PLATFORM_ANGLE_ANGLE,
                        display_owner.display.as_ptr(),
                        &display_attributes,
                    )
                }
                .unwrap();
                (display, Some(Rc::new(display_owner)), WindowKind::AngleX11)
            } else if client_ext_str.contains("EGL_MESA_platform_surfaceless") {
                log::warn!("No windowing system present. Using surfaceless platform");
                #[allow(clippy::unnecessary_literal_unwrap)] // This is only a literal on Emscripten
                let egl = egl1_5.expect("Failed to get EGL 1.5 for surfaceless");
                let display = unsafe {
                    egl.get_platform_display(
                        EGL_PLATFORM_SURFACELESS_MESA,
                        khronos_egl::DEFAULT_DISPLAY,
                        &[khronos_egl::ATTRIB_NONE],
                    )
                }
                .unwrap();

                (display, None, WindowKind::Unknown)
            } else {
                log::warn!("EGL_MESA_platform_surfaceless not available. Using default platform");
                let display = unsafe { egl.get_display(khronos_egl::DEFAULT_DISPLAY) }.unwrap();
                (display, None, WindowKind::Unknown)
            };

        if desc.flags.contains(wgt::InstanceFlags::VALIDATION)
            && client_ext_str.contains("EGL_KHR_debug")
        {
            log::debug!("Enabling EGL debug output");
            let function: EglDebugMessageControlFun = {
                let addr = egl.get_proc_address("eglDebugMessageControlKHR").unwrap();
                unsafe { std::mem::transmute(addr) }
            };
            let attributes = [
                EGL_DEBUG_MSG_CRITICAL_KHR as khronos_egl::Attrib,
                1,
                EGL_DEBUG_MSG_ERROR_KHR as khronos_egl::Attrib,
                1,
                EGL_DEBUG_MSG_WARN_KHR as khronos_egl::Attrib,
                1,
                EGL_DEBUG_MSG_INFO_KHR as khronos_egl::Attrib,
                1,
                khronos_egl::ATTRIB_NONE,
            ];
            unsafe { (function)(Some(egl_debug_proc), attributes.as_ptr()) };
        }

        let inner = Inner::create(
            desc.flags,
            egl,
            display,
            desc.backend_options.gl.gles_minor_version,
        )?;

        Ok(Instance {
            wsi: WindowSystemInterface {
                display_owner,
                kind: wsi_kind,
            },
            flags: desc.flags,
            options: desc.backend_options.gl.clone(),
            inner: Mutex::new(inner),
        })
    }

    #[cfg_attr(target_os = "macos", allow(unused, unused_mut, unreachable_code))]
    unsafe fn create_surface(
        &self,
        display_handle: raw_window_handle::RawDisplayHandle,
        window_handle: raw_window_handle::RawWindowHandle,
    ) -> Result<Surface, crate::InstanceError> {
        use raw_window_handle::RawWindowHandle as Rwh;

        #[cfg_attr(any(target_os = "android", Emscripten), allow(unused_mut))]
        let mut inner = self.inner.lock();

        match (window_handle, display_handle) {
            (Rwh::Xlib(_), _) => {}
            (Rwh::Xcb(_), _) => {}
            (Rwh::Win32(_), _) => {}
            (Rwh::AppKit(_), _) => {}
            (Rwh::OhosNdk(_), _) => {}
            #[cfg(target_os = "android")]
            (Rwh::AndroidNdk(handle), _) => {
                let format = inner
                    .egl
                    .instance
                    .get_config_attrib(
                        inner.egl.display,
                        inner.config,
                        khronos_egl::NATIVE_VISUAL_ID,
                    )
                    .unwrap();

                let ret = unsafe {
                    ndk_sys::ANativeWindow_setBuffersGeometry(
                        handle
                            .a_native_window
                            .as_ptr()
                            .cast::<ndk_sys::ANativeWindow>(),
                        0,
                        0,
                        format,
                    )
                };

                if ret != 0 {
                    return Err(crate::InstanceError::new(format!(
                        "error {ret} returned from ANativeWindow_setBuffersGeometry",
                    )));
                }
            }
            #[cfg(not(Emscripten))]
            (Rwh::Wayland(_), raw_window_handle::RawDisplayHandle::Wayland(display_handle)) => {
                if inner
                    .wl_display
                    .map(|ptr| ptr != display_handle.display.as_ptr())
                    .unwrap_or(true)
                {
                    /* Wayland displays are not sharable between surfaces so if the
                     * surface we receive from this handle is from a different
                     * display, we must re-initialize the context.
                     *
                     * See gfx-rs/gfx#3545
                     */
                    log::warn!("Re-initializing Gles context due to Wayland window");

                    use std::ops::DerefMut;
                    let display_attributes = [khronos_egl::ATTRIB_NONE];

                    let display = unsafe {
                        inner
                            .egl
                            .instance
                            .upcast::<khronos_egl::EGL1_5>()
                            .unwrap()
                            .get_platform_display(
                                EGL_PLATFORM_WAYLAND_KHR,
                                display_handle.display.as_ptr(),
                                &display_attributes,
                            )
                    }
                    .unwrap();

                    let new_inner = Inner::create(
                        self.flags,
                        Arc::clone(&inner.egl.instance),
                        display,
                        inner.force_gles_minor_version,
                    )?;

                    let old_inner = std::mem::replace(inner.deref_mut(), new_inner);
                    inner.wl_display = Some(display_handle.display.as_ptr());

                    drop(old_inner);
                }
            }
            #[cfg(Emscripten)]
            (Rwh::Web(_), _) => {}
            other => {
                return Err(crate::InstanceError::new(format!(
                    "unsupported window: {other:?}"
                )));
            }
        };

        inner.egl.unmake_current();

        Ok(Surface {
            egl: inner.egl.clone(),
            wsi: self.wsi.clone(),
            config: inner.config,
            presentable: inner.supports_native_window,
            raw_window_handle: window_handle,
            swapchain: RwLock::new(None),
            srgb_kind: inner.srgb_kind,
        })
    }

    unsafe fn enumerate_adapters(
        &self,
        _surface_hint: Option<&Surface>,
    ) -> Vec<crate::ExposedAdapter<super::Api>> {
        let inner = self.inner.lock();
        inner.egl.make_current();

        let mut gl = unsafe {
            glow::Context::from_loader_function(|name| {
                inner
                    .egl
                    .instance
                    .get_proc_address(name)
                    .map_or(ptr::null(), |p| p as *const _)
            })
        };

        // In contrast to OpenGL ES, OpenGL requires explicitly enabling sRGB conversions,
        // as otherwise the user has to do the sRGB conversion.
        if !matches!(inner.srgb_kind, SrgbFrameBufferKind::None) {
            unsafe { gl.enable(glow::FRAMEBUFFER_SRGB) };
        }

        if self.flags.contains(wgt::InstanceFlags::DEBUG) && gl.supports_debug() {
            log::debug!("Max label length: {}", unsafe {
                gl.get_parameter_i32(glow::MAX_LABEL_LENGTH)
            });
        }

        if self.flags.contains(wgt::InstanceFlags::VALIDATION) && gl.supports_debug() {
            log::debug!("Enabling GLES debug output");
            unsafe { gl.enable(glow::DEBUG_OUTPUT) };
            unsafe { gl.debug_message_callback(super::gl_debug_message_callback) };
        }

        // Wrap in ManuallyDrop to make it easier to "current" the GL context before dropping this
        // GLOW context, which could also happen if a panic occurs after we uncurrent the context
        // below but before AdapterContext is constructed.
        let gl = ManuallyDrop::new(gl);
        inner.egl.unmake_current();

        unsafe {
            super::Adapter::expose(
                AdapterContext {
                    glow: Mutex::new(gl),
                    egl: Some(inner.egl.clone()),
                },
                self.options.clone(),
            )
        }
        .into_iter()
        .collect()
    }
}

impl super::Adapter {
    /// Creates a new external adapter using the specified loader function.
    ///
    /// # Safety
    ///
    /// - The underlying OpenGL ES context must be current.
    /// - The underlying OpenGL ES context must be current when interfacing with any objects returned by
    ///   wgpu-hal from this adapter.
    /// - The underlying OpenGL ES context must be current when dropping this adapter and when
    ///   dropping any objects returned from this adapter.
    pub unsafe fn new_external(
        fun: impl FnMut(&str) -> *const ffi::c_void,
        options: wgt::GlBackendOptions,
    ) -> Option<crate::ExposedAdapter<super::Api>> {
        let context = unsafe { glow::Context::from_loader_function(fun) };
        unsafe {
            Self::expose(
                AdapterContext {
                    glow: Mutex::new(ManuallyDrop::new(context)),
                    egl: None,
                },
                options,
            )
        }
    }

    pub fn adapter_context(&self) -> &AdapterContext {
        &self.shared.context
    }
}

impl super::Device {
    /// Returns the underlying EGL context.
    pub fn context(&self) -> &AdapterContext {
        &self.shared.context
    }
}

#[derive(Debug)]
pub struct Swapchain {
    surface: khronos_egl::Surface,
    wl_window: Option<*mut raw::c_void>,
    framebuffer: glow::Framebuffer,
    renderbuffer: glow::Renderbuffer,
    /// Extent because the window lies
    extent: wgt::Extent3d,
    format: wgt::TextureFormat,
    format_desc: super::TextureFormatDesc,
    #[allow(unused)]
    sample_type: wgt::TextureSampleType,
}

#[derive(Debug)]
pub struct Surface {
    egl: EglContext,
    wsi: WindowSystemInterface,
    config: khronos_egl::Config,
    pub(super) presentable: bool,
    raw_window_handle: raw_window_handle::RawWindowHandle,
    swapchain: RwLock<Option<Swapchain>>,
    srgb_kind: SrgbFrameBufferKind,
}

unsafe impl Send for Surface {}
unsafe impl Sync for Surface {}

impl Surface {
    pub(super) unsafe fn present(
        &self,
        _suf_texture: super::Texture,
        context: &AdapterContext,
    ) -> Result<(), crate::SurfaceError> {
        let gl = unsafe { context.get_without_egl_lock() };
        let swapchain = self.swapchain.read();
        let sc = swapchain.as_ref().unwrap();

        self.egl
            .instance
            .make_current(
                self.egl.display,
                Some(sc.surface),
                Some(sc.surface),
                Some(self.egl.raw),
            )
            .map_err(|e| {
                log::error!("make_current(surface) failed: {}", e);
                crate::SurfaceError::Lost
            })?;

        unsafe { gl.disable(glow::SCISSOR_TEST) };
        unsafe { gl.color_mask(true, true, true, true) };

        unsafe { gl.bind_framebuffer(glow::DRAW_FRAMEBUFFER, None) };
        unsafe { gl.bind_framebuffer(glow::READ_FRAMEBUFFER, Some(sc.framebuffer)) };

        if !matches!(self.srgb_kind, SrgbFrameBufferKind::None) {
            // Disable sRGB conversions for `glBlitFramebuffer` as behavior does diverge between
            // drivers and formats otherwise and we want to ensure no sRGB conversions happen.
            unsafe { gl.disable(glow::FRAMEBUFFER_SRGB) };
        }

        // Note the Y-flipping here. GL's presentation is not flipped,
        // but main rendering is. Therefore, we Y-flip the output positions
        // in the shader, and also this blit.
        unsafe {
            gl.blit_framebuffer(
                0,
                sc.extent.height as i32,
                sc.extent.width as i32,
                0,
                0,
                0,
                sc.extent.width as i32,
                sc.extent.height as i32,
                glow::COLOR_BUFFER_BIT,
                glow::NEAREST,
            )
        };

        if !matches!(self.srgb_kind, SrgbFrameBufferKind::None) {
            unsafe { gl.enable(glow::FRAMEBUFFER_SRGB) };
        }

        unsafe { gl.bind_framebuffer(glow::READ_FRAMEBUFFER, None) };

        self.egl
            .instance
            .swap_buffers(self.egl.display, sc.surface)
            .map_err(|e| {
                log::error!("swap_buffers failed: {}", e);
                crate::SurfaceError::Lost
                // TODO: should we unset the current context here?
            })?;
        self.egl
            .instance
            .make_current(self.egl.display, None, None, None)
            .map_err(|e| {
                log::error!("make_current(null) failed: {}", e);
                crate::SurfaceError::Lost
            })?;

        Ok(())
    }

    unsafe fn unconfigure_impl(
        &self,
        device: &super::Device,
    ) -> Option<(khronos_egl::Surface, Option<*mut raw::c_void>)> {
        let gl = &device.shared.context.lock();
        match self.swapchain.write().take() {
            Some(sc) => {
                unsafe { gl.delete_renderbuffer(sc.renderbuffer) };
                unsafe { gl.delete_framebuffer(sc.framebuffer) };
                Some((sc.surface, sc.wl_window))
            }
            None => None,
        }
    }

    pub fn supports_srgb(&self) -> bool {
        match self.srgb_kind {
            SrgbFrameBufferKind::None => false,
            _ => true,
        }
    }
}

impl crate::Surface for Surface {
    type A = super::Api;

    unsafe fn configure(
        &self,
        device: &super::Device,
        config: &crate::SurfaceConfiguration,
    ) -> Result<(), crate::SurfaceError> {
        use raw_window_handle::RawWindowHandle as Rwh;

        let (surface, wl_window) = match unsafe { self.unconfigure_impl(device) } {
            Some(pair) => pair,
            None => {
                let mut wl_window = None;
                let (mut temp_xlib_handle, mut temp_xcb_handle);
                let native_window_ptr = match (self.wsi.kind, self.raw_window_handle) {
                    (WindowKind::Unknown | WindowKind::X11, Rwh::Xlib(handle)) => {
                        temp_xlib_handle = handle.window;
                        ptr::from_mut(&mut temp_xlib_handle).cast::<ffi::c_void>()
                    }
                    (WindowKind::AngleX11, Rwh::Xlib(handle)) => handle.window as *mut ffi::c_void,
                    (WindowKind::Unknown | WindowKind::X11, Rwh::Xcb(handle)) => {
                        temp_xcb_handle = handle.window;
                        ptr::from_mut(&mut temp_xcb_handle).cast::<ffi::c_void>()
                    }
                    (WindowKind::AngleX11, Rwh::Xcb(handle)) => {
                        handle.window.get() as *mut ffi::c_void
                    }
                    (WindowKind::Unknown, Rwh::AndroidNdk(handle)) => {
                        handle.a_native_window.as_ptr()
                    }
                    (WindowKind::Unknown, Rwh::OhosNdk(handle)) => handle.native_window.as_ptr(),
                    (WindowKind::Wayland, Rwh::Wayland(handle)) => {
                        let library = &self.wsi.display_owner.as_ref().unwrap().library;
                        let wl_egl_window_create: libloading::Symbol<WlEglWindowCreateFun> =
                            unsafe { library.get(c"wl_egl_window_create".to_bytes()) }.unwrap();
                        let window =
                            unsafe { wl_egl_window_create(handle.surface.as_ptr(), 640, 480) }
                                .cast();
                        wl_window = Some(window);
                        window
                    }
                    #[cfg(Emscripten)]
                    (WindowKind::Unknown, Rwh::Web(handle)) => handle.id as *mut ffi::c_void,
                    (WindowKind::Unknown, Rwh::Win32(handle)) => {
                        handle.hwnd.get() as *mut ffi::c_void
                    }
                    (WindowKind::Unknown, Rwh::AppKit(handle)) => {
                        #[cfg(not(target_os = "macos"))]
                        let window_ptr = handle.ns_view.as_ptr();
                        #[cfg(target_os = "macos")]
                        let window_ptr = {
                            use objc::{msg_send, runtime::Object, sel, sel_impl};
                            // ns_view always have a layer and don't need to verify that it exists.
                            let layer: *mut Object =
                                msg_send![handle.ns_view.as_ptr().cast::<Object>(), layer];
                            layer.cast::<ffi::c_void>()
                        };
                        window_ptr
                    }
                    _ => {
                        log::warn!(
                            "Initialized platform {:?} doesn't work with window {:?}",
                            self.wsi.kind,
                            self.raw_window_handle
                        );
                        return Err(crate::SurfaceError::Other("incompatible window kind"));
                    }
                };

                let mut attributes = vec![
                    khronos_egl::RENDER_BUFFER,
                    // We don't want any of the buffering done by the driver, because we
                    // manage a swapchain on our side.
                    // Some drivers just fail on surface creation seeing `EGL_SINGLE_BUFFER`.
                    if cfg!(any(
                        target_os = "android",
                        target_os = "macos",
                        target_env = "ohos"
                    )) || cfg!(windows)
                        || self.wsi.kind == WindowKind::AngleX11
                    {
                        khronos_egl::BACK_BUFFER
                    } else {
                        khronos_egl::SINGLE_BUFFER
                    },
                ];
                if config.format.is_srgb() {
                    match self.srgb_kind {
                        SrgbFrameBufferKind::None => {}
                        SrgbFrameBufferKind::Core => {
                            attributes.push(khronos_egl::GL_COLORSPACE);
                            attributes.push(khronos_egl::GL_COLORSPACE_SRGB);
                        }
                        SrgbFrameBufferKind::Khr => {
                            attributes.push(EGL_GL_COLORSPACE_KHR as i32);
                            attributes.push(EGL_GL_COLORSPACE_SRGB_KHR as i32);
                        }
                    }
                }
                attributes.push(khronos_egl::ATTRIB_NONE as i32);

                #[cfg(not(Emscripten))]
                let egl1_5 = self.egl.instance.upcast::<khronos_egl::EGL1_5>();

                #[cfg(Emscripten)]
                let egl1_5: Option<&Arc<EglInstance>> = Some(&self.egl.instance);

                // Careful, we can still be in 1.4 version even if `upcast` succeeds
                let raw_result = match egl1_5 {
                    Some(egl) if self.wsi.kind != WindowKind::Unknown => {
                        let attributes_usize = attributes
                            .into_iter()
                            .map(|v| v as usize)
                            .collect::<Vec<_>>();
                        unsafe {
                            egl.create_platform_window_surface(
                                self.egl.display,
                                self.config,
                                native_window_ptr,
                                &attributes_usize,
                            )
                        }
                    }
                    _ => unsafe {
                        self.egl.instance.create_window_surface(
                            self.egl.display,
                            self.config,
                            native_window_ptr,
                            Some(&attributes),
                        )
                    },
                };

                match raw_result {
                    Ok(raw) => (raw, wl_window),
                    Err(e) => {
                        log::warn!("Error in create_window_surface: {:?}", e);
                        return Err(crate::SurfaceError::Lost);
                    }
                }
            }
        };

        if let Some(window) = wl_window {
            let library = &self.wsi.display_owner.as_ref().unwrap().library;
            let wl_egl_window_resize: libloading::Symbol<WlEglWindowResizeFun> =
                unsafe { library.get(c"wl_egl_window_resize".to_bytes()) }.unwrap();
            unsafe {
                wl_egl_window_resize(
                    window,
                    config.extent.width as i32,
                    config.extent.height as i32,
                    0,
                    0,
                )
            };
        }

        let format_desc = device.shared.describe_texture_format(config.format);
        let gl = &device.shared.context.lock();
        let renderbuffer = unsafe { gl.create_renderbuffer() }.map_err(|error| {
            log::error!("Internal swapchain renderbuffer creation failed: {error}");
            crate::DeviceError::OutOfMemory
        })?;
        unsafe { gl.bind_renderbuffer(glow::RENDERBUFFER, Some(renderbuffer)) };
        unsafe {
            gl.renderbuffer_storage(
                glow::RENDERBUFFER,
                format_desc.internal,
                config.extent.width as _,
                config.extent.height as _,
            )
        };
        let framebuffer = unsafe { gl.create_framebuffer() }.map_err(|error| {
            log::error!("Internal swapchain framebuffer creation failed: {error}");
            crate::DeviceError::OutOfMemory
        })?;
        unsafe { gl.bind_framebuffer(glow::READ_FRAMEBUFFER, Some(framebuffer)) };
        unsafe {
            gl.framebuffer_renderbuffer(
                glow::READ_FRAMEBUFFER,
                glow::COLOR_ATTACHMENT0,
                glow::RENDERBUFFER,
                Some(renderbuffer),
            )
        };
        unsafe { gl.bind_renderbuffer(glow::RENDERBUFFER, None) };
        unsafe { gl.bind_framebuffer(glow::READ_FRAMEBUFFER, None) };

        let mut swapchain = self.swapchain.write();
        *swapchain = Some(Swapchain {
            surface,
            wl_window,
            renderbuffer,
            framebuffer,
            extent: config.extent,
            format: config.format,
            format_desc,
            sample_type: wgt::TextureSampleType::Float { filterable: false },
        });

        Ok(())
    }

    unsafe fn unconfigure(&self, device: &super::Device) {
        if let Some((surface, wl_window)) = unsafe { self.unconfigure_impl(device) } {
            self.egl
                .instance
                .destroy_surface(self.egl.display, surface)
                .unwrap();
            if let Some(window) = wl_window {
                let library = &self
                    .wsi
                    .display_owner
                    .as_ref()
                    .expect("unsupported window")
                    .library;
                let wl_egl_window_destroy: libloading::Symbol<WlEglWindowDestroyFun> =
                    unsafe { library.get(c"wl_egl_window_destroy".to_bytes()) }.unwrap();
                unsafe { wl_egl_window_destroy(window) };
            }
        }
    }

    unsafe fn acquire_texture(
        &self,
        _timeout_ms: Option<Duration>, //TODO
        _fence: &super::Fence,
    ) -> Result<Option<crate::AcquiredSurfaceTexture<super::Api>>, crate::SurfaceError> {
        let swapchain = self.swapchain.read();
        let sc = swapchain.as_ref().unwrap();
        let texture = super::Texture {
            inner: super::TextureInner::Renderbuffer {
                raw: sc.renderbuffer,
            },
            drop_guard: None,
            array_layer_count: 1,
            mip_level_count: 1,
            format: sc.format,
            format_desc: sc.format_desc.clone(),
            copy_size: crate::CopyExtent {
                width: sc.extent.width,
                height: sc.extent.height,
                depth: 1,
            },
        };
        Ok(Some(crate::AcquiredSurfaceTexture {
            texture,
            suboptimal: false,
        }))
    }
    unsafe fn discard_texture(&self, _texture: super::Texture) {}
}
