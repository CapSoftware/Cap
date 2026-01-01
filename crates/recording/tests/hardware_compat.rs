#![cfg(target_os = "windows")]

use std::{collections::HashMap, time::Duration};

mod test_utils {
    use std::sync::Once;

    static INIT: Once = Once::new();

    pub fn init_tracing() {
        INIT.call_once(|| {
            tracing_subscriber::fmt()
                .with_env_filter(
                    tracing_subscriber::EnvFilter::from_default_env()
                        .add_directive(tracing::Level::DEBUG.into()),
                )
                .with_test_writer()
                .try_init()
                .ok();
        });
    }
}

#[test]
fn test_software_encoding_always_available() {
    test_utils::init_tracing();

    let libx264 = ffmpeg::encoder::find_by_name("libx264");
    assert!(
        libx264.is_some(),
        "libx264 software encoder must always be available as ultimate fallback"
    );

    let encoder = libx264.unwrap();
    println!("libx264 encoder available: {}", encoder.description());
}

#[test]
fn test_swscale_conversion_works() {
    test_utils::init_tracing();

    let config = cap_frame_converter::ConversionConfig::new(
        ffmpeg::format::Pixel::BGRA,
        1920,
        1080,
        ffmpeg::format::Pixel::NV12,
        1920,
        1080,
    );

    let result = cap_frame_converter::create_converter_with_details(config);
    assert!(
        result.is_ok(),
        "Frame converter should always succeed (with swscale fallback)"
    );

    let selection = result.unwrap();
    println!(
        "Converter backend: {:?}, fallback reason: {:?}",
        selection.backend, selection.fallback_reason
    );
}

#[test]
fn test_system_diagnostics_collection() {
    test_utils::init_tracing();

    let diagnostics = cap_recording::diagnostics::collect_diagnostics();

    println!("=== System Diagnostics ===");

    if let Some(ref version) = diagnostics.windows_version {
        println!(
            "Windows: {} (Build {})",
            version.display_name, version.build
        );
        println!("  Meets requirements: {}", version.meets_requirements);
        println!("  Is Windows 11: {}", version.is_windows_11);
    } else {
        println!("Windows version: Could not detect");
    }

    if let Some(ref gpu) = diagnostics.gpu_info {
        println!(
            "GPU: {} ({}) - {} MB VRAM",
            gpu.description, gpu.vendor, gpu.dedicated_video_memory_mb
        );
    } else {
        println!("GPU: No dedicated GPU detected (CPU-only or WARP)");
    }

    println!("Available encoders: {:?}", diagnostics.available_encoders);
    println!(
        "Graphics Capture supported: {}",
        diagnostics.graphics_capture_supported
    );
    println!(
        "D3D11 Video Processor available: {}",
        diagnostics.d3d11_video_processor_available
    );

    assert!(
        diagnostics
            .available_encoders
            .contains(&"libx264".to_string()),
        "libx264 must be available"
    );
}

#[test]
fn test_windows_version_detection() {
    test_utils::init_tracing();

    let version = scap_direct3d::WindowsVersion::detect();
    assert!(
        version.is_some(),
        "Windows version detection should succeed"
    );

    let version = version.unwrap();
    println!(
        "Windows Version: {} (Major: {}, Minor: {}, Build: {})",
        version.display_name(),
        version.major,
        version.minor,
        version.build
    );
    println!(
        "Meets minimum requirements (Windows 10 1903+): {}",
        version.meets_minimum_requirements()
    );
    println!("Is Windows 11: {}", version.is_windows_11());
    println!(
        "Supports border control: {}",
        version.supports_border_control()
    );

    let graphics_capture_supported = scap_direct3d::is_supported().unwrap_or(false);
    if !version.meets_minimum_requirements() && graphics_capture_supported {
        println!(
            "Note: GetVersionExW returned version {} but Graphics Capture is supported.",
            version.display_name()
        );
        println!(
            "This is expected - Windows compatibility shims can cause incorrect version reporting."
        );
        println!("Feature detection (is_supported) is the reliable method, and it returns true.");
    } else if !version.meets_minimum_requirements() {
        println!("Warning: Windows version appears to be below requirements.");
        println!("If Cap works correctly, this may be a version detection issue.");
    }
}

