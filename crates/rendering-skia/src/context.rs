use crate::SkiaRenderingError;
use skia_safe::{Color, Surface, gpu::DirectContext, surfaces};

#[cfg(target_os = "macos")]
use skia_safe::gpu::{SurfaceOrigin, mtl};

pub struct SkiaRenderContext {
    #[cfg(target_os = "macos")]
    gpu_context: Option<GpuContext>,
    _phantom: std::marker::PhantomData<()>,
}

#[cfg(target_os = "macos")]
struct GpuContext {
    direct_context: DirectContext,
    _device: metal::Device,
    _command_queue: metal::CommandQueue,
}

impl SkiaRenderContext {
    pub fn new() -> Result<Self, SkiaRenderingError> {
        #[cfg(target_os = "macos")]
        {
            // Try to create GPU context on macOS
            match Self::create_metal_context() {
                Ok(gpu_context) => {
                    tracing::info!("Created Metal GPU context");
                    Ok(Self {
                        gpu_context: Some(gpu_context),
                        _phantom: std::marker::PhantomData,
                    })
                }
                Err(e) => {
                    tracing::warn!("Failed to create Metal context: {}, falling back to CPU", e);
                    Ok(Self {
                        gpu_context: None,
                        _phantom: std::marker::PhantomData,
                    })
                }
            }
        }

        #[cfg(not(target_os = "macos"))]
        {
            tracing::info!("Creating Skia context (CPU backend)");
            Ok(Self {
                _phantom: std::marker::PhantomData,
            })
        }
    }

    #[cfg(target_os = "macos")]
    fn create_metal_context() -> Result<GpuContext, SkiaRenderingError> {
        use foreign_types_shared::ForeignType;
        use skia_safe::gpu;

        let device =
            metal::Device::system_default().ok_or_else(|| SkiaRenderingError::NoGpuContext)?;

        let command_queue = device.new_command_queue();

        let backend = unsafe {
            mtl::BackendContext::new(
                device.as_ptr() as mtl::Handle,
                command_queue.as_ptr() as mtl::Handle,
            )
        };

        let direct_context = gpu::direct_contexts::make_metal(&backend, None)
            .ok_or_else(|| SkiaRenderingError::NoGpuContext)?;

        Ok(GpuContext {
            direct_context,
            _device: device,
            _command_queue: command_queue,
        })
    }

    pub fn create_surface(
        &mut self,
        width: u32,
        height: u32,
    ) -> Result<Surface, SkiaRenderingError> {
        if width == 0 || height == 0 {
            return Err(SkiaRenderingError::InvalidDimensions(format!(
                "Invalid surface dimensions: {width}x{height}"
            )));
        }

        #[cfg(target_os = "macos")]
        {
            use skia_safe::gpu;

            if let Some(ref mut gpu_context) = self.gpu_context {
                tracing::debug!("Creating GPU surface with dimensions {}x{}", width, height);

                let image_info = skia_safe::ImageInfo::new_n32_premul(
                    (width as i32, height as i32),
                    Some(skia_safe::ColorSpace::new_srgb()),
                );

                return gpu::surfaces::render_target(
                    &mut gpu_context.direct_context,
                    gpu::Budgeted::Yes,
                    &image_info,
                    None,
                    SurfaceOrigin::TopLeft,
                    None,
                    false,
                    false,
                )
                .ok_or_else(|| {
                    SkiaRenderingError::SurfaceCreationFailed(format!(
                        "Failed to create {width}x{height} GPU surface"
                    ))
                });
            }
        }

        // Fallback to CPU surface
        tracing::debug!("Creating CPU surface with dimensions {}x{}", width, height);
        surfaces::raster_n32_premul((width as i32, height as i32)).ok_or_else(|| {
            SkiaRenderingError::SurfaceCreationFailed(format!(
                "Failed to create {width}x{height} surface"
            ))
        })
    }

    pub fn flush(&mut self) {
        #[cfg(target_os = "macos")]
        {
            if let Some(ref mut gpu_context) = self.gpu_context {
                gpu_context.direct_context.flush_and_submit();
            }
        }
    }

    /// Test rendering - draws a simple gradient
    pub fn test_render(&mut self, width: u32, height: u32) -> Result<Vec<u8>, SkiaRenderingError> {
        let mut surface = self.create_surface(width, height)?;
        let canvas = surface.canvas();

        // Clear to white
        canvas.clear(Color::WHITE);

        // Draw a simple gradient
        use skia_safe::{Paint, Point, Shader, TileMode};

        let mut paint = Paint::default();
        let colors = vec![Color::from_rgb(255, 0, 0), Color::from_rgb(0, 0, 255)];
        let shader = Shader::linear_gradient(
            (
                Point::new(0.0, 0.0),
                Point::new(width as f32, height as f32),
            ),
            colors.as_slice(),
            None,
            TileMode::Clamp,
            None,
            None,
        )
        .unwrap();
        paint.set_shader(shader);

        canvas.draw_rect(
            skia_safe::Rect::from_xywh(0.0, 0.0, width as f32, height as f32),
            &paint,
        );

        // Draw a circle
        let mut circle_paint = Paint::default();
        circle_paint.set_color(Color::from_rgb(0, 255, 0));
        circle_paint.set_anti_alias(true);
        canvas.draw_circle(
            Point::new(width as f32 / 2.0, height as f32 / 2.0),
            width.min(height) as f32 * 0.3,
            &circle_paint,
        );

        // Flush GPU operations if using GPU backend
        self.flush();

        // Read pixels
        let image_info = surface.image_info();
        let mut pixels = vec![0u8; (width * height * 4) as usize];

        if !surface.read_pixels(&image_info, &mut pixels, (width * 4) as usize, (0, 0)) {
            return Err(SkiaRenderingError::ReadPixelsFailed);
        }

        Ok(pixels)
    }

    pub fn is_gpu_accelerated(&self) -> bool {
        #[cfg(target_os = "macos")]
        {
            self.gpu_context.is_some()
        }
        #[cfg(not(target_os = "macos"))]
        {
            false
        }
    }

    /// Get mutable reference to the direct context (if GPU accelerated)
    #[cfg(target_os = "macos")]
    pub fn direct_context(&mut self) -> Option<&mut DirectContext> {
        self.gpu_context.as_mut().map(|ctx| &mut ctx.direct_context)
    }

    #[cfg(not(target_os = "macos"))]
    pub fn direct_context(&mut self) -> Option<&mut DirectContext> {
        None
    }
}
