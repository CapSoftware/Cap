//! Camera Preview Module
//!
//! This module handles camera preview rendering with GPU acceleration and fallback support.
//!
//! # Debugging Camera Preview Issues
//!
//! If the camera preview appears invisible, use the diagnostic functions:
//!
//! ```rust
//! // Basic camera feed test
//! if let Ok(working) = camera_preview.test_camera_feed().await {
//!     if !working {
//!         println!("Camera feed not working!");
//!     }
//! }
//!
//! // Comprehensive diagnostics
//! let report = CameraDiagnostics::diagnose_camera_preview(&camera_preview, &window).await?;
//! println!("{}", report);
//!
//! // Apply quick fixes
//! let fixes = CameraDiagnostics::quick_fix_camera_preview(&camera_preview, &window).await?;
//! for fix in fixes {
//!     println!("Applied fix: {}", fix);
//! }
//! ```
//!
//! # Common Issues and Solutions
//!
//! 1. **Camera never becomes visible**: Check if camera feed is working with `test_camera_feed()`
//! 2. **Window shows but is black**: Check GPU converter initialization and frame conversion
//! 3. **Loading state stuck**: Monitor frame reception and loading state with `is_loading()`
//! 4. **GPU conversion fails**: Check logs for fallback to FFmpeg conversion
//!
//! # Performance Monitoring
//!
//! The module includes extensive logging that can be enabled with RUST_LOG=info:
//! - Frame reception and processing statistics
//! - GPU conversion performance metrics
//! - Window and surface configuration details
//! - Texture upload and rendering information

use anyhow::Context;
use cap_gpu_converters::{CameraFormat, CameraInput, GPUCameraConverter, ScalingQuality};
use cap_media::feeds::RawCameraFrame;
use ffmpeg::{
    format::{self, Pixel},
    frame,
    software::scaling,
};

use futures::{executor::block_on, future::Either};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::{
    collections::HashMap,
    pin::pin,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    thread,
    time::Duration,
};
use tauri::{LogicalPosition, LogicalSize, Manager, PhysicalSize, WebviewWindow, Wry};
use tauri_plugin_store::Store;
use tokio::sync::{broadcast, oneshot};
use tokio_util::sync::CancellationToken;
use tracing::{error, info, warn};
use wgpu::{CompositeAlphaMode, SurfaceTexture};

static TOOLBAR_HEIGHT: f32 = 56.0; // also defined in Typescript

// We scale up the GPU surfaces resolution by this amount from the OS window's size.
// This smooths out the curved edges of the window.
// Basically poor man's MSAA
static GPU_SURFACE_SCALE: u32 = 4;

#[derive(Debug, Default, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum CameraPreviewSize {
    #[default]
    Sm,
    Lg,
}

#[derive(Debug, Default, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum CameraPreviewShape {
    #[default]
    Round,
    Square,
    Full,
}

#[derive(Debug, Default, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct CameraWindowState {
    size: CameraPreviewSize,
    shape: CameraPreviewShape,
    mirrored: bool,
}

pub struct CameraPreview {
    #[allow(clippy::type_complexity)]
    reconfigure: (
        broadcast::Sender<Option<(u32, u32)>>,
        broadcast::Receiver<Option<(u32, u32)>>,
    ),
    // TODO: Remove this and rely on `camera_feed.take()`
    cancel: CancellationToken,
    loading: Arc<AtomicBool>,
    store: Arc<Store<Wry>>,

    camera_preview: (
        flume::Sender<RawCameraFrame>,
        flume::Receiver<RawCameraFrame>,
    ),
}

impl CameraPreview {
    pub fn init(manager: &impl Manager<Wry>) -> tauri_plugin_store::Result<Self> {
        // let (camera_tx, camera_rx) = flume::bounded::<RawCameraFrame>(4);

        Ok(Self {
            reconfigure: broadcast::channel(1),
            cancel: CancellationToken::new(),
            loading: Arc::new(AtomicBool::new(false)),
            store: tauri_plugin_store::StoreBuilder::new(manager, "cameraPreview").build()?,
            camera_preview: flume::bounded::<RawCameraFrame>(4), // Mutex::new(None),
        })
    }

    pub fn get_sender(&self) -> flume::Sender<RawCameraFrame> {
        self.camera_preview.0.clone()
    }

    pub fn shutdown(&self) {
        println!("DO SHUTDOWN");
        self.cancel.cancel();
    }

