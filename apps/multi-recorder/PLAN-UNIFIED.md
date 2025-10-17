# Multi-Recorder CLI Plan - Unified Approach

## Overview

A flexible CLI tool that supports both command-line routing and complex configuration files. The key principle: **Define inputs, route to outputs**.

## Core Design Philosophy

**Two-Phase Declaration**:
1. **Define Inputs**: Declare all input sources with `--input <name> --type <type> [--options <json5>]`
2. **Route to Outputs**: Map inputs to output files with `--output <path> <input>...`
3. **File Configs**: For complex scenarios, use complete JSON/YAML config files

This approach provides:
- Clean separation of source definition from routing
- Natural composability (inputs are reusable)
- Simple CLI for basic use cases with json5 syntax
- Full config files for complex, repeatable scenarios
- No forced abstraction - use what you need

## CLI Interface

### Basic Pattern

```bash
cap-multi-recorder \
  --input screen --type display --options {id:0,fps:60} \
  --input mic --type microphone --options {deviceId:"default"} \
  --output out.mp4 screen mic \
  --output mic-only.mp3 mic
```

**Flow**:
1. Define `screen` input as display #0 at 60fps
2. Define `mic` input as default microphone
3. Create `out.mp4` with screen + mic
4. Create `mic-only.mp3` with mic only

### Simple Example (No Options)

```bash
cap-multi-recorder \
  --input screen --type display \
  --input mic --type microphone \
  --output recording.mp4 screen mic
```

### Complex Multi-Source Example

```bash
cap-multi-recorder \
  --input main --type display --options {id:0,fps:60,show_cursor:true} \
  --input secondary --type display --options {id:1,fps:30} \
  --input cam --type camera --options {id:0,resolution:{width:1920,height:1080}} \
  --input mic --type microphone --options {label:"Blue Yeti"} \
  --output full.mp4 main cam mic \
  --output screen-only.mp4 main mic \
  --output secondary.mp4 secondary mic \
  --output webcam.mp4 cam
```

### Full Config File Mode

```bash
cap-multi-recorder config.json
```

Where `config.json` uses the two-phase format from PLAN-JSON-CONFIG.md.

## Command-Line Argument Format

### Input Declaration

**Pattern**: `--input <NAME> --type <TYPE> [--options <JSON5>]`

```bash
# Display input
--input screen --type display --options {id:0,fps:60,show_cursor:true}

# Camera input
--input cam --type camera --options {id:0,resolution:{width:1920,height:1080},fps:30}

# Microphone input
--input mic --type microphone --options {label:"Blue Yeti"}

# Window input
--input win --type window --options {id:12345,fps:30}

# Without options (uses defaults)
--input screen --type display
```

**Input Types**:
- `display`: Screen capture
- `camera`: Webcam/camera device
- `microphone`: Audio input device
- `window`: Window capture

### Output Declaration

**Pattern**: `--output <PATH> <INPUT_NAME>...`

```bash
# Single input
--output video.mp4 screen

# Multiple inputs (composited)
--output full.mp4 screen cam mic

# Same input to multiple outputs
--input screen --type display
--output out1.mp4 screen
--output out2.mp4 screen

# Different combinations
--output screen-only.mp4 screen
--output audio-only.mp3 mic
--output full.mp4 screen cam mic
```

### Detailed Syntax

```bash
cap-multi-recorder [OPTIONS] [CONFIG_FILE]

Input Declaration (repeatable):
  --input <NAME>
      Unique name for this input source
      
  --type <TYPE>
      Input type: display | camera | microphone | window
      (Must follow --input)
      
  --options <JSON5>
      Input-specific configuration in json5 format
      (Optional, must follow --type)

Output Declaration (repeatable):
  --output <PATH> <INPUT>...
      Create output file with specified inputs
      PATH: Output file path
      INPUT: One or more input names

Config File:
  [CONFIG_FILE]
      Full JSON/YAML config file (disables CLI mode)
```

## JSON5 Options Schema

### Display Options