#[test]
fn test_gpu_detection() {
    test_utils::init_tracing();

    let gpu_info = cap_frame_converter::detect_primary_gpu();

    if let Some(info) = gpu_info {
        println!("=== GPU Information ===");
        println!("Description: {}", info.description);
        println!("Vendor: {} (0x{:04X})", info.vendor_name(), info.vendor_id);
        println!("Device ID: 0x{:04X}", info.device_id);
        println!(
            "Dedicated VRAM: {} MB",
            info.dedicated_video_memory / (1024 * 1024)
        );

        match info.vendor {
            cap_frame_converter::GpuVendor::Nvidia => {
                println!("  -> NVIDIA GPU: NVENC encoding expected");
            }
            cap_frame_converter::GpuVendor::Amd => {
                println!("  -> AMD GPU: AMF encoding expected");
            }
            cap_frame_converter::GpuVendor::Intel => {
                println!("  -> Intel GPU: QSV encoding expected");
            }
            cap_frame_converter::GpuVendor::Qualcomm => {
                println!("  -> Qualcomm GPU: Software encoding expected");
            }
            cap_frame_converter::GpuVendor::Arm => {
                println!("  -> ARM GPU: Software encoding expected");
            }
            cap_frame_converter::GpuVendor::Microsoft => {
                println!("  -> Microsoft WARP: Software rendering/encoding");
            }
            cap_frame_converter::GpuVendor::Unknown(id) => {
                println!("  -> Unknown GPU vendor (0x{id:04X}): Software fallback");
            }
        }
    } else {
        println!("No GPU detected - system will use software rendering and encoding");
    }
}

#[test]
fn test_graphics_capture_support() {
    test_utils::init_tracing();

    let supported = scap_direct3d::is_supported().unwrap_or(false);
    println!("Windows Graphics Capture API supported: {supported}");

    if !supported {
        let version = scap_direct3d::WindowsVersion::detect();
        if let Some(v) = version {
            if !v.meets_minimum_requirements() {
                println!(
                    "  -> Reason: Windows version {} does not meet requirements (need 10.0.18362+)",
                    v.display_name()
                );
            } else {
                println!("  -> Reason: Graphics Capture may be disabled by group policy");
            }
        }
    }
}

#[test]
fn test_camera_enumeration() {
    test_utils::init_tracing();

    let cameras: Vec<cap_camera::CameraInfo> = cap_camera::list_cameras().collect();

    println!("=== Camera Enumeration ===");
    println!("Found {} camera(s)", cameras.len());

    for (i, camera) in cameras.iter().enumerate() {
        println!("\n--- Camera {} ---", i + 1);
        println!("Display name: {}", camera.display_name());
        println!("Device ID: {}", camera.device_id());

        if let Some(model_id) = camera.model_id() {
            println!("Model ID: {model_id}");
        }

        if let Some(formats) = camera.formats() {
            println!("Supported formats: {} format(s)", formats.len());

            let mut format_summary: HashMap<String, Vec<(u32, u32, f32)>> = HashMap::new();
            for format in &formats {
                let key = format!("{}x{}", format.width(), format.height());
                format_summary.entry(key).or_default().push((
                    format.width(),
                    format.height(),
                    format.frame_rate(),
                ));
            }

            for (resolution, frame_rates) in format_summary.iter() {
                let rates: Vec<String> = frame_rates
                    .iter()
                    .map(|(_, _, fps)| format!("{fps:.1}fps"))
                    .collect();
                println!("  {}: {}", resolution, rates.join(", "));
            }
        } else {
            println!("  Could not enumerate formats");
        }
    }

    if cameras.is_empty() {
        println!("\nNo cameras found. This is acceptable for headless/VM environments.");
    }
}

