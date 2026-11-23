use bytemuck::{Pod, Zeroable};
use cap_project::XY;
use wgpu::{include_wgsl, util::DeviceExt};

pub struct CompositeVideoFramePipeline {
    pub bind_group_layout: wgpu::BindGroupLayout,
    pub render_pipeline: wgpu::RenderPipeline,
    sampler: wgpu::Sampler,
    no_enhancement: wgpu::TextureView,
}

fn shader_cache_path(
    data_dir: &std::path::Path,
    adapter: &wgpu::AdapterInfo,
) -> Option<std::path::PathBuf> {
    let key = wgpu::util::pipeline_cache_key(adapter)?;
    Some(data_dir.join("Cap").join(format!("{key}.bin")))
}

fn shader_cache_dir() -> Option<std::path::PathBuf> {
    #[cfg(test)]
    {
        let override_dir = TEST_SHADER_CACHE_DIR.with(|dir| dir.borrow().clone());
        if override_dir.is_some() {
            return override_dir;
        }
    }
    dirs::data_local_dir()
}

#[cfg(test)]
thread_local! {
    static TEST_SHADER_CACHE_DIR: std::cell::RefCell<Option<std::path::PathBuf>> =
        const { std::cell::RefCell::new(None) };
}

fn cache_adapter(device: &wgpu::Device) -> Option<wgpu::AdapterInfo> {
    #[cfg(target_os = "linux")]
    {
        unsafe {
            device.as_hal::<wgpu_hal::api::Vulkan, _, _>(|hal_device| {
                let hal_device = hal_device?;
                let properties = hal_device
                    .shared_instance()
                    .raw_instance()
                    .get_physical_device_properties(hal_device.raw_physical_device());
                Some(wgpu::AdapterInfo {
                    name: String::new(),
                    vendor: properties.vendor_id,
                    device: properties.device_id,
                    device_type: wgpu::DeviceType::Other,
                    driver: String::new(),
                    driver_info: String::new(),
                    backend: wgpu::Backend::Vulkan,
                })
            })
        }
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = device;
        None
    }
}

fn cache_path_for(device: &wgpu::Device) -> Option<std::path::PathBuf> {
    shader_cache_path(shader_cache_dir()?.as_path(), &cache_adapter(device)?)
}

fn load_pipeline_cache(device: &wgpu::Device) -> Option<wgpu::PipelineCache> {
    if !device.features().contains(wgpu::Features::PIPELINE_CACHE) {
        return None;
    }
    let path = cache_path_for(device);
    let bytes = path.as_ref().and_then(|path| std::fs::read(path).ok());
    match create_pipeline_cache(device, bytes.as_deref()) {
        Ok(cache) => Some(cache),
        Err(error) if bytes.is_some() => {
            if let Some(path) = &path {
                let _ = std::fs::remove_file(path);
            }
            tracing::warn!(%error, "shader cache rejected for this adapter; starting a new one");
            create_pipeline_cache(device, None).ok()
        }
        Err(_) => None,
    }
}

fn create_pipeline_cache(
    device: &wgpu::Device,
    data: Option<&[u8]>,
) -> Result<wgpu::PipelineCache, String> {
    device.push_error_scope(wgpu::ErrorFilter::Validation);
    let cache = unsafe {
        device.create_pipeline_cache(&wgpu::PipelineCacheDescriptor {
            label: Some("Cap Pipeline Cache"),
            data,
            fallback: true,
        })
    };
    if let Some(error) = validation_error(device) {
        return Err(error);
    }
    Ok(cache)
}

fn validation_error(device: &wgpu::Device) -> Option<String> {
    let mut future = std::pin::pin!(device.pop_error_scope());
    let waker = std::task::Waker::noop();
    let mut context = std::task::Context::from_waker(waker);
    match future.as_mut().poll(&mut context) {
        std::task::Poll::Ready(error) => error.map(|error| error.to_string()),
        std::task::Poll::Pending => Some(String::from("shader cache validation did not resolve")),
    }
}

fn save_pipeline_cache(device: &wgpu::Device, cache: &wgpu::PipelineCache) {
    let Some(path) = cache_path_for(device) else {
        return;
    };
    let Some(data) = cache.get_data() else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let temporary = path.with_extension("tmp");
    if std::fs::write(&temporary, data).is_err() {
        return;
    }
    if std::fs::rename(&temporary, path).is_err() {
        let _ = std::fs::remove_file(temporary);
    }
}

