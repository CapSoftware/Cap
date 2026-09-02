use std::sync::{Arc, OnceLock};
use std::time::Duration;

use anyhow::{Context as _, anyhow};

pub const MAX_DIMS: (u32, u32) = (640, 360);
const INFERENCE_INTERVAL: Duration = Duration::from_millis(150);
const LOW_MEMORY_THRESHOLD_BYTES: u64 = 8 * 1024 * 1024 * 1024;

pub fn blur_allowed() -> bool {
    static ALLOWED: OnceLock<bool> = OnceLock::new();
    *ALLOWED
        .get_or_init(|| total_memory_bytes().is_none_or(|bytes| bytes > LOW_MEMORY_THRESHOLD_BYTES))
}

#[cfg(unix)]
fn total_memory_bytes() -> Option<u64> {
    let pages = u64::try_from(unsafe { libc::sysconf(libc::_SC_PHYS_PAGES) }).ok()?;
    let page_size = u64::try_from(unsafe { libc::sysconf(libc::_SC_PAGESIZE) }).ok()?;
    pages.checked_mul(page_size)
}

#[cfg(windows)]
fn total_memory_bytes() -> Option<u64> {
    use windows_sys::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};

    let mut status: MEMORYSTATUSEX = unsafe { std::mem::zeroed() };
    status.dwLength = std::mem::size_of::<MEMORYSTATUSEX>() as u32;
    (unsafe { GlobalMemoryStatusEx(&mut status) } != 0).then_some(status.ullTotalPhys)
}

pub fn fitted_dimensions(width: u32, height: u32, max: (u32, u32)) -> Option<(u32, u32)> {
    if width == 0 || height == 0 {
        return None;
    }

    let scale = (max.0 as f64 / width as f64)
        .min(max.1 as f64 / height as f64)
        .min(1.0);
    Some((
        ((width as f64 * scale).round() as u32).max(1),
        ((height as f64 * scale).round() as u32).max(1),
    ))
}

pub struct PortableCameraBlur {
    device: wgpu::Device,
    queue: wgpu::Queue,
    processor: cap_camera_effects::BlurProcessor,
    source: Option<wgpu::Texture>,
    readback: Option<wgpu::Buffer>,
    dimensions: Option<(u32, u32)>,
    padded_bytes_per_row: u32,
    rgba: Vec<u8>,
}

impl PortableCameraBlur {
    pub fn new() -> anyhow::Result<Self> {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .context("camera blur runtime")?;
        let (device, queue) = runtime.block_on(async {
            let instance = cap_rendering::create_wgpu_instance_sync();
            let adapter = instance
                .request_adapter(&wgpu::RequestAdapterOptions {
                    power_preference: wgpu::PowerPreference::LowPower,
                    force_fallback_adapter: cap_rendering::force_software_wgpu_adapter(),
                    compatible_surface: None,
                })
                .await
                .map_err(|error| anyhow!("camera blur adapter: {error}"))?;
            adapter
                .request_device(&wgpu::DeviceDescriptor {
                    label: Some("Camera Preview Blur"),
                    required_features: wgpu::Features::empty(),
                    required_limits: wgpu::Limits::downlevel_webgl2_defaults()
                        .using_resolution(adapter.limits()),
                    memory_hints: Default::default(),
                    trace: wgpu::Trace::Off,
                })
                .await
                .map_err(|error| anyhow!("camera blur device: {error}"))
        })?;
        let mut processor =
            cap_camera_effects::BlurProcessor::new(&device, wgpu::TextureFormat::Rgba8Unorm)
                .context("camera blur processor")?;
        processor.set_inference_interval(INFERENCE_INTERVAL);

        Ok(Self {
            device,
            queue,
            processor,
            source: None,
            readback: None,
            dimensions: None,
            padded_bytes_per_row: 0,
            rgba: Vec::new(),
        })
    }

    pub fn process(
        &mut self,
        image: &gpui::RenderImage,
        dimensions: (usize, usize),
        mode: cap_camera_effects::BlurMode,
    ) -> anyhow::Result<Arc<gpui::RenderImage>> {
        self.process_with_status(image, dimensions, mode)
            .map(|(image, _)| image)
    }