#[test]
fn test_encoder_availability_matrix() {
    test_utils::init_tracing();

    let h264_encoders = [
        ("h264_nvenc", "NVIDIA NVENC"),
        ("h264_qsv", "Intel Quick Sync"),
        ("h264_amf", "AMD AMF"),
        ("h264_mf", "Media Foundation"),
        ("libx264", "x264 Software"),
    ];

    let hevc_encoders = [
        ("hevc_nvenc", "NVIDIA NVENC HEVC"),
        ("hevc_qsv", "Intel Quick Sync HEVC"),
        ("hevc_amf", "AMD AMF HEVC"),
        ("hevc_mf", "Media Foundation HEVC"),
        ("libx265", "x265 Software"),
    ];

    println!("=== H.264 Encoder Availability ===");
    for (name, description) in h264_encoders {
        let available = ffmpeg::encoder::find_by_name(name).is_some();
        let status = if available { "✓" } else { "✗" };
        println!("  {status} {description} ({name})");
    }

    println!("\n=== HEVC/H.265 Encoder Availability ===");
    for (name, description) in hevc_encoders {
        let available = ffmpeg::encoder::find_by_name(name).is_some();
        let status = if available { "✓" } else { "✗" };
        println!("  {status} {description} ({name})");
    }

    let gpu = cap_frame_converter::detect_primary_gpu();
    println!("\n=== Recommended Encoder Priority ===");
    match gpu.map(|g| g.vendor) {
        Some(cap_frame_converter::GpuVendor::Nvidia) => {
            println!("  NVIDIA detected: h264_nvenc -> h264_mf -> h264_qsv -> h264_amf -> libx264");
        }
        Some(cap_frame_converter::GpuVendor::Amd) => {
            println!("  AMD detected: h264_amf -> h264_mf -> h264_nvenc -> h264_qsv -> libx264");
        }
        Some(cap_frame_converter::GpuVendor::Intel) => {
            println!("  Intel detected: h264_qsv -> h264_mf -> h264_nvenc -> h264_amf -> libx264");
        }
        _ => {
            println!("  Default: h264_nvenc -> h264_qsv -> h264_amf -> h264_mf -> libx264");
        }
    }
}

#[test]
fn test_d3d11_converter_capability() {
    test_utils::init_tracing();

    let test_configs = [
        (
            "BGRA -> NV12 (1080p)",
            ffmpeg::format::Pixel::BGRA,
            ffmpeg::format::Pixel::NV12,
            1920,
            1080,
        ),
        (
            "RGBA -> NV12 (1080p)",
            ffmpeg::format::Pixel::RGBA,
            ffmpeg::format::Pixel::NV12,
            1920,
            1080,
        ),
        (
            "BGRA -> NV12 (4K)",
            ffmpeg::format::Pixel::BGRA,
            ffmpeg::format::Pixel::NV12,
            3840,
            2160,
        ),
        (
            "YUYV422 -> NV12 (720p)",
            ffmpeg::format::Pixel::YUYV422,
            ffmpeg::format::Pixel::NV12,
            1280,
            720,
        ),
        (
            "NV12 -> NV12 (passthrough)",
            ffmpeg::format::Pixel::NV12,
            ffmpeg::format::Pixel::NV12,
            1920,
            1080,
        ),
    ];

    println!("=== D3D11 Converter Capability Tests ===");

    for (name, input, output, width, height) in test_configs {
        let config =
            cap_frame_converter::ConversionConfig::new(input, width, height, output, width, height);

        match cap_frame_converter::create_converter_with_details(config) {
            Ok(result) => {
                let hw = if result.converter.is_hardware_accelerated() {
                    "GPU"
                } else {
                    "CPU"
                };
                println!("  ✓ {}: {} ({:?})", name, hw, result.backend);
                if let Some(reason) = result.fallback_reason {
                    println!("    Fallback: {reason}");
                }
            }
            Err(e) => {
                println!("  ✗ {name}: Failed - {e}");
            }
        }
    }
}

#[test]
fn test_supported_pixel_formats() {
    test_utils::init_tracing();

    let formats = [
        (ffmpeg::format::Pixel::NV12, "NV12"),
        (ffmpeg::format::Pixel::YUYV422, "YUYV422"),
        (ffmpeg::format::Pixel::BGRA, "BGRA"),
        (ffmpeg::format::Pixel::RGBA, "RGBA"),
        (ffmpeg::format::Pixel::P010LE, "P010LE (10-bit HDR)"),
        (ffmpeg::format::Pixel::YUV420P, "YUV420P"),
        (ffmpeg::format::Pixel::RGB24, "RGB24"),
    ];

    println!("=== D3D11 Pixel Format Support ===");
    for (format, name) in formats {
        let supported = cap_frame_converter::is_format_supported(format);
        let status = if supported { "✓" } else { "✗" };
        println!("  {status} {name}");
    }
}

