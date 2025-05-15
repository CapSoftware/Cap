use std::collections::HashMap;

use bytemuck::{Pod, Zeroable};
use cap_project::BackgroundSource;
use image::GenericImageView;
use serde::{Deserialize, Serialize};
use specta::Type;
use wgpu::{include_wgsl, util::DeviceExt};

use crate::{
    create_shader_render_pipeline, srgb_to_linear, ProjectUniforms, RenderVideoConstants,
    RenderingError,
};

#[derive(PartialEq, Debug, Clone, Copy, Serialize, Deserialize, Type)]
struct Gradient {
    start: [f32; 4],
    end: [f32; 4],
    angle: f32,
}

#[derive(PartialEq)]
enum ColorOrGradient {
    Color([f32; 4]),
    Gradient(Gradient),
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub enum Background {
    Color([f32; 4]),
    Gradient(Gradient),
    Image { path: String },
}

impl From<BackgroundSource> for Background {
    fn from(value: BackgroundSource) -> Self {
        match value {
            BackgroundSource::Color { value } => Background::Color([
                srgb_to_linear(value[0]),
                srgb_to_linear(value[1]),
                srgb_to_linear(value[2]),
                1.0,
            ]),
            BackgroundSource::Gradient { from, to, angle } => Background::Gradient(Gradient {
                start: [
                    srgb_to_linear(from[0]),
                    srgb_to_linear(from[1]),
                    srgb_to_linear(from[2]),
                    1.0,
                ],
                end: [
                    srgb_to_linear(to[0]),
                    srgb_to_linear(to[1]),
                    srgb_to_linear(to[2]),
                    1.0,
                ],
                angle: angle as f32,
            }),
            BackgroundSource::Image { path } | BackgroundSource::Wallpaper { path } => {
                if let Some(path) = path {
                    if !path.is_empty() {
                        let clean_path = path
                            .replace("asset://localhost/", "/")
                            .replace("asset://", "")
                            .replace("localhost//", "/");

                        if std::path::Path::new(&clean_path).exists() {
                            return Background::Image { path: clean_path };
                        }
                    }
                }
                Background::Color([1.0, 1.0, 1.0, 1.0])
            }
        }
    }
}

pub enum Inner {
    Image {
        path: String,
        bind_group: wgpu::BindGroup,
    },
    ColorOrGradient {
        value: ColorOrGradient,
        buffer: wgpu::Buffer,
        bind_group: wgpu::BindGroup,
    },
}

pub struct BackgroundLayer {
    inner: Option<Inner>,
    image_pipeline: ImageBackgroundPipeline,
    color_pipeline: GradientOrColorPipeline,
}

impl BackgroundLayer {
    pub fn new(device: &wgpu::Device) -> Self {
        Self {
            inner: None,
            image_pipeline: ImageBackgroundPipeline::new(device),
            color_pipeline: GradientOrColorPipeline::new(device),
        }
    }

