# cap-camera

Cross-platform camera capture API that provides a unified interface across
macOS (AVFoundation) and Windows (Media Foundation/DirectShow) backends.
Offers simple yet low-level access to camera devices with consistent device
enumeration, format negotiation, and callback-based frame capture.

## Purpose

Provides a single, ergonomic API for camera capture that abstracts platform
differences while maintaining access to native capabilities. Designed to handle
the complexity of different camera ecosystems on macOS and Windows through
platform-specific backends while exposing a consistent Rust interface.

## Key Features

- **Unified Device Enumeration**: Single `list_cameras()` call returns all available cameras across platforms
- **Cross-Platform Format Support**: Consistent `Format` abstraction over native format representations
- **Callback-Based Capture**: Platform-agnostic frame delivery via closures
- **Zero-Copy Frame Access**: Direct access to camera frame buffers without additional memory allocation
- **Native Backend Access**: Direct access to underlying AVFoundation/Media Foundation objects when needed
- **Memory Safety**: RAII resource management with automatic cleanup on drop
- **Chromium-Compatible Device Identification**: Consistent device tracking across sessions on the same platform

## Core APIs

### Device Management

- `list_cameras()` - Enumerate all cameras with unified `CameraInfo` objects
- `CameraInfo::model_id()`, `CameraInfo::display_name()` - Cross-platform device metadata
- `CameraInfo::formats()` - Iterator over platform-normalized `Format` objects

### Capture Pipeline

- `CameraInfo::start_capturing(format, callback)` - Begin capture with unified callback interface
- `RecordingHandle::stop_capturing()` - Stop capture session and cleanup resources
- `CapturedFrame::native()` - Access platform-specific frame data when needed

### Format Processing

- `Format::width()`, `Format::height()`, `Format::frame_rate()` - Cross-platform format properties
- `Format::native()` - Direct access to underlying AVFoundation/Media Foundation format objects

## Device Identification (ModelID)

The `ModelID` system provides device identification within each platform, modeled after Chromium's `VideoCaptureDeviceDescriptor::model_id`. It combines vendor ID (VID) and product ID (PID) to create a unique identifier that remains stable across sessions and system reboots on the same platform.

## Architecture

Bridges macOS AVFoundation and Windows Media Foundation/DirectShow through a unified device enumeration and capture interface.
Platform-specific modules (`macos.rs`, `windows.rs`) handle the underlying capture mechanics and expose them through common traits and callbacks,
while the main library provides a consistent API surface that abstracts away platform differences without sacrificing access to native functionality when needed.
