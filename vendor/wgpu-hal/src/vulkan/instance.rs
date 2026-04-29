use std::{
    borrow::ToOwned as _,
    boxed::Box,
    ffi::{c_void, CStr, CString},
    slice,
    str::FromStr,
    string::{String, ToString as _},
    sync::Arc,
    thread,
    vec::Vec,
};

use arrayvec::ArrayVec;
use ash::{ext, khr, vk};
use parking_lot::RwLock;

unsafe extern "system" fn debug_utils_messenger_callback(
    message_severity: vk::DebugUtilsMessageSeverityFlagsEXT,
    message_type: vk::DebugUtilsMessageTypeFlagsEXT,
    callback_data_ptr: *const vk::DebugUtilsMessengerCallbackDataEXT,
    user_data: *mut c_void,
) -> vk::Bool32 {
    use std::borrow::Cow;

    if thread::panicking() {
        return vk::FALSE;
    }

    let cd = unsafe { &*callback_data_ptr };
    let user_data = unsafe { &*user_data.cast::<super::DebugUtilsMessengerUserData>() };

    const VUID_VKCMDENDDEBUGUTILSLABELEXT_COMMANDBUFFER_01912: i32 = 0x56146426;
    if cd.message_id_number == VUID_VKCMDENDDEBUGUTILSLABELEXT_COMMANDBUFFER_01912 {
        // https://github.com/KhronosGroup/Vulkan-ValidationLayers/issues/5671
        // Versions 1.3.240 through 1.3.250 return a spurious error here if
        // the debug range start and end appear in different command buffers.
        if let Some(layer_properties) = user_data.validation_layer_properties.as_ref() {
            if layer_properties.layer_description.as_ref() == c"Khronos Validation Layer"
                && layer_properties.layer_spec_version >= vk::make_api_version(0, 1, 3, 240)
                && layer_properties.layer_spec_version <= vk::make_api_version(0, 1, 3, 250)
            {
                return vk::FALSE;
            }
        }
    }

    // Silence Vulkan Validation error "VUID-VkSwapchainCreateInfoKHR-pNext-07781"
    // This happens when a surface is configured with a size outside the allowed extent.
    // It's a false positive due to the inherent racy-ness of surface resizing.
    const VUID_VKSWAPCHAINCREATEINFOKHR_PNEXT_07781: i32 = 0x4c8929c1;
    if cd.message_id_number == VUID_VKSWAPCHAINCREATEINFOKHR_PNEXT_07781 {
        return vk::FALSE;
    }

    // Silence Vulkan Validation error "VUID-VkRenderPassBeginInfo-framebuffer-04627"
    // if the OBS layer is enabled. This is a bug in the OBS layer. As the OBS layer
    // does not have a version number they increment, there is no way to qualify the
    // suppression of the error to a specific version of the OBS layer.
    //
    // See https://github.com/obsproject/obs-studio/issues/9353
    const VUID_VKRENDERPASSBEGININFO_FRAMEBUFFER_04627: i32 = 0x45125641;
    if cd.message_id_number == VUID_VKRENDERPASSBEGININFO_FRAMEBUFFER_04627
        && user_data.has_obs_layer
    {
        return vk::FALSE;
    }

    // Silence Vulkan Validation error "VUID-vkCmdCopyImageToBuffer-pRegions-00184".
    // While we aren't sure yet, we suspect this is probably a VVL issue.
    // https://github.com/KhronosGroup/Vulkan-ValidationLayers/issues/9276
    const VUID_VKCMDCOPYIMAGETOBUFFER_PREGIONS_00184: i32 = 0x45ef177c;
    if cd.message_id_number == VUID_VKCMDCOPYIMAGETOBUFFER_PREGIONS_00184 {
        return vk::FALSE;
    }

    let level = match message_severity {
        vk::DebugUtilsMessageSeverityFlagsEXT::VERBOSE => log::Level::Debug,
        vk::DebugUtilsMessageSeverityFlagsEXT::INFO => log::Level::Info,
        vk::DebugUtilsMessageSeverityFlagsEXT::WARNING => log::Level::Warn,
        vk::DebugUtilsMessageSeverityFlagsEXT::ERROR => log::Level::Error,
        _ => log::Level::Warn,
    };

    let message_id_name =
        unsafe { cd.message_id_name_as_c_str() }.map_or(Cow::Borrowed(""), CStr::to_string_lossy);
    let message = unsafe { cd.message_as_c_str() }.map_or(Cow::Borrowed(""), CStr::to_string_lossy);

    let _ = std::panic::catch_unwind(|| {
        log::log!(
            level,
            "{:?} [{} (0x{:x})]\n\t{}",
            message_type,
            message_id_name,
            cd.message_id_number,
            message,
        );
    });

    if cd.queue_label_count != 0 {
        let labels =
            unsafe { slice::from_raw_parts(cd.p_queue_labels, cd.queue_label_count as usize) };
        let names = labels
            .iter()
            .flat_map(|dul_obj| unsafe { dul_obj.label_name_as_c_str() }.map(CStr::to_string_lossy))
            .collect::<Vec<_>>();

        let _ = std::panic::catch_unwind(|| {
            log::log!(level, "\tqueues: {}", names.join(", "));
        });
    }

    if cd.cmd_buf_label_count != 0 {
        let labels =
            unsafe { slice::from_raw_parts(cd.p_cmd_buf_labels, cd.cmd_buf_label_count as usize) };
        let names = labels
            .iter()
            .flat_map(|dul_obj| unsafe { dul_obj.label_name_as_c_str() }.map(CStr::to_string_lossy))
            .collect::<Vec<_>>();

        let _ = std::panic::catch_unwind(|| {
            log::log!(level, "\tcommand buffers: {}", names.join(", "));
        });
    }

    if cd.object_count != 0 {
        let labels = unsafe { slice::from_raw_parts(cd.p_objects, cd.object_count as usize) };
        //TODO: use color fields of `vk::DebugUtilsLabelExt`?
        let names = labels
            .iter()
            .map(|obj_info| {
                let name = unsafe { obj_info.object_name_as_c_str() }
                    .map_or(Cow::Borrowed("?"), CStr::to_string_lossy);

                format!(
                    "(type: {:?}, hndl: 0x{:x}, name: {})",
                    obj_info.object_type, obj_info.object_handle, name
                )
            })
            .collect::<Vec<_>>();
        let _ = std::panic::catch_unwind(|| {
            log::log!(level, "\tobjects: {}", names.join(", "));
        });
    }

    if cfg!(debug_assertions) && level == log::Level::Error {
        // Set canary and continue
        crate::VALIDATION_CANARY.add(message.to_string());
    }

    vk::FALSE
}

