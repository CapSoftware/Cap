use clap::Args;

#[derive(Args)]
pub struct SystemInfoArgs {
    #[arg(long)]
    json: Option<bool>,
}

impl SystemInfoArgs {
    pub async fn run(self, json_default: bool) -> Result<(), String> {
        let json = self.json.unwrap_or(json_default);
        let diagnostics = cap_recording::diagnostics::collect_diagnostics();
        let hardware = cap_recording::diagnostics::collect_hardware_info();
        let displays = cap_recording::diagnostics::collect_displays();

        if json {
            let output = serde_json::json!({
                "diagnostics": diagnostics,
                "hardware": hardware,
                "displays": displays,
            });
            println!("{}", serde_json::to_string_pretty(&output).unwrap());
        } else {
            print_human_readable(&diagnostics, &hardware, &displays);
        }
        Ok(())
    }
}

#[cfg(target_os = "macos")]
fn print_human_readable(
    diag: &cap_recording::diagnostics::SystemDiagnostics,
    hw: &cap_recording::diagnostics::HardwareInfo,
    displays: &[cap_recording::diagnostics::DisplayDiagnostics],
) {
    if let Some(ref ver) = diag.macos_version {
        eprintln!(
            "Operating System:  macOS {}.{}.{}{}",
            ver.major,
            ver.minor,
            ver.patch,
            if ver.is_apple_silicon {
                " (Apple Silicon)"
            } else {
                ""
            }
        );
    }
    eprintln!(
        "Capture Support:   {}",
        if diag.screen_capture_supported {
            "Screen Capture: Supported"
        } else {
            "Screen Capture: Not Supported"
        }
    );
    if let Some(ref gpu) = diag.gpu_name {
        eprintln!(
            "GPU:               {}{}",
            gpu,
            if diag.metal_supported {
                " (Metal supported)"
            } else {
                ""
            }
        );
    }
    eprintln!(
        "CPU:               {} ({} cores)",
        hw.cpu_brand, hw.cpu_cores
    );
    eprintln!("Memory:            {} MB", hw.total_memory_mb);

    if !diag.available_encoders.is_empty() {
        eprintln!("\nAvailable Encoders:");
        eprintln!("  {}", diag.available_encoders.join("  "));
    }

    if !displays.is_empty() {
        eprintln!("\nDisplays:");
        for d in displays {
            eprintln!(
                "  {}  {}x{} @{}Hz ({}x scale{})",
                d.name,
                d.width,
                d.height,
                d.refresh_rate,
                d.scale_factor,
                if d.is_primary { ", primary" } else { "" }
            );
        }
    }
}

#[cfg(target_os = "windows")]
fn print_human_readable(
    diag: &cap_recording::diagnostics::SystemDiagnostics,
    hw: &cap_recording::diagnostics::HardwareInfo,
    displays: &[cap_recording::diagnostics::DisplayDiagnostics],
) {
    if let Some(ref ver) = diag.windows_version {
        eprintln!("Operating System:  {}", ver.display_name);
    }
    eprintln!(
        "Capture Support:   {}",
        if diag.graphics_capture_supported {
            "Graphics Capture: Supported"
        } else {
            "Graphics Capture: Not Supported"
        }
    );
    if let Some(ref gpu) = diag.gpu_info {
        eprintln!("GPU:               {} ({})", gpu.description, gpu.vendor);
    }
    eprintln!(
        "CPU:               {} ({} cores)",
        hw.cpu_brand, hw.cpu_cores
    );
    eprintln!("Memory:            {} MB", hw.total_memory_mb);

    if !diag.available_encoders.is_empty() {
        eprintln!("\nAvailable Encoders:");
        eprintln!("  {}", diag.available_encoders.join("  "));
    }

    if !displays.is_empty() {
        eprintln!("\nDisplays:");
        for d in displays {
            eprintln!(
                "  {}  {}x{} @{}Hz ({}x scale{})",
                d.name,
                d.width,
                d.height,
                d.refresh_rate,
                d.scale_factor,
                if d.is_primary { ", primary" } else { "" }
            );
        }
    }
}
