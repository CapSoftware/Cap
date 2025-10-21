use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};

use crate::InputType;

#[derive(Debug, Clone)]
#[allow(dead_code)]
pub enum InputConfig {
    Display(DisplayInputConfig),
     Camera(CameraInputConfig),
     Microphone(MicrophoneInputConfig),
     Window(WindowInputConfig),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DisplayInputConfig {
    pub id: u32,
    pub fps: Option<u32>,
    pub show_cursor: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CameraInputConfig {
    pub id: u32,
    pub resolution: Option<Resolution>,
    pub fps: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MicrophoneInputConfig {
    pub label: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WindowInputConfig {
    pub id: u32,
    pub fps: Option<u32>,
    pub show_cursor: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Resolution {
    pub width: u32,
    pub height: u32,
}

pub fn parse_input_config(
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
                id: opts.id.unwrap_or(0),
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
                id: opts.id.unwrap_or(0),
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
                label: opts.label,
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

#[derive(Deserialize)]
struct DisplayOptions {
    #[serde(default)]
    id: Option<u32>,
    fps: Option<u32>,
    show_cursor: Option<bool>,
}

impl Default for DisplayOptions {
    fn default() -> Self {
        DisplayOptions {
            id: Some(0),
            fps: None,
            show_cursor: Some(true),
        }
    }
}

#[derive(Deserialize)]
struct CameraOptions {
    #[serde(default)]
    id: Option<u32>,
    resolution: Option<Resolution>,
    fps: Option<u32>,
}

impl Default for CameraOptions {
    fn default() -> Self {
        CameraOptions {
            id: Some(0),
            resolution: None,
            fps: None,
        }
    }
}

#[derive(Deserialize)]
struct MicrophoneOptions {
    label: Option<String>,
}

impl Default for MicrophoneOptions {
    fn default() -> Self {
        MicrophoneOptions {
            label: None,
        }
    }
}

#[derive(Deserialize)]
struct WindowOptions {
    id: u32,
    fps: Option<u32>,
    show_cursor: Option<bool>,
}