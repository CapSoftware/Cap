# MediaFoundation-FFmpeg H264 Muxing

This crate provides utilities for muxing H264 encoded samples from Windows MediaFoundation into container formats using FFmpeg.

## Purpose

When using MediaFoundation for hardware-accelerated H264 encoding, the encoded output needs to be muxed into a container format (MP4, MKV, etc.). This crate bridges MediaFoundation's `IMFSample` output with FFmpeg's powerful muxing capabilities.

## Features

- Extract H264 data from MediaFoundation `IMFSample` objects
- Mux H264 streams into various container formats via FFmpeg
- Automatic keyframe detection
- Proper timestamp handling (converts from MediaFoundation's 100ns units to microseconds)
- Support for multiple output formats (MP4, MKV, etc.)

## Usage

### Basic Example

```rust
use cap_mediafoundation_ffmpeg::{H264SampleMuxer, MuxerConfig};
use std::path::PathBuf;

// Configure the muxer
let config = MuxerConfig {
    width: 1920,
    height: 1080,
    fps: 30,
    bitrate: 5_000_000, // 5 Mbps
};

// Create the muxer
let mut muxer = H264SampleMuxer::new_mp4(
    PathBuf::from("output.mp4"),
    config,
)?;

// Write MediaFoundation samples
// (assuming you have an encoder producing IMFSample objects)
for sample in encoded_samples {
    muxer.write_sample(&sample)?;
}

// Finish muxing
muxer.finish()?;
```

### Using Raw H264 Data

If you already have extracted H264 data:

```rust
muxer.write_h264_data(
    &h264_data,
    pts,        // presentation timestamp in microseconds
    dts,        // decode timestamp in microseconds
    duration,   // duration in microseconds
    is_keyframe,
)?;
```

## Integration with MediaFoundation

This crate is designed to work with MediaFoundation H264 encoders. After encoding a frame with MediaFoundation:

1. The encoder produces an `IMFSample` containing H264 data
2. Pass the sample to `write_sample()`
3. The muxer extracts the H264 data and timing information
4. The data is muxed into the output container

## Timestamp Handling

MediaFoundation uses 100-nanosecond units for timestamps, while FFmpeg typically works with microseconds. This crate automatically handles the conversion:

- MediaFoundation: 100ns units
- This crate's API: microseconds
- FFmpeg internal: time_base units (configured based on FPS)

## Keyframe Detection

The muxer automatically detects IDR frames (keyframes) by inspecting the H264 NAL unit types. This ensures proper seeking and playback in the output file.

## Audio Support

The crate also includes utility traits for converting FFmpeg audio frames to MediaFoundation samples:

- `AudioExt`: Convert `ffmpeg::frame::Audio` to `IMFSample`
- `PlanarData`: Access planar audio data

## Requirements

- Windows (MediaFoundation is Windows-only)
- FFmpeg libraries
- A MediaFoundation H264 encoder (hardware or software)

## Error Handling

All operations return proper error types that can be handled:

```rust
match muxer.write_sample(&sample) {
    Ok(_) => // Success
    Err(e) => eprintln!("Failed to write sample: {}", e),
}
```

## Thread Safety

The `H264SampleMuxer` is not thread-safe and should be used from a single thread. If you need concurrent access, wrap it in appropriate synchronization primitives.