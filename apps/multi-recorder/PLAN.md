# Multi-Recorder CLI Plan

## Overview

Build a flexible CLI tool that allows users to capture multiple input sources (screens, cameras, microphones) and declaratively route them to multiple output files. Each output file is powered by an `OutputPipeline` instance. The tool enables arbitrary N→M routing scenarios:

- 1 source → 1 output (simple recording)
- N sources → 1 output (combined recording)
- 1 source → M outputs (duplicate/backup recording)
- N sources → M sources (complex multi-output scenarios)

## Core Design Philosophy

**Flexible Configuration Layers**:
- **CLI Routing**: Declare sources and their outputs via command-line flags
- **JSON Settings**: Optionally provide detailed source configuration via inline JSON or file references
- **Full Config Files**: For complex scenarios, use complete JSON/YAML configs with two-phase declaration

See [PLAN-UNIFIED.md](./PLAN-UNIFIED.md) for detailed unified approach combining CLI and JSON.
See [PLAN-JSON-CONFIG.md](./PLAN-JSON-CONFIG.md) for full config file format specification.

## Architecture

### Core Components

1. **Input Sources**
   - Screen captures (displays, windows, areas)
   - Cameras (via camera feeds)
   - Microphones (via microphone feeds)
   - System audio (platform-specific)

2. **Output Pipelines**
   - Each output file gets its own `OutputPipeline` instance
   - Multiple outputs can share the same input sources (via broadcast/clone)
   - Independent start/stop/pause/resume control per pipeline

3. **Routing System**
   - Declarative input→output mapping
   - Sources can target multiple outputs
   - Multiple sources can target the same output
   - Validation ensures OutputPipeline constraints are met

4. **Configuration System**
   - Flexible CLI syntax for all routing scenarios
   - Optional YAML/JSON configuration files for complex setups
   - Interactive mode for discovering available devices

## CLI Interface Design

### Flexible Routing Syntax

Each source type accepts its identifier followed by one or more output file paths:

```bash
cap-multi-recorder record \
  --display <ID> <OUTPUT> [<OUTPUT>...] \
  --camera <ID> <OUTPUT> [<OUTPUT>...] \
  --microphone <LABEL> <OUTPUT> [<OUTPUT>...] \
  --system-audio <OUTPUT> [<OUTPUT>...]
```

**Key principle**: Sources can be specified multiple times with different outputs, and multiple sources can target the same output.

### Command Structure

```bash
cap-multi-recorder [SUBCOMMAND] [OPTIONS]
```

### Subcommands

#### `list` - Discover Available Inputs

```bash
cap-multi-recorder list [--displays] [--windows] [--cameras] [--microphones]
```

Lists available capture sources with IDs and metadata.

#### `record` - Start Recording with Flexible Routing

```bash
cap-multi-recorder record [OPTIONS] [CONFIG_FILE]

Source Options (repeatable):
  --display <SPEC> <OUTPUT>...        Capture display and route to output(s)
  --window <SPEC> <OUTPUT>...         Capture window and route to output(s)
  --camera <SPEC> <OUTPUT>...         Capture camera and route to output(s)
  --microphone <SPEC> <OUTPUT>...     Capture microphone and route to output(s)
  --system-audio <OUTPUT>...          Capture system audio and route to output(s)

Global Options:
  --fps <FPS>                         Default frame rate (default: 30)
  --cursor                            Default cursor visibility (default: true)
  --duration <SECONDS>                Auto-stop after duration

Config File:
  [CONFIG_FILE]                       Load routing from YAML/JSON config
```

**Source Specification Patterns**:

Each source accepts three patterns:

1. **Simple Identifier**: `--display 0 output.mp4`
   - Display ID: `0`, `1`, `"primary"`
   - Camera ID: `0`, `1`, `"default"`
   - Microphone: `"Blue Yeti"`, `"default"`