impl super::DebugUtilsCreateInfo {
    fn to_vk_create_info(&self) -> vk::DebugUtilsMessengerCreateInfoEXT<'_> {
        let user_data_ptr: *const super::DebugUtilsMessengerUserData = &*self.callback_data;
        vk::DebugUtilsMessengerCreateInfoEXT::default()
            .message_severity(self.severity)
            .message_type(self.message_type)
            .user_data(user_data_ptr as *mut _)
            .pfn_user_callback(Some(debug_utils_messenger_callback))
    }
}

impl super::Swapchain {
    /// # Safety
    ///
    /// - The device must have been made idle before calling this function.
    unsafe fn release_resources(mut self, device: &ash::Device) -> Self {
        profiling::scope!("Swapchain::release_resources");
        {
            profiling::scope!("vkDeviceWaitIdle");
            // We need to also wait until all presentation work is done. Because there is no way to portably wait until
            // the presentation work is done, we are forced to wait until the device is idle.
            let _ = unsafe {
                device
                    .device_wait_idle()
                    .map_err(super::map_host_device_oom_and_lost_err)
            };
        };

        // We cannot take this by value, as the function returns `self`.
        for semaphore in self.surface_semaphores.drain(..) {
            let arc_removed = Arc::into_inner(semaphore).expect(
                "Trying to destroy a SurfaceSemaphores that is still in use by a SurfaceTexture",
            );
            let mutex_removed = arc_removed.into_inner();

            unsafe { mutex_removed.destroy(device) };
        }

        self
    }
}

impl super::InstanceShared {
    pub fn entry(&self) -> &ash::Entry {
        &self.entry
    }

    pub fn raw_instance(&self) -> &ash::Instance {
        &self.raw
    }

    pub fn instance_api_version(&self) -> u32 {
        self.instance_api_version
    }

    pub fn extensions(&self) -> &[&'static CStr] {
        &self.extensions[..]
    }
}

impl super::Instance {
    pub fn shared_instance(&self) -> &super::InstanceShared {
        &self.shared
    }

    fn enumerate_instance_extension_properties(
        entry: &ash::Entry,
        layer_name: Option<&CStr>,
    ) -> Result<Vec<vk::ExtensionProperties>, crate::InstanceError> {
        let instance_extensions = {
            profiling::scope!("vkEnumerateInstanceExtensionProperties");
            unsafe { entry.enumerate_instance_extension_properties(layer_name) }
        };
        instance_extensions.map_err(|e| {
            crate::InstanceError::with_source(
                String::from("enumerate_instance_extension_properties() failed"),
                e,
            )
        })
    }

    /// Return the instance extension names wgpu would like to enable.
    ///
    /// Return a vector of the names of instance extensions actually available
    /// on `entry` that wgpu would like to enable.
    ///
    /// The `instance_api_version` argument should be the instance's Vulkan API
    /// version, as obtained from `vkEnumerateInstanceVersion`. This is the same
    /// space of values as the `VK_API_VERSION` constants.
    ///
    /// Note that wgpu can function without many of these extensions (for
    /// example, `VK_KHR_wayland_surface` is certainly not going to be available
    /// everywhere), but if one of these extensions is available at all, wgpu
    /// assumes that it has been enabled.
    pub fn desired_extensions(
        entry: &ash::Entry,
        _instance_api_version: u32,
        flags: wgt::InstanceFlags,
    ) -> Result<Vec<&'static CStr>, crate::InstanceError> {
        let instance_extensions = Self::enumerate_instance_extension_properties(entry, None)?;

        // Check our extensions against the available extensions
        let mut extensions: Vec<&'static CStr> = Vec::new();

        // VK_KHR_surface
        extensions.push(khr::surface::NAME);