```json5
{
  id: 0,              // Display index (0, 1, ...) or "primary"
  fps: 60,            // Frame rate (optional)
  show_cursor: true   // Show cursor in capture (optional)
}
```

### Window Options

```json5
{
  id: 12345,          // Window ID
  fps: 30,            // Frame rate (optional)
  show_cursor: true   // Show cursor (optional)
}
```

### Camera Options

```json5
{
  id: 0,              // Camera index or "default"
  resolution: {       // Desired resolution (optional)
    width: 1920,
    height: 1080
  },
  fps: 30            // Frame rate (optional)
}
```

### Microphone Options

```json5
{
  label: "Blue Yeti",  // Device label or "default"
  // No additional settings currently
}
```

**Note**: json5 allows:
- Unquoted keys: `{id:0}` instead of `{"id":0}`
- Comments: `{id:0 /* main display */}`
- Trailing commas: `{id:0,fps:60,}`
- Single quotes: `{label:'Blue Yeti'}`

## Full Config File Format

For complex scenarios, use complete config files with two-phase declaration:

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
        "fps": 60
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
    "recording.mp4": {
      "video": "main_display",
      "audio": ["mic"]
    }
  }
}
```

## Examples

### Example 1: Simple Screen Recording

```bash
cap-multi-recorder \
  --input screen --type display \
  --output recording.mp4 screen
```

### Example 2: Screen + Microphone

```bash
cap-multi-recorder \
  --input screen --type display \
  --input mic --type microphone \
  --output recording.mp4 screen mic
```

### Example 3: High-FPS Gaming Capture

```bash
cap-multi-recorder \
  --input screen --type display --options {id:0,fps:120,show_cursor:false} \
  --input mic --type microphone --options {label:"Blue Yeti"} \
  --output gameplay.mp4 screen mic
```

### Example 4: Multiple Outputs from Same Sources

```bash
cap-multi-recorder \
  --input screen --type display --options {id:0,fps:60} \
  --input mic --type microphone \
  --output full.mp4 screen mic \
  --output video-only.mp4 screen \
  --output audio-only.mp3 mic
```

Result:
- `full.mp4`: screen + mic
- `video-only.mp4`: screen only
- `audio-only.mp3`: mic only

### Example 5: Multi-Display Recording

```bash
cap-multi-recorder \
  --input left --type display --options {id:0,fps:60} \
  --input right --type display --options {id:1,fps:60} \
  --input mic --type microphone \
  --output left-monitor.mp4 left mic \
  --output right-monitor.mp4 right mic
```

### Example 6: Complex Multi-Source Setup

```bash
cap-multi-recorder \
  --input screen --type display --options {id:0,fps:60} \
  --input cam --type camera --options {id:0,resolution:{width:1920,height:1080},fps:30} \
  --input mic --type microphone --options {label:"Blue Yeti"} \
  --output full.mp4 screen cam mic \
  --output screen-only.mp4 screen \
  --output webcam.mp4 cam \
  --output audio.mp3 mic
```

Result:
- `full.mp4`: screen + camera + mic (composited)
- `screen-only.mp4`: screen capture only
- `webcam.mp4`: camera only
- `audio.mp3`: microphone only

### Example 7: Full Config File

```bash
cap-multi-recorder config.json
```

Where `config.json` contains complete input/output configuration.

## Implementation

### CLI Argument Parsing

```rust
// src/main.rs

use clap::Parser;
use json5;

#[derive(Parser)]
#[command(
    name = "cap-multi-recorder",
    about = "Record multiple audio/video sources to multiple outputs"
)]
struct Cli {
    /// Config file (disables CLI mode)
    config: Option<PathBuf>,
}

#[derive(Parser)]
struct InputGroup {
    /// Input name
    #[arg(long)]
    input: String,
    
    /// Input type: display | camera | microphone | window
    #[arg(long, requires = "input")]
    r#type: InputType,
    
    /// Input options (json5 format)
    #[arg(long, requires = "type")]
    options: Option<String>,
}

#[derive(Parser)]
struct OutputGroup {
    /// Output file path
    #[arg(long)]
    output: PathBuf,
    
