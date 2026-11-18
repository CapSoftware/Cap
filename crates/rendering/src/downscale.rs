//! Resampling for the screen and camera where they are drawn smaller than
//! their source: the default 720p export, padded framing and the editor
//! preview.
//!
//! The composite shader takes one bilinear tap per output pixel, which skips
//! most source texels once the layer shrinks, so text and 1 px lines alias
//! and shimmer. For a shrinking layer this prefilters the frame with a
//! separable Lanczos-2 kernel, stretched to the shrink factor, into a scratch
//! texture with one texel per output pixel; the composite then reads that
//! texture 1:1 and runs exactly as before. 1:1 and magnified layers never
//! come here.

use bytemuck::{Pod, Zeroable};

use crate::composite_frame::{CompositeVideoFramePipeline, CompositeVideoFrameUniforms};

/// How the screen and camera are resampled where they are drawn smaller than
/// their source. Applies to every project.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DownscaleFilter {
    /// One bilinear tap per output pixel, plus a light unsharp mask above a
    /// 1.1x shrink.
    Bilinear,
    /// Separable Lanczos-2 with its footprint widened to the shrink factor.
    Lanczos,
}

/// The one switch for the downscale filter.
pub const DOWNSCALE_FILTER: DownscaleFilter = DownscaleFilter::Lanczos;

/// Shrink factors at or below this keep the composite's own sampling, so
/// 1:1 output is untouched; the margin absorbs float noise in the ratio.
const MIN_SHRINK: f32 = 1.001;

/// Lanczos lobes on each side of the kernel centre.
const KERNEL_RADIUS: f32 = 2.0;

const SCRATCH_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba16Float;
/// Scratch textures grow in steps of this many texels so a zoom or resize
/// animation does not reallocate them every frame.
const SCRATCH_GRANULARITY: u32 = 64;

#[derive(Debug, Clone, Copy, PartialEq, Pod, Zeroable)]
#[repr(C)]
struct PassParams {
    origin: f32,
    scale: f32,
    footprint: f32,
    row_offset: f32,
    edge_min: i32,
    edge_max: i32,
    radius: f32,
    _padding: f32,
}

/// Where a shrinking layer's prefiltered pixels go and how each pass maps
/// them back onto the source.
#[derive(Debug, Clone, Copy)]
struct Plan {
    /// Output pixels covered: the target bounds rounded out to whole pixels.
    size: [u32; 2],
    /// Source rows the horizontal pass keeps (the crop's rows).
    rows: u32,
    horizontal: PassParams,
    vertical: PassParams,
    /// The layer's uniforms re-pointed at the scratch texture's top-left
    /// `size` texels, at 1:1.
    composite: CompositeVideoFrameUniforms,
}

fn plan(
    uniforms: &CompositeVideoFrameUniforms,
    texture_size: [u32; 2],
    max_texture_size: u32,
) -> Option<Plan> {
    if DOWNSCALE_FILTER != DownscaleFilter::Lanczos || uniforms.preserve_source_alpha > 0.5 {
        return None;
    }
    let [tex_w, tex_h] = texture_size;
    let [frame_w, frame_h] = uniforms.frame_size;
    if tex_w == 0 || tex_h == 0 || frame_w <= 0.0 || frame_h <= 0.0 {
        return None;
    }
    let to_texels = [tex_w as f32 / frame_w, tex_h as f32 / frame_h];
    let [cx0, cy0, cx1, cy1] = uniforms.crop_bounds;
    let crop = [
        cx0 * to_texels[0],
        cy0 * to_texels[1],
        cx1 * to_texels[0],
        cy1 * to_texels[1],
    ];
    let [tx0, ty0, tx1, ty1] = uniforms.target_bounds;
    let target_w = tx1 - tx0;
    let target_h = ty1 - ty0;
    if !(target_w >= 1.0 && target_h >= 1.0) {
        return None;
    }
    let step = [
        (crop[2] - crop[0]) / target_w,
        (crop[3] - crop[1]) / target_h,
    ];
    if !(step[0].max(step[1]) > MIN_SHRINK && step[0].min(step[1]) >= 1.0 / MIN_SHRINK) {
        return None;
    }

    let x0 = tx0.floor();
    let y0 = ty0.floor();
    let size = [(tx1.ceil() - x0) as u32, (ty1.ceil() - y0) as u32];
    let edge_x = texel_range(crop[0], crop[2], tex_w);
    let edge_y = texel_range(crop[1], crop[3], tex_h);
    let rows = (edge_y.1 - edge_y.0 + 1) as u32;
    if size[0] == 0 || size[1] == 0 || size[0].max(size[1]).max(rows) > max_texture_size {
        return None;
    }

    let mirrored = uniforms.mirror_x != 0.0;
    let horizontal = PassParams {
        origin: if mirrored {
            crop[2] - (x0 - tx0) * step[0]
        } else {
            crop[0] + (x0 - tx0) * step[0]
        },
        scale: if mirrored { -step[0] } else { step[0] },
        footprint: step[0].max(1.0),
        row_offset: edge_y.0 as f32,
        edge_min: edge_x.0,
        edge_max: edge_x.1,
        radius: KERNEL_RADIUS,
        _padding: 0.0,
    };
    let vertical = PassParams {
        origin: crop[1] + (y0 - ty0) * step[1] - edge_y.0 as f32,
        scale: step[1],
        footprint: step[1].max(1.0),
        row_offset: 0.0,
        edge_min: 0,
        edge_max: rows as i32 - 1,
        radius: KERNEL_RADIUS,
        _padding: 0.0,
    };
    let composite = CompositeVideoFrameUniforms {
        crop_bounds: [tx0 - x0, ty0 - y0, tx1 - x0, ty1 - y0],
        mirror_x: 0.0,
        ..*uniforms
    };
    Some(Plan {
        size,
        rows,
        horizontal,
        vertical,
        composite,
    })
}