#[test]
#[ignore = "Requires NVIDIA GPU - run with --ignored on NVIDIA systems"]
fn test_nvidia_nvenc_encoding() {
    test_utils::init_tracing();

    let gpu = cap_frame_converter::detect_primary_gpu();
    if !matches!(
        gpu.map(|g| g.vendor),
        Some(cap_frame_converter::GpuVendor::Nvidia)
    ) {
        println!("Skipping: No NVIDIA GPU detected");
        return;
    }

    let nvenc = ffmpeg::encoder::find_by_name("h264_nvenc");
    assert!(
        nvenc.is_some(),
        "h264_nvenc should be available on NVIDIA systems"
    );

    let nvenc_hevc = ffmpeg::encoder::find_by_name("hevc_nvenc");
    println!(
        "NVIDIA NVENC: H.264={}, HEVC={}",
        nvenc.is_some(),
        nvenc_hevc.is_some()
    );

    let gpu = gpu.unwrap();
    println!(
        "GPU: {} (VRAM: {} MB)",
        gpu.description,
        gpu.dedicated_video_memory / (1024 * 1024)
    );
}

#[test]
#[ignore = "Requires AMD GPU - run with --ignored on AMD systems"]
fn test_amd_amf_encoding() {
    test_utils::init_tracing();

    let gpu = cap_frame_converter::detect_primary_gpu();
    if !matches!(
        gpu.map(|g| g.vendor),
        Some(cap_frame_converter::GpuVendor::Amd)
    ) {
        println!("Skipping: No AMD GPU detected");
        return;
    }

    let amf = ffmpeg::encoder::find_by_name("h264_amf");
    assert!(amf.is_some(), "h264_amf should be available on AMD systems");

    let amf_hevc = ffmpeg::encoder::find_by_name("hevc_amf");
    println!(
        "AMD AMF: H.264={}, HEVC={}",
        amf.is_some(),
        amf_hevc.is_some()
    );

    let gpu = gpu.unwrap();
    println!(
        "GPU: {} (VRAM: {} MB)",
        gpu.description,
        gpu.dedicated_video_memory / (1024 * 1024)
    );
}

#[test]
#[ignore = "Requires Intel GPU - run with --ignored on Intel systems"]
fn test_intel_qsv_encoding() {
    test_utils::init_tracing();

    let gpu = cap_frame_converter::detect_primary_gpu();
    if !matches!(
        gpu.map(|g| g.vendor),
        Some(cap_frame_converter::GpuVendor::Intel)
    ) {
        println!("Skipping: No Intel GPU detected");
        return;
    }

    let qsv = ffmpeg::encoder::find_by_name("h264_qsv");
    assert!(
        qsv.is_some(),
        "h264_qsv should be available on Intel systems"
    );

    let qsv_hevc = ffmpeg::encoder::find_by_name("hevc_qsv");
    println!(
        "Intel Quick Sync: H.264={}, HEVC={}",
        qsv.is_some(),
        qsv_hevc.is_some()
    );

    let gpu = gpu.unwrap();
    println!(
        "GPU: {} (VRAM: {} MB)",
        gpu.description,
        gpu.dedicated_video_memory / (1024 * 1024)
    );
}