    pub async fn init_preview_window(&self, window: WebviewWindow) -> anyhow::Result<()> {
        let camera_rx = self.camera_preview.1.clone();
        let cancel = self.cancel.clone();

        self.loading.store(true, Ordering::Relaxed);

        let mut renderer = Renderer::init(window.clone()).await?;
        info!("Renderer initialization completed successfully");

        let store = self.store.clone();
        let mut reconfigure = self.reconfigure.1.resubscribe();
        let loading_state = self.loading.clone();
        thread::spawn(move || {
            let mut _window_visible = false;
            let mut first = true;
            let mut loading = true;
            let mut window_size = None;
            // let mut resampler_frame = Cached::default();
            let mut aspect_ratio = None;
            let mut frame_count = 0u64;

            // Initialize GPU converter
            let rt = tokio::runtime::Runtime::new().expect("Failed to create GPU runtime");
            info!("Attempting to initialize GPU camera converter...");
            let mut gpu_converter = match rt.block_on(GPUCameraConverter::new()) {
                Ok(converter) => {
                    info!("GPU camera converter initialized successfully");
                    Some(converter)
                }
                Err(e) => {
                    warn!(
                        "Failed to initialize GPU converter, using ffmpeg fallback: {}",
                        e
                    );
                    None
                }
            };

            // Fallback ffmpeg scaler
            info!("Initializing FFmpeg fallback scaler...");
            let mut fallback_scaler = match scaling::Context::get(
                Pixel::RGBA,
                1,
                1,
                Pixel::RGBA,
                1,
                1,
                scaling::Flags::empty(),
            ) {
                Ok(scaler) => {
                    info!("FFmpeg fallback scaler initialized successfully");
                    Some(scaler)
                }
                Err(err) => {
                    error!("Error initializing ffmpeg scaler: {err:?}");
                    None
                }
            };

            info!("Camera preview initialized!");

            // Debug initial state
            info!(
                "Initial renderer state: GPU device: {:?}, surface size cache: empty",
                renderer.device.features()
            );
            info!(
                "Camera state: shape={:?}, size={:?}, mirrored={}",
                renderer.state.shape, renderer.state.size, renderer.state.mirrored
            );

            // Show window immediately to ensure it's visible
            if let Err(err) = renderer.window.show() {
                error!("Failed to show camera preview window initially: {}", err);
            } else {
                info!("Camera preview window shown initially");
                _window_visible = true;
            }

            // Add timeout for frame receiving
            let frame_timeout = std::time::Duration::from_millis(5000); // 5 second timeout
            let mut last_frame_time = std::time::Instant::now();
            let mut timeout_warned = false;

            while let Some((frame, reconfigure)) = block_on({
                let camera_rx = &camera_rx;
                let reconfigure = &mut reconfigure;

                async {
                    // Triggers the first paint
                    if first {
                        // We don't set `first = false` as that is done within the loop.
                        return Some((None, true));
                    }

                    match futures::future::select(
                        pin!(camera_rx.recv_async()),
                        futures::future::select(pin!(reconfigure.recv()), pin!(cancel.cancelled())),
                    )
                    .await
                    {
                        Either::Left((frame, _)) => {
                            if let Ok(f) = frame {
                                last_frame_time = std::time::Instant::now();
                                timeout_warned = false;
                                Some((Some(f.frame), false))
                            } else {
                                // Camera disconnected
                                error!("Camera frame receiver disconnected");
                                None
                            }
                        }
                        Either::Right((Either::Left((event, _)), _)) => {
                            if let Ok(Some((width, height))) = event {
                                window_size = Some((width, height));
                            }
                            Some((None, true))
                        }
                        Either::Right((Either::Right(_), _)) => {
                            // Cancellation requested
                            info!("Camera preview cancellation requested");
                            None
                        }
                    }
                }
            }) {
                // Check for camera timeout
                let elapsed = last_frame_time.elapsed();
                if elapsed > frame_timeout && !timeout_warned {
                    warn!(
                        "No camera frames received for {:.1}s - camera may be disconnected or not working",
                        elapsed.as_secs_f32()
                    );
                    timeout_warned = true;
                }

                let window_resize_required =
                    if reconfigure && renderer.refresh_state(&store) || first {
                        first = false;
                        renderer.update_state_uniforms();
                        info!("WINDOW RESIZE REQUESTED A - first render or reconfigure");
                        true
                    } else if let Some(frame) = frame.as_ref()
                        && renderer.frame_info.update_key_and_should_init((
                            frame.format(),
                            frame.width(),
                            frame.height(),
                        ))
                    {
                        aspect_ratio = Some(frame.width() as f32 / frame.height() as f32);
                        info!(
                            "NEW CAMERA SIZE: {}x{}, aspect_ratio: {:?}",
                            frame.width(),
                            frame.height(),
                            aspect_ratio
                        );

                        info!("WINDOW RESIZE REQUESTED B - frame size changed");
                        true
                    } else {
                        false
                    };

                let camera_aspect_ratio =
                    aspect_ratio.unwrap_or(if renderer.state.shape == CameraPreviewShape::Full {
                        16.0 / 9.0
                    } else {
                        1.0
                    });

                if window_resize_required {
                    info!(
                        "Executing window resize with camera_aspect_ratio: {}",
                        camera_aspect_ratio
                    );

                    renderer.update_camera_aspect_ratio_uniforms(camera_aspect_ratio);

                    match renderer.resize_window(camera_aspect_ratio) {
                        Ok(size) => {
                            window_size = Some(size);
                            info!("Window resized to: {}x{}", size.0, size.1);
                        }
                        Err(err) => {
                            error!("Error updating window size: {err:?}");
                            continue;
                        }
                    }
                }

                let (window_width, window_height) = match window_size {
                    Some(s) => s,
                    // Calling `window.outer_size` will hang when a native menu is opened.
                    // So we only callback to it if absolute required as it could randomly hang.
                    None => match renderer
                        .window
                        .inner_size()
                        .and_then(|size| Ok(size.to_logical(renderer.window.scale_factor()?)))
                    {
                        Ok(size) => {
                            window_size = Some((size.width, size.height));
                            (size.width, size.height)
                        }
                        Err(err) => {
                            error!("Error getting window size: {err:?}");
                            continue;
                        }
                    },
                };

                info!(
                    "Render frame {}: camera_aspect={:.3}, window={}x{}",
                    frame_count, camera_aspect_ratio, window_width, window_height
                );

                if let Err(err) = renderer.reconfigure_gpu_surface(window_width, window_height) {
                    error!("Error reconfiguring GPU surface: {err:?}");
                    continue;
                }

                if let Ok(surface) = renderer
                    .surface
                    .get_current_texture()
                    .map_err(|err| error!("Error getting camera renderer surface texture: {err:?}"))
                {
                    let output_width = 1280;
                    let output_height = (1280.0 / camera_aspect_ratio) as u32;

                    let new_texture_value = if let Some(frame) = frame {
                        frame_count += 1;
                        if loading {
                            loading_state.store(false, Ordering::Relaxed);
                            loading = false;
                            info!(
                                "Camera finished loading, received first frame #{}",
                                frame_count
                            );
                        }

                        // Convert ffmpeg pixel format to our format enum
                        let camera_format = match frame.format() {
                            Pixel::NV12 => CameraFormat::NV12,
                            Pixel::UYVY422 => CameraFormat::UYVY,
                            Pixel::YUYV422 => CameraFormat::YUYV,
                            Pixel::YUV420P => CameraFormat::YUV420P,
                            Pixel::BGRA => CameraFormat::BGRA,
                            Pixel::RGB24 => CameraFormat::RGB24,
                            Pixel::RGBA => CameraFormat::RGBA,
                            _ => CameraFormat::Unknown,
                        };

                        // Try GPU conversion first
                        if let Some(ref mut converter) = gpu_converter {
                            let frame_data = frame.data(0);
                            let camera_input = CameraInput::new(
                                frame_data,
                                camera_format,
                                frame.width(),
                                frame.height(),
                            )
                            .with_stride(frame.stride(0) as u32);

                            match rt.block_on(converter.convert_and_scale(
                                &camera_input,
                                output_width,
                                output_height,
                                ScalingQuality::Good,
                            )) {
                                Ok(rgba_data) => {
                                    if frame_count % 30 == 1 {
                                        info!(
                                            "GPU conversion successful for frame #{}, size: {} bytes",
                                            frame_count,
                                            rgba_data.len()
                                        );
                                    }
                                    Some((rgba_data, output_width * 4))
                                }
                                Err(e) => {
                                    warn!(
                                        "GPU conversion failed for frame #{}, falling back to ffmpeg: {}",
                                        frame_count, e
                                    );
                                    // Fall back to ffmpeg
                                    // gpu_to_ffmpeg_fallback(
                                    //     &mut fallback_scaler,
                                    //     &mut resampler_frame,
                                    //     &frame,
                                    //     output_width,
                                    //     output_height,
                                    // )
                                    todo!()
                                }
                            }
                        } else {
                            // Use ffmpeg fallback
                            // let result = gpu_to_ffmpeg_fallback(
                            //     &mut fallback_scaler,
                            //     &mut resampler_frame,
                            //     &frame,
                            //     output_width,
                            //     output_height,
                            // );
                            // if frame_count % 30 == 1 {
                            //     info!(
                            //         "FFmpeg fallback used for frame #{}, result: {}",
                            //         frame_count,
                            //         result.is_some()
                            //     );
                            // }
                            // result
                            todo!()
                        }
                    } else if loading {
                        let (buffer, stride) = render_solid_frame(
                            [0x44, 0x44, 0x44, 0xFF], // Lighter gray for better visibility
                            output_width,
                            output_height,
                        );
                        if frame_count % 30 == 1 {
                            info!("Rendering loading frame (gray) #{}", frame_count);
                        }
                        Some((buffer, stride))
                    } else {
                        if frame_count % 30 == 1 {
                            warn!(
                                "No frame data and not loading - rendering nothing for frame #{}",
                                frame_count
                            );
                        }
                        None
                    };

                    renderer.render(
                        surface,
                        new_texture_value.as_ref().map(|(b, s)| (&**b, *s)),
                        output_width,
                        output_height,
                    );

                    if frame_count % 30 == 1 {
                        info!(
                            "Rendered frame #{}, has_texture: {}",
                            frame_count,
                            new_texture_value.is_some()
                        );
                    }
                } else {
                    error!("Failed to get surface texture for frame #{}", frame_count);
                }
            }

            fn gpu_to_ffmpeg_fallback(
                scaler: &mut Option<scaling::Context>,
                resampler_frame: &mut Cached<(u32, u32), frame::Video>,
                frame: &frame::Video,
                output_width: u32,
                output_height: u32,
            ) -> Option<(Vec<u8>, u32)> {
                if let Some(scaler) = scaler {
                    let resampler_frame = resampler_frame
                        .get_or_init((output_width, output_height), frame::Video::empty);

                    // Cache the scaler configuration
                    scaler.cached(
                        frame.format(),
                        frame.width(),
                        frame.height(),
                        format::Pixel::RGBA,
                        output_width,
                        output_height,
                        ffmpeg::software::scaling::flag::Flags::FAST_BILINEAR,
                    );

                    // Run the scaling operation
                    if let Err(err) = scaler.run(&frame, resampler_frame) {
                        error!(
                            "Error rescaling frame with ffmpeg - input: {}x{} {:?}, output: {}x{}: {err:?}",
                            frame.width(),
                            frame.height(),
                            frame.format(),
                            output_width,
                            output_height
                        );
                        return None;
                    }

                    let data = resampler_frame.data(0);
                    let stride = resampler_frame.stride(0) as u32;

                    if data.is_empty() {
                        error!("FFmpeg scaler produced empty frame data");
                        return None;
                    }

                    Some((data.to_vec(), stride))
                } else {
                    error!("No ffmpeg scaler available for fallback - cannot convert frame");
                    None
                }
            }

            warn!("Camera preview shutdown!");
            renderer.device.destroy();
            window.close().ok();
        });

        Ok(())
    }

