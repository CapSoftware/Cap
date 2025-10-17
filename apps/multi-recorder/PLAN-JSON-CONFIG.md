# Multi-Recorder CLI Plan - JSON Configuration Approach

## Overview

An alternative approach to multi-recorder configuration that separates input source declarations from output routing. This two-phase approach mirrors the internal architecture more closely and provides clearer separation of concerns.

## Core Design Philosophy

**Two-Phase Declaration**:
1. **Declare Inputs**: Define sources with IDs, types, and settings
2. **Declare Outputs**: Specify output files and which input IDs feed them

This approach provides:
- Clearer input reuse across outputs
- Explicit configuration of source settings
- Better alignment with the internal `InputManager` → `OutputPipeline` architecture
- More maintainable configs for complex scenarios

## Configuration Format

### JSON Structure

```json
{
  "settings": {
    "fps": 30,
    "show_cursor": true
  },
  "inputs": {
    "main_display": {
      "type": "display",
      "id": 0,
      "settings": {
        "show_cursor": true,
        "fps": 60
      }
    },
    "webcam": {
      "type": "camera",
      "id": 0,
      "settings": {}
    },
    "blue_yeti": {
      "type": "microphone",
      "label": "Blue Yeti",
      "settings": {}
    },
    "focusrite": {
      "type": "microphone",
      "label": "Focusrite USB",
      "settings": {}
    },
    "sys_audio": {
      "type": "system-audio",
      "settings": {}
    }
  },
  "outputs": {
    "full_recording.mp4": {
      "video": "main_display",
      "audio": ["blue_yeti", "focusrite", "sys_audio"]
    },
    "camera_only.mp4": {
      "video": "webcam",
      "audio": ["blue_yeti"]
    },
    "audio_backup.ogg": {
      "audio": ["focusrite"]
    }
  }
}
```

### YAML Alternative

```yaml
settings:
  fps: 30
  show_cursor: true

inputs:
  main_display:
    type: display
    id: 0
    settings:
      show_cursor: true
      fps: 60
  
  webcam:
    type: camera
    id: 0
    settings: {}
  
  blue_yeti:
    type: microphone
    label: "Blue Yeti"
    settings: {}
  
  focusrite:
    type: microphone
    label: "Focusrite USB"
    settings: {}
  
  sys_audio:
    type: system-audio
    settings: {}

outputs:
  full_recording.mp4:
    video: main_display
    audio: [blue_yeti, focusrite, sys_audio]
  
  camera_only.mp4:
    video: webcam
    audio: [blue_yeti]
  
  audio_backup.ogg:
    audio: [focusrite]
```

## Input Types Specification

### Display Input

```json
{
  "type": "display",
  "id": 0,
  "settings": {
    "show_cursor": true,
    "fps": 60
  }
}
```

**Fields:**
- `type`: `"display"`
- `id`: Display ID (number or "primary")
- `settings`:
  - `show_cursor`: bool (default: true)
  - `fps`: number (default: 30)

### Window Input

```json
{
  "type": "window",
  "id": 12345,
  "settings": {
    "show_cursor": true,
    "fps": 30
  }
}
```

**Fields:**
- `type`: `"window"`
- `id`: Window ID (number)
- `settings`:
  - `show_cursor`: bool (default: true)
  - `fps`: number (default: 30)

### Area Input

```json
{
  "type": "area",
  "screen": 0,
  "bounds": {
    "x": 100,
    "y": 100,
    "width": 1920,
    "height": 1080
  },
  "settings": {
    "show_cursor": true,
    "fps": 30
  }
}
```

**Fields:**
- `type`: `"area"`
- `screen`: Display ID to capture from
- `bounds`: Rectangle defining capture area
  - `x`, `y`: Position
  - `width`, `height`: Size
- `settings`:
  - `show_cursor`: bool (default: true)
  - `fps`: number (default: 30)

### Camera Input

