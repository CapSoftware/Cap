# cap-camera-windows

Unified Windows camera capture API that provides a seamless interface across both
Media Foundation and DirectShow backends.
Will use Media Foundation where possible, but will also list DirectShow devices if said
devices aren't available via Media Foundation.

## Purpose

Provides a single, ergonomic API for Windows camera capture that intelligently chooses
between Media Foundation (modern) and DirectShow (legacy) based on device capabilities
and format availability. Designed to handle the complexity of Windows camera ecosystem
where devices may support different APIs with varying feature sets.

## Key Features

- **Unified Device Enumeration**: Single `get_devices()` call returns all available cameras
- **Intelligent Backend Selection**: Prefers Media Foundation, falls back to DirectShow when needed
- **Format Deduplication**: Automatically merges formats from both APIs for each device
- **Virtual Camera Support**: Full compatibility with OBS Virtual Camera and similar tools
- **Seamless Capture**: Consistent callback interface regardless of underlying API
- **Memory Safety**: RAII resource management across both backends

## Core APIs

### Device Management

- `get_devices()` - Enumerate all cameras from both Media Foundation and DirectShow
- `VideoDeviceInfo::name()`, `VideoDeviceInfo::id()`, `VideoDeviceInfo::model_id()` - Device metadata
- `VideoDeviceInfo::is_mf()` - Check if device uses Media Foundation backend
- `VideoDeviceInfo::formats()` - Iterator over unified `VideoFormat` objects

### Capture Pipeline

- `VideoDeviceInfo::start_capturing(format, callback)` - Begin capture with unified callback interface
- `CaptureHandle::stop_capturing()` - Stop capture session and cleanup resources
- `Frame::bytes()` - Access frame data with automatic buffer management

### Format Processing

- `VideoFormat::width()`, `VideoFormat::height()`, `VideoFormat::frame_rate()` - Format properties
- `VideoFormat::pixel_format()` - Unified pixel format enum
- `PixelFormat` - Normalized format representation across ARGB, RGB, YUV420P, NV12, YUYV422, UYVY422

## Architecture

Bridges the gap between Media Foundation's async capture engine and DirectShow's filter graph architecture through a unified device enumeration and capture interface. Implements intelligent backend selection by comparing device names and model IDs to deduplicate devices exposed by both APIs, preferring Media Foundation for performance while ensuring DirectShow compatibility for virtual cameras and legacy hardware.