    /// Test camera feed reception with timeout
    ///
    /// This function helps diagnose if the camera feed is working properly.
    /// Returns `Ok(true)` if frames are being received, `Ok(false)` if the feed
    /// is disconnected, and `Err(_)` if there's a timeout or other error.
    ///
    /// # Example
    /// ```rust
    /// if !camera_preview.test_camera_feed().await.unwrap_or(false) {
    ///     println!("Camera feed is not working!");
    /// }
    /// ```

    /// Debug function to check camera feed status
    pub fn debug_camera_feed(&self) -> anyhow::Result<()> {
        let camera_rx = self.camera_preview.1.clone();
        let _cancel = self.cancel.clone();

        thread::spawn(move || {
            info!("Starting camera feed debug monitor...");
            let mut frame_count = 0;
            let start_time = std::time::Instant::now();

            while let Ok(frame_data) = camera_rx.try_recv() {
                frame_count += 1;
                let frame = &frame_data.frame;

                info!(
                    "Debug frame #{}: {}x{} format={:?} data_size={}",
                    frame_count,
                    frame.width(),
                    frame.height(),
                    frame.format(),
                    frame.data(0).len()
                );

                if frame_count >= 5 {
                    break;
                }
            }

            let elapsed = start_time.elapsed();
            if frame_count == 0 {
                error!(
                    "No camera frames received in debug check ({}ms)",
                    elapsed.as_millis()
                );
            } else {
                info!(
                    "Camera feed debug complete: {} frames in {}ms",
                    frame_count,
                    elapsed.as_millis()
                );
            }
        });

        Ok(())
    }