```json
{
  "type": "camera",
  "id": 0,
  "settings": {
    "resolution": {
      "width": 1920,
      "height": 1080
    },
    "fps": 30
  }
}
```

**Fields:**
- `type`: `"camera"`
- `id`: Camera ID (number or device name)
- `settings`:
  - `resolution`: Optional preferred resolution
  - `fps`: number (default: 30)

### Microphone Input

```json
{
  "type": "microphone",
  "label": "Blue Yeti",
  "settings": {}
}
```

**Fields:**
- `type`: `"microphone"`
- `label`: Device label/name (or "default")
- `settings`: Currently empty, reserved for future use

### System Audio Input

```json
{
  "type": "system-audio",
  "settings": {}
}
```

**Fields:**
- `type`: `"system-audio"`
- `settings`: Platform-specific settings (future)

## Output Specification

### Output Entry

```json
{
  "path/to/output.mp4": {
    "video": "input_id",
    "audio": ["input_id1", "input_id2"],
    "format": "mp4",
    "settings": {
      "bitrate": "5M"
    }
  }
}
```

**Fields:**
- Key: Output file path
- `video`: Optional input ID for video source
- `audio`: Optional array of input IDs for audio sources
- `format`: Optional format override (inferred from extension by default)
- `settings`: Optional format-specific settings

## CLI Integration

### Config File Mode

```bash
cap-multi-recorder record config.json
```

Loads configuration from JSON/YAML file.

### Generate Config Mode

```bash
cap-multi-recorder generate-config [OPTIONS] > config.json
```

Interactive mode that generates a configuration file by:
1. Listing available inputs
2. Prompting user to select and name inputs
3. Prompting user to define outputs
4. Outputting JSON/YAML configuration

**Options:**
- `--format json|yaml` - Output format (default: json)
- `--interactive` - Interactive mode (default)
- `--template` - Generate template with all input types

### Hybrid Mode (CLI + Config)

```bash
cap-multi-recorder record config.json \
  --add-input microphone:backup="Backup Mic" \
  --add-output backup.ogg:backup
```

Load config but allow CLI overrides:
- `--add-input <name>=<spec>` - Add input to config
- `--add-output <file>:<inputs>` - Add output routing
- `--override-input <name>.<setting>=<value>` - Override input setting

## Data Structures

### Configuration Schema

```rust
// src/config.rs

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;

#[derive(Debug, Serialize, Deserialize)]
pub struct Config {
    #[serde(default)]
    pub settings: GlobalSettings,
    
    pub inputs: HashMap<String, InputConfig>,
    
    pub outputs: HashMap<PathBuf, OutputConfig>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct GlobalSettings {
    #[serde(default = "default_fps")]
    pub fps: u32,
    
    #[serde(default = "default_true")]
    pub show_cursor: bool,
}

fn default_fps() -> u32 { 30 }
fn default_true() -> bool { true }

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum InputConfig {
    Display {
        id: DisplayIdOrName,
        #[serde(default)]
        settings: DisplaySettings,
    },
    Window {
        id: u64,
        #[serde(default)]
        settings: WindowSettings,
    },
    Area {
        screen: DisplayIdOrName,
        bounds: AreaBounds,
        #[serde(default)]
        settings: AreaSettings,
    },
    Camera {
        id: CameraIdOrName,
        #[serde(default)]
        settings: CameraSettings,
    },
    Microphone {
        label: String,
        #[serde(default)]
        settings: MicrophoneSettings,
    },
    #[serde(rename = "system-audio")]
    SystemAudio {
        #[serde(default)]
        settings: SystemAudioSettings,
    },
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(untagged)]
pub enum DisplayIdOrName {
    Id(u32),
    Name(String), // "primary", "secondary", etc.
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(untagged)]
pub enum CameraIdOrName {
    Id(u32),
    Name(String),
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct DisplaySettings {
    pub show_cursor: Option<bool>,
    pub fps: Option<u32>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct WindowSettings {
    pub show_cursor: Option<bool>,
    pub fps: Option<u32>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct AreaBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct AreaSettings {
    pub show_cursor: Option<bool>,
    pub fps: Option<u32>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct CameraSettings {
    pub resolution: Option<Resolution>,
    pub fps: Option<u32>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Resolution {
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct MicrophoneSettings {}

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct SystemAudioSettings {}

#[derive(Debug, Serialize, Deserialize)]
pub struct OutputConfig {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub video: Option<String>,
    
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub audio: Vec<String>,
    
    #[serde(skip_serializing_if = "Option::is_none")]
    pub format: Option<String>,
    
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub settings: Option<OutputSettings>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct OutputSettings {
    pub bitrate: Option<String>,
    // Future: quality, codec, etc.
}
```

