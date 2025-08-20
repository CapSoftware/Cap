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
        
        // High-quality sampler for smooth blur
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("Selective Blur Sampler"),
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            address_mode_w: wgpu::AddressMode::ClampToEdge,
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            mipmap_filter: wgpu::FilterMode::Linear,
            anisotropy_clamp: 1,
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
                    .filter(|segment| {
                        current_time >= segment.start as f32 && 
                        current_time <= segment.end as f32
                    })
                    .collect()
            })
            .unwrap_or_default();

        let gpu_blur_segments: Vec<GpuBlurSegment> = active_segments
            .iter()
            .filter(|segment| segment.blur_amount.unwrap_or(0.0) >= 0.01)
            .map(|segment| {
                // Convert from 0-1 slider range to shader-appropriate values
                let blur_intensity = segment.blur_amount.unwrap_or(0.0) as f32;
                
                let shader_blur_amount = blur_intensity * 8.0;
                
                GpuBlurSegment {
                    rect: [
                        segment.rect.x as f32,
                        segment.rect.y as f32,
                        segment.rect.width as f32,
                        segment.rect.height as f32,
                    ],
                    blur_amount: shader_blur_amount,
                    _padding: [0.0; 3],
                }
            })
            .collect();
       
        if gpu_blur_segments.is_empty() {
            return;
        }

        let blur_uniforms = SelectiveBlurUniforms {
            output_size: [uniforms.output_size.0 as f32, uniforms.output_size.1 as f32],
            blur_segments_count: gpu_blur_segments.len() as u32,
            _padding: 0.0,
        };

        let bind_group = self.pipeline.create_bind_group(
            device,
            &blur_uniforms,
            input_texture_view,
            &self.sampler,
            &gpu_blur_segments,
        );

        pass.set_pipeline(&self.pipeline.render_pipeline);
        pass.set_bind_group(0, &bind_group, &[]);
        pass.draw(0..3, 0..1);
    }
}