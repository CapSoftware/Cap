#[cfg(target_os = "macos")]
use cidre::{arc::R, cv, io, mtl};

#[cfg(target_os = "macos")]
use foreign_types::ForeignType;

#[cfg(target_os = "macos")]
use wgpu_hal::api::Metal as MtlApi;

#[derive(Debug)]
pub enum IOSurfaceTextureError {
    NoIOSurface,
    NoMetalDevice,
    TextureCreationFailed,
    WgpuImportFailed(String),
    UnsupportedFormat,
}

impl std::fmt::Display for IOSurfaceTextureError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NoIOSurface => write!(f, "CVPixelBuffer has no IOSurface backing"),
            Self::NoMetalDevice => write!(f, "Failed to get Metal device"),
            Self::TextureCreationFailed => {
                write!(f, "Failed to create Metal texture from IOSurface")
            }
            Self::WgpuImportFailed(e) => write!(f, "Failed to import texture to wgpu: {e}"),
            Self::UnsupportedFormat => write!(f, "Unsupported pixel format for zero-copy"),
        }
    }
}

impl std::error::Error for IOSurfaceTextureError {}

#[cfg(target_os = "macos")]
pub struct IOSurfaceTextureCache {
    metal_device: R<mtl::Device>,
}

#[cfg(target_os = "macos")]
impl IOSurfaceTextureCache {
    pub fn new() -> Option<Self> {
        let metal_device = mtl::Device::sys_default()?;
        Some(Self { metal_device })
    }

    pub fn create_y_texture(
        &self,
        io_surface: &io::Surf,
        width: u32,
        height: u32,
    ) -> Result<R<mtl::Texture>, IOSurfaceTextureError> {
        let mut desc = mtl::TextureDesc::new_2d(
            mtl::PixelFormat::R8UNorm,
            width as usize,
            height as usize,
            false,
        );
        desc.set_storage_mode(mtl::StorageMode::Shared);
        desc.set_usage(mtl::TextureUsage::SHADER_READ);

        self.metal_device
            .new_texture_with_surf(&desc, io_surface, 0)
            .ok_or(IOSurfaceTextureError::TextureCreationFailed)
    }

    pub fn create_uv_texture(
        &self,
        io_surface: &io::Surf,
        width: u32,
        height: u32,
    ) -> Result<R<mtl::Texture>, IOSurfaceTextureError> {
        let mut desc = mtl::TextureDesc::new_2d(
            mtl::PixelFormat::Rg8UNorm,
            (width / 2) as usize,
            (height / 2) as usize,
            false,
        );
        desc.set_storage_mode(mtl::StorageMode::Shared);
        desc.set_usage(mtl::TextureUsage::SHADER_READ);

        self.metal_device
            .new_texture_with_surf(&desc, io_surface, 1)
            .ok_or(IOSurfaceTextureError::TextureCreationFailed)
    }

    pub fn create_rgba_texture(
        &self,
        io_surface: &io::Surf,
        width: u32,
        height: u32,
    ) -> Result<R<mtl::Texture>, IOSurfaceTextureError> {
        let mut desc = mtl::TextureDesc::new_2d(
            mtl::PixelFormat::Rgba8UNorm,
            width as usize,
            height as usize,
            false,
        );
        desc.set_storage_mode(mtl::StorageMode::Shared);
        desc.set_usage(mtl::TextureUsage::SHADER_READ);

        self.metal_device
            .new_texture_with_surf(&desc, io_surface, 0)
            .ok_or(IOSurfaceTextureError::TextureCreationFailed)
    }
}

#[cfg(target_os = "macos")]
pub struct IOSurfaceYuvTextures {
    pub y_texture: R<mtl::Texture>,
    pub uv_texture: R<mtl::Texture>,
    pub width: u32,
    pub height: u32,
}

#[cfg(target_os = "macos")]
impl IOSurfaceYuvTextures {
    pub fn from_cv_image_buf(
        cache: &IOSurfaceTextureCache,
        image_buf: &cv::ImageBuf,
    ) -> Result<Self, IOSurfaceTextureError> {
        let io_surface = image_buf
            .io_surf()
            .ok_or(IOSurfaceTextureError::NoIOSurface)?;

        let width = image_buf.width() as u32;
        let height = image_buf.height() as u32;

        let y_texture = cache.create_y_texture(io_surface, width, height)?;
        let uv_texture = cache.create_uv_texture(io_surface, width, height)?;

        Ok(Self {
            y_texture,
            uv_texture,
            width,
            height,
        })
    }
}

#[cfg(target_os = "macos")]
pub fn import_metal_texture_to_wgpu(
    device: &wgpu::Device,
    metal_texture: &mtl::Texture,
    format: wgpu::TextureFormat,
    width: u32,
    height: u32,
    label: Option<&str>,
) -> Result<wgpu::Texture, IOSurfaceTextureError> {
    let desc = wgpu::TextureDescriptor {
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
    };

    let raw_ptr = metal_texture as *const mtl::Texture as *mut std::ffi::c_void;

    let metal_texture_owned = unsafe {
        let ptr = raw_ptr as *mut objc2::runtime::AnyObject;
        objc2::ffi::objc_retain(ptr);
        metal::Texture::from_ptr(raw_ptr as *mut metal::MTLTexture)
    };

    let hal_texture = unsafe {
        wgpu_hal::metal::Device::texture_from_raw(
            metal_texture_owned,
            format,
            metal::MTLTextureType::D2,
            1,
            1,
            wgpu_hal::CopyExtent {
                width,
                height,
                depth: 1,
            },
        )
    };

    let texture = unsafe { device.create_texture_from_hal::<MtlApi>(hal_texture, &desc) };
    Ok(texture)
}