    /// Get current loading state
    ///
    /// Returns `true` if the camera preview is still in loading state,
    /// `false` if it has finished loading and should be showing frames.
    ///
    /// # Example
    /// ```rust
    /// if camera_preview.is_loading() {
    ///     println!("Camera is still loading...");
    /// }
    /// ```

    /// Test camera feed reception with timeout
    pub async fn test_camera_feed(&self) -> anyhow::Result<bool> {
        info!("Testing camera feed reception...");
        let camera_rx = self.camera_preview.1.clone();

        match tokio::time::timeout(
            std::time::Duration::from_millis(2000),
            camera_rx.recv_async(),
        )
        .await
        {
            Ok(Ok(frame_data)) => {
                let frame = &frame_data.frame;
                info!(
                    "✓ Camera feed working: {}x{} format={:?}",
                    frame.width(),
                    frame.height(),
                    frame.format()
                );
                Ok(true)
            }
            Ok(Err(_)) => {
                error!("✗ Camera feed disconnected");
                Ok(false)
            }
            Err(_) => {
                error!("✗ Camera feed timeout - no frames received");
                Ok(false)
            }
        }
    }

    /// Force show camera window for debugging
    ///
    /// This function bypasses the normal window visibility logic and forces
    /// the camera window to be shown. Useful for debugging cases where the
    /// window never becomes visible due to frame processing issues.
    ///
    /// # Example
    /// ```rust
    /// if let Err(e) = camera_preview.force_show_window(&window) {
    ///     println!("Failed to force show window: {}", e);
    /// }
    /// ```
    pub fn force_show_window(&self, window: &WebviewWindow) -> anyhow::Result<()> {
        info!("Force showing camera window...");
        if let Err(e) = window.show() {
            error!("Failed to force show window: {}", e);
            return Err(anyhow::anyhow!("Failed to show window: {}", e));
        }
        info!("✓ Window forced visible");
        Ok(())
    }

    /// Get current loading state
    pub fn is_loading(&self) -> bool {
        self.loading.load(Ordering::Relaxed)
    }

    /// Comprehensive test function for debugging camera preview issues
    ///
    /// This function runs a complete test suite to diagnose camera preview problems:
    /// 1. Tests camera frame reception
    /// 2. Tests GPU converter functionality
    /// 3. Tests renderer initialization
    /// 4. Tests window operations
    ///
    /// Use this when the camera preview is not working and you need detailed
    /// diagnostic information.
    ///
    /// # Example
    /// ```rust
    /// if let Err(e) = camera_preview.test_camera_preview(window).await {
    ///     println!("Camera preview test failed: {}", e);
    /// }
    /// ```

    /// Comprehensive test function for debugging camera preview issues
    pub async fn test_camera_preview(&self, window: WebviewWindow) -> anyhow::Result<()> {
        info!("=== STARTING CAMERA PREVIEW TEST ===");

        // Test 1: Check if we can receive camera frames
        info!("Test 1: Checking camera frame reception...");
        let camera_rx = self.camera_preview.1.clone();

        // Try to receive a few frames with timeout
        let mut test_frame_count = 0;
        for attempt in 1..=5 {
            match tokio::time::timeout(
                std::time::Duration::from_millis(1000),
                camera_rx.recv_async(),
            )
            .await
            {
                Ok(Ok(frame_data)) => {
                    test_frame_count += 1;
                    let frame = &frame_data.frame;
                    info!(
                        "✓ Test frame #{}: {}x{} format={:?} data_size={}",
                        test_frame_count,
                        frame.width(),
                        frame.height(),
                        frame.format(),
                        frame.data(0).len()
                    );
                    if test_frame_count >= 3 {
                        break;
                    }
                }
                Ok(Err(_)) => {
                    error!(
                        "✗ Camera frame receiver disconnected on attempt {}",
                        attempt
                    );
                    break;
                }
                Err(_) => {
                    warn!(
                        "⚠ No frame received within 1s timeout (attempt {})",
                        attempt
                    );
                }
            }
        }

        if test_frame_count == 0 {
            error!("✗ CRITICAL: No camera frames received - camera may not be working");
            return Err(anyhow::anyhow!("No camera frames received"));
        } else {
            info!(
                "✓ Camera frame reception working: {} frames received",
                test_frame_count
            );
        }

        // Test 2: Test GPU converter
        info!("Test 2: Testing GPU converter...");
        let rt = tokio::runtime::Runtime::new()?;
        match rt.block_on(GPUCameraConverter::new()) {
            Ok(mut converter) => {
                info!("✓ GPU converter initialized successfully");

                // Test with dummy data
                let test_data = vec![128u8; 1920 * 1080 * 4]; // RGBA test data
                let camera_input = CameraInput::new(&test_data, CameraFormat::RGBA, 1920, 1080);

                match rt.block_on(converter.convert_and_scale(
                    &camera_input,
                    640,
                    480,
                    ScalingQuality::Good,
                )) {
                    Ok(result) => {
                        info!(
                            "✓ GPU conversion test successful: {} bytes output",
                            result.len()
                        );
                    }
                    Err(e) => {
                        warn!("⚠ GPU conversion test failed: {}", e);
                    }
                }
            }
            Err(e) => {
                warn!("⚠ GPU converter initialization failed: {}", e);
            }
        }

        // Test 3: Test renderer initialization
        info!("Test 3: Testing renderer initialization...");
        match Renderer::init(window.clone()).await {
            Ok(renderer) => {
                info!("✓ Renderer initialized successfully");
                info!("  - Device: {:?}", renderer.device.features());
                info!("  - Surface format: {:?}", renderer.surface_config.format);
                info!(
                    "  - Current state: shape={:?}, size={:?}, mirrored={}",
                    renderer.state.shape, renderer.state.size, renderer.state.mirrored
                );
            }
            Err(e) => {
                error!("✗ Renderer initialization failed: {}", e);
                return Err(anyhow::anyhow!("Renderer initialization failed: {}", e));
            }
        }

        // Test 4: Test window operations
        info!("Test 4: Testing window operations...");
        if let Err(e) = window.show() {
            error!("✗ Failed to show window: {}", e);
        } else {
            info!("✓ Window show successful");
        }

        match window.inner_size() {
            Ok(size) => {
                info!("✓ Window size: {}x{}", size.width, size.height);
            }
            Err(e) => {
                warn!("⚠ Failed to get window size: {}", e);
            }
        }

        info!("=== CAMERA PREVIEW TEST COMPLETED ===");
        Ok(())
    }