        // Platform-specific WSI extensions
        if cfg!(all(
            unix,
            not(target_os = "android"),
            not(target_os = "macos")
        )) {
            // VK_KHR_xlib_surface
            extensions.push(khr::xlib_surface::NAME);
            // VK_KHR_xcb_surface
            extensions.push(khr::xcb_surface::NAME);
            // VK_KHR_wayland_surface
            extensions.push(khr::wayland_surface::NAME);
        }
        if cfg!(target_os = "android") {
            // VK_KHR_android_surface
            extensions.push(khr::android_surface::NAME);
        }
        if cfg!(target_os = "windows") {
            // VK_KHR_win32_surface
            extensions.push(khr::win32_surface::NAME);
        }
        if cfg!(target_os = "macos") {
            // VK_EXT_metal_surface
            extensions.push(ext::metal_surface::NAME);
            extensions.push(khr::portability_enumeration::NAME);
        }
        if cfg!(all(
            unix,
            not(target_vendor = "apple"),
            not(target_family = "wasm")
        )) {
            // VK_EXT_acquire_drm_display -> VK_EXT_direct_mode_display -> VK_KHR_display
            extensions.push(ext::acquire_drm_display::NAME);
            extensions.push(ext::direct_mode_display::NAME);
            extensions.push(khr::display::NAME);
            //  VK_EXT_physical_device_drm -> VK_KHR_get_physical_device_properties2
            extensions.push(ext::physical_device_drm::NAME);
            extensions.push(khr::get_display_properties2::NAME);
        }

        if flags.contains(wgt::InstanceFlags::DEBUG) {
            // VK_EXT_debug_utils
            extensions.push(ext::debug_utils::NAME);
        }

        // VK_EXT_swapchain_colorspace
        // Provides wide color gamut
        extensions.push(ext::swapchain_colorspace::NAME);

        // VK_KHR_get_physical_device_properties2
        // Even though the extension was promoted to Vulkan 1.1, we still require the extension
        // so that we don't have to conditionally use the functions provided by the 1.1 instance
        extensions.push(khr::get_physical_device_properties2::NAME);