#[test]
#[ignore = "Requires actual camera - run with --ignored when camera is connected"]
fn test_camera_capture_basic() {
    test_utils::init_tracing();

    let cameras: Vec<cap_camera::CameraInfo> = cap_camera::list_cameras().collect();
    if cameras.is_empty() {
        println!("No cameras available for capture test");
        return;
    }

    let camera = &cameras[0];
    println!("Testing camera: {}", camera.display_name());

    let formats = camera.formats();
    if formats.is_none() {
        println!("Could not get camera formats");
        return;
    }

    let formats = formats.unwrap();
    if formats.is_empty() {
        println!("Camera has no supported formats");
        return;
    }

    let format = formats
        .iter()
        .find(|f| f.width() == 1280 && f.height() == 720)
        .or_else(|| formats.first())
        .cloned()
        .unwrap();

    println!(
        "Using format: {}x{} @ {}fps",
        format.width(),
        format.height(),
        format.frame_rate()
    );

    let frame_count = std::sync::Arc::new(std::sync::atomic::AtomicU32::new(0));
    let frame_count_clone = frame_count.clone();

    let handle = camera.start_capturing(format, move |_frame| {
        frame_count_clone.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    });

    match handle {
        Ok(handle) => {
            std::thread::sleep(Duration::from_secs(2));

            let frames = frame_count.load(std::sync::atomic::Ordering::Relaxed);
            println!("Captured {frames} frames in 2 seconds");

            let _ = handle.stop_capturing();

            assert!(frames > 0, "Should have captured at least one frame");
        }
        Err(e) => {
            println!("Failed to start capture: {e:?}");
        }
    }
}

#[test]
#[ignore = "Requires virtual camera (OBS Virtual Camera) - run with --ignored when available"]
fn test_virtual_camera_detection() {
    test_utils::init_tracing();

    let cameras: Vec<cap_camera::CameraInfo> = cap_camera::list_cameras().collect();

    let virtual_camera_keywords = ["obs", "virtual", "snap", "manycam", "xsplit", "droidcam"];

    println!("=== Virtual Camera Detection ===");
    for camera in &cameras {
        let name_lower = camera.display_name().to_lowercase();
        let is_virtual = virtual_camera_keywords
            .iter()
            .any(|keyword| name_lower.contains(keyword));

        if is_virtual {
            println!("  [VIRTUAL] {}", camera.display_name());
        } else {
            println!("  [PHYSICAL] {}", camera.display_name());
        }
    }

    let virtual_count = cameras
        .iter()
        .filter(|c| {
            let name = c.display_name().to_lowercase();
            virtual_camera_keywords
                .iter()
                .any(|keyword| name.contains(keyword))
        })
        .count();

    println!(
        "\nFound {} virtual camera(s), {} physical camera(s)",
        virtual_count,
        cameras.len() - virtual_count
    );
}

#[test]
#[ignore = "Requires capture card (Elgato, etc.) - run with --ignored when available"]
fn test_capture_card_detection() {
    test_utils::init_tracing();

    let cameras: Vec<cap_camera::CameraInfo> = cap_camera::list_cameras().collect();

    let capture_card_keywords = [
        "elgato",
        "avermedia",
        "magewell",
        "blackmagic",
        "decklink",
        "cam link",
        "hd60",
        "4k60",
    ];

    println!("=== Capture Card Detection ===");
    for camera in &cameras {
        let name_lower = camera.display_name().to_lowercase();
        let is_capture_card = capture_card_keywords
            .iter()
            .any(|keyword| name_lower.contains(keyword));

        if is_capture_card {
            println!("  [CAPTURE CARD] {}", camera.display_name());

            if let Some(formats) = camera.formats() {
                let max_res = formats.iter().max_by_key(|f| f.width() * f.height());
                if let Some(max) = max_res {
                    println!(
                        "    Max resolution: {}x{} @ {}fps",
                        max.width(),
                        max.height(),
                        max.frame_rate()
                    );
                }
            }
        }
    }
}