2. **Inline JSON**: `--display '{"id":0,"settings":{"fps":60}}' output.mp4`
   - Full control over source configuration
   - Include per-source settings
   - Must be valid JSON

3. **File Reference**: `--display @config/display.json output.mp4`
   - Reference external JSON file with `@` prefix
   - Reusable configurations
   - Easier to maintain complex settings

#### `validate` - Validate Configuration

```bash
cap-multi-recorder validate <CONFIG_FILE>
```

Checks configuration file for errors without starting recording.

### Routing Examples

#### Example 1: Simple - One Source, One Output
```bash
cap-multi-recorder record --display 0 output.mp4
```
**Result**: `output.mp4` contains display-0

#### Example 1b: With Settings
```bash
cap-multi-recorder record \
  --display '{"id":0,"settings":{"fps":60,"show_cursor":true}}' output.mp4
```
**Result**: `output.mp4` contains display-0 at 60fps with cursor

#### Example 2: Combined - Multiple Sources, One Output
```bash
cap-multi-recorder record \
  --display 0 recording.mp4 \
  --camera 0 recording.mp4 \
  --microphone "Blue Yeti" recording.mp4
```
**Result**: `recording.mp4` contains display-0 + camera-0 + microphone

#### Example 2b: With File Reference
```bash
cap-multi-recorder record \
  --display @high-quality-display.json recording.mp4 \
  --camera 0 recording.mp4 \
  --microphone "Blue Yeti" recording.mp4
```
Where `high-quality-display.json`:
```json
{
  "id": 0,
  "settings": {
    "fps": 60,
    "show_cursor": true
  }
}
```
**Result**: Same as Example 2, but display is 60fps

#### Example 3: Split - Each Source to Separate File
```bash
cap-multi-recorder record \
  --display 0 screen.mp4 \
  --camera 0 webcam.mp4 \
  --microphone "Blue Yeti" audio.ogg
```
**Result**: 
- `screen.mp4` contains display-0
- `webcam.mp4` contains camera-0
- `audio.ogg` contains microphone

#### Example 4: Duplicate - One Source, Multiple Outputs
```bash
cap-multi-recorder record \
  --display 0 backup1.mp4 backup2.mp4 backup3.mp4
```
**Result**: All three files contain the same display-0 recording

#### Example 5: Complex - Mixed Routing
```bash
cap-multi-recorder record \
  --display 0 screen-only.mp4 full-recording.mp4 \
  --camera 0 camera-only.mp4 full-recording.mp4 \
  --microphone "Blue Yeti" audio-only.ogg full-recording.mp4 \
  --system-audio full-recording.mp4
```
**Result**:
- `screen-only.mp4`: display-0
- `camera-only.mp4`: camera-0
- `audio-only.ogg`: microphone
- `full-recording.mp4`: display-0 + camera-0 + microphone + system-audio

#### Example 6: Multi-Display (Separate Files)
```bash
cap-multi-recorder record \
  --display 0 display-0.mp4 \
  --display 1 display-1.mp4 \
  --microphone "Default" display-0.mp4 display-1.mp4
```
**Result**:
- `display-0.mp4`: display-0 + microphone
- `display-1.mp4`: display-1 + microphone

Note: Multiple video sources in one output is not supported due to OutputPipeline constraints.

#### Example 7: Multiple Microphones Mixed
```bash
cap-multi-recorder record \
  --microphone "Blue Yeti" yeti.ogg mixed.ogg \
  --microphone "Focusrite" focusrite.ogg mixed.ogg
```
**Result**:
- `yeti.ogg`: Blue Yeti only
- `focusrite.ogg`: Focusrite only
- `mixed.ogg`: Both microphones mixed together

### Configuration File Format (Alternative to CLI)

For complex scenarios, YAML/JSON configs remain available:

