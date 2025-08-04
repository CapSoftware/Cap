# cap-camera-avfoundation

Ergonomic Rust wrapper around macOS AVFoundation API for camera capture,
providing safe abstractions while maintaining low-level control.
Built on top of the cidre framework for Apple platform APIs.
Aims to mirror how Chromium consumes AVFoundation.

## Purpose

Provides safe access to macOS camera devices through AVFoundation's capture system,
handling device enumeration, format negotiation, color space management, and callback-based frame delivery.

## Key Features

- **Device Discovery**: `list_video_devices()` for enumerating built-in, external, and desk view cameras
- **Format Enumeration**: Access to native video formats with frame rate ranges and color space information
- **Callback-Based Capture**: Delegate pattern for frame delivery via `CallbackOutputDelegate`
- **Memory Safety**: RAII pixel buffer locking with `ImageBufExt` trait and `BaseAddrLockGuard`

## Core APIs

### Device Management

- `list_video_devices()` - Enumerate available cameras (built-in, external, desk view)
- Access device metadata via cidre's `av::CaptureDevice` (name, unique ID, formats)
- Device configuration locking for format setting during capture initialization

### Capture Pipeline

- `CallbackOutputDelegate` - Custom delegate for handling frame callbacks
- `CallbackOutputDelegateInner::new(callback)` - Create delegate with closure-based frame handler
- AVFoundation capture session management with input/output configuration
- Video settings dictionary for pixel format specification

### Frame Processing

- `ImageBufExt::base_addr_lock()` - Safe pixel buffer access with automatic unlock
- `BaseAddrLockGuard::plane_data(index)` - Extract planar frame data as byte slices
- Direct access to frame metadata (dimensions, pixel format, presentation timestamp)

## Architecture

Bridges AVFoundation's delegate-based model to Rust's ownership system using closures for frame callbacks, RAII for pixel buffer management, and comprehensive color space handling. The capture pipeline requires careful device configuration locking to prevent format overwrites during session startup.