### Validation

```rust
// src/config.rs

impl Config {
    pub fn validate(&self) -> Result<(), ConfigError> {
        // Validate inputs
        if self.inputs.is_empty() {
            return Err(ConfigError::NoInputs);
        }
        
        for (name, input) in &self.inputs {
            self.validate_input(name, input)?;
        }
        
        // Validate outputs
        if self.outputs.is_empty() {
            return Err(ConfigError::NoOutputs);
        }
        
        for (path, output) in &self.outputs {
            self.validate_output(path, output)?;
        }
        
        Ok(())
    }
    
    fn validate_input(&self, name: &str, input: &InputConfig) -> Result<(), ConfigError> {
        // Validate input-specific constraints
        match input {
            InputConfig::Display { id, .. } => {
                // Check display exists (if possible)
            }
            InputConfig::Camera { id, .. } => {
                // Check camera exists (if possible)
            }
            // ... etc
        }
        
        Ok(())
    }
    
    fn validate_output(&self, path: &PathBuf, output: &OutputConfig) -> Result<(), ConfigError> {
        // Rule 1: Output must have at least one source
        if output.video.is_none() && output.audio.is_empty() {
            return Err(ConfigError::OutputNoSources {
                path: path.clone(),
            });
        }
        
        // Rule 2: Video input must exist and be a video source
        if let Some(video_id) = &output.video {
            let input = self.inputs.get(video_id)
                .ok_or_else(|| ConfigError::InputNotFound {
                    name: video_id.clone(),
                    output: path.clone(),
                })?;
                
            if !input.is_video_source() {
                return Err(ConfigError::InputNotVideoSource {
                    name: video_id.clone(),
                    output: path.clone(),
                });
            }
        }
        
        // Rule 3: Audio inputs must exist and be audio sources
        for audio_id in &output.audio {
            let input = self.inputs.get(audio_id)
                .ok_or_else(|| ConfigError::InputNotFound {
                    name: audio_id.clone(),
                    output: path.clone(),
                })?;
                
            if !input.is_audio_source() {
                return Err(ConfigError::InputNotAudioSource {
                    name: audio_id.clone(),
                    output: path.clone(),
                });
            }
        }
        
        // Rule 4: Check format compatibility
        let format = output.format.as_ref()
            .or_else(|| path.extension()?.to_str())
            .ok_or_else(|| ConfigError::UnknownFormat {
                path: path.clone(),
            })?;
            
        match format {
            "mp4" => {
                // MP4 needs video or audio
                if output.video.is_none() && output.audio.is_empty() {
                    return Err(ConfigError::FormatRequiresVideo {
                        format: format.to_string(),
                        path: path.clone(),
                    });
                }
            }
            "ogg" => {
                // Ogg is audio-only
                if output.video.is_some() {
                    return Err(ConfigError::FormatAudioOnly {
                        format: format.to_string(),
                        path: path.clone(),
                    });
                }
            }
            _ => return Err(ConfigError::UnsupportedFormat {
                format: format.to_string(),
            }),
        }
        
        Ok(())
    }
}

impl InputConfig {
    pub fn is_video_source(&self) -> bool {
        matches!(
            self,
            InputConfig::Display { .. }
                | InputConfig::Window { .. }
                | InputConfig::Area { .. }
                | InputConfig::Camera { .. }
        )
    }
    
    pub fn is_audio_source(&self) -> bool {
        matches!(
            self,
            InputConfig::Microphone { .. } | InputConfig::SystemAudio { .. }
        )
    }
}

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("No inputs defined")]
    NoInputs,
    
    #[error("No outputs defined")]
    NoOutputs,
    
    #[error("Output {path:?} has no sources")]
    OutputNoSources { path: PathBuf },
    
    #[error("Input '{name}' not found (referenced by output {output:?})")]
    InputNotFound { name: String, output: PathBuf },
    
    #[error("Input '{name}' is not a video source (output {output:?})")]
    InputNotVideoSource { name: String, output: PathBuf },
    
    #[error("Input '{name}' is not an audio source (output {output:?})")]
    InputNotAudioSource { name: String, output: PathBuf },
    
    #[error("Unknown format for output {path:?}")]
    UnknownFormat { path: PathBuf },
    
    #[error("Format {format} requires video source (output {path:?})")]
    FormatRequiresVideo { format: String, path: PathBuf },
    
    #[error("Format {format} is audio-only (output {path:?})")]
    FormatAudioOnly { format: String, path: PathBuf },
    
    #[error("Unsupported format: {format}")]
    UnsupportedFormat { format: String },
}
```

