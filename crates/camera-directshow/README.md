# cap-camera-directshow

Ergonomic Rust wrapper around Windows DirectShow API for legacy camera capture,
providing safe abstractions over COM interfaces while maintaining compatibility
with older camera devices and drivers that don't support Media Foundation.
Aims to mirror how Chromium consumes DirectShow.

## Purpose

Provides safe access to Windows camera devices through DirectShow's filter graph architecture,
handling COM initialization, device enumeration through monikers, format negotiation via
IAMStreamConfig,
and synchronous frame delivery through custom sink filters.

## Key Features

- **Device Discovery**: `VideoInputDeviceIterator` for enumerating video capture devices via COM monikers
- **Format Enumeration**: Access to `AM_MEDIA_TYPE` formats and frame rates through `IAMStreamConfig`
- **Synchronous Capture**: Callback-based frame delivery via custom `SinkFilter` implementation
- **Memory Safety**: RAII COM object management with automatic cleanup and proper reference counting
- **Legacy Support**: Compatibility with older cameras that lack Media Foundation support
- **Video Format Support**: Built-in support for I420, RGB24, YUY2, MJPG, NV12, and other common formats

## Core APIs

### Device Management

- `initialize_directshow()` - Initialize DirectShow COM subsystem
- `VideoInputDeviceIterator::new()` - Enumerate available cameras via system device enumerator
- `VideoInputDevice::name()`, `VideoInputDevice::id()`, `VideoInputDevice::model_id()` - Device metadata
- `VideoInputDevice::media_types()` - Iterator over supported `AMMediaType` formats

### Capture Pipeline

- `VideoInputDevice::start_capturing(format, callback)` - Begin sync capture with specified format
- `CaptureHandle::stop_capturing()` - Stop capture session and disconnect filter graph
- `SinkCallback` - Frame processing callback receiving `IMediaSample` and media type

### Format Processing

- `AMMediaType` - Safe wrapper around `AM_MEDIA_TYPE` with automatic memory management
- `AM_MEDIA_TYPEExt::subtype_str()` - Convert format GUIDs to readable strings
- `AM_MEDIA_TYPEVideoExt::video_info()` - Access video format details and dimensions

### Filter Graph Extensions

- `IBaseFilterExt::get_pin()` - Find pins by direction, category, and media type
- `IAMStreamConfigExt::media_types()` - Enumerate supported capture formats
- `IPinExt::matches_category()` - Pin category matching for capture pin discovery

## Architecture

Bridges DirectShow's COM-based filter graph model to Rust's ownership system using
custom sink filter implementation, RAII for COM resource management, and comprehensive
trait extensions for ergonomic API access. Designed for maximum compatibility with
legacy camera hardware while maintaining memory safety.

## Error Handling

Comprehensive `StartCapturingError` enum covering:

- **NoInputPin** - Sink filter pin creation failures
- **CreateGraph** - Filter graph builder instantiation errors
- **ConfigureGraph** - Filter connection and configuration issues
- **Run** - Media control execution failures
- **Other** - General DirectShow COM errors

The crate provides robust error propagation while maintaining the callback-based
architecture required for real-time video capture scenarios.