```yaml
settings:
  fps: 30
  show_cursor: true

routing:
  - source:
      type: display
      id: 0
    outputs:
      - screen-only.mp4
      - full-recording.mp4
      
  - source:
      type: camera
      id: 0
    outputs:
      - camera-only.mp4
      - full-recording.mp4
      
  - source:
      type: microphone
      label: "Blue Yeti"
    outputs:
      - audio-only.ogg
      - full-recording.mp4
      
  - source:
      type: system-audio
    outputs:
      - full-recording.mp4
```

Alternative JSON format:
```json
{
  "settings": {
    "fps": 30,
    "show_cursor": true
  },
  "routing": [
    {
      "source": {
        "type": "display",
        "id": 0
      },
      "outputs": ["screen-only.mp4", "full-recording.mp4"]
    }
  ]
}
```

## Implementation Plan

### Phase 1: Core Infrastructure with Routing

**Files to create/modify:**
- `src/main.rs` - Main entry point with CLI parsing
- `src/config.rs` - Configuration data structures
- `src/routing.rs` - Route resolution and validation
- `src/inputs.rs` - Input source management
- `src/outputs.rs` - Output pipeline management

**Dependencies to add:**
```toml
clap = { version = "4", features = ["derive"] }
serde = { version = "1", features = ["derive"] }
serde_yaml = "0.9"
serde_json = "1"
tokio = { version = "1", features = ["full"] }
anyhow = "1"
tracing = "0.1"
tracing-subscriber = { version = "0.3", features = ["env-filter"] }
```

**Key structures:**

```rust
// src/main.rs
#[derive(Parser)]
struct RecordCommand {
    /// Display: --display <ID> <OUTPUT> [<OUTPUT>...]
    #[arg(long, value_names = ["ID", "OUTPUT"], num_args = 2.., action = clap::ArgAction::Append)]
    display: Vec<Vec<String>>,
    
    /// Camera: --camera <ID> <OUTPUT> [<OUTPUT>...]
    #[arg(long, value_names = ["ID", "OUTPUT"], num_args = 2.., action = clap::ArgAction::Append)]
    camera: Vec<Vec<String>>,
    
    /// Microphone: --microphone <LABEL> <OUTPUT> [<OUTPUT>...]
    #[arg(long, value_names = ["LABEL", "OUTPUT"], num_args = 2.., action = clap::ArgAction::Append)]
    microphone: Vec<Vec<String>>,
    
    /// System audio: --system-audio <OUTPUT> [<OUTPUT>...]
    #[arg(long, value_name = "OUTPUT", num_args = 1..)]
    system_audio: Vec<String>,
    
    #[arg(long, default_value = "30")]
    fps: u32,
    
    #[arg(long, default_value = "true")]
    cursor: bool,
    
    /// Optional config file
    config: Option<PathBuf>,
}

// src/routing.rs
pub struct SourceOutputMapping {
    /// All source specifications
    pub sources: Vec<SourceSpec>,
    /// Output specifications derived from routing
    pub outputs: HashMap<PathBuf, OutputSpec>,
}

pub struct SourceSpec {
    pub id: String,
    pub source_type: SourceType,
    pub target_outputs: Vec<PathBuf>,
}

pub struct OutputSpec {
    pub path: PathBuf,
    pub format: OutputFormat,
    pub video_source: Option<SourceId>,
    pub audio_sources: Vec<SourceId>,
}

pub enum SourceType {
    Display,
    Window,
    Camera,
    Microphone,
    SystemAudio,
}

// Parse CLI args into routing structure
pub fn parse_routing(args: &RecordCommand) -> Result<SourceOutputMapping> {
    let mut sources = Vec::new();
    let mut outputs: HashMap<PathBuf, OutputSpec> = HashMap::new();
    
    // Parse displays
    for display_args in &args.display {
        let id = display_args[0].clone();
        let output_paths: Vec<PathBuf> = display_args[1..]
            .iter()
            .map(PathBuf::from)
            .collect();
        
        let source_id = format!("display-{}", id);
        sources.push(SourceSpec {
            id: source_id.clone(),
            source_type: SourceType::Display,
            target_outputs: output_paths.clone(),
        });
        
        // Register each output
        for path in output_paths {
            outputs.entry(path.clone())
                .or_insert_with(|| OutputSpec {
                    path: path.clone(),
                    format: infer_format(&path),
                    video_source: None,
                    audio_sources: Vec::new(),
                })
                .video_source = Some(source_id.clone());
        }
    }
    
    // Similar for camera, microphone, system-audio...
    
    Ok(SourceOutputMapping { sources, outputs })
}

// Validate routing rules
pub fn validate_routing(mapping: &SourceOutputMapping) -> Result<()> {
    // Rule 1: At least one source
    if mapping.sources.is_empty() {
        return Err(anyhow!("No input sources specified"));
    }
    
    // Rule 2: Each source must have ≥1 output
    for source in &mapping.sources {
        if source.target_outputs.is_empty() {
            return Err(anyhow!("Source {} has no outputs", source.id));
        }
    }
    
    // Rule 3: Each output must have ≥1 source
    for (path, spec) in &mapping.outputs {
        if spec.video_source.is_none() && spec.audio_sources.is_empty() {
            return Err(anyhow!("Output {:?} has no sources", path));
        }
    }
    
    // Rule 4: Video formats need video or audio sources
    for (path, spec) in &mapping.outputs {
        if spec.format.requires_video() 
            && spec.video_source.is_none() 
            && spec.audio_sources.is_empty() 
        {
            return Err(anyhow!("MP4 output {:?} needs sources", path));
        }
    }
    
    // Rule 5: Only one video source per output (OutputPipeline limitation)
    for (path, _) in &mapping.outputs {
        let video_sources: Vec<_> = mapping.sources.iter()
            .filter(|s| s.target_outputs.contains(path))
            .filter(|s| matches!(
                s.source_type, 
                SourceType::Display | SourceType::Window | SourceType::Camera
            ))
            .collect();
            
        if video_sources.len() > 1 {
            return Err(anyhow!(
                "Output {:?} has {} video sources (max 1 supported)",
                path, video_sources.len()
            ));
        }
    }
    
    Ok(())
}
```