## Example Configurations

### Example 1: Simple Screen Recording

```json
{
  "inputs": {
    "screen": {
      "type": "display",
      "id": 0,
      "settings": {}
    }
  },
  "outputs": {
    "recording.mp4": {
      "video": "screen"
    }
  }
}
```

### Example 2: Screen + Camera + Mic

```json
{
  "settings": {
    "fps": 30
  },
  "inputs": {
    "screen": {
      "type": "display",
      "id": "primary",
      "settings": {
        "show_cursor": true
      }
    },
    "webcam": {
      "type": "camera",
      "id": 0,
      "settings": {}
    },
    "mic": {
      "type": "microphone",
      "label": "Blue Yeti",
      "settings": {}
    }
  },
  "outputs": {
    "full-recording.mp4": {
      "video": "screen",
      "audio": ["mic"]
    }
  }
}
```

### Example 3: Multi-Output Recording

```json
{
  "inputs": {
    "screen": {
      "type": "display",
      "id": 0,
      "settings": {}
    },
    "webcam": {
      "type": "camera",
      "id": 0,
      "settings": {}
    },
    "mic1": {
      "type": "microphone",
      "label": "Blue Yeti",
      "settings": {}
    },
    "mic2": {
      "type": "microphone",
      "label": "Focusrite",
      "settings": {}
    },
    "sys": {
      "type": "system-audio",
      "settings": {}
    }
  },
  "outputs": {
    "screen-only.mp4": {
      "video": "screen"
    },
    "webcam-only.mp4": {
      "video": "webcam",
      "audio": ["mic1"]
    },
    "audio-mix.ogg": {
      "audio": ["mic1", "mic2"]
    },
    "full-recording.mp4": {
      "video": "screen",
      "audio": ["mic1", "mic2", "sys"]
    }
  }
}
```

### Example 4: Multi-Display Setup

```json
{
  "inputs": {
    "left_monitor": {
      "type": "display",
      "id": 0,
      "settings": {
        "fps": 60
      }
    },
    "right_monitor": {
      "type": "display",
      "id": 1,
      "settings": {
        "fps": 60
      }
    },
    "mic": {
      "type": "microphone",
      "label": "default",
      "settings": {}
    }
  },
  "outputs": {
    "left-display.mp4": {
      "video": "left_monitor",
      "audio": ["mic"]
    },
    "right-display.mp4": {
      "video": "right_monitor",
      "audio": ["mic"]
    }
  }
}
```

### Example 5: Area Capture with Multiple Outputs

