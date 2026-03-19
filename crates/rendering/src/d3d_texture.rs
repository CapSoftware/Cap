#[derive(Debug)]
pub enum D3DTextureError {
    NoD3D12Device,
    TextureCreationFailed(String),
    SharedHandleFailed(String),
    WgpuImportFailed(String),
    UnsupportedFormat,
    DeviceMismatch,
    OpenSharedHandleFailed(String),
    HalTextureCreationFailed(String),
    #[cfg(not(target_os = "windows"))]
    NotSupported,
}

impl std::fmt::Display for D3DTextureError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NoD3D12Device => write!(f, "No D3D12 device available"),
            Self::TextureCreationFailed(e) => write!(f, "Failed to create D3D texture: {e}"),
            Self::SharedHandleFailed(e) => write!(f, "Failed to create shared handle: {e}"),
            Self::WgpuImportFailed(e) => write!(f, "Failed to import texture to wgpu: {e}"),
            Self::UnsupportedFormat => write!(f, "Unsupported pixel format for zero-copy"),
            Self::DeviceMismatch => write!(f, "D3D11 and D3D12 device mismatch"),
            Self::OpenSharedHandleFailed(e) => write!(f, "Failed to open shared handle: {e}"),
            Self::HalTextureCreationFailed(e) => write!(f, "Failed to create HAL texture: {e}"),
            #[cfg(not(target_os = "windows"))]
            Self::NotSupported => write!(f, "D3D textures are only supported on Windows"),
        }
    }
}

impl std::error::Error for D3DTextureError {}

#[cfg(target_os = "windows")]
mod windows_impl {
    use super::D3DTextureError;
    use std::sync::atomic::{AtomicBool, Ordering};
    use wgpu_hal::api::Dx12 as dx12;
    use windows::{
        Win32::{
            Foundation::HANDLE,
            Graphics::{
                Direct3D11::{
                    D3D11_BIND_SHADER_RESOURCE, D3D11_RESOURCE_MISC_SHARED_NTHANDLE,
                    D3D11_TEXTURE2D_DESC, D3D11_USAGE_DEFAULT, ID3D11Device, ID3D11Texture2D,
                },
                Dxgi::Common::{
                    DXGI_FORMAT, DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_FORMAT_NV12,
                    DXGI_FORMAT_R8_UNORM, DXGI_FORMAT_R8G8_UNORM, DXGI_FORMAT_R8G8B8A8_UNORM,
                    DXGI_FORMAT_UNKNOWN, DXGI_SAMPLE_DESC,
                },
            },
        },
        core::Interface,
    };

    pub struct D3DTextureCache {
        d3d11_device: ID3D11Device,
    }

    impl D3DTextureCache {
        pub fn new(d3d11_device: ID3D11Device) -> Self {
            Self { d3d11_device }
        }

        pub fn d3d11_device(&self) -> &ID3D11Device {
            &self.d3d11_device
        }

        pub fn create_shared_texture(
            &self,
            width: u32,
            height: u32,
            format: DXGI_FORMAT,
        ) -> Result<SharedD3D11Texture, D3DTextureError> {
            SharedD3D11Texture::create(&self.d3d11_device, width, height, format)
        }
    }

    pub struct SharedD3D11Texture {
        pub texture: ID3D11Texture2D,
        pub width: u32,
        pub height: u32,
        pub format: DXGI_FORMAT,
    }

    impl SharedD3D11Texture {
        pub fn create_nv12(
            device: &ID3D11Device,
            width: u32,
            height: u32,
        ) -> Result<Self, D3DTextureError> {
            Self::create(device, width, height, DXGI_FORMAT_NV12)
        }

        pub fn create_r8(
            device: &ID3D11Device,
            width: u32,
            height: u32,
        ) -> Result<Self, D3DTextureError> {
            Self::create(device, width, height, DXGI_FORMAT_R8_UNORM)
        }

        pub fn create_rg8(
            device: &ID3D11Device,
            width: u32,
            height: u32,
        ) -> Result<Self, D3DTextureError> {
            Self::create(device, width, height, DXGI_FORMAT_R8G8_UNORM)
        }