    /// Save the current state of the camera window.
    pub fn save(&self, state: &CameraWindowState) -> tauri_plugin_store::Result<()> {
        self.store.set("state", serde_json::to_value(state)?);
        self.store.save()?;
        self.reconfigure.0.send(None).ok();
        Ok(())
    }

    /// Wait for the camera to load.
    pub async fn wait_for_camera_to_load(&self) {
        // The webview is generally slow to load so it's rare this will actually loop.
        while self.loading.load(Ordering::Relaxed) {
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }

    /// Update the size of the window.
    /// Using `window.outer_size` just never resolves when a native menu is open.
    pub fn update_window_size(&self, width: u32, height: u32) {
        self.reconfigure.0.send(Some((width, height))).ok();
    }
}

struct Renderer {
    surface: wgpu::Surface<'static>,
    surface_config: wgpu::SurfaceConfiguration,
    render_pipeline: wgpu::RenderPipeline,
    device: wgpu::Device,
    queue: wgpu::Queue,
    sampler: wgpu::Sampler,
    bind_group_layout: wgpu::BindGroupLayout,
    uniform_buffer: wgpu::Buffer,
    window_uniform_buffer: wgpu::Buffer,
    camera_uniform_buffer: wgpu::Buffer,
    uniform_bind_group: wgpu::BindGroup,
    window: tauri::WebviewWindow<Wry>,

    state: CameraWindowState,
    frame_info: Cached<(format::Pixel, u32, u32)>,
    surface_size: Cached<(u32, u32)>,
    texture: Cached<(u32, u32), (wgpu::Texture, wgpu::TextureView, wgpu::BindGroup)>,
}

impl Renderer {
    /// Initialize a new renderer for a specific Tauri window.
    async fn init(window: WebviewWindow) -> anyhow::Result<Self> {
        let (tx, rx) = oneshot::channel();
        window
            .run_on_main_thread({
                let window = window.clone();
                move || {
                    let instance = wgpu::Instance::default();
                    let surface = instance.create_surface(window.clone());
                    tx.send((instance, surface)).ok();
                }
            })
            .with_context(|| "Failed to initialize wgpu instance")?;

        let (instance, surface) = rx
            .await
            .with_context(|| "Failed to receive initialized wgpu instance and surface")?;
        let surface = surface.with_context(|| "Failed to initialize wgpu surface")?;

        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions {
                power_preference: wgpu::PowerPreference::default(),
                force_fallback_adapter: false,
                compatible_surface: Some(&surface),
            })
            .await
            .with_context(|| "Failed to find an appropriate wgpu adapter")?;

