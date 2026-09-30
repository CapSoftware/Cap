use bytemuck::{Pod, Zeroable};
use wgpu::util::DeviceExt;

use crate::ProjectUniforms;
use crate::camera3d::{CAMERA3D_BLUR_BASE_HEIGHT, camera3d_inverse_homography};
use cap_project::Camera3DBlurMode;

/// Which blur kernel runs this frame.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Camera3DBlurKind {
    /// Separable gaussian: horizontal pass then vertical pass.
    Gaussian,
    /// Single-pass ring-disc bokeh.
    Bokeh,
}

/// Warps the composed content texture through the timeline's 3D camera pose
/// and applies a screen-space focus blur.
/// See `shaders/camera3d.wgsl` and `shaders/camera3d-blur.wgsl`.
pub struct Camera3DLayer {
    warp_active: bool,
    blur_kind: Option<Camera3DBlurKind>,
    sampler: wgpu::Sampler,
    warp_uniforms_buffer: wgpu::Buffer,
    warp_pipeline: Camera3DPipeline,
    cached_warp_uniforms: Option<Camera3DUniforms>,
    // Separate H/V buffers: both passes are encoded before submission, so a
    // single buffer would make the H pass read the V parameters.
    blur_h_buffer: wgpu::Buffer,
    blur_v_buffer: wgpu::Buffer,
    blur_pipeline: Camera3DBlurPipeline,
    cached_blur_uniforms: Option<(Camera3DBlurUniforms, Camera3DBlurUniforms)>,
}