        pub fn create(
            device: &ID3D11Device,
            width: u32,
            height: u32,
            format: DXGI_FORMAT,
        ) -> Result<Self, D3DTextureError> {
            let desc = D3D11_TEXTURE2D_DESC {
                Width: width,
                Height: height,
                MipLevels: 1,
                ArraySize: 1,
                Format: format,
                SampleDesc: DXGI_SAMPLE_DESC {
                    Count: 1,
                    Quality: 0,
                },
                Usage: D3D11_USAGE_DEFAULT,
                BindFlags: D3D11_BIND_SHADER_RESOURCE.0 as u32,
                CPUAccessFlags: 0,
                MiscFlags: D3D11_RESOURCE_MISC_SHARED_NTHANDLE.0 as u32,
            };

            let texture = unsafe {
                let mut texture: Option<ID3D11Texture2D> = None;
                device
                    .CreateTexture2D(&desc, None, Some(&mut texture))
                    .map_err(|e| D3DTextureError::TextureCreationFailed(format!("{e:?}")))?;
                texture.ok_or_else(|| {
                    D3DTextureError::TextureCreationFailed(
                        "CreateTexture2D returned null".to_string(),
                    )
                })?
            };

            Ok(Self {
                texture,
                width,
                height,
                format,
            })
        }

        pub fn as_raw_ptr(&self) -> *mut std::ffi::c_void {
            self.texture.as_raw()
        }
    }

    pub struct D3DYuvTextures {
        pub y_texture: SharedD3D11Texture,
        pub uv_texture: SharedD3D11Texture,
        pub width: u32,
        pub height: u32,
    }

    impl D3DYuvTextures {
        pub fn create_nv12(
            device: &ID3D11Device,
            width: u32,
            height: u32,
        ) -> Result<Self, D3DTextureError> {
            let y_texture = SharedD3D11Texture::create_r8(device, width, height)?;
            let uv_texture = SharedD3D11Texture::create_rg8(device, width / 2, height / 2)?;

            Ok(Self {
                y_texture,
                uv_texture,
                width,
                height,
            })
        }
    }

    pub fn wgpu_to_dxgi_format(format: wgpu::TextureFormat) -> DXGI_FORMAT {
        match format {
            wgpu::TextureFormat::R8Unorm => DXGI_FORMAT_R8_UNORM,
            wgpu::TextureFormat::Rg8Unorm => DXGI_FORMAT_R8G8_UNORM,
            wgpu::TextureFormat::Rgba8Unorm => DXGI_FORMAT_R8G8B8A8_UNORM,
            wgpu::TextureFormat::Bgra8Unorm => DXGI_FORMAT_B8G8R8A8_UNORM,
            _ => DXGI_FORMAT_UNKNOWN,
        }
    }

    static ZERO_COPY_LOGGED: AtomicBool = AtomicBool::new(false);

    pub fn import_d3d11_texture_to_wgpu(
        device: &wgpu::Device,
        shared_handle: HANDLE,
        format: wgpu::TextureFormat,
        width: u32,
        height: u32,
        label: Option<&str>,
    ) -> Result<wgpu::Texture, D3DTextureError> {
        let dxgi_format = wgpu_to_dxgi_format(format);
        if dxgi_format == DXGI_FORMAT_UNKNOWN {
            return Err(D3DTextureError::UnsupportedFormat);
        }

        let handle_raw_value = shared_handle.0 as isize;

        let result: Result<wgpu::Texture, D3DTextureError> = unsafe {
            device.as_hal::<dx12, _, _>(|hal_device| {
                let hal_device = hal_device.ok_or(D3DTextureError::NoD3D12Device)?;

                let d3d12_device = hal_device.raw_device();

                use windows_0_58::Win32::Foundation::HANDLE as HAL_HANDLE;
                use windows_0_58::Win32::Graphics::Direct3D12::ID3D12Resource;

                let hal_handle = HAL_HANDLE(handle_raw_value as *mut std::ffi::c_void);

                let mut d3d12_resource: Option<ID3D12Resource> = None;
                d3d12_device
                    .OpenSharedHandle(hal_handle, &mut d3d12_resource)
                    .map_err(|e| D3DTextureError::OpenSharedHandleFailed(format!("{e:?}")))?;
                let d3d12_resource = d3d12_resource.ok_or_else(|| {
                    D3DTextureError::OpenSharedHandleFailed(
                        "OpenSharedHandle returned null".to_string(),
                    )
                })?;

                let hal_texture = wgpu_hal::dx12::Device::texture_from_raw(
                    d3d12_resource,
                    format,
                    wgpu::TextureDimension::D2,
                    wgpu::Extent3d {
                        width,
                        height,
                        depth_or_array_layers: 1,
                    },
                    1,
                    1,
                );

                if !ZERO_COPY_LOGGED.swap(true, Ordering::Relaxed) {
                    tracing::info!(
                        "D3D11→D3D12 zero-copy texture sharing enabled via shared handles"
                    );
                }

                tracing::debug!(
                    width = width,
                    height = height,
                    format = ?format,
                    "Opened D3D12 shared texture from D3D11 handle"
                );

                let wgpu_texture = device.create_texture_from_hal::<dx12>(
                    hal_texture,
                    &wgpu::TextureDescriptor {
                        label,
                        size: wgpu::Extent3d {
                            width,
                            height,
                            depth_or_array_layers: 1,
                        },
                        mip_level_count: 1,
                        sample_count: 1,
                        dimension: wgpu::TextureDimension::D2,
                        format,
                        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_SRC,
                        view_formats: &[],
                    },
                );

                Ok(wgpu_texture)
            })
        };

        result
    }

