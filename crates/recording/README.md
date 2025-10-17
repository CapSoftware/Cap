# cap-recording

Recording pipeline for Cap's screen, camera, and audio capture.

## Output Pipeline

The output pipeline (`output_pipeline`) orchestrates media capture from multiple sources and muxes them into a single output file.

### Core Architecture

The pipeline is built around a builder pattern that supports:

- **Video Sources**: Optional video input via `VideoSource` trait
- **Audio Sources**: Multiple audio inputs via `AudioSource` trait  
- **Muxers**: Platform-specific output formats via `Muxer`, `VideoMuxer`, and `AudioMuxer` traits
- **Task Management**: Coordinated async tasks with `TaskPool` and cancellation tokens
- **Timestamps**: Synchronized timing across all sources via `Timestamps`

The `OutputPipeline` itself provides pause/resume control and returns a `FinishedOutputPipeline` on completion.

### Available Muxers

- **FFmpeg (`Mp4Muxer`, `OggMuxer`)**: Cross-platform H.264/AAC (MP4) and Opus (Ogg) encoding
- **AVFoundation (`AVFoundationMp4Muxer`)**: Native macOS hardware-accelerated MP4 encoding
- **Windows (`WindowsMuxer`)**: Windows Media Foundation H.264 encoder with Direct3D integration, falling back to FFmpeg software encoding

### Audio Mixing

The `AudioMixer` combines multiple audio sources with different sample rates/formats into a single stereo 48kHz float stream. It handles:

- Automatic silence insertion for gaps and late-starting sources
- Per-source buffering and timestamp alignment
- FFmpeg filter graph (abuffer → amix → aformat → abuffersink)

## Sources

Media capture sources implement either `VideoSource` or `AudioSource` traits.

### Screen Capture (`sources::screen_capture`)

Platform-specific screen recording:

**macOS (`CMSampleBufferCapture`)**:
- ScreenCaptureKit-based capture via `scap-screencapturekit`
- Captures BGRA video at native resolution
- Optional system audio capture
- Supports display/window/area targeting with crop bounds

**Windows (`Direct3DCapture`)**:
- Windows.Graphics.Capture API via `scap-direct3d`
- Hardware-accelerated Media Foundation H.264 encoding when available
- Fallback to FFmpeg software encoding
- Optional CPAL-based system audio capture

Both implementations support cursor capture and configurable frame rates.

### Camera (`sources::camera`)

FFmpeg-based camera capture via camera feed locks. Connects to `CameraFeedLock` actors to receive timestamped video frames.

### Microphone (`sources::microphone`)

Audio capture via microphone feed locks. Connects to `MicrophoneFeedLock` actors to receive timestamped audio data, wrapping raw samples into FFmpeg frames.

### Audio Mixer (`sources::audio_mixer`)

Internal source that combines multiple audio inputs (see [Audio Mixing](#audio-mixing) above).
