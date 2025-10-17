# Multi-Recorder CLI

A flexible command-line tool for recording multiple input sources (screens, cameras, microphones) to multiple output files simultaneously.

## Planning Documents

This project has three complementary planning documents:

### [PLAN.md](./PLAN.md) - Main Implementation Plan
The primary plan covering:
- Overall architecture and design philosophy
- CLI routing syntax and examples
- Implementation phases (1-6)
- Testing strategy
- Success criteria

**Key Approach**: Declarative routing where each source specifies its target outputs, with three input specification patterns (simple ID, inline JSON, file reference).

### [PLAN-UNIFIED.md](./PLAN-UNIFIED.md) - Unified CLI & JSON Approach
Detailed specification of the hybrid approach:
- CLI flags for routing
- JSON for source configuration (inline or file)
- Full config files for complex scenarios
- Complete implementation details with Rust code examples

**Philosophy**: "CLI for routing, JSON for settings" - no forced abstraction.

### [PLAN-JSON-CONFIG.md](./PLAN-JSON-CONFIG.md) - Full Config File Format
Complete specification of JSON/YAML configuration format:
- Two-phase declaration (inputs → outputs)
- Detailed schema for all input types
- Validation rules and error handling
- Config file commands and tooling

**Use Case**: Complex, repeatable recording setups that benefit from named inputs and version control.

## Quick Examples

### Simple Recording
```bash
cap-multi-recorder record --display 0 output.mp4
```

### Recording with Settings
```bash
cap-multi-recorder record \
  --display '{"id":0,"settings":{"fps":60}}' output.mp4
```

### Multiple Outputs
```bash
cap-multi-recorder record \
  --display 0 screen.mp4 full.mp4 \
  --camera 0 webcam.mp4 full.mp4 \
  --microphone "Blue Yeti" full.mp4
```

### Config File
```bash
cap-multi-recorder record config.json
```

## Features

- **Flexible Routing**: Arbitrary N→M input-to-output mappings
- **Multiple Formats**: MP4, Ogg (more coming)
- **Platform Native**: Hardware acceleration on macOS (AVFoundation) and Windows (Media Foundation)
- **Per-Source Settings**: Configure FPS, resolution, cursor visibility per source
- **No Forced Abstraction**: Use simple IDs or detailed JSON as needed
- **Config Files**: JSON/YAML for complex, repeatable setups

## Architecture

Built on the `cap-recording` crate's `OutputPipeline` architecture:
- Each output file = one `OutputPipeline` instance
- Multiple outputs can share input sources
- Sources: Display, Window, Camera, Microphone, System Audio
- Platform-specific muxers and encoders

## Current Status

⚠️ **Planning Phase** - Implementation not yet started.

See planning documents for implementation roadmap.

## Contributing

See [PLAN.md](./PLAN.md) for implementation phases and priorities.