#[cfg(test)]
mod shader_cache_tests {
    use super::*;

    fn adapter(backend: wgpu::Backend, vendor: u32, device: u32) -> wgpu::AdapterInfo {
        wgpu::AdapterInfo {
            name: String::new(),
            vendor,
            device,
            device_type: wgpu::DeviceType::Other,
            driver: String::new(),
            driver_info: String::new(),
            backend,
        }
    }

    #[test]
    fn shader_cache_file_follows_the_adapter() {
        let dir = std::path::Path::new("cap-data");
        let intel = adapter(wgpu::Backend::Vulkan, 0x8086, 0x5917);
        let nvidia = adapter(wgpu::Backend::Vulkan, 0x10de, 0x1d10);
        let intel_path = shader_cache_path(dir, &intel).expect("vulkan cache path");
        let nvidia_path = shader_cache_path(dir, &nvidia).expect("vulkan cache path");
        assert_ne!(intel_path, nvidia_path);
        assert_eq!(
            intel_path,
            dir.join("Cap").join(format!(
                "{}.bin",
                wgpu::util::pipeline_cache_key(&intel).unwrap()
            ))
        );
        assert_eq!(shader_cache_path(dir, &intel), Some(intel_path.clone()));
        assert_ne!(
            intel_path.file_name().and_then(|name| name.to_str()),
            Some("shader_cache.bin")
        );
        assert!(shader_cache_path(dir, &adapter(wgpu::Backend::Metal, 0x8086, 0x5917)).is_none());
        assert!(shader_cache_path(dir, &adapter(wgpu::Backend::Dx12, 0x8086, 0x5917)).is_none());
    }

    struct CacheDir(tempfile::TempDir);

    impl CacheDir {
        fn new() -> Self {
            let dir = tempfile::tempdir().expect("temp dir");
            TEST_SHADER_CACHE_DIR.with(|slot| *slot.borrow_mut() = Some(dir.path().to_path_buf()));
            Self(dir)
        }

        fn path(&self) -> &std::path::Path {
            self.0.path()
        }
    }

    impl Drop for CacheDir {
        fn drop(&mut self) {
            TEST_SHADER_CACHE_DIR.with(|slot| *slot.borrow_mut() = None);
        }
    }

    struct LogWriter(std::sync::Arc<std::sync::Mutex<Vec<u8>>>);