    pub async fn prepare(
        &mut self,
        constants: &RenderVideoConstants,
        uniforms: &ProjectUniforms,
        background: Background,
    ) -> Result<(), RenderingError> {
        let device = &constants.device;
        let queue = &constants.queue;

        match background {
            Background::Image { path } => {
                match &self.inner {
                    Some(Inner::Image {
                        path: current_path, ..
                    }) if current_path == &path => {}
                    _ => {
                        let mut textures = constants.background_textures.write().await;
                        let texture = match textures.entry(path.clone()) {
                            std::collections::hash_map::Entry::Occupied(e) => e.into_mut(),
                            std::collections::hash_map::Entry::Vacant(e) => {
                                let img = image::open(&path)
                                    .map_err(|e| RenderingError::ImageLoadError(e.to_string()))?;
                                let rgba = img.to_rgba8();
                                let dimensions = img.dimensions();

                                let texture = device.create_texture(&wgpu::TextureDescriptor {
                                    label: Some("Background Image Texture"),
                                    size: wgpu::Extent3d {
                                        width: dimensions.0,
                                        height: dimensions.1,
                                        depth_or_array_layers: 1,
                                    },
                                    mip_level_count: 1,
                                    sample_count: 1,
                                    dimension: wgpu::TextureDimension::D2,
                                    format: wgpu::TextureFormat::Rgba8UnormSrgb,
                                    usage: wgpu::TextureUsages::TEXTURE_BINDING
                                        | wgpu::TextureUsages::COPY_DST,
                                    view_formats: &[],
                                });

                                queue.write_texture(
                                    wgpu::ImageCopyTexture {
                                        texture: &texture,
                                        mip_level: 0,
                                        origin: wgpu::Origin3d::ZERO,
                                        aspect: wgpu::TextureAspect::All,
                                    },
                                    &rgba,
                                    wgpu::ImageDataLayout {
                                        offset: 0,
                                        bytes_per_row: Some(4 * dimensions.0),
                                        rows_per_image: Some(dimensions.1),
                                    },
                                    wgpu::Extent3d {
                                        width: dimensions.0,
                                        height: dimensions.1,
                                        depth_or_array_layers: 1,
                                    },
                                );

                                e.insert(texture)
                            }
                        };

                        let output_ar =
                            uniforms.output_size.1 as f32 / uniforms.output_size.0 as f32;
                        let image_ar = texture.height() as f32 / texture.width() as f32;

                        let y_height = if output_ar < image_ar {
                            ((image_ar - output_ar) / 2.0) / image_ar
                        } else {
                            0.0
                        };

                        let x_width = if output_ar > image_ar {
                            let output_ar = 1.0 / output_ar;
                            let image_ar = 1.0 / image_ar;

                            ((image_ar - output_ar) / 2.0) / image_ar
                        } else {
                            0.0
                        };

                        let image_uniforms = ImageBackgroundUniforms {
                            output_size: [
                                uniforms.output_size.0 as f32,
                                uniforms.output_size.1 as f32,
                            ],
                            padding: 0.0,
                            x_width,
                            y_height,
                            _padding: 0.0,
                        };

                        let uniform_buffer =
                            device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                                label: Some("Image Background Uniforms"),
                                contents: bytemuck::cast_slice(&[image_uniforms]),
                                usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
                            });

                        let texture_view =
                            texture.create_view(&wgpu::TextureViewDescriptor::default());

                        self.inner = Some(Inner::Image {
                            path,
                            bind_group: self.image_pipeline.bind_group(
                                &device,
                                &uniform_buffer,
                                &texture_view,
                            ),
                        });
                    }
                };
            }
            Background::Color(color) => match &self.inner {
                Some(Inner::ColorOrGradient {
                    value: ColorOrGradient::Color(current_color),
                    ..
                }) if &color == current_color => {}
                _ => {
                    let buffer = GradientOrColorUniforms::from(background).to_buffer(device);
                    self.inner = Some(Inner::ColorOrGradient {
                        value: ColorOrGradient::Color(color),
                        bind_group: self.color_pipeline.bind_group(device, &buffer),
                        buffer,
                    });
                }
            },
            Background::Gradient(gradient) => match &self.inner {
                Some(Inner::ColorOrGradient {
                    value: ColorOrGradient::Gradient(current_gradient),
                    ..
                }) if &gradient == current_gradient => {}
                _ => {
                    let buffer = GradientOrColorUniforms::from(background).to_buffer(device);
                    self.inner = Some(Inner::ColorOrGradient {
                        value: ColorOrGradient::Gradient(gradient),
                        bind_group: self.color_pipeline.bind_group(device, &buffer),
                        buffer,
                    });
                }
            },
        }

        Ok(())
    }

    pub fn render(&self, pass: &mut wgpu::RenderPass<'_>) {
        if let Some(Inner::Image { bind_group, .. }) = &self.inner {
            pass.set_pipeline(&self.image_pipeline.render_pipeline);
            pass.set_bind_group(0, bind_group, &[]);
        } else if let Some(Inner::ColorOrGradient { bind_group, .. }) = &self.inner {
            pass.set_pipeline(&self.color_pipeline.render_pipeline);
            pass.set_bind_group(0, bind_group, &[]);
        } else {
            return;
        }

        pass.draw(0..4, 0..1);
    }
}

pub struct ImageBackgroundPipeline {
    pub bind_group_layout: wgpu::BindGroupLayout,
    pub render_pipeline: wgpu::RenderPipeline,
}

#[repr(C)]
#[derive(Copy, Clone, Pod, Zeroable)]
pub struct ImageBackgroundUniforms {
    output_size: [f32; 2],
    padding: f32,
    x_width: f32,
    y_height: f32,
    _padding: f32, // For alignment
}

