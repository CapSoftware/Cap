use std::sync::Arc;

use crate::composite_frame::{CompositeVideoFramePipeline, CompositeVideoFrameUniforms};
use crate::notch_shape;

/// `composite.frame_size` and `crop_bounds` are filled in by the layer once the
/// texture size is known, as the frame chrome does.
#[derive(Clone, Copy, Debug)]
pub struct NotchUniforms {
    pub composite: CompositeVideoFrameUniforms,
    /// Unzoomed notch size in output px. Zoom scales the texture rather than
    /// re-rasterizing it, so an animating zoom doesn't thrash the cache.
    pub raster_size: [f64; 2],
    pub source_crop: [f32; 4],
}

/// Redraws the recording device's physical notch over the screen capture.
pub struct NotchLayer {
    pipeline: Arc<CompositeVideoFramePipeline>,
    uniforms_buffer: wgpu::Buffer,
    texture: Option<wgpu::Texture>,
    texture_view: Option<wgpu::TextureView>,
    bind_group: Option<wgpu::BindGroup>,
    cache_key: Option<(u32, u32)>,
    failed_key: Option<(u32, u32)>,
    ready: bool,
}

impl NotchLayer {
    pub fn new(device: &wgpu::Device, pipeline: Arc<CompositeVideoFramePipeline>) -> Self {
        Self {
            pipeline,
            uniforms_buffer: CompositeVideoFrameUniforms::default().to_buffer(device),
            texture: None,
            texture_view: None,
            bind_group: None,
            cache_key: None,
            failed_key: None,
            ready: false,
        }
    }

