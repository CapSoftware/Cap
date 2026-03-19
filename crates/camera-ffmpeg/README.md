# cap-camera-ffmpeg

Cross-platform FFmpeg integration for the cap-camera library that provides seamless conversion between native camera frames and FFmpeg video frames. Enables direct use of camera capture data in FFmpeg-based video processing pipelines without additional memory copies or format conversions.

## Purpose

Bridges the gap between cap-camera's unified camera capture API and FFmpeg's video processing ecosystem. Provides zero-copy conversion from platform-specific camera frames (AVFoundation on macOS, Media Foundation/DirectShow on Windows) to FFmpeg video frames while preserving pixel format fidelity and performance.

## Key Features

- **Zero-Copy Frame Conversion**: Direct memory mapping from camera buffers to FFmpeg frames
- **Format Preservation**: Maintains pixel format integrity across platform boundaries
- **Cross-Platform Support**: Consistent conversion interface for macOS and Windows camera backends
- **Multiple Pixel Format Support**: Handles common camera formats (UYVY422, NV12, YUYV422, YUV420P, ARGB, RGB24/32)
- **Error Handling**: Comprehensive error reporting for unsupported formats and conversion failures
- **FFmpeg Integration**: Native FFmpeg video frame output ready for encoding, filtering, or analysis

## Core APIs

### Frame Conversion

- `CapturedFrameExt::to_ffmpeg()` - Convert camera frames to FFmpeg video frames with automatic format detection
- Platform-specific error handling via `ToFfmpegError` for unsupported formats and native errors

### Supported Formats

**macOS (AVFoundation)**:
- `2vuy` → UYVY422 (Packed YUV 4:2:2)
- `420v` → NV12 (Planar YUV 4:2:0 with interleaved UV)
- `yuvs` → YUYV422 (Packed YUV 4:2:2)

**Windows (Media Foundation/DirectShow)**:
- YUV420P, NV12, ARGB, RGB24, RGB32, YUYV422, UYVY422

## Architecture

Extends cap-camera's `CapturedFrame` with FFmpeg conversion capabilities through the `CapturedFrameExt` trait. Platform-specific modules handle the native frame format detection and memory layout conversion, while maintaining a unified interface for FFmpeg integration across macOS and Windows camera backends.

The conversion process preserves the original frame's memory layout and copies data efficiently into FFmpeg's expected format, ensuring compatibility with the broader FFmpeg ecosystem for video processing, encoding, and analysis tasks.