impl ImageBackgroundPipeline {
    pub fn new(device: &wgpu::Device) -> Self {
        let bind_group_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("ImageBackgroundBindGroupLayout"),
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
        });
        let shader = device.create_shader_module(include_wgsl!("../shaders/image-background.wgsl"));

        let empty_constants: HashMap<String, f64> = HashMap::new();

        let render_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("ImageBackgroundPipeline"),
            layout: Some(
                &device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                    label: Some("ImageBackgroundPipelineLayout"),
                    bind_group_layouts: &[&bind_group_layout],
                    push_constant_ranges: &[],
                }),
            ),
            vertex: wgpu::VertexState {
                module: &shader,
                entry_point: "vs_main",
                buffers: &[],
                compilation_options: wgpu::PipelineCompilationOptions {
                    constants: &empty_constants,
                    zero_initialize_workgroup_memory: false,
                    vertex_pulling_transform: false,
                },
            },
            fragment: Some(wgpu::FragmentState {
                module: &shader,
                entry_point: "fs_main",
                targets: &[Some(wgpu::ColorTargetState {
                    format: wgpu::TextureFormat::Rgba8UnormSrgb,
                    blend: Some(wgpu::BlendState::REPLACE),
                    write_mask: wgpu::ColorWrites::ALL,
                })],
                compilation_options: wgpu::PipelineCompilationOptions {
                    constants: &empty_constants,
                    zero_initialize_workgroup_memory: false,
                    vertex_pulling_transform: false,
                },
            }),
            primitive: wgpu::PrimitiveState {
                topology: wgpu::PrimitiveTopology::TriangleList,
                strip_index_format: None,
                front_face: wgpu::FrontFace::Ccw,
                cull_mode: Some(wgpu::Face::Back),
                unclipped_depth: false,
                polygon_mode: wgpu::PolygonMode::Fill,
                conservative: false,
            },
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            multiview: None,
            cache: None,
        });

        Self {
            bind_group_layout,
            render_pipeline,
        }
    }

    pub fn bind_group(
        &self,
        device: &wgpu::Device,
        uniforms: &wgpu::Buffer,
        texture: &wgpu::TextureView,
    ) -> wgpu::BindGroup {
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            address_mode_w: wgpu::AddressMode::ClampToEdge,
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            mipmap_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        });

        device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("ImageBackgroundBindGroup"),
            layout: &self.bind_group_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: uniforms.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::TextureView(texture),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: wgpu::BindingResource::Sampler(&sampler),
                },
            ],
        })
    }
}

pub struct GradientOrColorPipeline {
    pub bind_group_layout: wgpu::BindGroupLayout,
    pub render_pipeline: wgpu::RenderPipeline,
}

#[derive(Debug, Clone, Copy, Pod, Zeroable, Default)]
#[repr(C)]
pub struct GradientOrColorUniforms {
    pub start: [f32; 4],
    pub end: [f32; 4],
    pub angle: f32,
    _padding: [f32; 3],
}

impl GradientOrColorUniforms {
    fn to_buffer(self, device: &wgpu::Device) -> wgpu::Buffer {
        device.create_buffer_init(
            &(wgpu::util::BufferInitDescriptor {
                label: Some("GradientOrColorUniforms Buffer"),
                contents: bytemuck::cast_slice(&[self]),
                usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            }),
        )
    }
}

impl From<Background> for GradientOrColorUniforms {
    fn from(value: Background) -> Self {
        match value {
            Background::Color(color) => Self {
                start: color,
                end: color,
                angle: 0.0,
                _padding: [0.0; 3],
            },
            Background::Gradient(Gradient { start, end, angle }) => Self {
                start,
                end,
                angle,
                _padding: [0.0; 3],
            },
            Background::Image { .. } => {
                unreachable!("Image backgrounds should be handled separately")
            }
        }
    }
}

impl GradientOrColorPipeline {
    pub fn new(device: &wgpu::Device) -> Self {
        let bind_group_layout = Self::bind_group_layout(device);
        let render_pipeline = create_shader_render_pipeline(
            device,
            &bind_group_layout,
            include_wgsl!("../shaders/gradient-or-color.wgsl"),
        );

        Self {
            bind_group_layout,
            render_pipeline,
        }
    }

    fn bind_group_layout(device: &wgpu::Device) -> wgpu::BindGroupLayout {
        device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("gradient-or-color.wgsl Bind Group Layout"),
            entries: &[wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Uniform,
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
                count: None,
            }],
        })
    }

    pub fn bind_group(&self, device: &wgpu::Device, uniforms: &wgpu::Buffer) -> wgpu::BindGroup {
        let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            layout: &self.bind_group_layout,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: uniforms.as_entire_binding(),
            }],
            label: Some("bind_group"),
        });

        bind_group
    }
}
