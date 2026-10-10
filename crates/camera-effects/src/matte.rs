/// Longest side of the guided filter's working resolution. Coefficients are
/// smooth by construction, so solving them at up to 480px and applying them
/// to the full frame costs a fraction of a full resolution solve.
const MAX_WORKING_SIZE: u32 = 480;

const COEFFICIENT_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba32Float;
/// The smoothed coefficients the composite samples. Half floats are
/// filterable, so the composite's cubic upsampling is four bilinear taps;
/// coefficient magnitudes stay small enough for half precision.
const SMOOTHED_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba16Float;

pub fn working_dimensions(width: u32, height: u32) -> (u32, u32) {
    let scale = (f64::from(MAX_WORKING_SIZE) / f64::from(width.max(height).max(1))).min(1.0);
    (
        ((f64::from(width) * scale).round() as u32).max(1),
        ((f64::from(height) * scale).round() as u32).max(1),
    )
}

pub struct MattePipeline {
    guide: wgpu::RenderPipeline,
    coefficients: wgpu::RenderPipeline,
    smooth_horizontal: wgpu::RenderPipeline,
    smooth_vertical: wgpu::RenderPipeline,
    sampled_layout: wgpu::BindGroupLayout,
    unfiltered_layout: wgpu::BindGroupLayout,
    sampler: wgpu::Sampler,
}

pub struct MatteTextures {
    _guide: wgpu::Texture,
    guide_view: wgpu::TextureView,
    _raw: wgpu::Texture,
    raw_view: wgpu::TextureView,
    _intermediate: wgpu::Texture,
    intermediate_view: wgpu::TextureView,
    _coefficients: wgpu::Texture,
    pub coefficients_view: wgpu::TextureView,
}

impl MatteTextures {
    pub fn new(device: &wgpu::Device, width: u32, height: u32) -> Self {
        let (width, height) = working_dimensions(width, height);
        let create = |label, format| {
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
                format,
                usage: wgpu::TextureUsages::RENDER_ATTACHMENT
                    | wgpu::TextureUsages::TEXTURE_BINDING,
                view_formats: &[],
            })
        };
        let guide = create("Matte Guide", wgpu::TextureFormat::Rgba8Unorm);
        let raw = create("Matte Coefficients Raw", COEFFICIENT_FORMAT);
        let intermediate = create("Matte Coefficients Intermediate", COEFFICIENT_FORMAT);
        let coefficients = create("Matte Coefficients", SMOOTHED_FORMAT);
        Self {
            guide_view: guide.create_view(&Default::default()),
            _guide: guide,
            raw_view: raw.create_view(&Default::default()),
            _raw: raw,
            intermediate_view: intermediate.create_view(&Default::default()),
            _intermediate: intermediate,
            coefficients_view: coefficients.create_view(&Default::default()),
            _coefficients: coefficients,
        }
    }
}