    pub fn prepare(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        notch: Option<NotchUniforms>,
    ) {
        self.ready = false;

        let Some(notch) = notch else {
            return;
        };
        if notch.composite.opacity <= 0.001 {
            return;
        }

        let (tex_w, tex_h) = notch_shape::texture_size(notch.raster_size[0], notch.raster_size[1]);
        let key = (tex_w, tex_h);

        if self.failed_key == Some(key) {
            return;
        }

        if self.cache_key != Some(key) {
            let Some(rgba) = notch_shape::rasterize(tex_w, tex_h) else {
                // Remember the failure so a bad size doesn't re-rasterize every
                // frame; any size change retries.
                self.failed_key = Some(key);
                return;
            };

            if self.texture.as_ref().map(|t| (t.width(), t.height())) != Some(key) {
                let texture = device.create_texture(&wgpu::TextureDescriptor {
                    label: Some("Notch texture"),
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
                queue.write_texture(
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
            self.bind_group = Some(
                self.pipeline
                    .bind_group(device, &self.uniforms_buffer, view),
            );
        }

        let mut composite = notch.composite;
        composite.frame_size = [tex_w as f32, tex_h as f32];
        composite.crop_bounds = [
            notch.source_crop[0] * tex_w as f32,
            notch.source_crop[1] * tex_h as f32,
            notch.source_crop[2] * tex_w as f32,
            notch.source_crop[3] * tex_h as f32,
        ];
        composite.write_to_buffer(queue, &self.uniforms_buffer);
        self.ready = true;
    }

    pub fn has_content(&self) -> bool {
        self.ready
    }

    pub fn render(&self, pass: &mut wgpu::RenderPass<'_>) {
        let Some(bind_group) = self.bind_group.as_ref() else {
            return;
        };
        if !self.ready {
            return;
        }

        pass.set_pipeline(&self.pipeline.render_pipeline);
        pass.set_bind_group(0, bind_group, &[]);
        pass.draw(0..3, 0..1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const OUTPUT: u32 = 256;
    /// A notch spanning x 64..192 and y 0..48 of the output.
    const BOUNDS: [f32; 4] = [64.0, 0.0, 192.0, 48.0];

    fn device() -> Option<(wgpu::Device, wgpu::Queue, wgpu::AdapterInfo)> {
        let instance = crate::create_wgpu_instance_sync();
        let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::LowPower,
            force_fallback_adapter: false,
            compatible_surface: None,
        }))
        .ok()?;

        let info = adapter.get_info();
        let (device, queue) =
            pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor::default())).ok()?;
        Some((device, queue, info))
    }

    fn uniforms() -> NotchUniforms {
        NotchUniforms {
            composite: CompositeVideoFrameUniforms {
                output_size: [OUTPUT as f32, OUTPUT as f32],
                target_bounds: BOUNDS,
                target_size: [BOUNDS[2] - BOUNDS[0], BOUNDS[3] - BOUNDS[1]],
                opacity: 1.0,
                // The outline lives in the texture's alpha, so the SDF has to
                // stay out of the way.
                preserve_source_alpha: 1.0,
                rounding_px: 0.0,
                corner_radii: [0.0; 4],
                ..Default::default()
            },
            raster_size: [
                (BOUNDS[2] - BOUNDS[0]) as f64,
                (BOUNDS[3] - BOUNDS[1]) as f64,
            ],
            source_crop: [0.0, 0.0, 1.0, 1.0],
        }
    }

    /// Renders the notch over a white frame and returns the RGBA pixels.
    fn render_with_uniforms(uniforms: NotchUniforms) -> Option<Vec<u8>> {
        let (pixels, _) = render_with_uniforms_and_adapter(uniforms)?;
        Some(pixels)
    }

    fn render_with_uniforms_and_adapter(
        uniforms: NotchUniforms,
    ) -> Option<(Vec<u8>, wgpu::AdapterInfo)> {
        let (device, queue, adapter_info) = device()?;

        let mut layer =
            NotchLayer::new(&device, Arc::new(CompositeVideoFramePipeline::new(&device)));
        layer.prepare(&device, &queue, Some(uniforms));
        assert!(layer.has_content());

        let target = device.create_texture(&wgpu::TextureDescriptor {
            label: None,
            size: wgpu::Extent3d {
                width: OUTPUT,
                height: OUTPUT,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        let view = target.create_view(&Default::default());

        let bytes_per_row = OUTPUT * 4;
        let readback = device.create_buffer(&wgpu::BufferDescriptor {
            label: None,
            size: (bytes_per_row * OUTPUT) as u64,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });

        let mut encoder = device.create_command_encoder(&Default::default());
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: None,
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &view,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color::WHITE),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
            });
            layer.render(&mut pass);
        }
        encoder.copy_texture_to_buffer(
            wgpu::TexelCopyTextureInfo {
                texture: &target,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::TexelCopyBufferInfo {
                buffer: &readback,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(bytes_per_row),
                    rows_per_image: Some(OUTPUT),
                },
            },
            wgpu::Extent3d {
                width: OUTPUT,
                height: OUTPUT,
                depth_or_array_layers: 1,
            },
        );
        queue.submit([encoder.finish()]);

        readback.slice(..).map_async(wgpu::MapMode::Read, |_| {});
        device.poll(wgpu::PollType::Wait).ok()?;
        let pixels = readback.slice(..).get_mapped_range().to_vec();
        readback.unmap();

        Some((pixels, adapter_info))
    }

    /// Renders on the available adapter, but returns None (skip) when a
    /// software rasterizer produced output that fails the basic sanity of
    /// "the clear executed and the layer drew something". Hosted CI GPU
    /// stacks break underneath us (the windows-2022 WARP adapter stopped
    /// compositing correctly with a runner image update, with no repo
    /// change); on real hardware — and on software adapters that do render,
    /// like Ubuntu's lavapipe — the shape assertions still run at full
    /// strength.
    fn render_or_skip_broken_software_adapter() -> Option<Vec<u8>> {
        let (pixels, adapter_info) = render_with_uniforms_and_adapter(uniforms())?;

        let is_software = adapter_info.device_type == wgpu::DeviceType::Cpu
            || adapter_info.name.contains("Basic Render Driver")
            || adapter_info.name.to_lowercase().contains("warp");
        let cleared_to_white = is_white(pixel(&pixels, 2, OUTPUT - 2));
        let drew_anything = (0..OUTPUT).any(|y| black_run(&pixels, y) > 0);

        if is_software && !(cleared_to_white && drew_anything) {
            eprintln!(
                "software adapter '{}' cannot composite this pass (cleared={cleared_to_white}, \
                 drew={drew_anything}), skipping",
                adapter_info.name
            );
            return None;
        }

        Some(pixels)
    }