/// Inclusive texel range a crop edge pair covers.
fn texel_range(start: f32, end: f32, len: u32) -> (i32, i32) {
    let last = len as i32 - 1;
    let first = (start.floor() as i32).clamp(0, last);
    (first, (end.ceil() as i32 - 1).clamp(first, last))
}

struct Scratch {
    rows: wgpu::Texture,
    rows_view: wgpu::TextureView,
    output: wgpu::Texture,
    output_view: wgpu::TextureView,
    vertical_bind_group: wgpu::BindGroup,
    composite_bind_group: wgpu::BindGroup,
}

pub struct DownscalePrefilter {
    layout: wgpu::BindGroupLayout,
    horizontal: wgpu::RenderPipeline,
    vertical: wgpu::RenderPipeline,
    horizontal_params: wgpu::Buffer,
    vertical_params: wgpu::Buffer,
    composite_uniforms: wgpu::Buffer,
    scratch: Option<Scratch>,
    active: bool,
}

impl DownscalePrefilter {
    pub fn new(device: &wgpu::Device) -> Self {
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("Downscale prefilter bind group layout"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: false },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
            ],
        });
        let shader = device.create_shader_module(wgpu::include_wgsl!("shaders/downscale.wgsl"));
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("Downscale prefilter pipeline layout"),
            bind_group_layouts: &[&layout],
            push_constant_ranges: &[],
        });
        let pipeline = |entry: &str| {
            device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some("Downscale prefilter pipeline"),
                layout: Some(&pipeline_layout),
                vertex: wgpu::VertexState {
                    module: &shader,
                    entry_point: Some("vs_main"),
                    buffers: &[],
                    compilation_options: Default::default(),
                },
                fragment: Some(wgpu::FragmentState {
                    module: &shader,
                    entry_point: Some(entry),
                    targets: &[Some(wgpu::ColorTargetState {
                        format: SCRATCH_FORMAT,
                        blend: None,
                        write_mask: wgpu::ColorWrites::ALL,
                    })],
                    compilation_options: Default::default(),
                }),
                primitive: wgpu::PrimitiveState::default(),
                depth_stencil: None,
                multisample: wgpu::MultisampleState::default(),
                multiview: None,
                cache: None,
            })
        };
        let horizontal = pipeline("fs_horizontal");
        let vertical = pipeline("fs_vertical");
        let buffer = |label: &str, size: u64| {
            device.create_buffer(&wgpu::BufferDescriptor {
                label: Some(label),
                size,
                usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            })
        };
        let params_size = std::mem::size_of::<PassParams>() as u64;
        Self {
            horizontal_params: buffer("Downscale horizontal params", params_size),
            vertical_params: buffer("Downscale vertical params", params_size),
            composite_uniforms: buffer(
                "Downscale composite uniforms",
                std::mem::size_of::<CompositeVideoFrameUniforms>() as u64,
            ),
            layout,
            horizontal,
            vertical,
            scratch: None,
            active: false,
        }
    }

    /// Records the prefilter for this frame when `uniforms` shrink `source`.
    /// Afterwards [`Self::bind_group`] is the composite bind group to draw
    /// the layer with, or `None` to draw it as before.
    #[allow(clippy::too_many_arguments)]
    pub fn encode(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        encoder: &mut wgpu::CommandEncoder,
        composite: &CompositeVideoFramePipeline,
        source_size: [u32; 2],
        source_view: &wgpu::TextureView,
        uniforms: &CompositeVideoFrameUniforms,
    ) {
        self.active = false;
        let Some(mut plan) = plan(
            uniforms,
            source_size,
            device.limits().max_texture_dimension_2d,
        ) else {
            return;
        };
        self.ensure_scratch(device, composite, plan.size, plan.rows);
        let Some(scratch) = self.scratch.as_ref() else {
            return;
        };
        plan.composite.frame_size = [
            scratch.output.width() as f32,
            scratch.output.height() as f32,
        ];

        queue.write_buffer(
            &self.horizontal_params,
            0,
            bytemuck::bytes_of(&plan.horizontal),
        );
        queue.write_buffer(&self.vertical_params, 0, bytemuck::bytes_of(&plan.vertical));
        plan.composite
            .write_to_buffer(queue, &self.composite_uniforms);

        let horizontal_bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Downscale horizontal bind group"),
            layout: &self.layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: self.horizontal_params.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::TextureView(source_view),
                },
            ],
        });
        draw_pass(
            encoder,
            &scratch.rows_view,
            &self.horizontal,
            &horizontal_bind_group,
            [plan.size[0], plan.rows],
        );
        draw_pass(
            encoder,
            &scratch.output_view,
            &self.vertical,
            &scratch.vertical_bind_group,
            plan.size,
        );
        self.active = true;
    }

    /// Draws the layer as before until the next [`Self::encode`].
    pub fn deactivate(&mut self) {
        self.active = false;
    }

    /// The composite bind group reading this frame's prefiltered texture.
    pub fn bind_group(&self) -> Option<&wgpu::BindGroup> {
        if !self.active {
            return None;
        }
        self.scratch
            .as_ref()
            .map(|scratch| &scratch.composite_bind_group)
    }

    fn ensure_scratch(
        &mut self,
        device: &wgpu::Device,
        composite: &CompositeVideoFramePipeline,
        size: [u32; 2],
        rows: u32,
    ) {
        let current = self.scratch.as_ref();
        if current.is_some_and(|scratch| {
            scratch.output.width() >= size[0]
                && scratch.output.height() >= size[1]
                && scratch.rows.height() >= rows
        }) {
            return;
        }
        let limit = device.limits().max_texture_dimension_2d;
        let grow = |needed: u32, current: Option<u32>| {
            (needed
                .max(current.unwrap_or(0))
                .div_ceil(SCRATCH_GRANULARITY)
                * SCRATCH_GRANULARITY)
                .min(limit)
        };
        let width = grow(size[0], current.map(|s| s.output.width()));
        let height = grow(size[1], current.map(|s| s.output.height()));
        let row_count = grow(rows, current.map(|s| s.rows.height()));
        let rows_texture = scratch_texture(device, "Downscale rows", width, row_count);
        let output = scratch_texture(device, "Downscale output", width, height);
        let rows_view = rows_texture.create_view(&Default::default());
        let output_view = output.create_view(&Default::default());
        let vertical_bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Downscale vertical bind group"),
            layout: &self.layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: self.vertical_params.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::TextureView(&rows_view),
                },
            ],
        });
        let composite_bind_group =
            composite.bind_group(device, &self.composite_uniforms, &output_view);
        self.scratch = Some(Scratch {
            rows: rows_texture,
            rows_view,
            output,
            output_view,
            vertical_bind_group,
            composite_bind_group,
        });
    }
}