    /// Input names to include
    #[arg(requires = "output")]
    inputs: Vec<String>,
}

#[derive(Clone, Copy, ValueEnum)]
enum InputType {
    Display,
    Camera,
    Microphone,
    Window,
}

// Manual parsing since clap doesn't easily support grouped repeating args
fn parse_cli_args() -> Result<CliConfig> {
    let args: Vec<String> = std::env::args().collect();
    
    let mut inputs = Vec::new();
    let mut outputs = Vec::new();
    let mut i = 1;
    
    while i < args.len() {
        match args[i].as_str() {
            "--input" => {
                let name = args.get(i + 1).context("--input requires NAME")?;
                let type_flag = args.get(i + 2).context("--input requires --type")?;
                if type_flag != "--type" {
                    bail!("--input must be followed by --type");
                }
                let input_type = args.get(i + 3).context("--type requires TYPE")?;
                
                let mut options = None;
                let mut consumed = 4;
                
                if args.get(i + 4).map(|s| s.as_str()) == Some("--options") {
                    options = Some(args.get(i + 5).context("--options requires JSON5")?.clone());
                    consumed = 6;
                }
                
                inputs.push(InputDecl {
                    name: name.clone(),
                    input_type: parse_input_type(input_type)?,
                    options,
                });
                
                i += consumed;
            }
            "--output" => {
                let path = args.get(i + 1).context("--output requires PATH")?;
                let mut input_names = Vec::new();
                let mut j = i + 2;
                
                while j < args.len() && !args[j].starts_with("--") {
                    input_names.push(args[j].clone());
                    j += 1;
                }
                
                if input_names.is_empty() {
                    bail!("--output requires at least one input name");
                }
                
                outputs.push(OutputDecl {
                    path: PathBuf::from(path),
                    inputs: input_names,
                });
                
                i = j;
            }
            _ => {
                // Check if it's a config file (positional arg)
                if !args[i].starts_with("--") {
                    return Ok(CliConfig::File(PathBuf::from(&args[i])));
                }
                bail!("Unknown argument: {}", args[i]);
            }
        }
    }
    
    Ok(CliConfig::Routing { inputs, outputs })
}

struct InputDecl {
    name: String,
    input_type: InputType,
    options: Option<String>,
}

struct OutputDecl {
    path: PathBuf,
    inputs: Vec<String>,
}

enum CliConfig {
    Routing { inputs: Vec<InputDecl>, outputs: Vec<OutputDecl> },
    File(PathBuf),
}
```

### Options Parsing

```rust
// src/config.rs

use json5;

fn parse_input_config(
    name: &str,
    input_type: InputType,
    options: Option<&str>,
) -> Result<InputConfig> {
    match input_type {
        InputType::Display => {
            let opts: DisplayOptions = if let Some(json5_str) = options {
                json5::from_str(json5_str)
                    .with_context(|| format!("Invalid display options for '{}'", name))?
            } else {
                DisplayOptions::default()
            };
            
            Ok(InputConfig::Display(DisplayInputConfig {
                id: opts.id,
                fps: opts.fps,
                show_cursor: opts.show_cursor.unwrap_or(true),
            }))
        }
        InputType::Camera => {
            let opts: CameraOptions = if let Some(json5_str) = options {
                json5::from_str(json5_str)
                    .with_context(|| format!("Invalid camera options for '{}'", name))?
            } else {
                CameraOptions::default()
            };
            
            Ok(InputConfig::Camera(CameraInputConfig {
                id: opts.id,
                resolution: opts.resolution,
                fps: opts.fps,
            }))
        }
        InputType::Microphone => {
            let opts: MicrophoneOptions = if let Some(json5_str) = options {
                json5::from_str(json5_str)
                    .with_context(|| format!("Invalid microphone options for '{}'", name))?
            } else {
                MicrophoneOptions::default()
            };
            
            Ok(InputConfig::Microphone(MicrophoneInputConfig {
                label: opts.label.unwrap_or_else(|| "default".to_string()),
            }))
        }
        InputType::Window => {
            let opts: WindowOptions = if let Some(json5_str) = options {
                json5::from_str(json5_str)
                    .with_context(|| format!("Invalid window options for '{}'", name))?
            } else {
                bail!("Window input requires id in options");
            };
            
            Ok(InputConfig::Window(WindowInputConfig {
                id: opts.id,
                fps: opts.fps,
                show_cursor: opts.show_cursor.unwrap_or(true),
            }))
        }
    }
}