        // Only keep available extensions.
        extensions.retain(|&ext| {
            if instance_extensions
                .iter()
                .any(|inst_ext| inst_ext.extension_name_as_c_str() == Ok(ext))
            {
                true
            } else {
                log::warn!("Unable to find extension: {}", ext.to_string_lossy());
                false
            }
        });
        Ok(extensions)
    }

    /// # Safety
    ///
    /// - `raw_instance` must be created from `entry`
    /// - `raw_instance` must be created respecting `instance_api_version`, `extensions` and `flags`
    /// - `extensions` must be a superset of `desired_extensions()` and must be created from the
    ///   same entry, `instance_api_version`` and flags.
    /// - `android_sdk_version` is ignored and can be `0` for all platforms besides Android
    /// - If `drop_callback` is [`None`], wgpu-hal will take ownership of `raw_instance`. If
    ///   `drop_callback` is [`Some`], `raw_instance` must be valid until the callback is called.
    ///
    /// If `debug_utils_user_data` is `Some`, then the validation layer is
    /// available, so create a [`vk::DebugUtilsMessengerEXT`].
    #[allow(clippy::too_many_arguments)]
    pub unsafe fn from_raw(
        entry: ash::Entry,
        raw_instance: ash::Instance,
        instance_api_version: u32,
        android_sdk_version: u32,
        debug_utils_create_info: Option<super::DebugUtilsCreateInfo>,
        extensions: Vec<&'static CStr>,
        flags: wgt::InstanceFlags,
        has_nv_optimus: bool,
        drop_callback: Option<crate::DropCallback>,
    ) -> Result<Self, crate::InstanceError> {
        log::debug!("Instance version: 0x{:x}", instance_api_version);

        let debug_utils = if let Some(debug_utils_create_info) = debug_utils_create_info {
            if extensions.contains(&ext::debug_utils::NAME) {
                log::info!("Enabling debug utils");

                let extension = ext::debug_utils::Instance::new(&entry, &raw_instance);
                let vk_info = debug_utils_create_info.to_vk_create_info();
                let messenger =
                    unsafe { extension.create_debug_utils_messenger(&vk_info, None) }.unwrap();

                Some(super::DebugUtils {
                    extension,
                    messenger,
                    callback_data: debug_utils_create_info.callback_data,
                })
            } else {
                log::debug!("Debug utils not enabled: extension not listed");
                None
            }
        } else {
            log::debug!(
                "Debug utils not enabled: \
                        debug_utils_user_data not passed to Instance::from_raw"
            );
            None
        };

        let get_physical_device_properties =
            if extensions.contains(&khr::get_physical_device_properties2::NAME) {
                log::debug!("Enabling device properties2");
                Some(khr::get_physical_device_properties2::Instance::new(
                    &entry,
                    &raw_instance,
                ))
            } else {
                None
            };

        let drop_guard = crate::DropGuard::from_option(drop_callback);

        Ok(Self {
            shared: Arc::new(super::InstanceShared {
                raw: raw_instance,
                extensions,
                drop_guard,
                flags,
                debug_utils,
                get_physical_device_properties,
                entry,
                has_nv_optimus,
                instance_api_version,
                android_sdk_version,
            }),
        })
    }

    fn create_surface_from_xlib(
        &self,
        dpy: *mut vk::Display,
        window: vk::Window,
    ) -> Result<super::Surface, crate::InstanceError> {
        if !self.shared.extensions.contains(&khr::xlib_surface::NAME) {
            return Err(crate::InstanceError::new(String::from(
                "Vulkan driver does not support VK_KHR_xlib_surface",
            )));
        }

        let surface = {
            let xlib_loader =
                khr::xlib_surface::Instance::new(&self.shared.entry, &self.shared.raw);
            let info = vk::XlibSurfaceCreateInfoKHR::default()
                .flags(vk::XlibSurfaceCreateFlagsKHR::empty())
                .window(window)
                .dpy(dpy);

            unsafe { xlib_loader.create_xlib_surface(&info, None) }
                .expect("XlibSurface::create_xlib_surface() failed")
        };

        Ok(self.create_surface_from_vk_surface_khr(surface))
    }

    fn create_surface_from_xcb(
        &self,
        connection: *mut vk::xcb_connection_t,
        window: vk::xcb_window_t,
    ) -> Result<super::Surface, crate::InstanceError> {
        if !self.shared.extensions.contains(&khr::xcb_surface::NAME) {
            return Err(crate::InstanceError::new(String::from(
                "Vulkan driver does not support VK_KHR_xcb_surface",
            )));
        }

        let surface = {
            let xcb_loader = khr::xcb_surface::Instance::new(&self.shared.entry, &self.shared.raw);
            let info = vk::XcbSurfaceCreateInfoKHR::default()
                .flags(vk::XcbSurfaceCreateFlagsKHR::empty())
                .window(window)
                .connection(connection);

            unsafe { xcb_loader.create_xcb_surface(&info, None) }
                .expect("XcbSurface::create_xcb_surface() failed")
        };

        Ok(self.create_surface_from_vk_surface_khr(surface))
    }

    fn create_surface_from_wayland(
        &self,
        display: *mut vk::wl_display,
        surface: *mut vk::wl_surface,
    ) -> Result<super::Surface, crate::InstanceError> {
        if !self.shared.extensions.contains(&khr::wayland_surface::NAME) {
            return Err(crate::InstanceError::new(String::from(
                "Vulkan driver does not support VK_KHR_wayland_surface",
            )));
        }

        let surface = {
            let w_loader =
                khr::wayland_surface::Instance::new(&self.shared.entry, &self.shared.raw);
            let info = vk::WaylandSurfaceCreateInfoKHR::default()
                .flags(vk::WaylandSurfaceCreateFlagsKHR::empty())
                .display(display)
                .surface(surface);

            unsafe { w_loader.create_wayland_surface(&info, None) }.expect("WaylandSurface failed")
        };

        Ok(self.create_surface_from_vk_surface_khr(surface))
    }

    fn create_surface_android(
        &self,
        window: *mut vk::ANativeWindow,
    ) -> Result<super::Surface, crate::InstanceError> {
        if !self.shared.extensions.contains(&khr::android_surface::NAME) {
            return Err(crate::InstanceError::new(String::from(
                "Vulkan driver does not support VK_KHR_android_surface",
            )));
        }

        let surface = {
            let a_loader =
                khr::android_surface::Instance::new(&self.shared.entry, &self.shared.raw);
            let info = vk::AndroidSurfaceCreateInfoKHR::default()
                .flags(vk::AndroidSurfaceCreateFlagsKHR::empty())
                .window(window);

            unsafe { a_loader.create_android_surface(&info, None) }.expect("AndroidSurface failed")
        };

        Ok(self.create_surface_from_vk_surface_khr(surface))
    }

    fn create_surface_from_hwnd(
        &self,
        hinstance: vk::HINSTANCE,
        hwnd: vk::HWND,
    ) -> Result<super::Surface, crate::InstanceError> {
        if !self.shared.extensions.contains(&khr::win32_surface::NAME) {
            return Err(crate::InstanceError::new(String::from(
                "Vulkan driver does not support VK_KHR_win32_surface",
            )));
        }

        let surface = {
            let info = vk::Win32SurfaceCreateInfoKHR::default()
                .flags(vk::Win32SurfaceCreateFlagsKHR::empty())
                .hinstance(hinstance)
                .hwnd(hwnd);
            let win32_loader =
                khr::win32_surface::Instance::new(&self.shared.entry, &self.shared.raw);
            unsafe {
                win32_loader
                    .create_win32_surface(&info, None)
                    .expect("Unable to create Win32 surface")
            }
        };

        Ok(self.create_surface_from_vk_surface_khr(surface))
    }

    #[cfg(metal)]
    fn create_surface_from_view(
        &self,
        view: std::ptr::NonNull<c_void>,
    ) -> Result<super::Surface, crate::InstanceError> {
        if !self.shared.extensions.contains(&ext::metal_surface::NAME) {
            return Err(crate::InstanceError::new(String::from(
                "Vulkan driver does not support VK_EXT_metal_surface",
            )));
        }

        let layer = unsafe { crate::metal::Surface::get_metal_layer(view.cast()) };
        // NOTE: The layer is retained by Vulkan's `vkCreateMetalSurfaceEXT`,
        // so no need to retain it beyond the scope of this function.
        let layer_ptr = (*layer).cast();

        let surface = {
            let metal_loader =
                ext::metal_surface::Instance::new(&self.shared.entry, &self.shared.raw);
            let vk_info = vk::MetalSurfaceCreateInfoEXT::default()
                .flags(vk::MetalSurfaceCreateFlagsEXT::empty())
                .layer(layer_ptr);

            unsafe { metal_loader.create_metal_surface(&vk_info, None).unwrap() }
        };

        Ok(self.create_surface_from_vk_surface_khr(surface))
    }

    pub(super) fn create_surface_from_vk_surface_khr(
        &self,
        surface: vk::SurfaceKHR,
    ) -> super::Surface {
        let functor = khr::surface::Instance::new(&self.shared.entry, &self.shared.raw);
        super::Surface {
            raw: surface,
            functor,
            instance: Arc::clone(&self.shared),
            swapchain: RwLock::new(None),
        }
    }
}