impl Camera3DLayer {
    pub fn new(device: &wgpu::Device) -> Self {
        let make_blur_buffer = |label: &str| {
            device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some(label),
                contents: bytemuck::cast_slice(&[Camera3DBlurUniforms::default()]),
                usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            })
        };
        Self {
            warp_active: false,
            blur_kind: None,
            sampler: device.create_sampler(&wgpu::SamplerDescriptor {
                address_mode_u: wgpu::AddressMode::ClampToEdge,
                address_mode_v: wgpu::AddressMode::ClampToEdge,
                address_mode_w: wgpu::AddressMode::ClampToEdge,
                mag_filter: wgpu::FilterMode::Linear,
                min_filter: wgpu::FilterMode::Linear,
                mipmap_filter: wgpu::FilterMode::Nearest,
                ..Default::default()
            }),
            warp_uniforms_buffer: device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("Camera3D Uniform Buffer"),
                contents: bytemuck::cast_slice(&[Camera3DUniforms::default()]),
                usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            }),
            warp_pipeline: Camera3DPipeline::new(device),
            cached_warp_uniforms: None,
            blur_h_buffer: make_blur_buffer("Camera3D Blur H Uniform Buffer"),
            blur_v_buffer: make_blur_buffer("Camera3D Blur V Uniform Buffer"),
            blur_pipeline: Camera3DBlurPipeline::new(device),
            cached_blur_uniforms: None,
        }
    }

    /// Whether the warp pass should run this frame.
    pub fn is_active(&self) -> bool {
        self.warp_active
    }

    pub fn blur_kind(&self) -> Option<Camera3DBlurKind> {
        self.blur_kind
    }

    pub fn prepare(&mut self, queue: &wgpu::Queue, uniforms: &ProjectUniforms) {
        self.warp_active = false;
        self.blur_kind = None;

        let Some(frame) = uniforms.camera3d else {
            return;
        };
        let (out_w, out_h) = (uniforms.output_size.0.max(1), uniforms.output_size.1.max(1));
        let aspect = out_w as f64 / out_h as f64;

        if let Some(pose) = frame.pose
            && let Some(homography) =
                camera3d_inverse_homography(&pose, aspect, uniforms.camera3d_zoom.as_ref())
        {
            let rows = homography.inverse_rows;
            let (hx, hy) = homography.half_extents;
            let warp_uniforms = Camera3DUniforms {
                inv_row0: [rows[0][0], rows[0][1], rows[0][2], 0.0],
                inv_row1: [rows[1][0], rows[1][1], rows[1][2], hx],
                inv_row2: [rows[2][0], rows[2][1], rows[2][2], hy],
            };

            if self.cached_warp_uniforms.as_ref() != Some(&warp_uniforms) {
                queue.write_buffer(
                    &self.warp_uniforms_buffer,
                    0,
                    bytemuck::cast_slice(&[warp_uniforms]),
                );
                self.cached_warp_uniforms = Some(warp_uniforms);
            }
            self.warp_active = true;
        }

        if let Some(blur) = frame.blur {
            // Strength is authored at 1080p output height; scale so preview
            // and export produce the same look.
            let strength_px = (blur.strength * out_h as f64 / CAMERA3D_BLUR_BASE_HEIGHT) as f32;
            let mode = match blur.mode {
                Camera3DBlurMode::None => return,
                Camera3DBlurMode::Radial => 1.0,
                Camera3DBlurMode::Directional => 2.0,
                Camera3DBlurMode::TiltShift => 3.0,
            };
            let params = |pass: f32| Camera3DBlurUniforms {
                params0: [pass, mode, strength_px, blur.falloff as f32],
                params1: [
                    blur.focus_x as f32,
                    blur.focus_y as f32,
                    blur.focus_size as f32,
                    blur.angle as f32,
                ],
                params2: [blur.dir_position as f32, out_w as f32, out_h as f32, 0.0],
            };
            let (h, v) = if blur.bokeh {
                // Bokeh is single-pass; only the "V" slot is used.
                (params(2.0), params(2.0))
            } else {
                (params(0.0), params(1.0))
            };

            if self.cached_blur_uniforms.as_ref() != Some(&(h, v)) {
                if !blur.bokeh {
                    // Bokeh never reads the H buffer (lib.rs only runs the V
                    // pass for it), so skip the redundant upload.
                    queue.write_buffer(&self.blur_h_buffer, 0, bytemuck::cast_slice(&[h]));
                }
                queue.write_buffer(&self.blur_v_buffer, 0, bytemuck::cast_slice(&[v]));
                self.cached_blur_uniforms = Some((h, v));
            }
            self.blur_kind = Some(if blur.bokeh {
                Camera3DBlurKind::Bokeh
            } else {
                Camera3DBlurKind::Gaussian
            });
        }
    }

    pub fn render(
        &self,
        pass: &mut wgpu::RenderPass<'_>,
        device: &wgpu::Device,
        content_texture: &wgpu::TextureView,
    ) {
        pass.set_pipeline(&self.warp_pipeline.render_pipeline);
        pass.set_bind_group(
            0,
            &self.warp_pipeline.bind_group(
                device,
                &self.warp_uniforms_buffer,
                content_texture,
                &self.sampler,
            ),
            &[],
        );
        pass.draw(0..3, 0..1);
    }

    /// Horizontal gaussian pass (or the single bokeh pass, which uses the V
    /// buffer via [`Self::render_blur_v`] instead).
    pub fn render_blur_h(
        &self,
        pass: &mut wgpu::RenderPass<'_>,
        device: &wgpu::Device,
        source_texture: &wgpu::TextureView,
    ) {
        self.render_blur(pass, device, &self.blur_h_buffer, source_texture);
    }

    pub fn render_blur_v(
        &self,
        pass: &mut wgpu::RenderPass<'_>,
        device: &wgpu::Device,
        source_texture: &wgpu::TextureView,
    ) {
        self.render_blur(pass, device, &self.blur_v_buffer, source_texture);
    }

    fn render_blur(
        &self,
        pass: &mut wgpu::RenderPass<'_>,
        device: &wgpu::Device,
        buffer: &wgpu::Buffer,
        source_texture: &wgpu::TextureView,
    ) {
        pass.set_pipeline(&self.blur_pipeline.render_pipeline);
        pass.set_bind_group(
            0,
            &self
                .blur_pipeline
                .bind_group(device, buffer, source_texture, &self.sampler),
            &[],
        );
        pass.draw(0..3, 0..1);
    }
}

#[repr(C)]
#[derive(Debug, Clone, Copy, Pod, Zeroable, Default, PartialEq)]
struct Camera3DUniforms {
    inv_row0: [f32; 4],
    inv_row1: [f32; 4],
    inv_row2: [f32; 4],
}

#[repr(C)]
#[derive(Debug, Clone, Copy, Pod, Zeroable, Default, PartialEq)]
struct Camera3DBlurUniforms {
    params0: [f32; 4],
    params1: [f32; 4],
    params2: [f32; 4],
}

fn make_bind_group_layout(device: &wgpu::Device, label: &str) -> wgpu::BindGroupLayout {
    device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some(label),
        entries: &[
            wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
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
                    sample_type: wgpu::TextureSampleType::Float { filterable: true },
                    view_dimension: wgpu::TextureViewDimension::D2,
                    multisampled: false,
                },
                count: None,
            },
            wgpu::BindGroupLayoutEntry {
                binding: 2,
                visibility: wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                count: None,
            },
        ],
    })
}