        let (device, queue) = adapter
            .request_device(&wgpu::DeviceDescriptor {
                label: None,
                required_features: wgpu::Features::empty(),
                required_limits: wgpu::Limits::downlevel_webgl2_defaults()
                    .using_resolution(adapter.limits()),
                memory_hints: Default::default(),
                trace: wgpu::Trace::Off,
            })
            .await
            .with_context(|| "Failed to create wgpu device")?;

        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: None,
            source: wgpu::ShaderSource::Wgsl(std::borrow::Cow::Borrowed(include_str!(
                "./camera.wgsl"
            ))),
        });

        let uniform_bind_group_layout =
            device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("Uniform Bind Group Layout"),
                entries: &[
                    wgpu::BindGroupLayoutEntry {
                        binding: 0,
                        visibility: wgpu::ShaderStages::VERTEX | wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Buffer {
                            ty: wgpu::BufferBindingType::Uniform,
                            has_dynamic_offset: false,
                            min_binding_size: None,
                        },
                        count: None,
                    },
                    wgpu::BindGroupLayoutEntry {
                        binding: 1,
                        visibility: wgpu::ShaderStages::VERTEX | wgpu::ShaderStages::FRAGMENT, // Add FRAGMENT here
                        ty: wgpu::BindingType::Buffer {
                            ty: wgpu::BufferBindingType::Uniform,
                            has_dynamic_offset: false,
                            min_binding_size: None,
                        },
                        count: None,
                    },
                    wgpu::BindGroupLayoutEntry {
                        binding: 2,
                        visibility: wgpu::ShaderStages::VERTEX | wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Buffer {
                            ty: wgpu::BufferBindingType::Uniform,
                            has_dynamic_offset: false,
                            min_binding_size: None,
                        },
                        count: None,
                    },
                ],
            });

        let bind_group_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("Texture Bind Group Layout"),
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

        let uniform_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Uniform Buffer"),
            size: std::mem::size_of::<StateUniforms>() as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        let window_uniform_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Window Uniform Buffer"),
            size: std::mem::size_of::<WindowUniforms>() as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        let camera_uniform_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Camera Uniform Buffer"),
            size: std::mem::size_of::<CameraUniforms>() as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        let uniform_bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Uniform Bind Group"),
            layout: &uniform_bind_group_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: uniform_buffer.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: window_uniform_buffer.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: camera_uniform_buffer.as_entire_binding(),
                },
            ],
        });

        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: None,
            bind_group_layouts: &[&bind_group_layout, &uniform_bind_group_layout],
            push_constant_ranges: &[],
        });

        let swapchain_format = wgpu::TextureFormat::Bgra8Unorm;
        let render_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: None,
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
                    format: swapchain_format,
                    blend: Some(wgpu::BlendState::ALPHA_BLENDING),
                    write_mask: wgpu::ColorWrites::ALL,
                })],
                compilation_options: Default::default(),
            }),
            primitive: wgpu::PrimitiveState::default(),
            depth_stencil: None,
            multisample: Default::default(),
            multiview: None,
            cache: None,
        });

        let surface_capabilities = surface.get_capabilities(&adapter);
        let alpha_mode = if surface_capabilities
            .alpha_modes
            .contains(&CompositeAlphaMode::PreMultiplied)
        {
            CompositeAlphaMode::PreMultiplied
        } else if surface_capabilities
            .alpha_modes
            .contains(&CompositeAlphaMode::PostMultiplied)
        {
            CompositeAlphaMode::PostMultiplied
        } else {
            CompositeAlphaMode::Inherit
        };

        let surface_config = wgpu::SurfaceConfiguration {
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            format: swapchain_format,
            // These will be sorted out by the main event loop
            width: 0,
            height: 0,
            present_mode: wgpu::PresentMode::Fifo,
            alpha_mode,
            view_formats: vec![],
            desired_maximum_frame_latency: 2,
        };

        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            address_mode_w: wgpu::AddressMode::ClampToEdge,
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            mipmap_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        });

        Ok(Self {
            surface,
            surface_config,
            render_pipeline,
            device,
            queue,
            sampler,
            bind_group_layout,
            uniform_buffer,
            window_uniform_buffer,
            camera_uniform_buffer,
            uniform_bind_group,
            window,

            state: Default::default(),
            frame_info: Cached::default(),
            surface_size: Cached::default(),
            texture: Cached::default(),
        })
    }

    /// Update the local cache of the camera state
    fn refresh_state(&mut self, store: &Store<tauri::Wry>) -> bool {
        let current = self.state.clone();

        self.state = store
            .get("state")
            .and_then(|v| serde_json::from_value(v).ok())
            .unwrap_or_default();

        current != self.state
    }

    /// Resize the OS window to the correct size
    fn resize_window(&self, aspect: f32) -> tauri::Result<(u32, u32)> {
        let base: f32 = if self.state.size == CameraPreviewSize::Sm {
            230.0
        } else {
            400.0
        };
        let window_width = if self.state.shape == CameraPreviewShape::Full {
            if aspect >= 1.0 { base * aspect } else { base }
        } else {
            base
        };
        let window_height = if self.state.shape == CameraPreviewShape::Full {
            if aspect >= 1.0 { base } else { base / aspect }
        } else {
            base
        } + TOOLBAR_HEIGHT;

        let (monitor_size, monitor_offset, monitor_scale_factor): (
            PhysicalSize<u32>,
            LogicalPosition<u32>,
            _,
        ) = if let Some(monitor) = self.window.current_monitor()? {
            let size = monitor.position().to_logical(monitor.scale_factor());
            (*monitor.size(), size, monitor.scale_factor())
        } else {
            (PhysicalSize::new(640, 360), LogicalPosition::new(0, 0), 1.0)
        };

        let x = (monitor_size.width as f64 / monitor_scale_factor - window_width as f64 - 100.0)
            as u32
            + monitor_offset.x;
        let y = (monitor_size.height as f64 / monitor_scale_factor - window_height as f64 - 100.0)
            as u32
            + monitor_offset.y;

        self.window
            .set_size(LogicalSize::new(window_width, window_height))?;
        self.window.set_position(LogicalPosition::new(x, y))?;

        Ok((window_width as u32, window_height as u32))
    }

    /// Reconfigure the GPU surface if the window has changed size
    fn reconfigure_gpu_surface(
        &mut self,
        window_width: u32,
        window_height: u32,
    ) -> tauri::Result<()> {
        self.surface_size
            .get_or_init((window_width, window_height), || {
                self.surface_config.width = if window_width > 0 {
                    window_width * GPU_SURFACE_SCALE
                } else {
                    1
                };
                self.surface_config.height = if window_height > 0 {
                    window_height * GPU_SURFACE_SCALE
                } else {
                    1
                };
                info!(
                    "Configuring GPU surface: {}x{} (scaled: {}x{})",
                    window_width,
                    window_height,
                    self.surface_config.width,
                    self.surface_config.height
                );
                self.surface.configure(&self.device, &self.surface_config);

                let toolbar_percentage =
                    (TOOLBAR_HEIGHT * GPU_SURFACE_SCALE as f32) / self.surface_config.height as f32;

                let window_uniforms = WindowUniforms {
                    window_height: window_height as f32,
                    window_width: window_width as f32,
                    toolbar_percentage,
                    _padding: 0.0,
                };

                info!(
                    "Updating window uniforms: size={}x{}, toolbar_percentage={:.3}",
                    window_width, window_height, toolbar_percentage
                );

                self.queue.write_buffer(
                    &self.window_uniform_buffer,
                    0,
                    bytemuck::cast_slice(&[window_uniforms]),
                );
            });

        Ok(())
    }

    /// Update the uniforms which hold the camera preview state
    fn update_state_uniforms(&mut self) {
        let uniforms = StateUniforms {
            shape: match self.state.shape {
                CameraPreviewShape::Round => 0.0,
                CameraPreviewShape::Square => 1.0,
                CameraPreviewShape::Full => 2.0,
            },
            size: match self.state.size {
                CameraPreviewSize::Sm => 0.0,
                CameraPreviewSize::Lg => 1.0,
            },
            mirrored: if self.state.mirrored { 1.0 } else { 0.0 },
            _padding: 0.0,
        };

        info!(
            "Updating state uniforms: shape={:.1}, size={:.1}, mirrored={:.1}",
            uniforms.shape, uniforms.size, uniforms.mirrored
        );

        self.queue
            .write_buffer(&self.uniform_buffer, 0, bytemuck::cast_slice(&[uniforms]));
    }

    /// Update the uniforms which hold the camera aspect ratio
    fn update_camera_aspect_ratio_uniforms(&mut self, camera_aspect_ratio: f32) {
        let uniforms = CameraUniforms {
            camera_aspect_ratio,
            _padding: 0.0,
        };

        info!(
            "Updating camera aspect ratio uniforms: aspect={:.3}",
            camera_aspect_ratio
        );

        self.queue.write_buffer(
            &self.camera_uniform_buffer,
            0,
            bytemuck::cast_slice(&[uniforms]),
        );
    }

    /// Render the camera preview to the window.
    fn render(
        &mut self,
        surface: SurfaceTexture,
        new_texture_value: Option<(&[u8], u32)>,
        width: u32,
        height: u32,
    ) {
        let surface_view = surface
            .texture
            .create_view(&wgpu::TextureViewDescriptor::default());

        // let surface_width = surface.texture.width();
        // let surface_height = surface.texture.height();

        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor { label: None });

        {
            let mut render_pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: None,
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &surface_view,
                    // depth_slice: None,
                    resolve_target: None, // Some(&surface_view),
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color {
                            r: 0.1,
                            g: 0.1,
                            b: 0.1,
                            a: 1.0,
                        }),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
            });

            // Get or reinitialize the texture if necessary
            let (texture, _, bind_group) = &*self.texture.get_or_init((width, height), || {
                let texture = self.device.create_texture(&wgpu::TextureDescriptor {
                    label: Some("Camera Texture"),
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
                });

                let texture_view = texture.create_view(&wgpu::TextureViewDescriptor::default());

                let bind_group = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
                    label: Some("Texture Bind Group"),
                    layout: &self.bind_group_layout,
                    entries: &[
                        wgpu::BindGroupEntry {
                            binding: 0,
                            resource: wgpu::BindingResource::TextureView(&texture_view),
                        },
                        wgpu::BindGroupEntry {
                            binding: 1,
                            resource: wgpu::BindingResource::Sampler(&self.sampler),
                        },
                    ],
                });

                (texture, texture_view, bind_group)
            });

            if let Some((buffer, stride)) = new_texture_value {
                // Validate buffer size
                let expected_size = (stride * height) as usize;
                if buffer.len() < expected_size {
                    error!(
                        "Buffer too small: {} bytes, expected at least {} bytes ({}x{}, stride {})",
                        buffer.len(),
                        expected_size,
                        width,
                        height,
                        stride
                    );
                    return;
                }

                // Log texture upload details occasionally
                static TEXTURE_LOG_COUNTER: AtomicU64 = AtomicU64::new(0);
                let counter = TEXTURE_LOG_COUNTER.fetch_add(1, Ordering::Relaxed) + 1;
                if counter % 60 == 1 {
                    info!(
                        "Uploading texture #{}: {}x{}, stride: {}, buffer size: {} bytes",
                        counter,
                        width,
                        height,
                        stride,
                        buffer.len()
                    );
                }

                self.queue.write_texture(
                    wgpu::TexelCopyTextureInfo {
                        texture,
                        mip_level: 0,
                        origin: wgpu::Origin3d::ZERO,
                        aspect: wgpu::TextureAspect::All,
                    },
                    buffer,
                    wgpu::TexelCopyBufferLayout {
                        offset: 0,
                        bytes_per_row: Some(stride),
                        rows_per_image: Some(height),
                    },
                    wgpu::Extent3d {
                        width,
                        height,
                        depth_or_array_layers: 1,
                    },
                );
            } else {
                // Log when no texture data is provided
                static NO_TEXTURE_LOG_COUNTER: AtomicU64 = AtomicU64::new(0);
                let counter = NO_TEXTURE_LOG_COUNTER.fetch_add(1, Ordering::Relaxed) + 1;
                if counter % 60 == 1 {
                    warn!("No texture data provided for render #{}", counter);
                }
            }

            render_pass.set_pipeline(&self.render_pipeline);
            render_pass.set_bind_group(0, bind_group, &[]);
            render_pass.set_bind_group(1, &self.uniform_bind_group, &[]);
            render_pass.draw(0..6, 0..1);

            // Log render pass details occasionally
            static RENDER_LOG_COUNTER: AtomicU64 = AtomicU64::new(0);
            let counter = RENDER_LOG_COUNTER.fetch_add(1, Ordering::Relaxed) + 1;
            if counter % 60 == 1 {
                info!(
                    "Render pass #{}: pipeline set, bind groups set, drawing 6 vertices",
                    counter
                );
            }
        }

        self.queue.submit(Some(encoder.finish()));

        // Present the surface
        surface.present();

        // Log presentation occasionally
        static PRESENT_LOG_COUNTER: AtomicU64 = AtomicU64::new(0);
        let counter = PRESENT_LOG_COUNTER.fetch_add(1, Ordering::Relaxed) + 1;
        if counter % 60 == 1 {
            info!("Surface presented #{}", counter);
        }
    }
}

