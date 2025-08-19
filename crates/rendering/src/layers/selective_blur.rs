use crate::selective_blur_pipeline::{
    BlurSegment as GpuBlurSegment, SelectiveBlurPipeline, SelectiveBlurUniforms,
};
use crate::{ProjectUniforms};
use bytemuck::cast_slice;
use wgpu::{util::DeviceExt, RenderPass};

pub struct SelectiveBlurLayer {
    pipeline: SelectiveBlurPipeline,
    sampler: wgpu::Sampler,
}

impl SelectiveBlurLayer {
    pub fn new(device: &wgpu::Device) -> Self {
        let pipeline = SelectiveBlurPipeline::new(device, wgpu::TextureFormat::Rgba8UnormSrgb);
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("Selective Blur Sampler"),
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            address_mode_w: wgpu::AddressMode::ClampToEdge,
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            mipmap_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        });

        Self { pipeline, sampler }
    }

    pub fn render(
        &self,
        pass: &mut RenderPass,
        device: &wgpu::Device,
        input_texture_view: &wgpu::TextureView,
        uniforms: &ProjectUniforms,
        current_time: f32,
    ) {
        let active_segments: Vec<&cap_project::BlurSegment> = uniforms
            .project
            .timeline
            .as_ref()
            .and_then(|t| t.blur_segments.as_ref())
            .map(|segments| {
                segments
                    .iter()
                    .filter(|segment| current_time >= segment.start && current_time <= segment.end)
                    .collect()
            })
            .unwrap_or_default();

        if active_segments.is_empty() {
            return;
        }

        let gpu_blur_segments: Vec<GpuBlurSegment> = active_segments
            .iter()
            .map(|segment| GpuBlurSegment {
                rect: [
                    segment.rect.x as f32,
                    segment.rect.y as f32, 
                    segment.rect.width as f32,
                    segment.rect.height as f32,
                ],
                blur_amount: segment.blur_amount.unwrap_or(8.0),
                _padding: [0.0; 3],
            })
            .collect();

        let blur_uniforms = SelectiveBlurUniforms {
            output_size: [uniforms.output_size.0 as f32, uniforms.output_size.1 as f32],
            blur_segments_count: gpu_blur_segments.len() as u32,
            _padding: 0.0,
        };

        let uniforms_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Selective Blur Uniforms"),
            contents: cast_slice(&[blur_uniforms]),
            usage: wgpu::BufferUsages::UNIFORM,
        });

        let segments_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Blur Segments Buffer"),
            contents: cast_slice(&gpu_blur_segments),
            usage: wgpu::BufferUsages::STORAGE,
        });

        let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Selective Blur Bind Group"),
            layout: &self.pipeline.bind_group_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: uniforms_buffer.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::TextureView(input_texture_view),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: wgpu::BindingResource::Sampler(&self.sampler),
                },
                wgpu::BindGroupEntry {
                    binding: 3,
                    resource: segments_buffer.as_entire_binding(),
                },
            ],
        });

        pass.set_pipeline(&self.pipeline.render_pipeline);
        pass.set_bind_group(0, &bind_group, &[]);
        pass.draw(0..3, 0..1);
    }
}