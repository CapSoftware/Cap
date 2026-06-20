use cap_recording::NativeCameraFrame;
use cap_rendering::iosurface_texture::{
    IOSurfaceTextureCache, IOSurfaceTextureError, import_metal_texture_to_wgpu,
};

// Converts IOSurface-backed camera frames into an RGBA destination texture
// entirely on the GPU: the CVPixelBuffer planes are imported as Metal textures
// (zero CPU copies) and a fullscreen pass does YUV->RGB plus downscaling in
// one step. BT.601 matches what the swscale CPU path produced for untagged
// webcam streams.
const CONVERT_SHADER: &str = r#"
struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
}

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VertexOutput {
    var positions = array<vec2<f32>, 3>(
        vec2<f32>(-1.0, -1.0),
        vec2<f32>(3.0, -1.0),
        vec2<f32>(-1.0, 3.0),
    );
    var uvs = array<vec2<f32>, 3>(
        vec2<f32>(0.0, 1.0),
        vec2<f32>(2.0, 1.0),
        vec2<f32>(0.0, -1.0),
    );
    var out: VertexOutput;
    out.position = vec4<f32>(positions[vi], 0.0, 1.0);
    out.uv = uvs[vi];
    return out;
}

@group(0) @binding(0) var frame_sampler: sampler;
@group(0) @binding(1) var plane0_texture: texture_2d<f32>;
@group(0) @binding(2) var uv_texture: texture_2d<f32>;

fn yuv_video_range(y: f32, u: f32, v: f32) -> vec3<f32> {
    let yy = y - 0.0625;
    let uu = u - 0.5;
    let vv = v - 0.5;
    return clamp(
        vec3<f32>(
            1.164 * yy + 1.596 * vv,
            1.164 * yy - 0.392 * uu - 0.813 * vv,
            1.164 * yy + 2.017 * uu,
        ),
        vec3<f32>(0.0),
        vec3<f32>(1.0),
    );
}

fn yuv_full_range(y: f32, u: f32, v: f32) -> vec3<f32> {
    let uu = u - 0.5;
    let vv = v - 0.5;
    return clamp(
        vec3<f32>(
            y + 1.402 * vv,
            y - 0.344 * uu - 0.714 * vv,
            y + 1.772 * uu,
        ),
        vec3<f32>(0.0),
        vec3<f32>(1.0),
    );
}

@fragment
fn fs_nv12_video(in: VertexOutput) -> @location(0) vec4<f32> {
    let y = textureSample(plane0_texture, frame_sampler, in.uv).r;
    let uv = textureSample(uv_texture, frame_sampler, in.uv).rg;
    return vec4<f32>(yuv_video_range(y, uv.r, uv.g), 1.0);
}

@fragment
fn fs_nv12_full(in: VertexOutput) -> @location(0) vec4<f32> {
    let y = textureSample(plane0_texture, frame_sampler, in.uv).r;
    let uv = textureSample(uv_texture, frame_sampler, in.uv).rg;
    return vec4<f32>(yuv_full_range(y, uv.r, uv.g), 1.0);
}

@fragment
fn fs_bgra(in: VertexOutput) -> @location(0) vec4<f32> {
    let color = textureSample(plane0_texture, frame_sampler, in.uv);
    return vec4<f32>(color.rgb, 1.0);
}
"#;

#[derive(Debug)]
pub enum NativeFrameError {
    NoImageBuffer,
    NoFormatDesc,
    UnsupportedFormat(String),
    Surface(IOSurfaceTextureError),
}

impl std::fmt::Display for NativeFrameError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NoImageBuffer => write!(f, "sample buffer has no image buffer"),
            Self::NoFormatDesc => write!(f, "sample buffer has no format description"),
            Self::UnsupportedFormat(fourcc) => {
                write!(f, "unsupported pixel format for GPU path: {fourcc}")
            }
            Self::Surface(err) => write!(f, "{err}"),
        }
    }
}

impl From<IOSurfaceTextureError> for NativeFrameError {
    fn from(err: IOSurfaceTextureError) -> Self {
        Self::Surface(err)
    }
}

pub enum NativeFrameKind {
    Nv12 { full_range: bool },
    Bgra,
}

pub fn classify_frame(frame: &NativeCameraFrame) -> Result<NativeFrameKind, NativeFrameError> {
    let format_desc = frame
        .sample_buf
        .format_desc()
        .ok_or(NativeFrameError::NoFormatDesc)?;
    let mut fourcc = format_desc.media_sub_type().to_be_bytes();
    match cidre::four_cc_to_str(&mut fourcc) {
        "420v" => Ok(NativeFrameKind::Nv12 { full_range: false }),
        "420f" => Ok(NativeFrameKind::Nv12 { full_range: true }),
        "BGRA" => Ok(NativeFrameKind::Bgra),
        other => Err(NativeFrameError::UnsupportedFormat(other.to_string())),
    }
}

pub struct NativeFrameConverter {
    cache: IOSurfaceTextureCache,
    sampler: wgpu::Sampler,
    nv12_layout: wgpu::BindGroupLayout,
    single_layout: wgpu::BindGroupLayout,
    nv12_video_pipeline: wgpu::RenderPipeline,
    nv12_full_pipeline: wgpu::RenderPipeline,
    bgra_pipeline: wgpu::RenderPipeline,
}