    pub struct D3D11WgpuInterop {
        cached_width: u32,
        cached_height: u32,
        y_wgpu_texture: Option<wgpu::Texture>,
        uv_wgpu_texture: Option<wgpu::Texture>,
        last_y_handle: Option<isize>,
        last_uv_handle: Option<isize>,
    }

    unsafe impl Send for D3D11WgpuInterop {}
    unsafe impl Sync for D3D11WgpuInterop {}

    impl Default for D3D11WgpuInterop {
        fn default() -> Self {
            Self::new()
        }
    }

    impl D3D11WgpuInterop {
        pub fn new() -> Self {
            Self {
                cached_width: 0,
                cached_height: 0,
                y_wgpu_texture: None,
                uv_wgpu_texture: None,
                last_y_handle: None,
                last_uv_handle: None,
            }
        }

        pub fn import_nv12_planes(
            &mut self,
            device: &wgpu::Device,
            y_handle: HANDLE,
            uv_handle: HANDLE,
            width: u32,
            height: u32,
        ) -> Result<(&wgpu::Texture, &wgpu::Texture), D3DTextureError> {
            let y_handle_value = y_handle.0 as isize;
            let uv_handle_value = uv_handle.0 as isize;

            let need_recreate = self.cached_width != width
                || self.cached_height != height
                || self.last_y_handle != Some(y_handle_value)
                || self.last_uv_handle != Some(uv_handle_value)
                || self.y_wgpu_texture.is_none()
                || self.uv_wgpu_texture.is_none();

            if need_recreate {
                self.y_wgpu_texture = Some(import_d3d11_texture_to_wgpu(
                    device,
                    y_handle,
                    wgpu::TextureFormat::R8Unorm,
                    width,
                    height,
                    Some("D3D11 Y Plane Zero-Copy"),
                )?);

                self.uv_wgpu_texture = Some(import_d3d11_texture_to_wgpu(
                    device,
                    uv_handle,
                    wgpu::TextureFormat::Rg8Unorm,
                    width / 2,
                    height / 2,
                    Some("D3D11 UV Plane Zero-Copy"),
                )?);

                self.cached_width = width;
                self.cached_height = height;
                self.last_y_handle = Some(y_handle_value);
                self.last_uv_handle = Some(uv_handle_value);

                tracing::debug!(
                    width = width,
                    height = height,
                    "Created zero-copy NV12 textures from D3D11 shared handles"
                );
            }

            Ok((
                self.y_wgpu_texture.as_ref().unwrap(),
                self.uv_wgpu_texture.as_ref().unwrap(),
            ))
        }

        pub fn invalidate(&mut self) {
            self.y_wgpu_texture = None;
            self.uv_wgpu_texture = None;
            self.last_y_handle = None;
            self.last_uv_handle = None;
        }
    }
}

#[cfg(target_os = "windows")]
pub use windows_impl::*;