fn make_pipeline(
    device: &wgpu::Device,
    label: &str,
    shader: wgpu::ShaderModuleDescriptor<'_>,
    layout: &wgpu::BindGroupLayout,
    blend: wgpu::BlendState,
) -> wgpu::RenderPipeline {
    let shader = device.create_shader_module(shader);
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
            compilation_options: wgpu::PipelineCompilationOptions {
                constants: &[],
                zero_initialize_workgroup_memory: false,
            },
        },
        fragment: Some(wgpu::FragmentState {
            module: &shader,
            entry_point: Some("fs_main"),
            targets: &[Some(wgpu::ColorTargetState {
                format: wgpu::TextureFormat::Rgba8Unorm,
                blend: Some(blend),
                write_mask: wgpu::ColorWrites::ALL,
            })],
            compilation_options: wgpu::PipelineCompilationOptions {
                constants: &[],
                zero_initialize_workgroup_memory: false,
            },
        }),
        primitive: wgpu::PrimitiveState {
            topology: wgpu::PrimitiveTopology::TriangleList,
            strip_index_format: None,
            front_face: wgpu::FrontFace::Ccw,
            cull_mode: None,
            polygon_mode: wgpu::PolygonMode::Fill,
            unclipped_depth: false,
            conservative: false,
        },
        depth_stencil: None,
        multisample: wgpu::MultisampleState::default(),
        multiview: None,
        cache: None,
    })
}

fn make_bind_group(
    device: &wgpu::Device,
    label: &str,
    layout: &wgpu::BindGroupLayout,
    uniform_buffer: &wgpu::Buffer,
    texture_view: &wgpu::TextureView,
    sampler: &wgpu::Sampler,
) -> wgpu::BindGroup {
    device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some(label),
        layout,
        entries: &[
            wgpu::BindGroupEntry {
                binding: 0,
                resource: uniform_buffer.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 1,
                resource: wgpu::BindingResource::TextureView(texture_view),
            },
            wgpu::BindGroupEntry {
                binding: 2,
                resource: wgpu::BindingResource::Sampler(sampler),
            },
        ],
    })
}

struct Camera3DPipeline {
    bind_group_layout: wgpu::BindGroupLayout,
    render_pipeline: wgpu::RenderPipeline,
}

impl Camera3DPipeline {
    fn new(device: &wgpu::Device) -> Self {
        let bind_group_layout = make_bind_group_layout(device, "camera3d Bind Group Layout");
        let render_pipeline = make_pipeline(
            device,
            "Camera3D Pipeline",
            wgpu::ShaderModuleDescriptor {
                label: Some("Camera3D Shader"),
                source: wgpu::ShaderSource::Wgsl(include_str!("../shaders/camera3d.wgsl").into()),
            },
            &bind_group_layout,
            // The content texture is premultiplied; composite it over the
            // background that's already in the target.
            wgpu::BlendState::PREMULTIPLIED_ALPHA_BLENDING,
        );
        Self {
            bind_group_layout,
            render_pipeline,
        }
    }

    fn bind_group(
        &self,
        device: &wgpu::Device,
        uniform_buffer: &wgpu::Buffer,
        texture_view: &wgpu::TextureView,
        sampler: &wgpu::Sampler,
    ) -> wgpu::BindGroup {
        make_bind_group(
            device,
            "Camera3D Bind Group",
            &self.bind_group_layout,
            uniform_buffer,
            texture_view,
            sampler,
        )
    }
}

struct Camera3DBlurPipeline {
    bind_group_layout: wgpu::BindGroupLayout,
    render_pipeline: wgpu::RenderPipeline,
}

impl Camera3DBlurPipeline {
    fn new(device: &wgpu::Device) -> Self {
        let bind_group_layout = make_bind_group_layout(device, "camera3d-blur Bind Group Layout");
        let render_pipeline = make_pipeline(
            device,
            "Camera3D Blur Pipeline",
            wgpu::ShaderModuleDescriptor {
                label: Some("Camera3D Blur Shader"),
                source: wgpu::ShaderSource::Wgsl(
                    include_str!("../shaders/camera3d-blur.wgsl").into(),
                ),
            },
            &bind_group_layout,
            wgpu::BlendState::REPLACE,
        );
        Self {
            bind_group_layout,
            render_pipeline,
        }
    }

    fn bind_group(
        &self,
        device: &wgpu::Device,
        uniform_buffer: &wgpu::Buffer,
        texture_view: &wgpu::TextureView,
        sampler: &wgpu::Sampler,
    ) -> wgpu::BindGroup {
        make_bind_group(
            device,
            "Camera3D Blur Bind Group",
            &self.bind_group_layout,
            uniform_buffer,
            texture_view,
            sampler,
        )
    }
}
