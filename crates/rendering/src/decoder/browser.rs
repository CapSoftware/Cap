use std::sync::Arc;

use super::{DecodedFrame, PixelFormat};

#[derive(Clone)]
pub enum BrowserFrameSource {
    Bitmap(web_sys::ImageBitmap),
    Video(web_sys::HtmlVideoElement),
    VideoFrame(web_sys::VideoFrame),
}

/// A decoded browser frame that stays on the GPU side of the page: layers copy
/// it straight into their frame texture with `copy_external_image_to_texture`
/// instead of uploading CPU pixels.
#[derive(Clone)]
pub struct BrowserFrameImage {
    source: BrowserFrameSource,
    pub(crate) source_color_fix: bool,
    pub(crate) source_display_gamma: f32,
}

// SAFETY: wasm32-unknown-unknown without the atomics target feature has a
// single thread, so JS handles can never be observed from another thread.
unsafe impl Send for BrowserFrameImage {}
// SAFETY: see the `Send` implementation above.
unsafe impl Sync for BrowserFrameImage {}

impl BrowserFrameImage {
    pub fn external_source(&self) -> wgpu::ExternalImageSource {
        match &self.source {
            BrowserFrameSource::Bitmap(bitmap) => {
                wgpu::ExternalImageSource::ImageBitmap(bitmap.clone())
            }
            BrowserFrameSource::Video(video) => {
                wgpu::ExternalImageSource::HTMLVideoElement(video.clone())
            }
            BrowserFrameSource::VideoFrame(frame) => {
                wgpu::ExternalImageSource::VideoFrame(Clone::clone(frame))
            }
        }
    }

    pub fn copy_to_texture(&self, queue: &wgpu::Queue, texture: &wgpu::Texture) {
        queue.copy_external_image_to_texture(
            &wgpu::CopyExternalImageSourceInfo {
                source: self.external_source(),
                origin: wgpu::Origin2d::ZERO,
                flip_y: false,
            },
            wgpu::CopyExternalImageDestInfo {
                texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
                color_space: wgpu::PredefinedColorSpace::Srgb,
                premultiplied_alpha: false,
            },
            wgpu::Extent3d {
                width: texture.width(),
                height: texture.height(),
                depth_or_array_layers: 1,
            },
        );
    }
}

impl DecodedFrame {
    pub fn from_browser_source(
        source: BrowserFrameSource,
        width: u32,
        height: u32,
        source_color_fix: bool,
        source_display_gamma: f32,
    ) -> Self {
        Self {
            data: Arc::new(Vec::new()),
            width,
            height,
            format: PixelFormat::Rgba,
            y_stride: width * 4,
            uv_stride: 0,
            browser_image: Some(BrowserFrameImage {
                source,
                source_color_fix,
                source_display_gamma,
            }),
            nv12_full_range: false,
        }
    }

    /// NV12 planes the page copied out of a browser decoder. Safari hands them
    /// over expanded to full range, where native decoders keep video range.
    pub fn from_browser_nv12(
        data: Vec<u8>,
        width: u32,
        height: u32,
        y_stride: u32,
        uv_stride: u32,
        full_range: bool,
    ) -> Self {
        let mut frame = Self::new_nv12(data, width, height, y_stride, uv_stride);
        frame.nv12_full_range = full_range;
        frame
    }

    pub fn nv12_full_range(&self) -> bool {
        self.nv12_full_range
    }

    pub fn browser_image(&self) -> Option<&BrowserFrameImage> {
        self.browser_image.as_ref()
    }

    pub fn browser_source_color_fix(&self) -> bool {
        self.browser_image
            .as_ref()
            .is_some_and(|image| image.source_color_fix)
    }
}
