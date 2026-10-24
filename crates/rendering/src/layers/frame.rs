use std::sync::Arc;

use cap_project::{FrameStyle, FrameTheme};

use crate::{
    ProjectUniforms, RenderVideoConstants,
    composite_frame::{CompositeVideoFramePipeline, CompositeVideoFrameUniforms},
    frame_chrome,
};

/// Inputs that require re-rasterizing the chrome texture. Zoom and card
/// position are NOT part of the key: the texture is rasterized at the
/// unzoomed card size (supersampled) and the composite pass scales it, so
/// animated frames reuse the cached texture.
#[derive(Clone, PartialEq)]
struct ChromeCacheKey {
    style: FrameStyle,
    theme: FrameTheme,
    url: String,
    title: String,
    tex_size: (u32, u32),
}

/// Draws decorative frame chrome (macOS window bar, browser toolbar, MacBook
/// body) behind the display layer, using the shared composite pipeline so the
/// chrome gets the same rounded corners, shadow, border and motion blur
/// treatment as the video card itself.
pub struct FrameLayer {
    pipeline: Arc<CompositeVideoFramePipeline>,
    uniforms_buffer: wgpu::Buffer,
    texture: Option<wgpu::Texture>,
    texture_view: Option<wgpu::TextureView>,
    bind_group: Option<wgpu::BindGroup>,
    cache_key: Option<ChromeCacheKey>,
    failed_key: Option<ChromeCacheKey>,
    ready: bool,
}

impl FrameLayer {
    pub fn new(device: &wgpu::Device, pipeline: Arc<CompositeVideoFramePipeline>) -> Self {
        Self {
            uniforms_buffer: CompositeVideoFrameUniforms::default().to_buffer(device),
            pipeline,
            texture: None,
            texture_view: None,
            bind_group: None,
            cache_key: None,
            failed_key: None,
            ready: false,
        }
    }

    pub fn prepare(&mut self, constants: &RenderVideoConstants, uniforms: &ProjectUniforms) {
        self.ready = false;
        let Some(chrome) = uniforms.frame_chrome.as_ref() else {
            return;
        };
        if chrome.composite.opacity <= 0.001 {
            return;
        }

        let (tex_w, tex_h) =
            frame_chrome::chrome_texture_size(chrome.raster_size.x, chrome.raster_size.y);
        let key = ChromeCacheKey {
            style: chrome.style,
            theme: chrome.theme,
            url: chrome.url.clone(),
            title: chrome.title.clone(),
            tex_size: (tex_w, tex_h),
        };

        if self.failed_key.as_ref() == Some(&key) {
            return;
        }

        if self.cache_key.as_ref() != Some(&key) {
            let scale = tex_w as f64 / chrome.raster_size.x.max(1.0);
            let content_h_px = chrome.content_height * scale;
            let Some(rgba) = frame_chrome::rasterize_chrome(
                chrome.style,
                chrome.theme,
                &chrome.url,
                &chrome.title,
                tex_w,
                tex_h,
                content_h_px,
            ) else {
                // Remember the failure so a bad configuration doesn't
                // re-rasterize every frame; any config change retries.
                self.failed_key = Some(key);
                return;
            };

            if self.texture.as_ref().map(|t| (t.width(), t.height())) != Some((tex_w, tex_h)) {
                let texture = constants.device.create_texture(&wgpu::TextureDescriptor {
                    label: Some("FrameChrome texture"),
                    size: wgpu::Extent3d {
                        width: tex_w,
                        height: tex_h,
                        depth_or_array_layers: 1,
                    },
                    mip_level_count: 1,
                    sample_count: 1,
                    dimension: wgpu::TextureDimension::D2,
                    format: wgpu::TextureFormat::Rgba8Unorm,
                    usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
                    view_formats: &[],
                });
                self.texture_view = Some(texture.create_view(&Default::default()));
                self.texture = Some(texture);
                self.bind_group = None;
            }

            if let Some(texture) = self.texture.as_ref() {
                constants.queue.write_texture(
                    wgpu::TexelCopyTextureInfo {
                        texture,
                        mip_level: 0,
                        origin: wgpu::Origin3d::ZERO,
                        aspect: wgpu::TextureAspect::All,
                    },
                    &rgba,
                    wgpu::TexelCopyBufferLayout {
                        offset: 0,
                        bytes_per_row: Some(4 * tex_w),
                        rows_per_image: None,
                    },
                    wgpu::Extent3d {
                        width: tex_w,
                        height: tex_h,
                        depth_or_array_layers: 1,
                    },
                );
            }

            self.failed_key = None;
            self.cache_key = Some(key);
        }

        let Some(view) = self.texture_view.as_ref() else {
            return;
        };
        if self.bind_group.is_none() {
            self.bind_group = Some(self.pipeline.bind_group(
                &constants.device,
                &self.uniforms_buffer,
                view,
            ));
        }

        let mut composite = chrome.composite;
        composite.frame_size = [tex_w as f32, tex_h as f32];
        composite.crop_bounds = [0.0, 0.0, tex_w as f32, tex_h as f32];
        composite.write_to_buffer(&constants.queue, &self.uniforms_buffer);
        self.ready = true;
    }

    pub fn has_content(&self) -> bool {
        self.ready
    }

    pub fn render(&self, pass: &mut wgpu::RenderPass<'_>) {
        if !self.ready {
            return;
        }
        let Some(bind_group) = self.bind_group.as_ref() else {
            return;
        };
        pass.set_pipeline(&self.pipeline.render_pipeline);
        pass.set_bind_group(0, bind_group, &[]);
        pass.draw(0..3, 0..1);
    }
}
