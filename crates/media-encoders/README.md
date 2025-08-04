# cap-media-encoders

A comprehensive collection of media encoders for various output formats, designed to work seamlessly with the Cap media processing pipeline. The crate provides unified interfaces for encoding captured audio and video data into different formats using multiple underlying media frameworks.

## Overview

This crate serves as a unified interface for encoding captured media into various output formats, with FFmpeg providing cross-platform support and AVFoundation offering optimized macOS-specific encoding. All encoders support real-time frame queuing and proper finalization for streaming applications.

## Available Encoders

### FFmpeg-based Encoders

**Video Encoders:**
- `H264Encoder` - H.264/AVC video encoding with configurable quality presets and bitrate control
- `MP4File` - Complete MP4 container handling H.264 video + audio stream muxing

**Audio Encoders:**
- `AACEncoder` - AAC audio encoding at 320kbps with automatic resampling and format conversion
- `OpusEncoder` - Opus audio encoding at 128kbps optimized for voice and music
- `OggFile` - Ogg container wrapper specifically designed for Opus audio streams

### AVFoundation-based Encoders (macOS only)

**Video + Audio:**
- `MP4AVAssetWriterEncoder` - Native macOS encoder using AVAssetWriter for hardware-accelerated MP4 encoding
  - Hardware acceleration support
  - Pause/resume functionality for recording sessions
  - Real-time encoding optimizations

### Standalone Encoders

**Animation:**
- `GifEncoderWrapper` - GIF animation encoder with advanced features:
  - Floyd-Steinberg dithering for quality color reduction
  - Custom 256-color palette with grayscale fallback
  - Configurable frame delay and infinite loop support

## Common Interface

### AudioEncoder Trait

All audio encoders implement the `AudioEncoder` trait providing:
- `queue_frame()` - Queue audio frames for encoding
- `finish()` - Finalize encoding and flush remaining data
- `boxed()` - Convert to boxed trait object for dynamic dispatch

## Key Features

### Format Handling
- **Automatic conversion**: Seamless pixel format and sample format conversion between input and encoder requirements
- **Resampling**: Built-in audio resampling for sample rate and format mismatches
- **Validation**: Input validation with detailed error reporting

### Performance Optimizations
- **Hardware acceleration**: AVFoundation encoder leverages macOS VideoToolbox
- **Threading**: Multi-threaded encoding support where available
- **Real-time processing**: Optimized for live capture and streaming scenarios

### Quality Control
- **Configurable presets**: H.264 encoding supports Slow, Medium, and Ultrafast presets
- **Bitrate control**: Intelligent bitrate calculation based on resolution and frame rate
- **Format-specific optimizations**: Each encoder tuned for its target format characteristics

## Dependencies

- `cap-media-info` - Media stream information structures
- `ffmpeg` - Cross-platform media processing (video and audio encoding)
- `gif` - GIF image format encoding
- `cidre` (macOS only) - AVFoundation bindings for native encoding

## Integration

The crate integrates with:
- **cap-media-info** for media stream configuration and format definitions
- **FFmpeg ecosystem** for broad codec and container support
- **macOS AVFoundation** for optimized native encoding on Apple platforms
- **Raw media pipelines** for direct frame processing

## Error Handling

Comprehensive error types for each encoder:
- `H264EncoderError` - Video encoding failures
- `AACEncoderError` / `OpusEncoderError` - Audio encoding issues
- `GifEncodingError` - Animation encoding problems
- `InitError` - Encoder initialization failures

Each error type provides detailed context about failures including codec availability, format compatibility, and resource constraints.

## Use Cases

This crate is designed for applications requiring:
- **Screen recording** with multiple output formats
- **Live streaming** with real-time encoding
- **Video conferencing** with adaptive quality
- **Media conversion** between different formats
- **Animation creation** from frame sequences

The modular design allows applications to choose the most appropriate encoder for their specific requirements, whether prioritizing quality, performance, or compatibility.