impl MattePipeline {
    pub fn new(device: &wgpu::Device) -> Self {
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Guided Filter Shader"),
            source: wgpu::ShaderSource::Wgsl(include_str!("shaders/guided_filter.wgsl").into()),
        });
        let texture_entry = |binding, filterable| wgpu::BindGroupLayoutEntry {
            binding,
            visibility: wgpu::ShaderStages::FRAGMENT,
            ty: wgpu::BindingType::Texture {
                sample_type: wgpu::TextureSampleType::Float { filterable },
                view_dimension: wgpu::TextureViewDimension::D2,
                multisampled: false,
            },
            count: None,
        };
        let sampled_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("Guided Filter Sampled BGL"),
            entries: &[
                texture_entry(0, true),
                texture_entry(1, true),
                wgpu::BindGroupLayoutEntry {
                    binding: 2,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                    count: None,
                },
            ],
        });
        let unfiltered_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("Guided Filter Unfiltered BGL"),
            entries: &[texture_entry(0, false)],
        });
        let create = |label, layout: &wgpu::BindGroupLayout, entry_point, format| {
            let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some(label),
                bind_group_layouts: &[layout],
                push_constant_ranges: &[],
            });
            device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some(label),
                layout: Some(&pipeline_layout),
                vertex: wgpu::VertexState {
                    module: &shader,
                    entry_point: Some("vs_main"),
                    buffers: &[],
                    compilation_options: Default::default(),
                },
                fragment: Some(wgpu::FragmentState {
                    module: &shader,
                    entry_point: Some(entry_point),
                    targets: &[Some(wgpu::ColorTargetState {
                        format,
                        blend: None,
                        write_mask: wgpu::ColorWrites::ALL,
                    })],
                    compilation_options: Default::default(),
                }),
                primitive: wgpu::PrimitiveState::default(),
                depth_stencil: None,
                multisample: Default::default(),
                multiview: None,
                cache: None,
            })
        };
        Self {
            guide: create(
                "Matte Guide Pipeline",
                &sampled_layout,
                "fs_guide",
                wgpu::TextureFormat::Rgba8Unorm,
            ),
            coefficients: create(
                "Matte Coefficients Pipeline",
                &sampled_layout,
                "fs_coefficients",
                COEFFICIENT_FORMAT,
            ),
            smooth_horizontal: create(
                "Matte Smooth Horizontal Pipeline",
                &unfiltered_layout,
                "fs_smooth_horizontal",
                COEFFICIENT_FORMAT,
            ),
            smooth_vertical: create(
                "Matte Smooth Vertical Pipeline",
                &unfiltered_layout,
                "fs_smooth_vertical",
                SMOOTHED_FORMAT,
            ),
            sampler: device.create_sampler(&wgpu::SamplerDescriptor {
                address_mode_u: wgpu::AddressMode::ClampToEdge,
                address_mode_v: wgpu::AddressMode::ClampToEdge,
                mag_filter: wgpu::FilterMode::Linear,
                min_filter: wgpu::FilterMode::Linear,
                ..Default::default()
            }),
            sampled_layout,
            unfiltered_layout,
        }
    }

    pub fn refine(
        &self,
        device: &wgpu::Device,
        encoder: &mut wgpu::CommandEncoder,
        source: &wgpu::TextureView,
        mask: &wgpu::TextureView,
        textures: &MatteTextures,
    ) {
        let sampled = |texture| {
            device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("Guided Filter BG"),
                layout: &self.sampled_layout,
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: wgpu::BindingResource::TextureView(texture),
                    },
                    wgpu::BindGroupEntry {
                        binding: 1,
                        resource: wgpu::BindingResource::TextureView(mask),
                    },
                    wgpu::BindGroupEntry {
                        binding: 2,
                        resource: wgpu::BindingResource::Sampler(&self.sampler),
                    },
                ],
            })
        };
        let unfiltered = |texture| {
            device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("Guided Filter Smooth BG"),
                layout: &self.unfiltered_layout,
                entries: &[wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(texture),
                }],
            })
        };
        draw(
            encoder,
            &self.guide,
            &sampled(source),
            &textures.guide_view,
            "Matte Guide",
        );
        draw(
            encoder,
            &self.coefficients,
            &sampled(&textures.guide_view),
            &textures.raw_view,
            "Matte Coefficients",
        );
        draw(
            encoder,
            &self.smooth_horizontal,
            &unfiltered(&textures.raw_view),
            &textures.intermediate_view,
            "Matte Smooth Horizontal",
        );
        draw(
            encoder,
            &self.smooth_vertical,
            &unfiltered(&textures.intermediate_view),
            &textures.coefficients_view,
            "Matte Smooth Vertical",
        );
    }
}

fn draw(
    encoder: &mut wgpu::CommandEncoder,
    pipeline: &wgpu::RenderPipeline,
    bind_group: &wgpu::BindGroup,
    target: &wgpu::TextureView,
    label: &str,
) {
    let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
        label: Some(label),
        color_attachments: &[Some(wgpu::RenderPassColorAttachment {
            view: target,
            resolve_target: None,
            ops: wgpu::Operations {
                load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                store: wgpu::StoreOp::Store,
            },
        })],
        depth_stencil_attachment: None,
        timestamp_writes: None,
        occlusion_query_set: None,
    });
    pass.set_pipeline(pipeline);
    pass.set_bind_group(0, bind_group, &[]);
    pass.draw(0..3, 0..1);
}

#[cfg(test)]
mod tests {
    use super::working_dimensions;

    #[test]
    fn working_resolution_is_bounded_and_keeps_aspect() {
        assert_eq!(working_dimensions(1920, 1080), (480, 270));
        assert_eq!(working_dimensions(1080, 1920), (270, 480));
        assert_eq!(working_dimensions(480, 270), (480, 270));
        assert_eq!(working_dimensions(320, 180), (320, 180));
    }
}