#[test]
fn test_hardware_compatibility_summary() {
    test_utils::init_tracing();

    println!("\n╔════════════════════════════════════════════════════════════════╗");
    println!("║            HARDWARE COMPATIBILITY SUMMARY                       ║");
    println!("╠════════════════════════════════════════════════════════════════╣");

    let version = scap_direct3d::WindowsVersion::detect();
    let gpu = cap_frame_converter::detect_primary_gpu();
    let diagnostics = cap_recording::diagnostics::collect_diagnostics();

    let windows_status = if diagnostics.graphics_capture_supported {
        if let Some(v) = &version {
            format!("✓ {} (Graphics Capture OK)", v.display_name())
        } else {
            "✓ Graphics Capture supported".to_string()
        }
    } else if let Some(v) = &version {
        format!("✗ {} - Graphics Capture unavailable", v.display_name())
    } else {
        "? Unknown".to_string()
    };
    println!("║ Windows: {windows_status:<52} ║");

    let gpu_status = if let Some(g) = gpu {
        format!(
            "✓ {} ({} MB)",
            truncate_string(&g.description, 35),
            g.dedicated_video_memory / (1024 * 1024)
        )
    } else {
        "⚠ No GPU (WARP software rendering)".to_string()
    };
    println!("║ GPU: {gpu_status:<56} ║");

    let capture_status = if diagnostics.graphics_capture_supported {
        "✓ Available"
    } else {
        "✗ Unavailable"
    };
    println!("║ Screen Capture: {capture_status:<45} ║");

    let d3d11_status = if diagnostics.d3d11_video_processor_available {
        "✓ GPU accelerated"
    } else {
        "⚠ CPU fallback (swscale)"
    };
    println!("║ Frame Conversion: {d3d11_status:<43} ║");

    let hw_encoders: Vec<&str> = diagnostics
        .available_encoders
        .iter()
        .filter(|e| !e.starts_with("lib"))
        .map(|s| s.as_str())
        .collect();
    let encoder_status = if !hw_encoders.is_empty() {
        format!("✓ {} hardware encoder(s)", hw_encoders.len())
    } else {
        "⚠ Software only (libx264)".to_string()
    };
    println!("║ Encoding: {encoder_status:<51} ║");

    let cameras: Vec<cap_camera::CameraInfo> = cap_camera::list_cameras().collect();
    let camera_status = format!("{} camera(s) detected", cameras.len());
    println!("║ Cameras: {camera_status:<52} ║");

    println!("╠════════════════════════════════════════════════════════════════╣");

    let all_good = diagnostics.graphics_capture_supported
        && diagnostics
            .available_encoders
            .contains(&"libx264".to_string());

    if all_good {
        println!("║ Status: ✓ SYSTEM COMPATIBLE                                    ║");
    } else {
        println!("║ Status: ⚠ COMPATIBILITY ISSUES DETECTED                        ║");
    }
    println!("╚════════════════════════════════════════════════════════════════╝\n");
}

fn truncate_string(s: &str, max_len: usize) -> String {
    if s.chars().count() <= max_len {
        s.to_string()
    } else {
        let truncate_at = max_len.saturating_sub(3);
        let truncated: String = s.chars().take(truncate_at).collect();
        format!("{truncated}...")
    }
}

#[test]
#[ignore = "Intensive test - run with --ignored for full validation"]
fn test_frame_conversion_performance() {
    test_utils::init_tracing();

    let config = cap_frame_converter::ConversionConfig::new(
        ffmpeg::format::Pixel::BGRA,
        1920,
        1080,
        ffmpeg::format::Pixel::NV12,
        1920,
        1080,
    );

    let result = cap_frame_converter::create_converter_with_details(config.clone());
    if result.is_err() {
        println!("Could not create converter: {:?}", result.err());
        return;
    }

    let selection = result.unwrap();
    println!(
        "Testing converter: {:?} (hardware: {})",
        selection.backend,
        selection.converter.is_hardware_accelerated()
    );

    let test_frame = ffmpeg::frame::Video::new(ffmpeg::format::Pixel::BGRA, 1920, 1080);

    let warmup_iterations = 10;
    let test_iterations = 100;

    for _ in 0..warmup_iterations {
        let frame = test_frame.clone();
        let _ = selection.converter.convert(frame);
    }

    let start = std::time::Instant::now();
    for _ in 0..test_iterations {
        let frame = test_frame.clone();
        let _ = selection.converter.convert(frame);
    }
    let elapsed = start.elapsed();

    let avg_ms = elapsed.as_secs_f64() * 1000.0 / test_iterations as f64;
    let fps_capacity = 1000.0 / avg_ms;

    println!("Performance: {avg_ms:.2}ms/frame avg ({fps_capacity:.1} fps capacity)");

    let target_fps = 60.0;
    let target_ms = 1000.0 / target_fps;
    if avg_ms < target_ms {
        println!("✓ Can sustain {}fps recording", target_fps as u32);
    } else {
        println!(
            "⚠ May struggle with {}fps (need {:.2}ms, got {:.2}ms)",
            target_fps as u32, target_ms, avg_ms
        );
    }
}