### Phase 2: Input Discovery & Management

**Implement:**

1. **Display/Window listing**
   - Use `screen_capture::list_displays()`
   - Use `screen_capture::list_windows()`
   - Format output for CLI display

2. **Camera listing**
   - Use `cap_camera::list_cameras()`
   - Initialize `CameraFeed` actors
   - Provide camera info and IDs

3. **Microphone listing**
   - Use `MicrophoneFeed::list()`
   - Show available audio devices with labels
   - Handle default device selection

4. **Input initialization from routing**
   - Create feeds only for requested sources
   - Track which sources are shared across multiple outputs
   - Use Arc/clone for shared camera/microphone feeds
   - Set up ScreenCaptureConfig for screen sources
   - Handle platform-specific requirements (ShareableContent on macOS, D3D device on Windows)

### Phase 3: Output Pipeline Construction from Routing

**Implement:**

1. **Build pipelines from OutputSpec**
   ```rust
   for (path, spec) in mapping.outputs {
       let mut builder = OutputPipeline::builder(path);
       
       // Add video source if present
       if let Some(video_id) = spec.video_source {
           let video_config = get_video_config(&video_id)?;
           builder = builder.with_video(video_config);
       }
       
       // Add audio sources
       for audio_id in spec.audio_sources {
           let audio_config = get_audio_config(&audio_id)?;
           builder = builder.with_audio_source(audio_config);
       }
       
       // Build with appropriate muxer
       let pipeline = builder.build(select_muxer(&spec)).await?;
       pipelines.push((path, pipeline));
   }
   ```