impl Drop for super::InstanceShared {
    fn drop(&mut self) {
        unsafe {
            // Keep du alive since destroy_instance may also log
            let _du = self.debug_utils.take().inspect(|du| {
                du.extension
                    .destroy_debug_utils_messenger(du.messenger, None);
            });
            if self.drop_guard.is_none() {
                self.raw.destroy_instance(None);
            }
        }
    }
}

impl crate::Instance for super::Instance {
    type A = super::Api;

    unsafe fn init(desc: &crate::InstanceDescriptor) -> Result<Self, crate::InstanceError> {
        profiling::scope!("Init Vulkan Backend");

        let entry = unsafe {
            profiling::scope!("Load vk library");
            ash::Entry::load()
        }
        .map_err(|err| {
            crate::InstanceError::with_source(String::from("missing Vulkan entry points"), err)
        })?;
        let version = {
            profiling::scope!("vkEnumerateInstanceVersion");
            unsafe { entry.try_enumerate_instance_version() }
        };
        let instance_api_version = match version {
            // Vulkan 1.1+
            Ok(Some(version)) => version,
            Ok(None) => vk::API_VERSION_1_0,
            Err(err) => {
                return Err(crate::InstanceError::with_source(
                    String::from("try_enumerate_instance_version() failed"),
                    err,
                ));
            }
        };

        let app_name = CString::new(desc.name).unwrap();
        let app_info = vk::ApplicationInfo::default()
            .application_name(app_name.as_c_str())
            .application_version(1)
            .engine_name(c"wgpu-hal")
            .engine_version(2)
            .api_version(
                // Vulkan 1.0 doesn't like anything but 1.0 passed in here...
                if instance_api_version < vk::API_VERSION_1_1 {
                    vk::API_VERSION_1_0
                } else {
                    // This is the max Vulkan API version supported by `wgpu-hal`.
                    //
                    // If we want to increment this, there are some things that must be done first:
                    //  - Audit the behavioral differences between the previous and new API versions.
                    //  - Audit all extensions used by this backend:
                    //    - If any were promoted in the new API version and the behavior has changed, we must handle the new behavior in addition to the old behavior.
                    //    - If any were obsoleted in the new API version, we must implement a fallback for the new API version
                    //    - If any are non-KHR-vendored, we must ensure the new behavior is still correct (since backwards-compatibility is not guaranteed).
                    vk::API_VERSION_1_3
                },
            );

        let extensions = Self::desired_extensions(&entry, instance_api_version, desc.flags)?;

        let instance_layers = {
            profiling::scope!("vkEnumerateInstanceLayerProperties");
            unsafe { entry.enumerate_instance_layer_properties() }
        };
        let instance_layers = instance_layers.map_err(|e| {
            log::debug!("enumerate_instance_layer_properties: {:?}", e);
            crate::InstanceError::with_source(
                String::from("enumerate_instance_layer_properties() failed"),
                e,
            )
        })?;

        fn find_layer<'layers>(
            instance_layers: &'layers [vk::LayerProperties],
            name: &CStr,
        ) -> Option<&'layers vk::LayerProperties> {
            instance_layers
                .iter()
                .find(|inst_layer| inst_layer.layer_name_as_c_str() == Ok(name))
        }

        let validation_layer_name = c"VK_LAYER_KHRONOS_validation";
        let validation_layer_properties = find_layer(&instance_layers, validation_layer_name);

        // Determine if VK_EXT_validation_features is available, so we can enable
        // GPU assisted validation and synchronization validation.
        let validation_features_are_enabled = if validation_layer_properties.is_some() {
            // Get the all the instance extension properties.
            let exts =
                Self::enumerate_instance_extension_properties(&entry, Some(validation_layer_name))?;
            // Convert all the names of the extensions into an iterator of CStrs.
            let mut ext_names = exts
                .iter()
                .filter_map(|ext| ext.extension_name_as_c_str().ok());
            // Find the validation features extension.
            ext_names.any(|ext_name| ext_name == ext::validation_features::NAME)
        } else {
            false
        };

        let should_enable_gpu_based_validation = desc
            .flags
            .intersects(wgt::InstanceFlags::GPU_BASED_VALIDATION)
            && validation_features_are_enabled;

        let has_nv_optimus = find_layer(&instance_layers, c"VK_LAYER_NV_optimus").is_some();

        let has_obs_layer = find_layer(&instance_layers, c"VK_LAYER_OBS_HOOK").is_some();

        let mut layers: Vec<&'static CStr> = Vec::new();

        let has_debug_extension = extensions.contains(&ext::debug_utils::NAME);
        let mut debug_user_data = has_debug_extension.then(|| {
            // Put the callback data on the heap, to ensure it will never be
            // moved.
            Box::new(super::DebugUtilsMessengerUserData {
                validation_layer_properties: None,
                has_obs_layer,
            })
        });

        // Request validation layer if asked.
        if desc.flags.intersects(wgt::InstanceFlags::VALIDATION)
            || should_enable_gpu_based_validation
        {
            if let Some(layer_properties) = validation_layer_properties {
                layers.push(validation_layer_name);

                if let Some(debug_user_data) = debug_user_data.as_mut() {
                    debug_user_data.validation_layer_properties =
                        Some(super::ValidationLayerProperties {
                            layer_description: layer_properties
                                .description_as_c_str()
                                .unwrap()
                                .to_owned(),
                            layer_spec_version: layer_properties.spec_version,
                        });
                }
            } else {
                log::warn!(
                    "InstanceFlags::VALIDATION requested, but unable to find layer: {}",
                    validation_layer_name.to_string_lossy()
                );
            }
        }
        let mut debug_utils = if let Some(callback_data) = debug_user_data {
            // having ERROR unconditionally because Vk doesn't like empty flags
            let mut severity = vk::DebugUtilsMessageSeverityFlagsEXT::ERROR;
            if log::max_level() >= log::LevelFilter::Debug {
                severity |= vk::DebugUtilsMessageSeverityFlagsEXT::VERBOSE;
            }
            if log::max_level() >= log::LevelFilter::Info {
                severity |= vk::DebugUtilsMessageSeverityFlagsEXT::INFO;
            }
            if log::max_level() >= log::LevelFilter::Warn {
                severity |= vk::DebugUtilsMessageSeverityFlagsEXT::WARNING;
            }

            let message_type = vk::DebugUtilsMessageTypeFlagsEXT::GENERAL
                | vk::DebugUtilsMessageTypeFlagsEXT::VALIDATION
                | vk::DebugUtilsMessageTypeFlagsEXT::PERFORMANCE;

            let create_info = super::DebugUtilsCreateInfo {
                severity,
                message_type,
                callback_data,
            };

            Some(create_info)
        } else {
            None
        };

        #[cfg(target_os = "android")]
        let android_sdk_version = {
            let properties = android_system_properties::AndroidSystemProperties::new();
            // See: https://developer.android.com/reference/android/os/Build.VERSION_CODES
            if let Some(val) = properties.get("ro.build.version.sdk") {
                match val.parse::<u32>() {
                    Ok(sdk_ver) => sdk_ver,
                    Err(err) => {
                        log::error!(
                            concat!(
                                "Couldn't parse Android's ",
                                "ro.build.version.sdk system property ({}): {}",
                            ),
                            val,
                            err,
                        );
                        0
                    }
                }
            } else {
                log::error!("Couldn't read Android's ro.build.version.sdk system property");
                0
            }
        };
        #[cfg(not(target_os = "android"))]
        let android_sdk_version = 0;

        let mut flags = vk::InstanceCreateFlags::empty();

        // Avoid VUID-VkInstanceCreateInfo-flags-06559: Only ask the instance to
        // enumerate incomplete Vulkan implementations (which we need on Mac) if
        // we managed to find the extension that provides the flag.
        if extensions.contains(&khr::portability_enumeration::NAME) {
            flags |= vk::InstanceCreateFlags::ENUMERATE_PORTABILITY_KHR;
        }
        let vk_instance = {
            let str_pointers = layers
                .iter()
                .chain(extensions.iter())
                .map(|&s: &&'static _| {
                    // Safe because `layers` and `extensions` entries have static lifetime.
                    s.as_ptr()
                })
                .collect::<Vec<_>>();

            let mut create_info = vk::InstanceCreateInfo::default()
                .flags(flags)
                .application_info(&app_info)
                .enabled_layer_names(&str_pointers[..layers.len()])
                .enabled_extension_names(&str_pointers[layers.len()..]);

            let mut debug_utils_create_info = debug_utils
                .as_mut()
                .map(|create_info| create_info.to_vk_create_info());
            if let Some(debug_utils_create_info) = debug_utils_create_info.as_mut() {
                create_info = create_info.push_next(debug_utils_create_info);
            }

            // Enable explicit validation features if available
            let mut validation_features;
            let mut validation_feature_list: ArrayVec<_, 3>;
            if validation_features_are_enabled {
                validation_feature_list = ArrayVec::new();

                // Always enable synchronization validation
                validation_feature_list
                    .push(vk::ValidationFeatureEnableEXT::SYNCHRONIZATION_VALIDATION);

                // Only enable GPU assisted validation if requested.
                if should_enable_gpu_based_validation {
                    validation_feature_list.push(vk::ValidationFeatureEnableEXT::GPU_ASSISTED);
                    validation_feature_list
                        .push(vk::ValidationFeatureEnableEXT::GPU_ASSISTED_RESERVE_BINDING_SLOT);
                }

                validation_features = vk::ValidationFeaturesEXT::default()
                    .enabled_validation_features(&validation_feature_list);
                create_info = create_info.push_next(&mut validation_features);
            }

            unsafe {
                profiling::scope!("vkCreateInstance");
                entry.create_instance(&create_info, None)
            }
            .map_err(|e| {
                crate::InstanceError::with_source(
                    String::from("Entry::create_instance() failed"),
                    e,
                )
            })?
        };

        unsafe {
            Self::from_raw(
                entry,
                vk_instance,
                instance_api_version,
                android_sdk_version,
                debug_utils,
                extensions,
                desc.flags,
                has_nv_optimus,
                None,
            )
        }
    }

    unsafe fn create_surface(
        &self,
        display_handle: raw_window_handle::RawDisplayHandle,
        window_handle: raw_window_handle::RawWindowHandle,
    ) -> Result<super::Surface, crate::InstanceError> {
        use raw_window_handle::{RawDisplayHandle as Rdh, RawWindowHandle as Rwh};

        // TODO: Replace with ash-window, which also lazy-loads the extension based on handle type

        match (window_handle, display_handle) {
            (Rwh::Wayland(handle), Rdh::Wayland(display)) => {
                self.create_surface_from_wayland(display.display.as_ptr(), handle.surface.as_ptr())
            }
            (Rwh::Xlib(handle), Rdh::Xlib(display)) => {
                let display = display.display.expect("Display pointer is not set.");
                self.create_surface_from_xlib(display.as_ptr(), handle.window)
            }
            (Rwh::Xcb(handle), Rdh::Xcb(display)) => {
                let connection = display.connection.expect("Pointer to X-Server is not set.");
                self.create_surface_from_xcb(connection.as_ptr(), handle.window.get())
            }
            (Rwh::AndroidNdk(handle), _) => {
                self.create_surface_android(handle.a_native_window.as_ptr())
            }
            (Rwh::Win32(handle), _) => {
                let hinstance = handle.hinstance.ok_or_else(|| {
                    crate::InstanceError::new(String::from(
                        "Vulkan requires raw-window-handle's Win32::hinstance to be set",
                    ))
                })?;
                self.create_surface_from_hwnd(hinstance.get(), handle.hwnd.get())
            }
            #[cfg(all(target_os = "macos", feature = "metal"))]
            (Rwh::AppKit(handle), _)
                if self.shared.extensions.contains(&ext::metal_surface::NAME) =>
            {
                self.create_surface_from_view(handle.ns_view)
            }
            #[cfg(all(any(target_os = "ios", target_os = "visionos"), feature = "metal"))]
            (Rwh::UiKit(handle), _)
                if self.shared.extensions.contains(&ext::metal_surface::NAME) =>
            {
                self.create_surface_from_view(handle.ui_view)
            }
            (_, _) => Err(crate::InstanceError::new(format!(
                "window handle {window_handle:?} is not a Vulkan-compatible handle"
            ))),
        }
    }

    unsafe fn enumerate_adapters(
        &self,
        _surface_hint: Option<&super::Surface>,
    ) -> Vec<crate::ExposedAdapter<super::Api>> {
        use crate::auxil::db;

        let raw_devices = match unsafe { self.shared.raw.enumerate_physical_devices() } {
            Ok(devices) => devices,
            Err(err) => {
                log::error!("enumerate_adapters: {}", err);
                Vec::new()
            }
        };

        let mut exposed_adapters = raw_devices
            .into_iter()
            .flat_map(|device| self.expose_adapter(device))
            .collect::<Vec<_>>();

        // Detect if it's an Intel + NVidia configuration with Optimus
        let has_nvidia_dgpu = exposed_adapters.iter().any(|exposed| {
            exposed.info.device_type == wgt::DeviceType::DiscreteGpu
                && exposed.info.vendor == db::nvidia::VENDOR
        });
        if cfg!(target_os = "linux") && has_nvidia_dgpu && self.shared.has_nv_optimus {
            for exposed in exposed_adapters.iter_mut() {
                if exposed.info.device_type == wgt::DeviceType::IntegratedGpu
                    && exposed.info.vendor == db::intel::VENDOR
                {
                    // Check if mesa driver and version less than 21.2
                    if let Some(version) = exposed.info.driver_info.split_once("Mesa ").map(|s| {
                        let mut components = s.1.split('.');
                        let major = components.next().and_then(|s| u8::from_str(s).ok());
                        let minor = components.next().and_then(|s| u8::from_str(s).ok());
                        if let (Some(major), Some(minor)) = (major, minor) {
                            (major, minor)
                        } else {
                            (0, 0)
                        }
                    }) {
                        if version < (21, 2) {
                            // See https://gitlab.freedesktop.org/mesa/mesa/-/issues/4688
                            log::warn!(
                                concat!(
                                    "Disabling presentation on '{}' (id {:?}) ",
                                    "due to NV Optimus and Intel Mesa < v21.2"
                                ),
                                exposed.info.name,
                                exposed.adapter.raw
                            );
                            exposed.adapter.private_caps.can_present = false;
                        }
                    }
                }
            }
        }

        exposed_adapters
    }
}

