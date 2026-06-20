use std::path::PathBuf;

use cap_recording::{screen_capture::ScreenCaptureTarget, screenshot::capture_screenshot};
use clap::Args;
use scap_targets::{DisplayId, WindowId};
use serde::Serialize;

use crate::{OutputFormat, resolve_format, write_json};

#[derive(Args)]
pub struct Screenshot {
    /// ID of the screen to capture (see `cap targets screens`)
    #[arg(long, group = "target")]
    screen: Option<DisplayId>,
    /// ID of the window to capture (see `cap targets windows`)
    #[arg(long, group = "target")]
    window: Option<WindowId>,
    /// Output image path (format inferred from extension, e.g. .png)
    #[arg(long)]
    path: PathBuf,
    /// Output format for the result (json emits {"path","width","height"})
    #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
    format: OutputFormat,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ScreenshotResult {
    path: PathBuf,
    width: u32,
    height: u32,
}

impl Screenshot {
    pub async fn run(self, json: bool) -> Result<(), String> {
        let format = resolve_format(json, self.format);
        match self.run_inner(format).await {
            Ok(()) => Ok(()),
            Err(error) => {
                if format == OutputFormat::Json {
                    let _ = write_json(&serde_json::json!({ "error": error }));
                }
                Err(error)
            }
        }
    }

    async fn run_inner(self, format: OutputFormat) -> Result<(), String> {
        let target = match (self.screen, self.window) {
            (Some(id), _) => resolve_screen(&id)?,
            (_, Some(id)) => resolve_window(&id)?,
            _ => {
                return Err(
                    "No target specified; pass --screen <id> or --window <id> (see `cap targets`)"
                        .to_string(),
                );
            }
        };

        let automation_target = target.clone();

        let image = capture_screenshot(target)
            .await
            .map_err(|e| format!("Screenshot failed: {e}"))?;
        let (width, height) = (image.width(), image.height());
        image
            .save(&self.path)
            .map_err(|e| format!("Failed to write screenshot to {}: {e}", self.path.display()))?;

        crate::automation::run_screenshot(&self.path, &automation_target).await;

        match format {
            OutputFormat::Json => write_json(&ScreenshotResult {
                path: self.path,
                width,
                height,
            }),
            OutputFormat::Text => {
                println!("Screenshot saved: {}", self.path.display());
                Ok(())
            }
        }
    }
}

fn resolve_screen(id: &DisplayId) -> Result<ScreenCaptureTarget, String> {
    cap_recording::screen_capture::list_displays()
        .into_iter()
        .find(|s| &s.0.id == id)
        .map(|(s, _)| ScreenCaptureTarget::Display { id: s.id })
        .ok_or_else(|| {
            let available: Vec<String> = cap_recording::screen_capture::list_displays()
                .into_iter()
                .map(|(s, _)| s.id.to_string())
                .collect();
            format!("Screen with id '{id}' not found. Available screen ids: {available:?}")
        })
}

fn resolve_window(id: &WindowId) -> Result<ScreenCaptureTarget, String> {
    cap_recording::screen_capture::list_windows()
        .into_iter()
        .find(|s| &s.0.id == id)
        .map(|(s, _)| ScreenCaptureTarget::Window { id: s.id })
        .ok_or_else(|| {
            format!("Window with id '{id}' not found. Run `cap targets windows` to list window ids")
        })
}