#[test]
fn test_multi_gpu_detection() {
    test_utils::init_tracing();

    println!("=== Multi-GPU Detection ===");
    println!("Primary GPU detection uses DXGI EnumAdapters(0)");

    if let Some(gpu) = cap_frame_converter::detect_primary_gpu() {
        println!("Primary adapter: {}", gpu.description);
        println!("Vendor: {} (0x{:04X})", gpu.vendor_name(), gpu.vendor_id);

        if gpu.dedicated_video_memory < 512 * 1024 * 1024 {
            println!("⚠ Low VRAM (<512MB) - software encoding recommended");
        } else if gpu.dedicated_video_memory < 2 * 1024 * 1024 * 1024 {
            println!("✓ Adequate VRAM for 1080p recording");
        } else {
            println!("✓ Ample VRAM for 4K recording");
        }
    } else {
        println!("No dedicated GPU found - using integrated or software rendering");
    }
}

#[test]
fn test_minimum_requirements_check() {
    test_utils::init_tracing();

    let mut requirements_met = true;
    let mut warnings = Vec::new();

    println!("=== Minimum Requirements Check ===\n");

    println!("Required:");

    let graphics_capture_supported = scap_direct3d::is_supported().unwrap_or(false);
    if graphics_capture_supported {
        println!("  ✓ Windows Graphics Capture API");
    } else {
        println!("  ✗ Windows Graphics Capture API unavailable");
        requirements_met = false;
    }

    let version = scap_direct3d::WindowsVersion::detect();
    if let Some(v) = &version {
        if v.meets_minimum_requirements() {
            println!(
                "  ✓ Windows 10 version 1903 or later (reported: {})",
                v.display_name()
            );
        } else if graphics_capture_supported {
            println!(
                "  ⚠ Windows version reported as {} (may be inaccurate due to compat shims)",
                v.display_name()
            );
            println!("    Graphics Capture works, so actual version is sufficient.");
        } else {
            println!(
                "  ✗ Windows version {} is below minimum (need 10.0.18362+)",
                v.display_name()
            );
            requirements_met = false;
        }
    } else {
        println!("  ? Could not detect Windows version");
        if !graphics_capture_supported {
            requirements_met = false;
        }
    }

    if ffmpeg::encoder::find_by_name("libx264").is_some() {
        println!("  ✓ FFmpeg with libx264 encoder");
    } else {
        println!("  ✗ libx264 encoder not available");
        requirements_met = false;
    }

    println!("\nRecommended:");
    if cap_frame_converter::detect_primary_gpu().is_some() {
        println!("  ✓ Dedicated or integrated GPU");
    } else {
        println!("  ⚠ No GPU detected (will use software rendering)");
        warnings.push("Performance may be reduced without GPU acceleration");
    }

    let diagnostics = cap_recording::diagnostics::collect_diagnostics();
    let hw_encoders: Vec<&str> = diagnostics
        .available_encoders
        .iter()
        .filter(|e| !e.starts_with("lib"))
        .map(|s| s.as_str())
        .collect();

    if !hw_encoders.is_empty() {
        println!("  ✓ Hardware video encoder ({hw_encoders:?})");
    } else {
        println!("  ⚠ No hardware encoders (will use CPU encoding)");
        warnings.push("CPU encoding may impact system performance");
    }

    if diagnostics.d3d11_video_processor_available {
        println!("  ✓ D3D11 video processor for frame conversion");
    } else {
        println!("  ⚠ D3D11 video processor unavailable (will use CPU conversion)");
        warnings.push("CPU frame conversion may impact performance");
    }

    println!("\n=== Result ===");
    if requirements_met && warnings.is_empty() {
        println!("✓ All requirements met - system fully compatible");
    } else if requirements_met {
        println!("⚠ Requirements met with warnings:");
        for warning in &warnings {
            println!("  - {warning}");
        }
    } else {
        println!("✗ Missing required components - Cap may not function correctly");
    }

    assert!(requirements_met, "Minimum requirements not met");
}
