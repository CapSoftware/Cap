use cap_gpu_converters::{
    CameraFormat, CameraInput, ConversionPreset, FallbackStrategy, GPUCameraConverter,
    ScalingQuality,
};

/// Generate simple test data for NV12 format
fn generate_nv12_test_data(width: u32, height: u32) -> Vec<u8> {
    let y_size = (width * height) as usize;
    let uv_size = y_size / 2;
    let mut data = vec![0u8; y_size + uv_size];

    // Fill Y plane with gradient
    for y in 0..height {
        for x in 0..width {
            let idx = (y * width + x) as usize;
            data[idx] = ((x + y) % 256) as u8;
        }
    }

    // Fill UV plane with neutral values
    for i in y_size..(y_size + uv_size) {
        data[i] = 128;
    }

    data
}

/// Generate simple test data for RGBA format
fn generate_rgba_test_data(width: u32, height: u32) -> Vec<u8> {
    let mut data = vec![0u8; (width * height * 4) as usize];

    for y in 0..height {
        for x in 0..width {
            let idx = ((y * width + x) * 4) as usize;
            data[idx] = (x % 256) as u8; // R
            data[idx + 1] = (y % 256) as u8; // G
            data[idx + 2] = 128; // B
            data[idx + 3] = 255; // A
        }
    }

    data
}

#[tokio::test]
#[ignore] // Only run when GPU is available
async fn test_basic_gpu_conversion() {
    // Test basic GPU converter initialization
    let converter = GPUCameraConverter::new().await;
    assert!(converter.is_ok(), "Failed to initialize GPU converter");

    let mut converter = converter.unwrap();

    // Test NV12 to RGBA conversion
    let test_data = generate_nv12_test_data(320, 240);
    let input = CameraInput::new(&test_data, CameraFormat::NV12, 320, 240);

    let result = converter
        .convert_and_scale(&input, 320, 240, ScalingQuality::Fast)
        .await;

    assert!(result.is_ok(), "NV12 conversion failed");
    let rgba_data = result.unwrap();
    assert_eq!(rgba_data.len(), 320 * 240 * 4, "Output size mismatch");
}

#[tokio::test]
#[ignore] // Only run when GPU is available
async fn test_scaling() {
    let mut converter = GPUCameraConverter::new().await.unwrap();

    // Test scaling down
    let test_data = generate_rgba_test_data(640, 480);
    let input = CameraInput::new(&test_data, CameraFormat::RGBA, 640, 480);

    let result = converter
        .convert_and_scale(&input, 320, 240, ScalingQuality::Good)
        .await;

    assert!(result.is_ok(), "Scaling failed");
    let scaled_data = result.unwrap();
    assert_eq!(
        scaled_data.len(),
        320 * 240 * 4,
        "Scaled output size mismatch"
    );
}

#[tokio::test]
#[ignore] // Only run when GPU is available
async fn test_presets() {
    let presets = vec![
        ConversionPreset::Performance,
        ConversionPreset::Balanced,
        ConversionPreset::Quality,
    ];

    for preset in presets {
        let converter = GPUCameraConverter::with_preset(preset).await;
        assert!(
            converter.is_ok(),
            "Failed to create converter with preset {:?}",
            preset
        );

        let mut converter = converter.unwrap();
        let test_data = generate_nv12_test_data(160, 120);
        let input = CameraInput::new(&test_data, CameraFormat::NV12, 160, 120);

        let result = converter
            .convert_with_preset(&input, 160, 120, preset)
            .await;

        assert!(result.is_ok(), "Conversion failed with preset {:?}", preset);
    }
}

#[tokio::test]
#[ignore] // Only run when GPU is available
async fn test_performance_tracking() {
    let mut converter = GPUCameraConverter::with_preset(ConversionPreset::Balanced)
        .await
        .unwrap();

    // Performance tracking should be enabled by default for Balanced preset
    let test_data = generate_nv12_test_data(320, 240);
    let input = CameraInput::new(&test_data, CameraFormat::NV12, 320, 240);

    // Perform a few conversions
    for _ in 0..3 {
        let _ = converter
            .convert_and_scale(&input, 320, 240, ScalingQuality::Good)
            .await;
    }

    let summary = converter.get_performance_summary();
    assert!(summary.is_some(), "Performance tracking not working");

    let summary = summary.unwrap();
    assert_eq!(summary.total_operations, 3, "Wrong operation count");
    assert!(summary.avg_throughput_mbps > 0.0, "Invalid throughput");
}

#[tokio::test]
async fn test_fallback_conversion() {
    use cap_gpu_converters::FallbackConverter;

    let fallback_converter = FallbackConverter::new(FallbackStrategy::CpuConversion);

    // Test RGBA passthrough (no conversion needed)
    let test_data = generate_rgba_test_data(100, 100);
    let input = CameraInput::new(&test_data, CameraFormat::RGBA, 100, 100);

    let result = fallback_converter.convert_with_fallback(&input, 100, 100);
    assert!(result.is_ok(), "RGBA fallback failed");

    // Test NV12 fallback conversion
    let nv12_data = generate_nv12_test_data(160, 120);
    let nv12_input = CameraInput::new(&nv12_data, CameraFormat::NV12, 160, 120);

    let result = fallback_converter.convert_with_fallback(&nv12_input, 160, 120);
    assert!(result.is_ok(), "NV12 fallback conversion failed");

    let rgba_result = result.unwrap();
    assert_eq!(
        rgba_result.len(),
        160 * 120 * 4,
        "Fallback output size mismatch"
    );
}

