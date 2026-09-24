use cap_rendering::SharedWgpuDevice;
use wasm_bindgen::JsCast;
use wasm_bindgen::prelude::*;
use web_sys::{HtmlCanvasElement, OffscreenCanvas, WebGl2RenderingContext};

use crate::{js_error, shared_device, trace_renderer};

const BLIT_SHADER: &str = r#"
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var source_sampler: sampler;

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) index: u32) -> VertexOutput {
    let uv = vec2<f32>(f32((index << 1u) & 2u), f32(index & 2u));
    var output: VertexOutput;
    output.position = vec4<f32>(uv * vec2<f32>(2.0, -2.0) + vec2<f32>(-1.0, 1.0), 0.0, 1.0);
    output.uv = uv;
    return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
    let color = textureSampleLevel(source, source_sampler, input.uv, 0.0);
    return vec4<f32>(color.rgb, 1.0);
}
"#;

/// The preview draws into a page canvas; exports draw into an `OffscreenCanvas`
/// inside a worker and hand each frame to the encoder.
#[derive(Clone)]
pub(crate) enum CanvasTarget {
    Html(HtmlCanvasElement),
    Offscreen(OffscreenCanvas),
}

impl CanvasTarget {
    pub fn from_js(value: JsValue) -> Result<Self, JsValue> {
        let value = match value.dyn_into::<HtmlCanvasElement>() {
            Ok(canvas) => return Ok(Self::Html(canvas)),
            Err(value) => value,
        };
        value
            .dyn_into::<OffscreenCanvas>()
            .map(Self::Offscreen)
            .map_err(|_| js_error("Editor canvas is invalid"))
    }

    fn size(&self) -> (u32, u32) {
        match self {
            Self::Html(canvas) => (canvas.width(), canvas.height()),
            Self::Offscreen(canvas) => (canvas.width(), canvas.height()),
        }
    }

    fn surface_target(&self) -> wgpu::SurfaceTarget<'static> {
        match self {
            Self::Html(canvas) => wgpu::SurfaceTarget::Canvas(canvas.clone()),
            Self::Offscreen(canvas) => wgpu::SurfaceTarget::OffscreenCanvas(canvas.clone()),
        }
    }
}

pub(crate) async fn create_device(
    canvas: &CanvasTarget,
    prefer_webgpu: bool,
) -> Result<
    (
        SharedWgpuDevice,
        wgpu::Surface<'static>,
        wgpu::SurfaceConfiguration,
    ),
    JsValue,
> {
    let (width, height) = canvas.size();
    let (width, height) = (width.max(2), height.max(2));
    if prefer_webgpu {
        match create_webgpu(canvas, width, height).await {
            Ok(result) => return Ok(result),
            Err(error) => {
                trace_renderer(&format!(
                    "WebGPU unavailable, using WebGL: {}",
                    error.as_string().unwrap_or_default()
                ));
            }
        }
    }
    match canvas {
        CanvasTarget::Html(canvas) => create_webgl(canvas, width, height).await,
        CanvasTarget::Offscreen(_) => Err(js_error("Offscreen rendering requires WebGPU")),
    }
}

async fn create_webgpu(
    canvas: &CanvasTarget,
    width: u32,
    height: u32,
) -> Result<
    (
        SharedWgpuDevice,
        wgpu::Surface<'static>,
        wgpu::SurfaceConfiguration,
    ),
    JsValue,
> {
    trace_renderer("requesting WebGPU instance");
    let instance = wgpu::util::new_instance_with_webgpu_detection(&wgpu::InstanceDescriptor {
        backends: wgpu::Backends::BROWSER_WEBGPU,
        ..Default::default()
    })
    .await;
    let adapter = instance
        .request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::HighPerformance,
            compatible_surface: None,
            force_fallback_adapter: false,
        })
        .await
        .map_err(js_error)?;
    trace_renderer("requesting WebGPU device");
    let (device, queue) = adapter
        .request_device(&wgpu::DeviceDescriptor {
            label: Some("cap-browser-rendering-device"),
            required_limits: wgpu::Limits::default().using_resolution(adapter.limits()),
            required_features: wgpu::Features::empty(),
            ..Default::default()
        })
        .await
        .map_err(js_error)?;
    let surface = instance
        .create_surface(canvas.surface_target())
        .map_err(js_error)?;
    let mut config = surface
        .get_default_config(&adapter, width, height)
        .ok_or_else(|| js_error("Browser canvas is not supported by this GPU"))?;
    config.format = surface_format(&surface.get_capabilities(&adapter).formats, config.format);
    config.alpha_mode = wgpu::CompositeAlphaMode::Opaque;
    config.usage = wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC;
    config.desired_maximum_frame_latency = 2;
    Ok((
        shared_device(instance, adapter, device, queue),
        surface,
        config,
    ))
}

