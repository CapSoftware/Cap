mod audio;
mod cameras;
mod displays;

pub use audio::*;
pub use cameras::*;
pub use displays::*;

use anyhow::Result;
use colored::Colorize;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiscoveredHardware {
    pub displays: Vec<DiscoveredDisplay>,
    pub cameras: Vec<DiscoveredCamera>,
    pub audio_inputs: Vec<DiscoveredAudioInput>,
    pub audio_outputs: Vec<DiscoveredAudioOutput>,
    pub system_info: SystemInfo,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SystemInfo {
    pub platform: String,
    pub cpu: String,
    pub memory_gb: u64,
    pub gpu: Option<String>,
}

impl DiscoveredHardware {
    pub async fn discover() -> Result<Self> {
        let displays = discover_displays()?;
        let cameras = discover_cameras()?;
        let (audio_inputs, audio_outputs) = discover_audio_devices()?;
        let system_info = discover_system_info();

        Ok(Self {
            displays,
            cameras,
            audio_inputs,
            audio_outputs,
            system_info,
        })
    }

    pub fn print_summary(&self) {
        println!("\n{}", "=== Hardware Discovery ===".bold().cyan());

        println!("\n{}", "System Info:".bold());
        println!("  Platform: {}", self.system_info.platform);
        println!("  CPU: {}", self.system_info.cpu);
        println!("  Memory: {} GB", self.system_info.memory_gb);
        if let Some(gpu) = &self.system_info.gpu {
            println!("  GPU: {}", gpu);
        }

        println!("\n{} ({})", "Displays:".bold(), self.displays.len());
        for display in &self.displays {
            println!(
                "  {} - {}x{} @ {:.0}Hz",
                display.name.as_deref().unwrap_or("Unknown"),
                display.physical_width,
                display.physical_height,
                display.refresh_rate
            );
        }

        println!("\n{} ({})", "Cameras:".bold(), self.cameras.len());
        for camera in &self.cameras {
            let formats_str = camera
                .formats
                .iter()
                .take(3)
                .map(|f| format!("{}x{}@{}fps", f.width, f.height, f.frame_rate))
                .collect::<Vec<_>>()
                .join(", ");
            let suffix = if camera.formats.len() > 3 {
                format!(" +{} more", camera.formats.len() - 3)
            } else {
                String::new()
            };
            println!("  {} - {}{}", camera.name, formats_str, suffix);
        }

        println!("\n{} ({})", "Audio Inputs:".bold(), self.audio_inputs.len());
        for input in &self.audio_inputs {
            let device_type = if input.is_bluetooth {
                " [Bluetooth]"
            } else if input.is_usb {
                " [USB]"
            } else {
                ""
            };
            println!(
                "  {} - {}Hz, {} ch{}",
                input.name,
                input.sample_rates.first().unwrap_or(&0),
                input.channels,
                device_type
            );
        }

        println!(
            "\n{} ({})",
            "Audio Outputs:".bold(),
            self.audio_outputs.len()
        );
        for output in &self.audio_outputs {
            println!(
                "  {} - {}Hz, {} ch",
                output.name,
                output.sample_rates.first().unwrap_or(&0),
                output.channels
            );
        }

        println!();
    }
}

fn discover_system_info() -> SystemInfo {
    use sysinfo::System;

    let mut sys = System::new_all();
    sys.refresh_all();

    let cpu = sys
        .cpus()
        .first()
        .map(|c| c.brand().to_string())
        .unwrap_or_else(|| "Unknown".to_string());

    let memory_gb = sys.total_memory() / 1024 / 1024 / 1024;

    let platform = if cfg!(target_os = "macos") {
        "macOS".to_string()
    } else if cfg!(target_os = "windows") {
        "Windows".to_string()
    } else {
        "Unknown".to_string()
    };

    let gpu = detect_gpu();

    SystemInfo {
        platform,
        cpu,
        memory_gb,
        gpu,
    }
}

#[cfg(target_os = "macos")]
fn detect_gpu() -> Option<String> {
    Some("Apple Silicon / Intel UHD".to_string())
}

#[cfg(target_os = "windows")]
fn detect_gpu() -> Option<String> {
    None
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn detect_gpu() -> Option<String> {
    None
}
