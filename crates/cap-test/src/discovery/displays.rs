use anyhow::Result;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiscoveredDisplay {
    pub id: String,
    pub name: Option<String>,
    pub physical_width: u32,
    pub physical_height: u32,
    pub logical_width: f64,
    pub logical_height: f64,
    pub refresh_rate: f64,
    pub is_primary: bool,
    pub scale_factor: f64,
}

impl DiscoveredDisplay {
    pub fn resolution_label(&self) -> String {
        let w = self.physical_width;
        let h = self.physical_height;

        match (w, h) {
            (1280, 720) => "720p".to_string(),
            (1920, 1080) => "1080p".to_string(),
            (2560, 1440) => "1440p".to_string(),
            (3840, 2160) => "4K".to_string(),
            (5120, 2880) => "5K".to_string(),
            (2560, 1080) => "UW-1080".to_string(),
            (3440, 1440) => "UW-1440".to_string(),
            (5120, 1440) => "SUW".to_string(),
            (2880, 1800) => "Retina".to_string(),
            (3024, 1964) => "MBP-14".to_string(),
            (3456, 2234) => "MBP-16".to_string(),
            _ => format!("{}x{}", w, h),
        }
    }
}

pub fn discover_displays() -> Result<Vec<DiscoveredDisplay>> {
    use scap_targets::Display;

    let displays = Display::list();
    let primary = Display::primary();
    let primary_id = primary.id().to_string();

    let mut result = Vec::new();

    for display in displays {
        let id = display.id().to_string();
        let name = display.name();
        let physical_size = display.physical_size();
        let logical_size = display.logical_size();
        let refresh_rate = display.refresh_rate();

        let (physical_width, physical_height) = physical_size
            .map(|s| (s.width() as u32, s.height() as u32))
            .unwrap_or((0, 0));

        let (logical_width, logical_height) = logical_size
            .map(|s| (s.width(), s.height()))
            .unwrap_or((0.0, 0.0));

        let scale_factor = if logical_width > 0.0 {
            physical_width as f64 / logical_width
        } else {
            1.0
        };

        result.push(DiscoveredDisplay {
            id: id.clone(),
            name,
            physical_width,
            physical_height,
            logical_width,
            logical_height,
            refresh_rate,
            is_primary: id == primary_id,
            scale_factor,
        });
    }

    Ok(result)
}