    fn pixel(pixels: &[u8], x: u32, y: u32) -> [u8; 4] {
        let i = ((y * OUTPUT + x) * 4) as usize;
        [pixels[i], pixels[i + 1], pixels[i + 2], pixels[i + 3]]
    }

    fn is_black(p: [u8; 4]) -> bool {
        p[0] < 16 && p[1] < 16 && p[2] < 16 && p[3] > 240
    }

    fn is_white(p: [u8; 4]) -> bool {
        p[0] > 240 && p[1] > 240 && p[2] > 240
    }

    /// Number of solidly black pixels in a row, i.e. the notch's width there.
    fn black_run(pixels: &[u8], y: u32) -> u32 {
        (0..OUTPUT)
            .filter(|x| is_black(pixel(pixels, *x, y)))
            .count() as u32
    }

    #[test]
    fn draws_an_opaque_notch_that_flares_at_the_top() {
        let Some(pixels) = render_or_skip_broken_software_adapter() else {
            eprintln!("no usable wgpu adapter available, skipping");
            return;
        };

        let height = (BOUNDS[3] - BOUNDS[1]) as u32;

        // Solid through the middle: the rasterized fill really is opaque black
        // once composited, not a washed-out blend.
        assert!(
            is_black(pixel(&pixels, OUTPUT / 2, height / 2)),
            "notch centre not black"
        );

        let wall = black_run(&pixels, height / 2);
        // Row 0 straddles the top edge, so read the flare just inside it.
        let top = black_run(&pixels, 1);
        let bottom = black_run(&pixels, height - 1);

        assert!(
            top > wall,
            "top should flare wider than the wall: {top} vs {wall}"
        );
        assert!(
            bottom + 8 < wall,
            "bottom should pull in from the wall: {bottom} vs {wall}"
        );

        // Nothing spills outside the notch.
        assert_eq!(black_run(&pixels, height + 6), 0, "spilled below");
        assert!(
            is_white(pixel(&pixels, 10, height / 2)),
            "spilled left of the notch"
        );
        assert!(
            is_white(pixel(&pixels, OUTPUT - 10, height / 2)),
            "spilled right of the notch"
        );
    }

    #[test]
    fn source_crop_preserves_the_uncropped_shape() {
        let Some(full) = render_or_skip_broken_software_adapter() else {
            return;
        };
        let mut cropped_uniforms = uniforms();
        cropped_uniforms.source_crop = [0.5, 0.0, 1.0, 1.0];
        cropped_uniforms.composite.target_bounds = [128.0, 0.0, 192.0, 48.0];
        cropped_uniforms.composite.target_size = [64.0, 48.0];
        let Some(cropped) = render_with_uniforms(cropped_uniforms) else {
            return;
        };

        for y in 1..47 {
            for x in 129..191 {
                let cropped_pixel = pixel(&cropped, x, y);
                let full_pixel = pixel(&full, x, y);
                assert!(
                    cropped_pixel
                        .iter()
                        .zip(full_pixel)
                        .all(|(cropped, full)| cropped.abs_diff(full) <= 32),
                    "{x},{y}: {cropped_pixel:?} != {full_pixel:?}"
                );
            }
        }
    }

    #[test]
    fn draws_nothing_when_there_is_no_notch() {
        let Some((device, queue, _)) = device() else {
            return;
        };

        let mut layer =
            NotchLayer::new(&device, Arc::new(CompositeVideoFramePipeline::new(&device)));

        layer.prepare(&device, &queue, None);
        assert!(!layer.has_content());

        let mut faded = uniforms();
        faded.composite.opacity = 0.0;
        layer.prepare(&device, &queue, Some(faded));
        assert!(!layer.has_content());
    }

    /// Zoom scales the texture; it must not re-rasterize per frame.
    #[test]
    fn reuses_the_texture_while_the_unzoomed_size_holds() {
        let Some((device, queue, _)) = device() else {
            return;
        };

        let mut layer =
            NotchLayer::new(&device, Arc::new(CompositeVideoFramePipeline::new(&device)));

        let mut zoomed = uniforms();
        layer.prepare(&device, &queue, Some(zoomed));
        let first = layer.cache_key;

        zoomed.composite.target_size = [512.0, 192.0];
        layer.prepare(&device, &queue, Some(zoomed));

        assert_eq!(layer.cache_key, first, "zoom should not re-rasterize");
    }
}