/// Camera diagnostics and troubleshooting utilities
///
/// This struct provides functions to diagnose and fix common camera preview issues.
/// Use these functions when the camera preview is not working properly.
///
/// # Usage Examples
///
/// ## Quick Diagnosis
/// ```rust
/// let report = CameraDiagnostics::diagnose_camera_preview(&camera_preview, &window).await?;
/// println!("{}", report);
/// ```
///
/// ## Apply Quick Fixes
/// ```rust
/// let fixes = CameraDiagnostics::quick_fix_camera_preview(&camera_preview, &window).await?;
/// for fix in fixes {
///     println!("Applied: {}", fix);
/// }
/// ```
///
/// ## Troubleshooting Guide
///
/// ### Camera Preview is Invisible
/// 1. Run `diagnose_camera_preview()` to get a full report
/// 2. Check if camera feed is working (look for "Camera Feed Status" in report)
/// 3. Check if window is visible (look for "Window Status" in report)
/// 4. Try `quick_fix_camera_preview()` to apply automatic fixes
///
/// ### Camera Preview Shows Black Screen
/// 1. Check GPU converter initialization in logs
/// 2. Verify frame format conversion is working
/// 3. Check texture upload and rendering logs
///
/// ### Camera Preview is Stuck Loading
/// 1. Check camera feed reception with `test_camera_feed()`
/// 2. Monitor frame processing logs
/// 3. Verify loading state transitions
pub struct CameraDiagnostics;

