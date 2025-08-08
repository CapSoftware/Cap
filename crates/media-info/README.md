# cap-media-info

A Rust crate providing information structures for audio and video processing, designed to bridge FFmpeg and CPAL libraries for media capture and encoding applications.

## Overview

This crate defines core data structures (`AudioInfo` and `VideoInfo`) that encapsulate media stream parameters and provide utilities for converting between different media processing libraries. It's particularly useful for applications that need to capture audio/video data and encode it using FFmpeg.

## Core Structures

### AudioInfo

Represents audio stream parameters and provides conversion utilities between CPAL (Cross-Platform Audio Library) and FFmpeg formats.

**Fields:**
- `sample_format`: FFmpeg sample format
- `sample_rate`: Audio sample rate in Hz
- `channels`: Number of audio channels (currently limited to 1-2)
- `time_base`: FFmpeg time base for timestamps
- `buffer_size`: Audio buffer size in samples

**Key Methods:**
- `new()`: Create with basic parameters and validation
- `from_stream_config()`: Create from CPAL's SupportedStreamConfig
- `from_decoder()`: Create from FFmpeg's audio decoder
- `empty_frame()`: Generate empty audio frames
- `wrap_frame()`: Wrap raw audio data into FFmpeg frames with automatic deinterleaving

**Limitations:**
- Currently supports only mono (1) and stereo (2) channel configurations
- Maximum channels defined by `MAX_AUDIO_CHANNELS = 2`

### VideoInfo

Represents video stream parameters for various pixel formats and provides frame manipulation utilities.

**Fields:**
- `pixel_format`: FFmpeg pixel format
- `width`: Video width in pixels
- `height`: Video height in pixels  
- `time_base`: FFmpeg time base for timestamps
- `frame_rate`: Video frame rate

**Key Methods:**
- `from_raw()`: Create from RawVideoFormat enum
- `from_raw_ffmpeg()`: Create directly from FFmpeg pixel format
- `scaled()`: Create scaled version with proportional resizing
- `wrap_frame()`: Wrap raw video data into FFmpeg frames with stride handling

### RawVideoFormat

Enum mapping common video formats to FFmpeg pixel formats:
- `Bgra` → BGRA
- `Mjpeg` → YUVJ422P
- `Uyvy` → UYVY422
- `RawRgb` → RGB24
- `Nv12` → NV12
- `Gray` → GRAY8
- `YUYV420` → YUV420P
- `Rgba` → RGBA

## Additional Features

### PlanarData Trait
Provides safe access to planar audio data, fixing issues with FFmpeg's audio frame data access for multi-channel audio processing.

### Error Handling
- `AudioInfoError`: Handles validation errors, particularly for unsupported channel configurations

## Dependencies

- `ffmpeg`: Core FFmpeg bindings for media processing
- `cpal`: Cross-platform audio library for audio I/O
- `thiserror`: Error handling utilities

## Use Cases

This crate is designed for applications that need to:
- Capture audio from system devices using CPAL
- Capture video from various sources  
- Convert raw media data to FFmpeg-compatible formats
- Encode captured media using FFmpeg codecs
- Handle format conversions between different media libraries

## Integration

The crate serves as a compatibility layer between:
- **CPAL** for audio input/output operations
- **FFmpeg** for media encoding/decoding operations  
- **Raw media data** processing pipelines

This makes it particularly suitable for screen recording, video conferencing, and media streaming applications.