```json
{
  "inputs": {
    "game_window": {
      "type": "area",
      "screen": 0,
      "bounds": {
        "x": 100,
        "y": 100,
        "width": 1920,
        "height": 1080
      },
      "settings": {
        "fps": 60,
        "show_cursor": false
      }
    },
    "facecam": {
      "type": "camera",
      "id": 0,
      "settings": {}
    },
    "game_audio": {
      "type": "system-audio",
      "settings": {}
    },
    "commentary": {
      "type": "microphone",
      "label": "Blue Yeti",
      "settings": {}
    }
  },
  "outputs": {
    "gameplay.mp4": {
      "video": "game_window",
      "audio": ["game_audio", "commentary"]
    },
    "facecam.mp4": {
      "video": "facecam",
      "audio": ["commentary"]
    },
    "commentary-backup.ogg": {
      "audio": ["commentary"]
    }
  }
}
```

## CLI Commands

### Record from Config

```bash
cap-multi-recorder record config.json
```

### Validate Config

```bash
cap-multi-recorder validate config.json
```

Output:
```
✓ Config is valid
✓ 5 inputs defined
✓ 3 outputs defined
✓ All input references resolved
✓ All format constraints satisfied
```

Or with errors:
```
✗ Config validation failed:
  - Output 'recording.mp4' references unknown input 'webcam'
  - Output 'audio.ogg' has video source (format is audio-only)
  - Input 'screen' has no outputs
```

### Generate Config

```bash
cap-multi-recorder generate-config --interactive
```

Interactive prompts:
1. "Select input sources to add:"
2. For each source: "Name this input:", "Configure settings?"
3. "Define outputs:"
4. For each output: "File path:", "Select video source:", "Select audio sources:"
5. Output JSON/YAML

```bash
cap-multi-recorder generate-config --template > template.json
```

Generates template with all input types documented.

### List Inputs

```bash
cap-multi-recorder list --displays --cameras --microphones
```

Output:
```json
{
  "displays": [
    {"id": 0, "name": "Built-in Display", "resolution": "2880x1800"},
    {"id": 1, "name": "LG Monitor", "resolution": "3840x2160"}
  ],
  "cameras": [
    {"id": 0, "name": "FaceTime HD Camera"},
    {"id": 1, "name": "Logitech Webcam"}
  ],
  "microphones": [
    {"label": "Blue Yeti", "default": true},
    {"label": "Focusrite USB"}
  ]
}
```

## Advantages of This Approach

1. **Clear Separation**: Inputs and outputs are independently defined
2. **Reusable Inputs**: Named inputs can be referenced by multiple outputs
3. **Settings per Input**: Each input has its own configuration
4. **Easy Validation**: Can validate input references before initializing hardware
5. **Better for Complex Configs**: More maintainable for scenarios with many inputs/outputs
6. **Tool-Friendly**: Easier to build GUIs/TUIs that generate configs
7. **Version Control**: Config files are more readable and diffable
8. **Composable**: Can merge multiple config files or override sections

## Disadvantages

1. **More Verbose**: Simple scenarios require more configuration
2. **Learning Curve**: Users must understand two-phase structure
3. **Indirection**: Must lookup input IDs to understand routing

## Migration Path

Both approaches can coexist:

1. **Keep original CLI** for simple use cases
2. **Add config file support** for complex scenarios
3. **Provide converter**: `cap-multi-recorder convert` to go from CLI to config format

## Implementation Priority

1. Implement config file parsing and validation
2. Add `validate` command
3. Implement `list` command with JSON output
4. Add `generate-config` interactive mode
5. Integrate with existing record command
6. Add conversion utilities

## Future Enhancements

1. **Config templates**: Pre-built configs for common scenarios
2. **Config inheritance**: Base configs + overrides
3. **Environment variables**: `${ENV_VAR}` substitution in configs
4. **Input groups**: Define groups of inputs to simplify routing
5. **Conditional inputs**: Platform-specific input definitions
6. **Profile support**: Multiple named configurations in one file