impl Drop for super::Surface {
    fn drop(&mut self) {
        unsafe { self.functor.destroy_surface(self.raw, None) };
    }
}

impl crate::Surface for super::Surface {
    type A = super::Api;

    unsafe fn configure(
        &self,
        device: &super::Device,
        config: &crate::SurfaceConfiguration,
    ) -> Result<(), crate::SurfaceError> {
        // SAFETY: `configure`'s contract guarantees there are no resources derived from the swapchain in use.
        let mut swap_chain = self.swapchain.write();
        let old = swap_chain
            .take()
            .map(|sc| unsafe { sc.release_resources(&device.shared.raw) });

        let swapchain = unsafe { device.create_swapchain(self, config, old)? };
        *swap_chain = Some(swapchain);

        Ok(())
    }

    unsafe fn unconfigure(&self, device: &super::Device) {
        if let Some(sc) = self.swapchain.write().take() {
            // SAFETY: `unconfigure`'s contract guarantees there are no resources derived from the swapchain in use.
            let swapchain = unsafe { sc.release_resources(&device.shared.raw) };
            unsafe { swapchain.functor.destroy_swapchain(swapchain.raw, None) };
        }
    }

    unsafe fn acquire_texture(
        &self,
        timeout: Option<std::time::Duration>,
        fence: &super::Fence,
    ) -> Result<Option<crate::AcquiredSurfaceTexture<super::Api>>, crate::SurfaceError> {
        let mut swapchain = self.swapchain.write();
        let swapchain = swapchain.as_mut().unwrap();

        let mut timeout_ns = match timeout {
            Some(duration) => duration.as_nanos() as u64,
            None => u64::MAX,
        };

        // AcquireNextImageKHR on Android (prior to Android 11) doesn't support timeouts
        // and will also log verbose warnings if tying to use a timeout.
        //
        // Android 10 implementation for reference:
        // https://android.googlesource.com/platform/frameworks/native/+/refs/tags/android-mainline-10.0.0_r13/vulkan/libvulkan/swapchain.cpp#1426
        // Android 11 implementation for reference:
        // https://android.googlesource.com/platform/frameworks/native/+/refs/tags/android-mainline-11.0.0_r45/vulkan/libvulkan/swapchain.cpp#1438
        //
        // Android 11 corresponds to an SDK_INT/ro.build.version.sdk of 30
        if cfg!(target_os = "android") && self.instance.android_sdk_version < 30 {
            timeout_ns = u64::MAX;
        }

        let swapchain_semaphores_arc = swapchain.get_surface_semaphores();
        // Nothing should be using this, so we don't block, but panic if we fail to lock.
        let locked_swapchain_semaphores = swapchain_semaphores_arc
            .try_lock()
            .expect("Failed to lock a SwapchainSemaphores.");

        // Wait for all commands writing to the previously acquired image to
        // complete.
        //
        // Almost all the steps in the usual acquire-draw-present flow are
        // asynchronous: they get something started on the presentation engine
        // or the GPU, but on the CPU, control returns immediately. Without some
        // sort of intervention, the CPU could crank out frames much faster than
        // the presentation engine can display them.
        //
        // This is the intervention: if any submissions drew on this image, and
        // thus waited for `locked_swapchain_semaphores.acquire`, wait for all
        // of them to finish, thus ensuring that it's okay to pass `acquire` to
        // `vkAcquireNextImageKHR` again.
        swapchain.device.wait_for_fence(
            fence,
            locked_swapchain_semaphores.previously_used_submission_index,
            timeout_ns,
        )?;

        // will block if no image is available
        let (index, suboptimal) = match unsafe {
            profiling::scope!("vkAcquireNextImageKHR");
            swapchain.functor.acquire_next_image(
                swapchain.raw,
                timeout_ns,
                locked_swapchain_semaphores.acquire,
                vk::Fence::null(),
            )
        } {
            // We treat `VK_SUBOPTIMAL_KHR` as `VK_SUCCESS` on Android.
            // See the comment in `Queue::present`.
            #[cfg(target_os = "android")]
            Ok((index, _)) => (index, false),
            #[cfg(not(target_os = "android"))]
            Ok(pair) => pair,
            Err(error) => {
                return match error {
                    vk::Result::TIMEOUT => Ok(None),
                    vk::Result::NOT_READY | vk::Result::ERROR_OUT_OF_DATE_KHR => {
                        Err(crate::SurfaceError::Outdated)
                    }
                    vk::Result::ERROR_SURFACE_LOST_KHR => Err(crate::SurfaceError::Lost),
                    // We don't use VK_EXT_full_screen_exclusive
                    // VK_ERROR_FULL_SCREEN_EXCLUSIVE_MODE_LOST_EXT
                    other => Err(super::map_host_device_oom_and_lost_err(other).into()),
                };
            }
        };

        drop(locked_swapchain_semaphores);
        // We only advance the surface semaphores if we successfully acquired an image, otherwise
        // we should try to re-acquire using the same semaphores.
        swapchain.advance_surface_semaphores();

        // special case for Intel Vulkan returning bizarre values (ugh)
        if swapchain.device.vendor_id == crate::auxil::db::intel::VENDOR && index > 0x100 {
            return Err(crate::SurfaceError::Outdated);
        }

        // https://registry.khronos.org/vulkan/specs/1.3-extensions/man/html/VkRenderPassBeginInfo.html#VUID-VkRenderPassBeginInfo-framebuffer-03209
        let raw_flags = if swapchain
            .raw_flags
            .contains(vk::SwapchainCreateFlagsKHR::MUTABLE_FORMAT)
        {
            vk::ImageCreateFlags::MUTABLE_FORMAT | vk::ImageCreateFlags::EXTENDED_USAGE
        } else {
            vk::ImageCreateFlags::empty()
        };

        let texture = super::SurfaceTexture {
            index,
            texture: super::Texture {
                raw: swapchain.images[index as usize],
                drop_guard: None,
                block: None,
                external_memory: None,
                usage: swapchain.config.usage,
                format: swapchain.config.format,
                raw_flags,
                copy_size: crate::CopyExtent {
                    width: swapchain.config.extent.width,
                    height: swapchain.config.extent.height,
                    depth: 1,
                },
                view_formats: swapchain.view_formats.clone(),
            },
            surface_semaphores: swapchain_semaphores_arc,
        };
        Ok(Some(crate::AcquiredSurfaceTexture {
            texture,
            suboptimal,
        }))
    }

    unsafe fn discard_texture(&self, _texture: super::SurfaceTexture) {}
}
