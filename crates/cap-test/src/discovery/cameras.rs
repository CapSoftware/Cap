use anyhow::Result;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiscoveredCamera {
    pub id: String,
    pub name: String,
    pub formats: Vec<CameraFormat>,
    pub is_virtual: bool,
    pub is_capture_card: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CameraFormat {
    pub width: u32,
    pub height: u32,
    pub frame_rate: f32,
    pub pixel_format: Option<String>,
}

#[allow(dead_code)]
impl CameraFormat {
    pub fn resolution_label(&self) -> String {
        match (self.width, self.height) {
            (320, 240) => "QVGA".to_string(),
            (640, 480) => "VGA".to_string(),
            (1280, 720) => "720p".to_string(),
            (1920, 1080) => "1080p".to_string(),
            (3840, 2160) => "4K".to_string(),
            _ => format!("{}x{}", self.width, self.height),
        }
    }
}

pub fn discover_cameras() -> Result<Vec<DiscoveredCamera>> {
    use cap_camera::list_cameras;

    let mut result = Vec::new();

    for camera in list_cameras() {
        let id = camera.device_id().to_string();
        let name = camera.display_name().to_string();

        let is_virtual = is_virtual_camera(&name);
        let is_capture_card = is_capture_card_device(&name);

        let formats = camera
            .formats()
            .unwrap_or_default()
            .into_iter()
            .map(|f| CameraFormat {
                width: f.width(),
                height: f.height(),
                frame_rate: f.frame_rate(),
                pixel_format: None,
            })
            .collect();

        result.push(DiscoveredCamera {
            id,
            name,
            formats,
            is_virtual,
            is_capture_card,
        });
    }

    Ok(result)
}

fn is_virtual_camera(name: &str) -> bool {
    let lower = name.to_lowercase();
    lower.contains("obs")
        || lower.contains("virtual")
        || lower.contains("manycam")
        || lower.contains("xsplit")
        || lower.contains("snap")
        || lower.contains("mmhmm")
        || lower.contains("camo")
}

fn is_capture_card_device(name: &str) -> bool {
    let lower = name.to_lowercase();
    lower.contains("elgato")
        || lower.contains("avermedia")
        || lower.contains("magewell")
        || lower.contains("blackmagic")
        || lower.contains("capture")
        || lower.contains("cam link")
}