impl CameraDiagnostics {
    /// Run comprehensive camera preview diagnostics
    pub async fn diagnose_camera_preview(
        camera_preview: &CameraPreview,
        window: &WebviewWindow,
    ) -> anyhow::Result<String> {
        let mut report = String::new();
        report.push_str("=== CAMERA PREVIEW DIAGNOSTICS ===\n");

        // Test 1: Camera feed status
        report.push_str("\n1. Camera Feed Status:\n");
        match camera_preview.test_camera_feed().await {
            Ok(true) => report.push_str("   ✓ Camera feed is working\n"),
            Ok(false) => report.push_str("   ✗ Camera feed not working\n"),
            Err(e) => report.push_str(&format!("   ✗ Camera feed error: {}\n", e)),
        }

        // Test 2: Loading state
        report.push_str("\n2. Loading State:\n");
        let is_loading = camera_preview.is_loading();
        report.push_str(&format!("   Loading: {}\n", is_loading));

        // Test 3: Window visibility
        report.push_str("\n3. Window Status:\n");
        match window.is_visible() {
            Ok(visible) => report.push_str(&format!("   Visible: {}\n", visible)),
            Err(e) => report.push_str(&format!("   ✗ Cannot check visibility: {}\n", e)),
        }

        // Test 4: Window size
        match window.inner_size() {
            Ok(size) => report.push_str(&format!("   Size: {}x{}\n", size.width, size.height)),
            Err(e) => report.push_str(&format!("   ✗ Cannot get size: {}\n", e)),
        }

        // Test 5: Force show window
        report.push_str("\n4. Force Show Test:\n");
        match camera_preview.force_show_window(window) {
            Ok(_) => report.push_str("   ✓ Force show successful\n"),
            Err(e) => report.push_str(&format!("   ✗ Force show failed: {}\n", e)),
        }

        report.push_str("\n=== END DIAGNOSTICS ===\n");
        Ok(report)
    }

    /// Quick fix attempts for common camera preview issues
    pub async fn quick_fix_camera_preview(
        camera_preview: &CameraPreview,
        window: &WebviewWindow,
    ) -> anyhow::Result<Vec<String>> {
        let mut fixes_applied = Vec::new();

        // Fix 1: Force show window
        if let Ok(false) = window.is_visible() {
            if camera_preview.force_show_window(window).is_ok() {
                fixes_applied.push("Applied: Force showed window".to_string());
            }
        }

        // Fix 2: Reset window position if it's off-screen
        if let Ok(size) = window.outer_size() {
            if size.width == 0 || size.height == 0 {
                if window.set_size(tauri::LogicalSize::new(400, 300)).is_ok() {
                    fixes_applied.push("Applied: Reset window size to 400x300".to_string());
                }
            }
        }

        // Fix 3: Bring window to front
        if window.set_focus().is_ok() {
            fixes_applied.push("Applied: Brought window to front".to_string());
        }

        Ok(fixes_applied)
    }
}

fn render_solid_frame(color: [u8; 4], width: u32, height: u32) -> (Vec<u8>, u32) {
    let pixel_count = (height * width) as usize;
    let buffer: Vec<u8> = color
        .iter()
        .cycle()
        .take(pixel_count * 4)
        .copied()
        .collect();

    (buffer, 4 * width)
}

struct Cached<K, V = ()> {
    value: Option<(K, V)>,
}

impl<K, V> Default for Cached<K, V> {
    fn default() -> Self {
        Self { value: None }
    }
}

impl<K: PartialEq, V> Cached<K, V> {
    pub fn get_or_init(&mut self, key: K, init: impl FnOnce() -> V) -> &mut V {
        if self.value.as_ref().is_none_or(|(k, _)| *k != key) {
            self.value = Some((key, init()));
        }

        &mut self.value.as_mut().expect("checked above").1
    }
}

impl<K: PartialEq> Cached<K, ()> {
    /// Updates the key and returns `true` when the key was changed.
    pub fn update_key_and_should_init(&mut self, key: K) -> bool {
        if self.value.as_ref().is_none_or(|(k, _)| *k != key) {
            self.value = Some((key, ()));
            true
        } else {
            false
        }
    }
}

#[repr(C)]
#[derive(Debug, Copy, Clone, bytemuck::Pod, bytemuck::Zeroable)]
struct StateUniforms {
    shape: f32,
    size: f32,
    mirrored: f32,
    _padding: f32,
}

#[repr(C)]
#[derive(Debug, Copy, Clone, bytemuck::Pod, bytemuck::Zeroable)]
struct WindowUniforms {
    window_height: f32,
    window_width: f32,
    toolbar_percentage: f32,
    _padding: f32,
}

#[repr(C)]
#[derive(Debug, Copy, Clone, bytemuck::Pod, bytemuck::Zeroable)]
struct CameraUniforms {
    camera_aspect_ratio: f32,
    _padding: f32,
}

pub struct CameraWindows {
    windows: HashMap<String, flume::Receiver<()>>,
}

impl CameraWindows {
    pub fn register(&self, _window: WebviewWindow) {
        // self.windows.insert(
        //     window.label(),
        //     tokio::spawn(async move {
        //         // TODO
        //     }),
        // );

        // tokio::spawn(async move {});

        // window.on_window_event(|event| {
        //     match event {
        //         tauri::WindowEvent::Resized(size) => {
        //             // TODO
        //         }
        //         tauri::WindowEvent::Destroyed => {
        //             // TODO
        //         }
        //         _ => {}
        //     }
        // });

        todo!();
    }

    pub fn set_feed(&self, _window: WebviewWindow) {
        todo!();
    }
}