async fn create_webgl(
    canvas: &HtmlCanvasElement,
    width: u32,
    height: u32,
) -> Result<
    (
        SharedWgpuDevice,
        wgpu::Surface<'static>,
        wgpu::SurfaceConfiguration,
    ),
    JsValue,
> {
    trace_renderer("requesting WebGL instance");
    let context_options = js_sys::Object::new();
    js_sys::Reflect::set(
        &context_options,
        &JsValue::from_str("antialias"),
        &JsValue::FALSE,
    )?;
    js_sys::Reflect::set(
        &context_options,
        &JsValue::from_str("preserveDrawingBuffer"),
        &JsValue::TRUE,
    )?;
    let context: WebGl2RenderingContext = canvas
        .get_context_with_context_options("webgl2", &context_options)?
        .ok_or_else(|| js_error("Browser WebGL2 is unavailable"))?
        .dyn_into()
        .map_err(|_| js_error("Browser WebGL2 context is invalid"))?;
    if context.is_context_lost() {
        return Err(js_error("Browser WebGL2 context was lost"));
    }
    let instance = wgpu::util::new_instance_with_webgpu_detection(&wgpu::InstanceDescriptor {
        backends: wgpu::Backends::GL,
        ..Default::default()
    })
    .await;
    let surface = instance
        .create_surface(wgpu::SurfaceTarget::Canvas(canvas.clone()))
        .map_err(js_error)?;
    let adapter = instance
        .request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::HighPerformance,
            compatible_surface: Some(&surface),
            force_fallback_adapter: false,
        })
        .await
        .map_err(js_error)?;
    trace_renderer("requesting WebGL device");
    let (device, queue) = adapter
        .request_device(&wgpu::DeviceDescriptor {
            label: Some("cap-browser-rendering-device"),
            required_limits: wgpu::Limits::downlevel_webgl2_defaults()
                .using_resolution(adapter.limits()),
            required_features: wgpu::Features::empty(),
            ..Default::default()
        })
        .await
        .map_err(js_error)?;
    let mut config = surface
        .get_default_config(&adapter, width, height)
        .ok_or_else(|| js_error("Browser canvas is not supported by this GPU"))?;
    config.format = surface_format(&surface.get_capabilities(&adapter).formats, config.format);
    config.desired_maximum_frame_latency = 2;
    Ok((
        shared_device(instance, adapter, device, queue),
        surface,
        config,
    ))
}

/// The render core writes sRGB-encoded values into `Rgba8Unorm`, so the canvas
/// must be a non-sRGB format or colors would be encoded twice. The browser's
/// preferred format avoids an extra copy on present.
fn surface_format(
    formats: &[wgpu::TextureFormat],
    fallback: wgpu::TextureFormat,
) -> wgpu::TextureFormat {
    [
        fallback.remove_srgb_suffix(),
        wgpu::TextureFormat::Bgra8Unorm,
        wgpu::TextureFormat::Rgba8Unorm,
    ]
    .into_iter()
    .find(|format| formats.contains(format))
    .unwrap_or_else(|| fallback.remove_srgb_suffix())
}

pub(crate) struct SurfacePresenter {
    surface: wgpu::Surface<'static>,
    config: wgpu::SurfaceConfiguration,
    pipeline: wgpu::RenderPipeline,
    layout: wgpu::BindGroupLayout,
    sampler: wgpu::Sampler,
    last_frame: Option<(wgpu::Texture, wgpu::BindGroup)>,
    pending: Option<wgpu::SurfaceTexture>,
}