2. **Handle shared sources**
   - Clone `CameraFeedLock` / `MicrophoneFeedLock` for shared feeds
   - For screen capture sharing between outputs:
     - Option A: Create separate ScreenCaptureConfig instances (simpler, 2x overhead)
     - Option B: Share VideoSource and duplicate frames (needs implementation)
   - Ensure consistent timestamps across outputs using shared `Timestamps`

3. **Muxer selection logic**
   ```rust
   match (config.format, platform) {
       (OutputFormat::Mp4, Platform::MacOS) => AVFoundationMp4Muxer,
       (OutputFormat::Mp4, Platform::Windows) => WindowsMuxer,
       (OutputFormat::Mp4, _) => Mp4Muxer,
       (OutputFormat::Ogg, _) => OggMuxer,
   }
   ```

### Phase 4: Recording Control

**Implement:**

1. **Start sequence**
   - Initialize all input feeds for sources in routing
   - Build all output pipelines
   - Wait for first frame from each source
   - Start all pipelines simultaneously

2. **Runtime monitoring**
   - Monitor pipeline health via `done_fut()`
   - Log frame rates and dropped frames
   - Handle feed disconnections
   - Display recording status per output

3. **Stop sequence**
   - Graceful shutdown on Ctrl+C (tokio signal handling)
   - Stop all pipelines in parallel
   - Wait for all muxers to finalize
   - Report final statistics per output

4. **Pause/Resume (future enhancement)**
   - Interactive commands during recording
   - Synchronized pause/resume across pipelines

### Phase 5: Error Handling & Validation

**Implement:**

1. **Configuration validation**
   - Validate routing before initializing sources (see `validate_routing`)
   - Check that referenced inputs exist and are available
   - Validate file paths are writable
   - Ensure video sources are compatible with selected formats
   - Detect multiple video sources targeting same output (not supported)

2. **Runtime error handling**
   - Handle feed disconnections gracefully
   - Recover from encoder errors when possible
   - Provide actionable error messages
   - Clean up partial recordings on failure

3. **Platform compatibility**
   - Check platform capabilities (ScreenCaptureKit on macOS, etc.)
   - Provide fallbacks where possible
   - Clear error messages for unsupported features

### Phase 6: User Experience

**Implement:**

1. **Interactive mode**
   - Prompt for input selection if no sources specified
   - Use `inquire` crate for interactive prompts
   - Generate routing from interactive session

2. **Progress display**
   - Show recording duration
   - Display per-output statistics
   - Show available disk space
   - Real-time frame rate

3. **Help & Documentation**
   - Comprehensive help text with routing examples
   - Example configurations
   - Troubleshooting guide

**Help text example:**

```
USAGE:
    cap-multi-recorder record [OPTIONS] [CONFIG_FILE]

OPTIONS:
    --display <ID> <OUTPUT>...
            Capture display and send to one or more outputs
            Can be specified multiple times for multiple displays
            
    --camera <ID> <OUTPUT>...
            Capture camera and send to one or more outputs
            Can be specified multiple times for multiple cameras
            
    --microphone <LABEL> <OUTPUT>...
            Capture microphone and send to one or more outputs
            Can be specified multiple times for multiple microphones
            
    --system-audio <OUTPUT>...
            Capture system audio and send to one or more outputs
            
    --fps <FPS>
            Frame rate (default: 30)
            
    --cursor
            Show cursor (default: true)

EXAMPLES:
    # Simple: one source → one output
    cap-multi-recorder record --display 0 output.mp4
    
    # Combined: multiple sources → one output
    cap-multi-recorder record \
        --display 0 recording.mp4 \
        --camera 0 recording.mp4 \
        --microphone "Blue Yeti" recording.mp4
    
    # Split: each source → separate output
    cap-multi-recorder record \
        --display 0 screen.mp4 \
        --camera 0 webcam.mp4 \
        --microphone "Blue Yeti" audio.ogg
    
    # Duplicate: one source → multiple outputs
    cap-multi-recorder record \
        --display 0 backup1.mp4 backup2.mp4 backup3.mp4
    
    # Complex: mixed routing
    cap-multi-recorder record \
        --display 0 full.mp4 screen-only.mp4 \
        --camera 0 full.mp4 camera-only.mp4 \
        --microphone "Blue Yeti" full.mp4 audio-only.ogg
```