#[derive(Deserialize, Default)]
struct DisplayOptions {
    id: Option<u32>,
    fps: Option<u32>,
    show_cursor: Option<bool>,
}

#[derive(Deserialize, Default)]
struct CameraOptions {
    id: Option<u32>,
    resolution: Option<Resolution>,
    fps: Option<u32>,
}

#[derive(Deserialize, Default)]
struct MicrophoneOptions {
    label: Option<String>,
}

#[derive(Deserialize)]
struct WindowOptions {
    id: u32,
    fps: Option<u32>,
    show_cursor: Option<bool>,
}

#[derive(Deserialize)]
struct Resolution {
    width: u32,
    height: u32,
}
```

### Routing Construction

```rust
// src/routing.rs

pub struct Routing {
    pub inputs: HashMap<String, InputConfig>,
    pub outputs: HashMap<PathBuf, OutputConfig>,
}

pub struct OutputConfig {
    pub path: PathBuf,
    pub video_input: Option<String>,
    pub audio_inputs: Vec<String>,
}

pub fn build_routing(cli_config: CliConfig) -> Result<Routing> {
    match cli_config {
        CliConfig::File(path) => {
            let contents = std::fs::read_to_string(&path)?;
            let config: FileConfig = json5::from_str(&contents)?;
            config.validate()?;
            file_config_to_routing(config)
        }
        CliConfig::Routing { inputs, outputs } => {
            cli_routing_to_routing(inputs, outputs)
        }
    }
}

fn cli_routing_to_routing(
    input_decls: Vec<InputDecl>,
    output_decls: Vec<OutputDecl>,
) -> Result<Routing> {
    let mut inputs = HashMap::new();
    
    // Parse all inputs
    for decl in input_decls {
        let config = parse_input_config(&decl.name, decl.input_type, decl.options.as_deref())?;
        inputs.insert(decl.name.clone(), config);
    }
    
    // Build outputs
    let mut outputs = HashMap::new();
    for decl in output_decls {
        // Determine which inputs are video vs audio
        let mut video_input = None;
        let mut audio_inputs = Vec::new();
        
        for input_name in &decl.inputs {
            let input_config = inputs.get(input_name)
                .with_context(|| format!("Unknown input '{}' in output '{}'", input_name, decl.path.display()))?;
            
            match input_config {
                InputConfig::Display(_) | InputConfig::Camera(_) | InputConfig::Window(_) => {
                    if video_input.is_some() {
                        bail!("Output '{}' has multiple video inputs", decl.path.display());
                    }
                    video_input = Some(input_name.clone());
                }
                InputConfig::Microphone(_) => {
                    audio_inputs.push(input_name.clone());
                }
            }
        }
        
        outputs.insert(decl.path.clone(), OutputConfig {
            path: decl.path.clone(),
            video_input,
            audio_inputs,
        });
    }
    
    // Validate
    validate_routing(&inputs, &outputs)?;
    
    Ok(Routing { inputs, outputs })
}
```

## Validation

### CLI Mode Validation

```rust
pub fn validate_routing(mapping: &SourceOutputMapping) -> Result<()> {
    // Same validation as before:
    // 1. At least one source
    // 2. Each source has ≥1 output
    // 3. Each output has ≥1 source
    // 4. Format compatibility
    // 5. Only one video source per output
    
    Ok(())
}
```

### JSON Validation

When parsing inline JSON or file references, validate schema:

```rust
fn parse_display_spec(spec: SourceSpec, global: &GlobalSettings) -> Result<DisplayInputConfig> {
    let config = match spec {
        SourceSpec::Simple(id) => DisplayInputConfig {
            id: parse_display_id(&id)?,
            settings: DisplaySettings::from_global(global),
        },
        SourceSpec::Json(json) => {
            // Validate against schema
            serde_json::from_value::<DisplayInputConfig>(json)
                .context("Invalid display configuration")?
        }
        SourceSpec::File(path) => {
            let contents = fs::read_to_string(&path)
                .with_context(|| format!("Failed to read {}", path.display()))?;
            serde_json::from_str(&contents)
                .with_context(|| format!("Invalid JSON in {}", path.display()))?
        }
    };
    
    // Additional validation
    validate_display_config(&config)?;
    
    Ok(config)
}
```

## Help Text

```
USAGE:
    cap-multi-recorder record [OPTIONS] [CONFIG_FILE]