impl SurfacePresenter {
    pub fn new(
        device: &wgpu::Device,
        surface: wgpu::Surface<'static>,
        config: wgpu::SurfaceConfiguration,
    ) -> Self {
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Browser present blit"),
            source: wgpu::ShaderSource::Wgsl(BLIT_SHADER.into()),
        });
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("Browser present blit layout"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                    count: None,
                },
            ],
        });
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("Browser present blit pipeline layout"),
            bind_group_layouts: &[&layout],
            push_constant_ranges: &[],
        });
        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("Browser present blit pipeline"),
            layout: Some(&pipeline_layout),
            vertex: wgpu::VertexState {
                module: &shader,
                entry_point: Some("vs_main"),
                buffers: &[],
                compilation_options: Default::default(),
            },
            fragment: Some(wgpu::FragmentState {
                module: &shader,
                entry_point: Some("fs_main"),
                targets: &[Some(wgpu::ColorTargetState {
                    format: config.format,
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
        });
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("Browser present sampler"),
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        });
        Self {
            surface,
            config,
            pipeline,
            layout,
            sampler,
            last_frame: None,
            pending: None,
        }
    }

    pub fn configure(&self, device: &wgpu::Device) {
        self.surface.configure(device, &self.config);
    }

    pub fn resize(
        &mut self,
        device: &wgpu::Device,
        width: u32,
        height: u32,
    ) -> Result<(), JsValue> {
        let max = device.limits().max_texture_dimension_2d;
        if width < 1 || height < 1 || width > max || height > max {
            return Err(js_error("Editor canvas size is invalid"));
        }
        if self.config.width == width && self.config.height == height {
            return Ok(());
        }
        self.config.width = width;
        self.config.height = height;
        self.last_frame = None;
        self.pending = None;
        self.configure(device);
        Ok(())
    }

    fn blit(
        &self,
        encoder: &mut wgpu::CommandEncoder,
        bind_group: &wgpu::BindGroup,
    ) -> Option<wgpu::SurfaceTexture> {
        let frame = match self.surface.get_current_texture() {
            Ok(frame) => frame,
            Err(error) => {
                trace_renderer(&format!("surface texture unavailable: {error}"));
                return None;
            }
        };
        let view = frame
            .texture
            .create_view(&wgpu::TextureViewDescriptor::default());
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("Browser present blit"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: &view,
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
        pass.set_pipeline(&self.pipeline);
        pass.set_bind_group(0, bind_group, &[]);
        pass.draw(0..3, 0..1);
        drop(pass);
        Some(frame)
    }

    /// Records the blit for a freshly rendered frame. The surface texture is
    /// presented by the browser once the current task yields.
    pub fn present(
        &mut self,
        device: &wgpu::Device,
        encoder: &mut wgpu::CommandEncoder,
        texture: &wgpu::Texture,
        view: &wgpu::TextureView,
    ) {
        let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Browser present blit bind group"),
            layout: &self.layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(view),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::Sampler(&self.sampler),
                },
            ],
        });
        self.pending = self.blit(encoder, &bind_group);
        self.last_frame = Some((texture.clone(), bind_group));
    }

    /// Presents the surface texture recorded by [`Self::present`]; call after
    /// the encoder that drew into it has been submitted.
    pub fn finish(&mut self) {
        if let Some(frame) = self.pending.take() {
            frame.present();
        }
    }

    pub fn redraw(&mut self, device: &wgpu::Device, queue: &wgpu::Queue) -> bool {
        let Some((_, bind_group)) = &self.last_frame else {
            return false;
        };
        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("Browser present redraw"),
        });
        let Some(frame) = self.blit(&mut encoder, bind_group) else {
            return false;
        };
        queue.submit(std::iter::once(encoder.finish()));
        frame.present();
        true
    }

    pub async fn snapshot_rgba(
        &self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
    ) -> Result<Vec<u8>, JsValue> {
        let Some((texture, _)) = &self.last_frame else {
            return Err(js_error("No editor frame has been rendered"));
        };
        let width = texture.width();
        let height = texture.height();
        let pixel_bytes = width as u64 * height as u64 * 4;
        if pixel_bytes > 64 * 1024 * 1024 {
            return Err(js_error("Editor snapshot exceeds the browser memory limit"));
        }
        let row_bytes = (width * 4).next_multiple_of(wgpu::COPY_BYTES_PER_ROW_ALIGNMENT);
        let buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Editor snapshot readback"),
            size: row_bytes as u64 * height as u64,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("Editor snapshot readback"),
        });
        encoder.copy_texture_to_buffer(
            wgpu::TexelCopyTextureInfo {
                texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::TexelCopyBufferInfo {
                buffer: &buffer,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(row_bytes),
                    rows_per_image: Some(height),
                },
            },
            wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
        );
        queue.submit(Some(encoder.finish()));
        let (sender, mut receiver) = futures_channel::oneshot::channel();
        buffer
            .slice(..)
            .map_async(wgpu::MapMode::Read, move |status| {
                let _ = sender.send(status);
            });
        let mut mapped = false;
        for _ in 0..500 {
            device.poll(wgpu::PollType::Poll).map_err(js_error)?;
            if let Some(status) = receiver.try_recv().map_err(js_error)? {
                status.map_err(js_error)?;
                mapped = true;
                break;
            }
            cap_rendering::browser_sleep(8).await;
        }
        if !mapped {
            return Err(js_error("Editor snapshot GPU readback timed out"));
        }
        let mapped = buffer.slice(..).get_mapped_range();
        let mut pixels = vec![0; pixel_bytes as usize];
        for row in 0..height as usize {
            let source = row * row_bytes as usize;
            let destination = row * width as usize * 4;
            pixels[destination..destination + width as usize * 4]
                .copy_from_slice(&mapped[source..source + width as usize * 4]);
        }
        drop(mapped);
        buffer.unmap();
        for pixel in pixels.chunks_exact_mut(4) {
            pixel[3] = 255;
        }
        Ok(pixels)
    }
}
