# GPU Video Format Converters

A high-performance GPU-accelerated video format conversion library built with WGPU. This crate provides efficient conversion between common camera formats and RGBA, with built-in scaling capabilities.

## Features

✨ **GPU-Accelerated Conversion**: Uses compute shaders for fast format conversion  
🎯 **Multiple Format Support**: NV12, UYVY, YUYV, YUV420P, BGRA, RGB24 → RGBA  
🔧 **Hardware Scaling**: GPU-based scaling with quality presets (Nearest, Bilinear, Bicubic)  
📊 **Performance Monitoring**: Built-in performance tracking and benchmarking  
🧠 **Memory Management**: Texture pooling for efficient GPU memory usage  
🛡️ **Fallback Support**: CPU-based fallback when GPU conversion fails  
⚙️ **Quality Presets**: Performance, Balanced, and Quality presets for different use cases  

## Quick Start

```rust
use cap_gpu_converters::{
    GPUCameraConverter, CameraInput, CameraFormat, ConversionPreset
};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Create a GPU converter with balanced preset
    let mut converter = GPUCameraConverter::with_preset(ConversionPreset::Balanced).await?;
    
    // Enable CPU fallback for reliability
    converter.enable_fallback(FallbackStrategy::CpuConversion);
    
    // Example: Convert NV12 camera data to RGBA and scale
    let nv12_data = get_camera_frame(); // Your camera data
    let input = CameraInput::new(&nv12_data, CameraFormat::NV12, 1920, 1080);
    
    // Convert and scale to 1280x720
    let rgba_data = converter.convert_and_scale(
        &input, 
        1280, 720, 
        ScalingQuality::Good
    ).await?;
    
    println!("Converted to RGBA: {} bytes", rgba_data.len());
    Ok(())
}
```

## Supported Formats

### Input Formats
- **NV12**: Semi-planar YUV 4:2:0 (Y plane + interleaved UV)
- **UYVY**: Packed YUV 4:2:2 (U-Y-V-Y ordering)
- **YUYV**: Packed YUV 4:2:2 (Y-U-Y-V ordering)
- **YUV420P**: Planar YUV 4:2:0 (separate Y, U, V planes)
- **BGRA**: 32-bit BGRA with alpha
- **RGB24**: 24-bit RGB
- **RGBA**: 32-bit RGBA (passthrough)

### Output Format
- **RGBA**: 32-bit RGBA with alpha (8 bits per channel)

## Performance Features

### Quality Presets

```rust
// Performance-focused: fastest conversion, minimal memory usage
let converter = GPUCameraConverter::with_preset(ConversionPreset::Performance).await?;

// Balanced: good speed/quality tradeoff with fallback support
let converter = GPUCameraConverter::with_preset(ConversionPreset::Balanced).await?;

// Quality-focused: best scaling quality, full feature set
let converter = GPUCameraConverter::with_preset(ConversionPreset::Quality).await?;
```

### Performance Monitoring

```rust
let mut converter = GPUCameraConverter::with_preset(ConversionPreset::Balanced).await?;

// Performance tracking is enabled by default for Balanced/Quality presets
for _ in 0..100 {
    converter.convert_and_scale(&input, 1280, 720, ScalingQuality::Good).await?;
}

// Get performance statistics
if let Some(summary) = converter.get_performance_summary() {
    println!("Average duration: {:.2}ms", summary.avg_duration.as_secs_f64() * 1000.0);
    println!("Throughput: {:.2} MB/s", summary.avg_throughput_mbps);
    println!("GPU efficiency: {:.1}%", summary.avg_gpu_efficiency * 100.0);
}
```

### Memory Management

```rust
// Check texture pool statistics
let stats = converter.get_texture_pool_stats();
println!("Texture pool: {} available, {} in use", 
         stats.total_available, stats.total_in_use);

// Clear texture pool to free GPU memory
converter.clear_texture_pool();

// Check overall memory usage
if let Some(usage) = converter.get_memory_usage() {
    println!("GPU memory usage: {}", usage);
}
```

## Error Handling and Fallback

The library includes robust error handling with automatic fallback capabilities:

```rust
use cap_gpu_converters::{FallbackStrategy, ErrorRecovery};

let mut converter = GPUCameraConverter::new().await?;

// Enable CPU fallback for when GPU fails
converter.enable_fallback(FallbackStrategy::CpuConversion);

// The converter will automatically:
// 1. Try GPU conversion first
// 2. Analyze any errors that occur
// 3. Apply appropriate recovery strategies
// 4. Fall back to CPU conversion when needed

let result = converter.convert_and_scale(&input, 1280, 720, ScalingQuality::Good).await;

match result {
    Ok(data) => println!("Conversion successful: {} bytes", data.len()),
    Err(e) => {
        // Analyze what went wrong
        let recovery = ErrorRecovery::analyze_error(&e);
        println!("Conversion failed: {} (suggested: {:?})", e, recovery);
    }
}
```