ROUTING:
    Specify sources and their target outputs via CLI flags.
    Each source can be:
      - Simple ID: --display 0 output.mp4
      - JSON: --display '{"id":0,"settings":{"fps":60}}' output.mp4
      - File: --display @config.json output.mp4

OPTIONS:
    --display <SPEC> <OUTPUT>...
            Capture display. SPEC: ID | JSON | @file
            
    --camera <SPEC> <OUTPUT>...
            Capture camera. SPEC: ID | JSON | @file
            
    --microphone <SPEC> <OUTPUT>...
            Capture microphone. SPEC: label | JSON | @file
            
    --window <SPEC> <OUTPUT>...
            Capture window. SPEC: ID | JSON | @file
            
    --system-audio <OUTPUT>...
            Capture system audio
            
    --fps <FPS>
            Default frame rate for video sources
            
    --cursor
            Default cursor visibility

CONFIG FILE:
    [CONFIG_FILE]
            Use full JSON/YAML config (disables CLI routing)

EXAMPLES:
    # Simple
    cap-multi-recorder record --display 0 output.mp4
    
    # With settings
    cap-multi-recorder record \
        --display '{"id":0,"settings":{"fps":60}}' output.mp4
    
    # Multiple sources
    cap-multi-recorder record \
        --display 0 screen.mp4 full.mp4 \
        --camera 0 webcam.mp4 full.mp4 \
        --microphone "Blue Yeti" full.mp4
    
    # Settings from file
    cap-multi-recorder record \
        --display @display-config.json output.mp4
    
    # Full config
    cap-multi-recorder record config.json
```

## Advantages of Unified Approach

1. **Simple for Simple Cases**: Just use IDs, no JSON required
2. **Flexible for Complex Cases**: Inline JSON or file references for detailed config
3. **No Forced Abstraction**: Use simple or complex forms as needed
4. **Gradual Complexity**: Start simple, add JSON when needed
5. **Both Worlds**: CLI for quick use, config files for repeatability
6. **Consistent**: Same JSON schema everywhere (CLI, files, full configs)

## Migration Path

Users can start simple and gradually increase complexity:

1. **Day 1**: `--display 0 output.mp4`
2. **Week 1**: `--display '{"id":0,"settings":{"fps":60}}' output.mp4`
3. **Month 1**: `--display @display-60fps.json output.mp4` (reusable config)
4. **Month 2**: `cap-multi-recorder record streaming-setup.json` (full config)

## Implementation Priority

1. ✅ Core routing structures
2. ✅ Simple ID parsing (`--display 0`)
3. ✅ Inline JSON parsing (`--display '{...}'`)
4. ✅ File reference parsing (`--display @file.json`)
5. ✅ Full config file support
6. ✅ Validation for all modes
7. ✅ Help text and examples
8. ✅ Error messages for common mistakes

## Testing Strategy

### Unit Tests
- Parse simple IDs
- Parse inline JSON
- Parse file references
- Validate each format
- Error cases

### Integration Tests
- CLI routing with simple IDs
- CLI routing with JSON
- CLI routing with files
- Full config files
- Mixed approaches

### E2E Tests
- Record with CLI routing
- Record with full config
- Multiple formats in one command