    pub fn process_with_status(
        &mut self,
        image: &gpui::RenderImage,
        dimensions: (usize, usize),
        mode: cap_camera_effects::BlurMode,
    ) -> anyhow::Result<(Arc<gpui::RenderImage>, cap_camera_effects::BlurOutputStatus)> {
        let width = u32::try_from(dimensions.0).context("camera frame width")?;
        let height = u32::try_from(dimensions.1).context("camera frame height")?;
        let row_bytes = width.checked_mul(4).context("camera frame row size")?;
        let expected_bytes = usize::try_from(row_bytes)
            .ok()
            .and_then(|row| row.checked_mul(dimensions.1))
            .context("camera frame size")?;
        let bgra = image
            .as_bytes(0)
            .context("camera frame pixels unavailable")?;
        if bgra.len() != expected_bytes {
            anyhow::bail!("camera frame pixel data does not match its dimensions");
        }

        self.ensure_resources(width, height)?;
        self.rgba.clear();
        self.rgba.reserve(expected_bytes);
        for pixel in bgra.chunks_exact(4) {
            self.rgba
                .extend_from_slice(&[pixel[2], pixel[1], pixel[0], pixel[3]]);
        }

        let source = self.source.as_ref().context("camera blur source missing")?;
        self.queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: source,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            &self.rgba,
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(row_bytes),
                rows_per_image: Some(height),
            },
            wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
        );

        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("Camera Preview Blur"),
            });
        self.processor
            .process_into_encoder(&self.device, &self.queue, source, &mut encoder, mode);
        let output = self
            .processor
            .process_returning_output()
            .context("camera blur output missing")?;
        let readback = self
            .readback
            .as_ref()
            .context("camera blur readback missing")?;
        encoder.copy_texture_to_buffer(
            wgpu::TexelCopyTextureInfo {
                texture: output,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::TexelCopyBufferInfo {
                buffer: readback,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(self.padded_bytes_per_row),
                    rows_per_image: Some(height),
                },
            },
            wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
        );
        self.queue.submit(std::iter::once(encoder.finish()));

        let (sender, receiver) = flume::bounded(1);
        readback
            .slice(..)
            .map_async(wgpu::MapMode::Read, move |result| {
                let _ = sender.send(result);
            });
        self.device
            .poll(wgpu::PollType::Wait)
            .map_err(|error| anyhow!("camera blur GPU polling: {error}"))?;
        receiver
            .recv()
            .context("camera blur GPU readback channel")?
            .map_err(|error| anyhow!("camera blur GPU readback: {error}"))?;

        let mut pixels = Vec::with_capacity(expected_bytes);
        {
            let mapped = readback.slice(..).get_mapped_range();
            let padded = self.padded_bytes_per_row as usize;
            let row = row_bytes as usize;
            for source in mapped.chunks_exact(padded).take(height as usize) {
                for pixel in source[..row].chunks_exact(4) {
                    pixels.extend_from_slice(&[pixel[2], pixel[1], pixel[0], pixel[3]]);
                }
            }
        }
        readback.unmap();

        let image = image::RgbaImage::from_raw(width, height, pixels)
            .context("camera blur output image")?;
        let status = self
            .processor
            .output_status()
            .context("camera blur output status missing")?;
        Ok((
            Arc::new(gpui::RenderImage::new(smallvec::smallvec![
                image::Frame::new(image)
            ])),
            status,
        ))
    }

    fn ensure_resources(&mut self, width: u32, height: u32) -> anyhow::Result<()> {
        if self.dimensions == Some((width, height)) {
            return Ok(());
        }

        let row_bytes = width.checked_mul(4).context("camera blur row size")?;
        let alignment = wgpu::COPY_BYTES_PER_ROW_ALIGNMENT;
        let padded_bytes_per_row = row_bytes
            .checked_add(alignment - 1)
            .context("camera blur row alignment")?
            / alignment
            * alignment;
        let readback_size = u64::from(padded_bytes_per_row)
            .checked_mul(u64::from(height))
            .context("camera blur readback size")?;
        self.source = Some(self.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("Camera Preview Blur Source"),
            size: wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        }));
        self.readback = Some(self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Camera Preview Blur Readback"),
            size: readback_size,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        }));
        self.dimensions = Some((width, height));
        self.padded_bytes_per_row = padded_bytes_per_row;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blur_dimensions_are_bounded_without_upscaling() {
        assert_eq!(fitted_dimensions(1920, 1080, MAX_DIMS), Some((640, 360)));
        assert_eq!(fitted_dimensions(1280, 720, MAX_DIMS), Some((640, 360)));
        assert_eq!(fitted_dimensions(640, 480, MAX_DIMS), Some((480, 360)));
        assert_eq!(fitted_dimensions(320, 180, MAX_DIMS), Some((320, 180)));
        assert_eq!(fitted_dimensions(0, 180, MAX_DIMS), None);
        assert_eq!(fitted_dimensions(320, 0, MAX_DIMS), None);
    }

    #[test]
    fn low_memory_devices_skip_gpu_blur() {
        assert_eq!(
            blur_allowed(),
            total_memory_bytes().is_none_or(|bytes| bytes > LOW_MEMORY_THRESHOLD_BYTES)
        );
    }

    #[test]
    fn portable_blur_processes_bgra_frames_without_changing_dimensions() {
        #[cfg(not(target_os = "macos"))]
        if std::env::var_os("CAP_GPUI_TEST_PORTABLE_BLUR").is_none() {
            return;
        }

        let mut pixels = Vec::with_capacity(64 * 32 * 4);
        for y in 0..32u8 {
            for x in 0..64u8 {
                pixels.extend_from_slice(&[x * 3, y * 5, x.saturating_add(y), 255]);
            }
        }
        let image = image::RgbaImage::from_raw(64, 32, pixels).unwrap();
        let input = gpui::RenderImage::new(smallvec::smallvec![image::Frame::new(image)]);
        let mut processor = PortableCameraBlur::new().expect("portable camera blur initialized");
        let (output, status) = processor
            .process_with_status(&input, (64, 32), cap_camera_effects::BlurMode::Heavy)
            .expect("portable camera blur processed a frame");

        assert_eq!(status.mode, cap_camera_effects::BlurMode::Heavy);
        assert_eq!(status.output_sequence, 1);
        assert_eq!(status.output_dimensions, (64, 32));
        assert_eq!(output.size(0).width.0, 64);
        assert_eq!(output.size(0).height.0, 32);
        assert_eq!(output.as_bytes(0).unwrap().len(), 64 * 32 * 4);
        assert!(
            output
                .as_bytes(0)
                .unwrap()
                .chunks_exact(4)
                .all(|pixel| pixel[3] == 255)
        );

        let staging = processor.rgba.as_ptr();
        processor
            .process(&input, (64, 32), cap_camera_effects::BlurMode::Light)
            .expect("portable camera blur reuses GPU resources");
        assert_eq!(processor.rgba.as_ptr(), staging);
        assert_eq!(processor.dimensions, Some((64, 32)));

        let image = image::RgbaImage::from_pixel(640, 360, image::Rgba([32, 96, 160, 255]));
        let preview = gpui::RenderImage::new(smallvec::smallvec![image::Frame::new(image)]);
        let started = std::time::Instant::now();
        for _ in 0..12 {
            let output = processor
                .process(&preview, (640, 360), cap_camera_effects::BlurMode::Heavy)
                .expect("portable camera blur processed a full-size preview frame");
            assert_eq!(output.as_bytes(0).unwrap().len(), 640 * 360 * 4);
        }

        eprintln!(
            "portable heavy-blur preview: {:.1} frames/s, staging={} bytes, readback={} bytes",
            12.0 / started.elapsed().as_secs_f64(),
            processor.rgba.capacity(),
            processor.readback.as_ref().unwrap().size()
        );
        assert_eq!(processor.dimensions, Some((640, 360)));
        assert_eq!(processor.readback.as_ref().unwrap().size(), 640 * 360 * 4);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn portable_blur_processes_real_webcam_frames_when_requested() {
        if std::env::var_os("CAP_GPUI_TEST_REAL_CAMERA").is_none() {
            return;
        }

        use cap_recording::feeds::camera::{
            AddSender, CameraFeed, DeviceOrModelID, RemoveInput, SetInput,
        };
        use kameo::Actor as _;

        let camera = cap_camera::list_cameras().next().expect("connected webcam");
        let camera_name = camera.display_name().to_string();
        let camera_id = DeviceOrModelID::from_info(&camera);
        let mut processor = PortableCameraBlur::new().expect("portable camera blur initialized");
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .enable_time()
            .build()
            .expect("camera runtime");

        runtime.block_on(async {
            let actor = CameraFeed::spawn(CameraFeed::default());
            let (sender, receiver) = flume::bounded(4);
            actor.ask(AddSender(sender)).await.expect("camera sender");
            let ready = actor
                .ask(SetInput {
                    id: camera_id,
                    settings: None,
                })
                .await
                .expect("camera selected");
            ready.await.expect("camera initialized");

            let mut scaler = None;
            let mut frames = 0;
            let started = std::time::Instant::now();
            while frames < 12 {
                let frame = tokio::time::timeout(Duration::from_secs(8), receiver.recv_async())
                    .await
                    .expect("camera frame arrived")
                    .expect("camera frame available");
                let (preview, dimensions) = crate::feeds::camera_preview_image(
                    &frame.inner,
                    &mut scaler,
                    true,
                    Some(MAX_DIMS),
                )
                .expect("camera preview converted");
                assert!(dimensions.0 <= MAX_DIMS.0 as usize);
                assert!(dimensions.1 <= MAX_DIMS.1 as usize);
                let blurred = processor
                    .process(&preview, dimensions, cap_camera_effects::BlurMode::Heavy)
                    .expect("real camera frame blurred");
                assert_eq!(blurred.as_bytes(0).unwrap().len(), dimensions.0 * dimensions.1 * 4);
                frames += 1;
            }

            eprintln!(
                "portable heavy-blur real webcam: camera={camera_name}, frames={frames}, rate={:.1}/s, dimensions={:?}",
                frames as f64 / started.elapsed().as_secs_f64(),
                processor.dimensions
            );
            actor.ask(RemoveInput).await.expect("camera released");
        });
    }
}