impl NativeFrameConverter {
    pub fn new(device: &wgpu::Device) -> Option<Self> {
        let cache = IOSurfaceTextureCache::new()?;

        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Camera Native Convert Shader"),
            source: wgpu::ShaderSource::Wgsl(std::borrow::Cow::Borrowed(CONVERT_SHADER)),
        });

        let sampler_entry = wgpu::BindGroupLayoutEntry {
            binding: 0,
            visibility: wgpu::ShaderStages::FRAGMENT,
            ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
            count: None,
        };
        let texture_entry = |binding: u32| wgpu::BindGroupLayoutEntry {
            binding,
            visibility: wgpu::ShaderStages::FRAGMENT,
            ty: wgpu::BindingType::Texture {
                sample_type: wgpu::TextureSampleType::Float { filterable: true },
                view_dimension: wgpu::TextureViewDimension::D2,
                multisampled: false,
            },
            count: None,
        };

        let nv12_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("Camera NV12 Layout"),
            entries: &[sampler_entry, texture_entry(1), texture_entry(2)],
        });
        let single_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("Camera BGRA Layout"),
            entries: &[sampler_entry, texture_entry(1)],
        });

        let make_pipeline = |layout: &wgpu::BindGroupLayout, entry_point: &str| {
            let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: None,
                bind_group_layouts: &[layout],
                push_constant_ranges: &[],
            });
            device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some("Camera Native Convert Pipeline"),
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
                        format: wgpu::TextureFormat::Rgba8Unorm,
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

        let nv12_video_pipeline = make_pipeline(&nv12_layout, "fs_nv12_video");
        let nv12_full_pipeline = make_pipeline(&nv12_layout, "fs_nv12_full");
        let bgra_pipeline = make_pipeline(&single_layout, "fs_bgra");

        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        });

        Some(Self {
            cache,
            sampler,
            nv12_layout,
            single_layout,
            nv12_video_pipeline,
            nv12_full_pipeline,
            bgra_pipeline,
        })
    }

    pub fn render_frame(
        &self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        frame: &NativeCameraFrame,
        kind: &NativeFrameKind,
        dst_view: &wgpu::TextureView,
    ) -> Result<(), NativeFrameError> {
        let image_buf = frame
            .sample_buf
            .image_buf()
            .ok_or(NativeFrameError::NoImageBuffer)?;
        let io_surface = image_buf.io_surf().ok_or(NativeFrameError::Surface(
            IOSurfaceTextureError::NoIOSurface,
        ))?;
        let width = image_buf.width() as u32;
        let height = image_buf.height() as u32;

        let (pipeline, bind_group) = match kind {
            NativeFrameKind::Nv12 { full_range } => {
                let y_metal = self.cache.create_y_texture(io_surface, width, height)?;
                let uv_metal = self.cache.create_uv_texture(io_surface, width, height)?;
                let y_texture = import_metal_texture_to_wgpu(
                    device,
                    &y_metal,
                    wgpu::TextureFormat::R8Unorm,
                    width,
                    height,
                    Some("Camera Y Plane"),
                )?;
                let uv_texture = import_metal_texture_to_wgpu(
                    device,
                    &uv_metal,
                    wgpu::TextureFormat::Rg8Unorm,
                    width / 2,
                    height / 2,
                    Some("Camera UV Plane"),
                )?;
                let y_view = y_texture.create_view(&wgpu::TextureViewDescriptor::default());
                let uv_view = uv_texture.create_view(&wgpu::TextureViewDescriptor::default());
                let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
                    label: Some("Camera NV12 Bind Group"),
                    layout: &self.nv12_layout,
                    entries: &[
                        wgpu::BindGroupEntry {
                            binding: 0,
                            resource: wgpu::BindingResource::Sampler(&self.sampler),
                        },
                        wgpu::BindGroupEntry {
                            binding: 1,
                            resource: wgpu::BindingResource::TextureView(&y_view),
                        },
                        wgpu::BindGroupEntry {
                            binding: 2,
                            resource: wgpu::BindingResource::TextureView(&uv_view),
                        },
                    ],
                });
                let pipeline = if *full_range {
                    &self.nv12_full_pipeline
                } else {
                    &self.nv12_video_pipeline
                };
                (pipeline, bind_group)
            }
            NativeFrameKind::Bgra => {
                let bgra_metal = self.cache.create_bgra_texture(io_surface, width, height)?;
                let bgra_texture = import_metal_texture_to_wgpu(
                    device,
                    &bgra_metal,
                    wgpu::TextureFormat::Bgra8Unorm,
                    width,
                    height,
                    Some("Camera BGRA"),
                )?;
                let view = bgra_texture.create_view(&wgpu::TextureViewDescriptor::default());
                let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
                    label: Some("Camera BGRA Bind Group"),
                    layout: &self.single_layout,
                    entries: &[
                        wgpu::BindGroupEntry {
                            binding: 0,
                            resource: wgpu::BindingResource::Sampler(&self.sampler),
                        },
                        wgpu::BindGroupEntry {
                            binding: 1,
                            resource: wgpu::BindingResource::TextureView(&view),
                        },
                    ],
                });
                (&self.bgra_pipeline, bind_group)
            }
        };

        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("Camera Native Convert"),
        });
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("Camera Native Convert Pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: dst_view,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color::BLACK),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
            });
            pass.set_pipeline(pipeline);
            pass.set_bind_group(0, &bind_group, &[]);
            pass.draw(0..3, 0..1);
        }
        queue.submit(std::iter::once(encoder.finish()));

        Ok(())
    }
}