## Advanced Usage

### Custom Conversion Settings

```rust
use cap_gpu_converters::{ConversionPreset, ScalingQuality};

// Custom preset with specific settings
let preset = ConversionPreset::Custom {
    scaling_quality: ScalingQuality::Best,
    enable_texture_pooling: true,
    enable_performance_tracking: false,
};

let converter = GPUCameraConverter::with_preset(preset).await?;
```

### Direct Texture Access

```rust
// Convert directly to GPU texture (no CPU readback)
let texture = converter.convert_to_rgba_texture(&input).await?;

// Use texture for further GPU operations...
```

### Batch Processing

```rust
// Process multiple frames efficiently
let frames = vec![frame1, frame2, frame3]; // Your camera frames

for frame in frames {
    let input = CameraInput::new(&frame.data, frame.format, frame.width, frame.height);
    let rgba_data = converter.convert_and_scale(&input, 1280, 720, ScalingQuality::Good).await?;
    
    // Process converted frame...
}

// Get batch performance statistics
let summary = converter.get_performance_summary().unwrap();
println!("Processed {} frames at {:.1} fps", 
         summary.total_operations,
         summary.total_operations as f64 / summary.avg_duration.as_secs_f64());
```

## Benchmarking

Run the included benchmark to test performance on your hardware:

```bash
# Run basic benchmark
cargo run --example benchmark

# Test all presets
cargo run --example benchmark presets

# Test all formats
cargo run --example benchmark formats

# Test different resolutions
cargo run --example benchmark resolutions

# Run complete benchmark suite
cargo run --example benchmark all
```

Example benchmark output:
```
=== Benchmark Results ===
Configuration:
  Input: 1920x1080 NV12
  Output: 1280x720 RGBA
  Preset: Balanced
  Iterations: 100

Performance:
  Average: 2.34ms
  Min: 1.89ms
  Max: 4.12ms
  Throughput: 845.2 MB/s
  Pixels/sec: 54,700,000
  Success rate: 100.0%
```

## Requirements

- **GPU**: Any GPU supported by WGPU (DirectX 12, Vulkan, Metal, or WebGPU)
- **Rust**: Edition 2021 or later
- **WGPU**: Version 25.0+

## Error Types

```rust
pub enum ConversionError {
    UnsupportedFormat(CameraFormat),
    InvalidDimensions { width: u32, height: u32 },
    InsufficientData { expected: usize, actual: usize },
    GPUError(String),
}
```

## Platform Support

| Platform | Status | Backend |
|----------|--------|---------|
| Windows  | ✅ Full | DirectX 12, Vulkan |
| macOS    | ✅ Full | Metal |
| Linux    | ✅ Full | Vulkan |
| iOS      | 🔄 Planned | Metal |
| Android  | 🔄 Planned | Vulkan |
| Web      | 🔄 Planned | WebGPU |

## Integration Examples

### With Camera Capture

```rust
use cap_camera::{CameraInfo, list_cameras};
use cap_gpu_converters::{GPUCameraConverter, ConversionPreset};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Initialize GPU converter
    let mut converter = GPUCameraConverter::with_preset(ConversionPreset::Balanced).await?;
    
    // Get camera and start capture
    let cameras: Vec<CameraInfo> = list_cameras().collect();
    let camera = &cameras[0];
    
    camera.start_capturing(format, move |frame| {
        // Convert camera frame to RGBA
        let input = CameraInput::new(
            frame.data(), 
            frame.format(), 
            frame.width(), 
            frame.height()
        );
        
        tokio::spawn(async move {
            if let Ok(rgba_data) = converter.convert_and_scale(
                &input, 1920, 1080, ScalingQuality::Good
            ).await {
                // Use converted RGBA data for preview, recording, etc.
                process_rgba_frame(rgba_data);
            }
        });
    })?;
    
    Ok(())
}
```

### Performance Comparison

Typical performance improvements over CPU conversion:

| Format | Resolution | CPU (ms) | GPU (ms) | Speedup |
|--------|------------|----------|----------|---------|
| NV12   | 1920x1080  | 12.5     | 2.1      | 6.0x    |
| UYVY   | 1920x1080  | 8.3      | 1.8      | 4.6x    |
| YUV420P| 3840x2160  | 45.2     | 7.8      | 5.8x    |

*Results may vary based on hardware and system configuration.*

## Contributing

Contributions are welcome! Areas where help is needed:

- [ ] Additional format support (P010, NV16, etc.)
- [ ] Optimize memory usage patterns
- [ ] Mobile platform support
- [ ] WebGPU backend testing
- [ ] Performance optimization for specific GPU architectures

## License

This project is licensed under the same terms as the Cap project.

## Changelog

### v0.1.0 (Current)
- Initial implementation with core format support
- GPU-based scaling with quality presets
- Performance monitoring and texture pooling
- CPU fallback support
- Comprehensive benchmarking tools