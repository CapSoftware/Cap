# cap-rendering-skia

A new rendering backend for Cap using Skia, designed to replace the current wgpu-based renderer.

## Status

This crate implements the basic infrastructure for Skia-based rendering with GPU acceleration support:

- ✅ Basic Skia context creation
- ✅ GPU acceleration via Metal (macOS)
- ✅ CPU fallback for other platforms
- ✅ Surface creation and management
- ✅ Basic rendering operations
- ✅ Pixel readback for frame export

## Building and Testing

```bash
# Build the crate
cargo build -p cap-rendering-skia

# Run the test binary
cargo run -p cap-rendering-skia --bin test-skia

# Run tests
cargo test -p cap-rendering-skia
```

The test binary will:
- Create a Skia context (GPU-accelerated on macOS via Metal)
- Test surface creation with various sizes
- Render a gradient with a green circle
- Save the output as `test_render.ppm`

## Architecture

### GPU Support

- **macOS**: Uses Metal backend for GPU acceleration
- **Other platforms**: Falls back to CPU raster backend
- **Future**: Can add Vulkan/OpenGL support for Linux/Windows

### Core Components

- `SkiaRenderContext`: Main context managing GPU/CPU backends
- Surface management with automatic format selection
- Simple API for creating and reading from surfaces

## Migration Plan Progress

### Phase 1: Setup and Infrastructure ✅
- [x] Create new crate with Skia dependencies
- [x] Basic GPU context initialization
- [x] Surface creation and management
- [x] Test binary to verify functionality

### Phase 2: Core Components (In Progress)
- [ ] Frame pipeline implementation
- [ ] Canvas-based layer system
- [ ] Uniform/parameter structures

### Phase 3: Layer Migration (Not Started)
- [ ] Background layer (gradients, solid colors, images)
- [ ] Display layer (video frames with effects)
- [ ] Cursor layer
- [ ] Camera layer
- [ ] Blur effects
- [ ] Caption/text rendering

### Phase 4: Integration (Not Started)
- [ ] Update render_video_to_channel
- [ ] Migrate frame decoding
- [ ] Update export pipeline

### Phase 5: Optimization and Cleanup (Not Started)
- [ ] Performance profiling
- [ ] Remove wgpu dependencies
- [ ] Clean up old shader files

## Next Steps

1. Implement the frame pipeline for managing render passes
2. Create the layer system with Canvas-based rendering
3. Start migrating individual rendering layers from wgpu shaders to Skia operations
4. Integrate with the existing video processing pipeline

## Benefits Over wgpu

- Simpler API - no manual shader management
- Built-in effects and filters
- Better cross-platform consistency
- Rich text rendering capabilities
- Extensive image format support
- Battle-tested 2D graphics performance