#[tokio::test]
#[ignore] // Only run when GPU is available
async fn test_texture_pool() {
    let mut converter = GPUCameraConverter::new().await.unwrap();

    let initial_stats = converter.get_texture_pool_stats();
    assert_eq!(initial_stats.total_available, 0);

    // Perform several conversions to populate the texture pool
    let test_data = generate_nv12_test_data(320, 240);
    let input = CameraInput::new(&test_data, CameraFormat::NV12, 320, 240);

    for _ in 0..5 {
        let _ = converter
            .convert_and_scale(&input, 320, 240, ScalingQuality::Fast)
            .await;
    }

    // Check if texture pool is being used (implementation detail may vary)
    let _final_stats = converter.get_texture_pool_stats();
    // Note: exact behavior depends on implementation details

    // Test clearing the pool
    converter.clear_texture_pool();
    let cleared_stats = converter.get_texture_pool_stats();
    assert_eq!(
        cleared_stats.total_available, 0,
        "Pool not cleared properly"
    );
}

#[tokio::test]
async fn test_error_handling() {
    use cap_gpu_converters::{ConversionError, ErrorRecovery, RecoveryAction};

    // Test error analysis
    let gpu_error = ConversionError::GPUError("device lost".to_string());
    let action = ErrorRecovery::analyze_error(&gpu_error);
    assert_eq!(action, RecoveryAction::RecreateDevice);

    let memory_error = ConversionError::GPUError("out of memory".to_string());
    let action = ErrorRecovery::analyze_error(&memory_error);
    assert_eq!(action, RecoveryAction::ReduceMemoryUsage);

    let format_error = ConversionError::UnsupportedFormat(CameraFormat::Unknown);
    let action = ErrorRecovery::analyze_error(&format_error);
    assert_eq!(action, RecoveryAction::UseFallback);

    // Test invalid input handling
    let empty_data = vec![];
    let invalid_input = CameraInput::new(&empty_data, CameraFormat::NV12, 320, 240);

    if let Ok(mut converter) = GPUCameraConverter::new().await {
        let result = converter
            .convert_and_scale(&invalid_input, 320, 240, ScalingQuality::Fast)
            .await;
        assert!(result.is_err(), "Should fail with insufficient data");

        match result.unwrap_err() {
            ConversionError::InsufficientData { .. } => {} // Expected
            other => panic!("Unexpected error type: {:?}", other),
        }
    }
}

#[tokio::test]
async fn test_format_detection() {
    // Test bytes per pixel calculation
    assert_eq!(CameraFormat::NV12.bytes_per_pixel(), 1.5);
    assert_eq!(CameraFormat::UYVY.bytes_per_pixel(), 2.0);
    assert_eq!(CameraFormat::YUYV.bytes_per_pixel(), 2.0);
    assert_eq!(CameraFormat::YUV420P.bytes_per_pixel(), 1.5);
    assert_eq!(CameraFormat::BGRA.bytes_per_pixel(), 4.0);
    assert_eq!(CameraFormat::RGB24.bytes_per_pixel(), 3.0);
    assert_eq!(CameraFormat::RGBA.bytes_per_pixel(), 4.0);

    // Test conversion requirements
    assert!(CameraFormat::NV12.needs_conversion());
    assert!(CameraFormat::UYVY.needs_conversion());
    assert!(CameraFormat::BGRA.needs_conversion());
    assert!(!CameraFormat::RGBA.needs_conversion());
}

#[tokio::test]
#[ignore] // Only run when GPU is available
async fn test_memory_usage_tracking() {
    let converter = GPUCameraConverter::new().await;
    if converter.is_ok() {
        let converter = converter.unwrap();
        let memory_usage = converter.get_memory_usage();
        assert!(
            memory_usage.is_some(),
            "Memory usage tracking not available"
        );

        let usage = memory_usage.unwrap();
        // Just verify the fields exist and have reasonable values
        let _ = usage.estimated_pool_memory_bytes;
        let _ = usage.textures_in_pool;
        let _ = usage.textures_in_use;
    }
}

#[test]
fn test_camera_input_helpers() {
    let test_data = vec![0u8; 1920 * 1080 * 4];
    let input = CameraInput::new(&test_data, CameraFormat::RGBA, 1920, 1080);

    assert_eq!(input.width, 1920);
    assert_eq!(input.height, 1080);
    assert_eq!(input.format, CameraFormat::RGBA);
    assert_eq!(input.data.len(), 1920 * 1080 * 4);

    // Test with stride
    let input_with_stride = input.with_stride(1920 * 4 + 64); // Padding
    assert_eq!(input_with_stride.stride, Some(1920 * 4 + 64));
    assert_eq!(input_with_stride.effective_stride(), 1920 * 4 + 64);

    // Test without stride (create new input since previous was moved)
    let input2 = CameraInput::new(&test_data, CameraFormat::RGBA, 1920, 1080);
    assert_eq!(input2.effective_stride(), 1920 * 4);
}