    impl std::io::Write for LogWriter {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(bytes);
            Ok(bytes.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    fn foreign_header() -> Vec<u8> {
        let mut bytes = vec![0u8; 64];
        bytes[..8].copy_from_slice(b"WGPUPLCH");
        bytes[8..12].copy_from_slice(&1u32.to_be_bytes());
        bytes[12..16].copy_from_slice(&8u32.to_be_bytes());
        bytes[16] = 1;
        let adapter_key = [255, 255, 255, 0, 0, 0, 1, 0, 0, 0, 2, 255, 255, 255, 255];
        bytes[17..32].copy_from_slice(&adapter_key);
        bytes[56..64].copy_from_slice(&0x0FED_CBA9_8765_4321u64.to_be_bytes());
        bytes
    }

    fn pipeline_device() -> Option<(wgpu::Adapter, wgpu::Device, wgpu::Queue)> {
        let instance = crate::create_wgpu_instance_sync();
        let adapter =
            pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions::default()))
                .ok()?;
        if !adapter.features().contains(wgpu::Features::PIPELINE_CACHE) {
            eprintln!("adapter {:?} has no pipeline cache", adapter.get_info());
            return None;
        }
        let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
            label: Some("shader-cache-test"),
            required_features: wgpu::Features::PIPELINE_CACHE,
            ..Default::default()
        }))
        .expect("device");
        Some((adapter, device, queue))
    }

    fn assert_saved_cache(path: &std::path::Path, rejected: &[u8]) {
        let stored = std::fs::read(path).expect("shader cache file after recovery");
        assert!(!stored.is_empty(), "shader cache file is empty");
        assert_ne!(stored.as_slice(), rejected);
    }

    fn reload_saved_cache(
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        path: &std::path::Path,
        rejected: &[u8],
        logs: &std::sync::Arc<std::sync::Mutex<Vec<u8>>>,
    ) {
        assert_saved_cache(path, rejected);
        let mark = logs.lock().unwrap().len();
        let pipeline = CompositeVideoFramePipeline::new(device);
        assert_eq!(draw_red(device, queue, &pipeline), vec![255, 0, 0, 255]);
        let text = {
            let bytes = logs.lock().unwrap();
            String::from_utf8_lossy(&bytes[mark..]).into_owned()
        };
        assert!(!text.contains("uncaptured wgpu error"), "{text}");
        assert!(
            !text.contains("shader cache rejected"),
            "saved cache was rejected on reload: {text}"
        );
        assert_saved_cache(path, rejected);
    }

    fn draw_red(
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        pipeline: &CompositeVideoFramePipeline,
    ) -> Vec<u8> {
        const SIZE: u32 = 8;
        let frame = device.create_texture(&wgpu::TextureDescriptor {
            label: None,
            size: wgpu::Extent3d {
                width: SIZE,
                height: SIZE,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        let red = [255, 0, 0, 255].repeat((SIZE * SIZE) as usize);
        queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &frame,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            &red,
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(SIZE * 4),
                rows_per_image: Some(SIZE),
            },
            frame.size(),
        );
        let side = SIZE as f32;
        let uniforms = CompositeVideoFrameUniforms {
            output_size: [side, side],
            frame_size: [side, side],
            crop_bounds: [0.0, 0.0, side, side],
            target_bounds: [0.0, 0.0, side, side],
            target_size: [side, side],
            ..Default::default()
        };
        let view = frame.create_view(&Default::default());
        let uniforms_buffer = uniforms.to_buffer(device);
        let bind_group = pipeline.bind_group(device, &uniforms_buffer, &view);
        let output = device.create_texture(&wgpu::TextureDescriptor {
            label: None,
            size: wgpu::Extent3d {
                width: SIZE,
                height: SIZE,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        let padded = (SIZE * 4).div_ceil(wgpu::COPY_BYTES_PER_ROW_ALIGNMENT)
            * wgpu::COPY_BYTES_PER_ROW_ALIGNMENT;
        let readback = device.create_buffer(&wgpu::BufferDescriptor {
            label: None,
            size: (padded * SIZE) as u64,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        let mut encoder = device.create_command_encoder(&Default::default());
        {
            let out_view = output.create_view(&Default::default());
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: None,
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &out_view,
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
            pass.set_pipeline(&pipeline.render_pipeline);
            pass.set_bind_group(0, &bind_group, &[]);
            pass.draw(0..3, 0..1);
        }
        encoder.copy_texture_to_buffer(
            wgpu::TexelCopyTextureInfo {
                texture: &output,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::TexelCopyBufferInfo {
                buffer: &readback,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(padded),
                    rows_per_image: Some(SIZE),
                },
            },
            output.size(),
        );
        queue.submit([encoder.finish()]);
        device.poll(wgpu::PollType::Wait).expect("poll");
        readback.slice(..).map_async(wgpu::MapMode::Read, |_| {});
        device.poll(wgpu::PollType::Wait).expect("map");
        let mapped = readback.slice(..).get_mapped_range();
        let center = ((4 * padded) + 16) as usize;
        mapped[center..center + 4].to_vec()
    }

    #[test]
    fn foreign_or_corrupt_shader_cache_still_draws() {
        let Some((adapter, device, queue)) = pipeline_device() else {
            eprintln!("no pipeline-cache adapter; skipping");
            return;
        };
        let cache_dir = CacheDir::new();
        let path = cache_path_for(&device).expect("per-adapter cache path");
        let expected = shader_cache_path(cache_dir.path(), &adapter.get_info())
            .expect("path from adapter info");
        assert_eq!(path, expected);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        let logs = std::sync::Arc::new(std::sync::Mutex::new(Vec::<u8>::new()));
        let writer = logs.clone();
        let _subscriber = tracing::subscriber::set_default(
            tracing_subscriber::fmt()
                .with_ansi(false)
                .with_writer(move || LogWriter(writer.clone()))
                .finish(),
        );
        crate::log_uncaptured_errors(&device, "shader-cache-test");

        let foreign = foreign_header();
        std::fs::write(&path, &foreign).unwrap();
        let pipeline = CompositeVideoFramePipeline::new(&device);
        assert_eq!(draw_red(&device, &queue, &pipeline), vec![255, 0, 0, 255]);
        reload_saved_cache(&device, &queue, &path, &foreign, &logs);

        let corrupt = b"not-a-cache";
        std::fs::write(&path, corrupt).unwrap();
        let pipeline = CompositeVideoFramePipeline::new(&device);
        assert_eq!(draw_red(&device, &queue, &pipeline), vec![255, 0, 0, 255]);
        reload_saved_cache(&device, &queue, &path, corrupt, &logs);

        let text = String::from_utf8(logs.lock().unwrap().clone()).unwrap_or_default();
        assert!(!text.contains("uncaptured wgpu error"), "{text}");
    }
}

#[derive(Debug, Clone, Copy, Pod, Zeroable)]
#[repr(C)]
pub struct CompositeVideoFrameUniforms {
    pub crop_bounds: [f32; 4],
    pub target_bounds: [f32; 4],
    pub output_size: [f32; 2],
    pub frame_size: [f32; 2],
    pub motion_blur_vector: [f32; 2],
    pub motion_blur_zoom_center: [f32; 2],
    pub motion_blur_params: [f32; 4],
    pub target_size: [f32; 2],
    pub rounding_px: f32,
    pub rounding_type: f32,
    pub mirror_x: f32,
    pub shadow: f32,
    pub shadow_size: f32,
    pub shadow_opacity: f32,
    pub shadow_blur: f32,
    pub opacity: f32,
    pub border_enabled: f32,
    pub border_width: f32,
    pub preserve_source_alpha: f32,
    pub _padding1: [f32; 3],
    pub border_color: [f32; 4],
    /// Per-corner multipliers on `rounding_px` (top-left, top-right,
    /// bottom-left, bottom-right). All 1s = uniform rounding; the display
    /// squares its top corners against decorative frame chrome with
    /// `[0, 0, 1, 1]`.
    pub corner_radii: [f32; 4],
    /// (exposure stops, contrast, saturation, temperature).
    pub color_adjust_a: [f32; 4],
    /// (tint, fade, split_tone, vignette).
    pub color_adjust_b: [f32; 4],
    /// (grain amount, grain seed, grade-active flag, full-frame vignette
    /// flag). The active flag gates the shader's whole color pass in one
    /// uniform branch, keeping ungraded layers bit-identical to before.
    pub grain_params: [f32; 4],
    /// Output-pixel rect (x, y, width, height) of the enhanced screen texture.
    pub enhance_region: [f32; 4],
    /// (upscale mix, unused, unused, unused); zero samples the frame as is.
    pub enhance_params: [f32; 4],
}

impl Default for CompositeVideoFrameUniforms {
    fn default() -> Self {
        Self {
            crop_bounds: Default::default(),
            target_bounds: Default::default(),
            output_size: Default::default(),
            frame_size: Default::default(),
            motion_blur_vector: Default::default(),
            motion_blur_zoom_center: [0.5, 0.5],
            motion_blur_params: Default::default(),
            target_size: Default::default(),
            rounding_px: Default::default(),
            rounding_type: 0.0,
            mirror_x: Default::default(),
            shadow: Default::default(),
            shadow_size: Default::default(),
            shadow_opacity: Default::default(),
            shadow_blur: Default::default(),
            opacity: 1.0,
            border_enabled: 0.0,
            border_width: 5.0,
            preserve_source_alpha: 0.0,
            _padding1: [0.0; 3],
            border_color: [0.0, 0.0, 0.0, 0.0],
            corner_radii: [1.0; 4],
            color_adjust_a: [0.0; 4],
            color_adjust_b: [0.0; 4],
            grain_params: [0.0; 4],
            enhance_region: [0.0; 4],
            enhance_params: [0.0; 4],
        }
    }
}

/// Intensity scaling and range clamping happen here, Rust-side, so the
/// shader never sees unscaled values and a hand-edited config can't push it
/// outside its designed ranges.
#[derive(Debug, Clone, Copy)]
pub struct ColorGradeUniformParams {
    pub color_adjust_a: [f32; 4],
    pub color_adjust_b: [f32; 4],
    pub grain_params: [f32; 4],
}

impl ColorGradeUniformParams {
    pub const IDENTITY: Self = Self {
        color_adjust_a: [0.0; 4],
        color_adjust_b: [0.0; 4],
        grain_params: [0.0; 4],
    };

    /// Must mirror the shader's own gate on `grain_params.z`.
    pub fn is_active(&self) -> bool {
        self.grain_params[2] > 0.5
    }

    /// `full_frame_vignette` selects the vignette's coordinate space: full
    /// output frame for the screen (one continuous field across card and
    /// backdrop), card-local for the camera.
    pub fn from_config(
        config: &cap_project::ColorCorrection,
        frame_number: u32,
        full_frame_vignette: bool,
    ) -> Self {
        let intensity = config.intensity.clamp(0.0, 1.0);
        let exposure_stops = config.exposure.clamp(-1.0, 1.0) * 1.5 * intensity;
        let contrast = config.contrast.clamp(-1.0, 1.0) * intensity;
        let saturation = config.saturation.clamp(-1.0, 1.0) * intensity;
        let temperature = config.temperature.clamp(-1.0, 1.0) * intensity;
        let tint = config.tint.clamp(-1.0, 1.0) * intensity;
        let fade = config.fade.clamp(0.0, 1.0) * intensity;
        let split_tone = config.split_tone.clamp(-1.0, 1.0) * intensity;
        let vignette = config.vignette.clamp(0.0, 1.0) * intensity;
        let grain = config.grain.clamp(0.0, 1.0);

        let active = [
            exposure_stops,
            contrast,
            saturation,
            temperature,
            tint,
            fade,
            split_tone,
            vignette,
            grain,
        ]
        .iter()
        .any(|v| v.abs() > 1e-4);

        // Seed is deterministic per frame number so preview and export match.
        let grain_seed = (frame_number % 600) as f32;

        Self {
            color_adjust_a: [exposure_stops, contrast, saturation, temperature],
            color_adjust_b: [tint, fade, split_tone, vignette],
            grain_params: [
                grain,
                grain_seed,
                if active { 1.0 } else { 0.0 },
                if full_frame_vignette { 1.0 } else { 0.0 },
            ],
        }
    }
}

impl CompositeVideoFrameUniforms {
    pub(crate) fn for_source_frame(mut self, source_size: XY<u32>) -> Self {
        let scale_x = source_size.x as f32 / self.frame_size[0].max(1.0);
        let scale_y = source_size.y as f32 / self.frame_size[1].max(1.0);

        self.crop_bounds = [
            self.crop_bounds[0] * scale_x,
            self.crop_bounds[1] * scale_y,
            self.crop_bounds[2] * scale_x,
            self.crop_bounds[3] * scale_y,
        ];
        self.frame_size = [source_size.x as f32, source_size.y as f32];

        let crop_w = self.crop_bounds[2] - self.crop_bounds[0];
        let crop_h = self.crop_bounds[3] - self.crop_bounds[1];
        let target_w = self.target_bounds[2] - self.target_bounds[0];
        let target_h = self.target_bounds[3] - self.target_bounds[1];

        if crop_w > 0.0 && crop_h > 0.0 && target_w > 0.0 && target_h > 0.0 {
            let source_aspect = crop_w / crop_h;
            let target_aspect = target_w / target_h;

            if (source_aspect - target_aspect).abs() > 0.001 {
                let scale = (target_w / crop_w).min(target_h / crop_h);
                let fitted_w = crop_w * scale;
                let fitted_h = crop_h * scale;
                let new_x0 = self.target_bounds[0] + (target_w - fitted_w) * 0.5;
                let new_y0 = self.target_bounds[1] + (target_h - fitted_h) * 0.5;

                self.target_bounds = [new_x0, new_y0, new_x0 + fitted_w, new_y0 + fitted_h];
                self.target_size = [fitted_w, fitted_h];
            }
        }

        self
    }

    pub(crate) fn source_uv_to_target(&self, position: XY<f64>) -> XY<f64> {
        let crop_size = XY::new(
            (self.crop_bounds[2] - self.crop_bounds[0]).max(f32::EPSILON) as f64,
            (self.crop_bounds[3] - self.crop_bounds[1]).max(f32::EPSILON) as f64,
        );
        let source_position =
            position * XY::new(self.frame_size[0] as f64, self.frame_size[1] as f64);
        let mut position_in_crop = (source_position
            - XY::new(self.crop_bounds[0] as f64, self.crop_bounds[1] as f64))
            / crop_size;
        if self.mirror_x != 0.0 {
            position_in_crop.x = 1.0 - position_in_crop.x;
        }

        XY::new(self.target_bounds[0] as f64, self.target_bounds[1] as f64)
            + position_in_crop * XY::new(self.target_size[0] as f64, self.target_size[1] as f64)
    }

    pub fn to_buffer(self, device: &wgpu::Device) -> wgpu::Buffer {
        device.create_buffer_init(
            &(wgpu::util::BufferInitDescriptor {
                label: Some("CompositeVideoFrameUniforms Buffer"),
                contents: bytemuck::cast_slice(&[self]),
                usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            }),
        )
    }

    pub fn write_to_buffer(&self, queue: &wgpu::Queue, buffer: &wgpu::Buffer) {
        queue.write_buffer(buffer, 0, bytemuck::bytes_of(self));
    }
}

// pub struct CompositeFrameResources {
//     pub bind_group: wgpu::BindGroup,
//     pub bind_group_layout: wgpu::BindGroupLayout,
//     pub uniforms_buffer: wgpu::Buffer,
//     pub sampler: wgpu::Sampler,
// }

impl CompositeVideoFramePipeline {
    pub fn new(device: &wgpu::Device) -> Self {
        let pipeline_cache = load_pipeline_cache(device);
        let bind_group_layout = Self::bind_group_layout(device);
        let shader_desc = include_wgsl!("shaders/composite-video-frame.wgsl");
        let shader = device.create_shader_module(shader_desc);

        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("Composite Render Pipeline Layout"),
            bind_group_layouts: &[&bind_group_layout],
            push_constant_ranges: &[],
        });

        let render_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("Composite Render Pipeline"),
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
                    blend: Some(wgpu::BlendState::ALPHA_BLENDING),
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
                cull_mode: Some(wgpu::Face::Back),
                polygon_mode: wgpu::PolygonMode::Fill,
                unclipped_depth: false,
                conservative: false,
            },
            depth_stencil: None,
            multisample: wgpu::MultisampleState {
                count: 1,
                mask: !0,
                alpha_to_coverage_enabled: false,
            },
            multiview: None,
            cache: pipeline_cache.as_ref(),
        });

        if let Some(cache) = &pipeline_cache {
            save_pipeline_cache(device, cache);
        }

        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            address_mode_w: wgpu::AddressMode::ClampToEdge,
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            mipmap_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        });

        let no_enhancement = device
            .create_texture(&wgpu::TextureDescriptor {
                label: Some("Composite no-enhancement texture"),
                size: wgpu::Extent3d {
                    width: 1,
                    height: 1,
                    depth_or_array_layers: 1,
                },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::Rgba8Unorm,
                usage: wgpu::TextureUsages::TEXTURE_BINDING,
                view_formats: &[],
            })
            .create_view(&Default::default());

        Self {
            bind_group_layout,
            render_pipeline,
            sampler,
            no_enhancement,
        }
    }

    fn bind_group_layout(device: &wgpu::Device) -> wgpu::BindGroupLayout {
        device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("composite-video-frame.wgsl Bind Group Layout"),
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
                wgpu::BindGroupLayoutEntry {
                    binding: 3,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
            ],
        })
    }

    pub fn bind_group(
        &self,
        device: &wgpu::Device,
        uniforms: &wgpu::Buffer,
        frame: &wgpu::TextureView,
    ) -> wgpu::BindGroup {
        self.bind_group_with_enhancement(device, uniforms, frame, None)
    }

    pub fn bind_group_with_enhancement(
        &self,
        device: &wgpu::Device,
        uniforms: &wgpu::Buffer,
        frame: &wgpu::TextureView,
        enhanced: Option<&wgpu::TextureView>,
    ) -> wgpu::BindGroup {
        device.create_bind_group(&wgpu::BindGroupDescriptor {
            layout: &self.bind_group_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: uniforms.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::TextureView(frame),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: wgpu::BindingResource::Sampler(&self.sampler),
                },
                wgpu::BindGroupEntry {
                    binding: 3,
                    resource: wgpu::BindingResource::TextureView(
                        enhanced.unwrap_or(&self.no_enhancement),
                    ),
                },
            ],
            label: Some("bind_group"),
        })
    }

    pub fn create_frame_texture(device: &wgpu::Device, width: u32, height: u32) -> wgpu::Texture {
        #[cfg(target_os = "macos")]
        let usage = wgpu::TextureUsages::TEXTURE_BINDING
            | wgpu::TextureUsages::STORAGE_BINDING
            | wgpu::TextureUsages::COPY_DST;
        #[cfg(not(target_os = "macos"))]
        let usage = wgpu::TextureUsages::TEXTURE_BINDING
            | wgpu::TextureUsages::RENDER_ATTACHMENT
            | wgpu::TextureUsages::COPY_DST;
        device.create_texture(
            &(wgpu::TextureDescriptor {
                size: wgpu::Extent3d {
                    width,
                    height,
                    depth_or_array_layers: 1,
                },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::Rgba8Unorm,
                usage,
                label: Some("Frame Composite texture"),
                view_formats: &[],
            }),
        )
    }
}