fn scratch_texture(device: &wgpu::Device, label: &str, width: u32, height: u32) -> wgpu::Texture {
    device.create_texture(&wgpu::TextureDescriptor {
        label: Some(label),
        size: wgpu::Extent3d {
            width,
            height,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: SCRATCH_FORMAT,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
        view_formats: &[],
    })
}

/// One fullscreen-triangle pass into the top-left `size` texels of `target`.
fn draw_pass(
    encoder: &mut wgpu::CommandEncoder,
    target: &wgpu::TextureView,
    pipeline: &wgpu::RenderPipeline,
    bind_group: &wgpu::BindGroup,
    size: [u32; 2],
) {
    let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
        label: Some("Downscale prefilter pass"),
        color_attachments: &[Some(wgpu::RenderPassColorAttachment {
            view: target,
            resolve_target: None,
            ops: wgpu::Operations {
                load: wgpu::LoadOp::Load,
                store: wgpu::StoreOp::Store,
            },
        })],
        depth_stencil_attachment: None,
        timestamp_writes: None,
        occlusion_query_set: None,
    });
    pass.set_viewport(0.0, 0.0, size[0] as f32, size[1] as f32, 0.0, 1.0);
    pass.set_scissor_rect(0, 0, size[0], size[1]);
    pass.set_pipeline(pipeline);
    pass.set_bind_group(0, bind_group, &[]);
    pass.draw(0..3, 0..1);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn uniforms(frame: [f32; 2], target: [f32; 4]) -> CompositeVideoFrameUniforms {
        CompositeVideoFrameUniforms {
            frame_size: frame,
            crop_bounds: [0.0, 0.0, frame[0], frame[1]],
            target_bounds: target,
            target_size: [target[2] - target[0], target[3] - target[1]],
            ..Default::default()
        }
    }

    #[test]
    fn one_to_one_magnified_and_alpha_layers_keep_the_composite_path() {
        let one_to_one = uniforms([1920.0, 1080.0], [0.0, 0.0, 1920.0, 1080.0]);
        assert!(plan(&one_to_one, [1920, 1080], 8192).is_none());
        let magnified = uniforms([1280.0, 720.0], [0.0, 0.0, 1920.0, 1080.0]);
        assert!(plan(&magnified, [1280, 720], 8192).is_none());
        let mut alpha = uniforms([1920.0, 1080.0], [0.0, 0.0, 1280.0, 720.0]);
        alpha.preserve_source_alpha = 1.0;
        assert!(plan(&alpha, [1920, 1080], 8192).is_none());
    }

    #[test]
    fn shrinking_layer_maps_output_pixels_onto_the_crop() {
        let layer = uniforms([1920.0, 1080.0], [47.5, 26.25, 1232.5, 692.75]);
        let plan = plan(&layer, [1920, 1080], 8192).expect("a shrinking layer prefilters");
        assert_eq!(plan.size, [1186, 667]);
        assert_eq!(plan.rows, 1080);
        let step = 1920.0 / 1185.0;
        // Output pixel 47 (the first column) centres at x = 47.5, the target's
        // left edge, which is source x = 0 (texel coordinate -0.5).
        let first = plan.horizontal.origin + plan.horizontal.scale * 0.5 - 0.5;
        assert!((first + 0.5).abs() < 1e-3, "{first}");
        assert!((plan.horizontal.scale - step).abs() < 1e-5);
        assert_eq!(
            (plan.horizontal.edge_min, plan.horizontal.edge_max),
            (0, 1919)
        );
        assert_eq!((plan.vertical.edge_min, plan.vertical.edge_max), (0, 1079));
        // The composite reads the scratch texture 1:1 at the same sub-pixel
        // offset as the target.
        assert_eq!(plan.composite.crop_bounds, [0.5, 0.25, 1185.5, 666.75]);
        assert_eq!(plan.composite.target_bounds, layer.target_bounds);
    }

    #[test]
    fn mirrored_layer_is_mirrored_by_the_prefilter() {
        let mut layer = uniforms([640.0, 480.0], [0.0, 0.0, 320.0, 240.0]);
        layer.mirror_x = 1.0;
        let plan = plan(&layer, [640, 480], 8192).expect("a shrinking layer prefilters");
        assert_eq!(plan.composite.mirror_x, 0.0);
        assert!(plan.horizontal.scale < 0.0);
        // Output column 0 reads the right edge of the source.
        let first = plan.horizontal.origin + plan.horizontal.scale * 0.5 - 0.5;
        assert!((first - 638.5).abs() < 1e-3, "{first}");
    }
}
