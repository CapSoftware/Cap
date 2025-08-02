# cap-camera-mediafoundation

Ergonomic Rust wrapper around Windows Media Foundation API for camera capture,
providing safe abstractions while maintaining low-level control.
Aims to mirror how Chromium consumes Media Foundation.

## Purpose

Provides safe access to Windows camera devices through Media Foundation's Capture Engine,
handling COM initialization, device enumeration, format negotiation, and asynchronous frame delivery.

## Key Features

- **Device Discovery**: `DeviceSourcesIterator` for enumerating video capture devices
- **Format Enumeration**: Access to native media types supported by each device
- **Asynchronous Capture**: Channel-based frame delivery via `CaptureHandle`
- **Memory Safety**: RAII buffer locking with `IMFMediaBufferExt` trait
- **Error Handling**: Comprehensive error types and retry logic for Media Foundation timing issues

## Core APIs

### Device Management

- `initialize_mediafoundation()` - Initialize MF subsystem
- `DeviceSourcesIterator::new()` - Enumerate available cameras
- `Device::name()`, `Device::id()`, `Device::model_id()` - Device metadata
- `Device::formats()` - Iterator over supported `IMFMediaType` formats

### Capture Pipeline

- `Device::start_capturing(format)` - Begin async capture with specified format
- `CaptureHandle::sample_rx()` - Receive `IMFSample` frames via channel
- `CaptureHandle::event_rx()` - Receive `CaptureEngineEvent` status updates

### Frame Processing

- `VideoSample::bytes()` - Extract frame data as byte array
- `IMFMediaBufferExt::lock()` - Safe buffer access with automatic unlock

## Architecture

Bridges Media Foundation's callback-based model to Rust's ownership system using channels for cross-thread communication, RAII for resource management, and comprehensive error handling for production reliability.