## Limitations & Constraints

### Current Limitations

1. **One video source per output**: OutputPipeline accepts a single VideoSource, so you cannot combine multiple video sources (e.g., multiple displays or display+camera) into one output with picture-in-picture. Each output can have:
   - 1 video source (display, window, OR camera)
   - N audio sources (microphones, system audio)

2. **Format constraints**:
   - MP4: Requires video source or audio sources
   - Ogg: Audio only

3. **Screen capture sharing**: When multiple outputs use the same screen:
   - Current approach: Create separate ScreenCaptureConfig instances (2x capture overhead)
   - Future optimization: Share VideoSource and duplicate frames

### Workarounds

For multiple video sources in one output, users would need:
- Record sources to separate files, combine in post-production
- Future enhancement: Picture-in-picture compositing

## Testing Strategy

### Unit Tests
- Routing parse and validation
- Conflicting video source detection
- Output format inference
- Source ID generation
- Configuration file parsing

### Integration Tests
- 1→1: Single display to single file
- N→1: Multiple sources to combined file
- 1→N: One source duplicated to multiple files
- N→M: Complex multi-output routing
- Config file + CLI args combination

### Platform Tests
- macOS: ScreenCaptureKit, AVFoundation
- Windows: Direct3D, Media Foundation
- Both: FFmpeg fallbacks

### CLI Tests
- Argument parsing edge cases
- Invalid routing rejection
- Help text generation
- List command output

## Open Questions

1. **Screen capture sharing**: When two outputs use the same display:
   - Option A: Create two ScreenCaptureConfig instances (2x overhead) ← Start with this
   - Option B: Share VideoSource and duplicate frames (needs implementation)
   - Recommendation: Start with Option A, optimize later if needed

2. **Timestamp synchronization**: Ensure all outputs start together:
   - Share `Timestamps` instance across all pipelines
   - Wait for all feeds to produce first frame before starting
   - Coordinate via `first_timestamp_rx`

3. **Performance limits**:
   - Test maximum simultaneous outputs
   - Monitor CPU/memory during N→M scenarios
   - Consider throttling or warnings for excessive routing

4. **Audio mixing**: When routing multiple microphones to one output:
   - Already handled by AudioMixer in pipeline
   - Just need to add multiple audio sources to builder
   - Mixer handles synchronization and mixing

## Future Enhancements

1. **Live streaming outputs** (RTMP support)
2. **Filters and effects** (watermarks, overlays)
3. **Multiple video sources in one output** (picture-in-picture)
4. **Real-time preview** (optional window showing recording)
5. **Scheduled recordings** (start/stop at specific times)
6. **Cloud upload** (automatic upload after recording)
7. **Segmented recording** (split into multiple files by duration)
8. **Hot-swappable inputs** (change camera/mic during recording)
9. **Screen capture sharing optimization** (reduce overhead when same display used by multiple outputs)

## Success Criteria

- ✅ Can specify arbitrary input→output routing via CLI
- ✅ Can route 1 source → 1 output (simple recording)
- ✅ Can route N sources → 1 output (combined recording)
- ✅ Can route 1 source → M outputs (duplicate recording)
- ✅ Can route N sources → M outputs (complex scenarios)
- ✅ Validates routing before recording starts
- ✅ Clear error messages for invalid routing
- ✅ Works without config files for all scenarios
- ✅ Intuitive, declarative CLI syntax
- ✅ Config file support for complex routing (optional)
- ✅ Graceful error handling and cleanup
- ✅ Works on both macOS and Windows
- ✅ Clear documentation and examples
