use std::{string::String, sync::Arc, vec::Vec};

use parking_lot::RwLock;
use windows::{
    core::Interface as _,
    Win32::{
        Foundation,
        Graphics::{Direct3D12, Dxgi},
    },
};

use super::SurfaceTarget;
use crate::{auxil, dx12::D3D12Lib};

impl crate::Instance for super::Instance {
    type A = super::Api;

    unsafe fn init(desc: &crate::InstanceDescriptor) -> Result<Self, crate::InstanceError> {
        profiling::scope!("Init DX12 Backend");
        let lib_main = D3D12Lib::new().map_err(|e| {
            crate::InstanceError::with_source(String::from("failed to load d3d12.dll"), e)
        })?;

        if desc
            .flags
            .intersects(wgt::InstanceFlags::VALIDATION | wgt::InstanceFlags::GPU_BASED_VALIDATION)
        {
            // Enable debug layer
            if let Ok(Some(debug_controller)) = lib_main.debug_interface() {
                if desc.flags.intersects(wgt::InstanceFlags::VALIDATION) {
                    unsafe { debug_controller.EnableDebugLayer() }
                }
                if desc
                    .flags
                    .intersects(wgt::InstanceFlags::GPU_BASED_VALIDATION)
                {
                    #[allow(clippy::collapsible_if)]
                    if let Ok(debug1) = debug_controller.cast::<Direct3D12::ID3D12Debug1>() {
                        unsafe { debug1.SetEnableGPUBasedValidation(true) }
                    } else {
                        log::warn!("Failed to enable GPU-based validation");
                    }
                }
            }
        }

        let (lib_dxgi, factory) = auxil::dxgi::factory::create_factory(desc.flags)?;

        // Create IDXGIFactoryMedia
        let factory_media = lib_dxgi.create_factory_media().ok();

        let mut supports_allow_tearing = false;
        if let Some(factory5) = factory.as_factory5() {
            let mut allow_tearing = Foundation::FALSE;
            let hr = unsafe {
                factory5.CheckFeatureSupport(
                    Dxgi::DXGI_FEATURE_PRESENT_ALLOW_TEARING,
                    <*mut _>::cast(&mut allow_tearing),
                    size_of_val(&allow_tearing) as u32,
                )
            };

            match hr {
                Err(err) => log::warn!("Unable to check for tearing support: {err}"),
                Ok(()) => supports_allow_tearing = true,
            }
        }

        // Initialize DXC shader compiler
        let dxc_container = match desc.backend_options.dx12.shader_compiler.clone() {
            wgt::Dx12Compiler::DynamicDxc {
                dxil_path,
                dxc_path,
                max_shader_model,
            } => {
                let container = super::shader_compilation::get_dynamic_dxc_container(
                    dxc_path.into(),
                    dxil_path.into(),
                    max_shader_model,
                )
                .map_err(|e| {
                    crate::InstanceError::with_source(String::from("Failed to load dynamic DXC"), e)
                })?;

                Some(Arc::new(container))
            }
            wgt::Dx12Compiler::StaticDxc => {
                let container =
                    super::shader_compilation::get_static_dxc_container().map_err(|e| {
                        crate::InstanceError::with_source(
                            String::from("Failed to load static DXC"),
                            e,
                        )
                    })?;

                Some(Arc::new(container))
            }
            wgt::Dx12Compiler::Fxc => None,
        };

        match dxc_container {
            Some(_) => log::debug!("Using DXC for shader compilation"),
            None => log::debug!("Using FXC for shader compilation"),
        }

        Ok(Self {
            // The call to create_factory will only succeed if we get a factory4, so this is safe.
            factory,
            factory_media,
            library: Arc::new(lib_main),
            _lib_dxgi: lib_dxgi,
            supports_allow_tearing,
            flags: desc.flags,
            dxc_container,
        })
    }

    unsafe fn create_surface(
        &self,
        _display_handle: raw_window_handle::RawDisplayHandle,
        window_handle: raw_window_handle::RawWindowHandle,
    ) -> Result<super::Surface, crate::InstanceError> {
        match window_handle {
            raw_window_handle::RawWindowHandle::Win32(handle) => Ok(super::Surface {
                factory: self.factory.clone(),
                factory_media: self.factory_media.clone(),
                // https://github.com/rust-windowing/raw-window-handle/issues/171
                target: SurfaceTarget::WndHandle(Foundation::HWND(handle.hwnd.get() as *mut _)),
                supports_allow_tearing: self.supports_allow_tearing,
                swap_chain: RwLock::new(None),
            }),
            _ => Err(crate::InstanceError::new(format!(
                "window handle {window_handle:?} is not a Win32 handle"
            ))),
        }
    }

    unsafe fn enumerate_adapters(
        &self,
        _surface_hint: Option<&super::Surface>,
    ) -> Vec<crate::ExposedAdapter<super::Api>> {
        let adapters = auxil::dxgi::factory::enumerate_adapters(self.factory.clone());

        adapters
            .into_iter()
            .filter_map(|raw| {
                super::Adapter::expose(raw, &self.library, self.flags, self.dxc_container.clone())
            })
            .collect()
    }
}
