mod configuration;
pub mod cursor;
pub mod keyboard;
mod meta;

pub use configuration::*;
pub use cursor::*;
pub use keyboard::*;
pub use meta::*;

use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RecordingConfig {
    pub fps: u32,
    pub resolution: Resolution,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct Resolution {
    pub width: u32,
    pub height: u32,
}

impl Default for RecordingConfig {
    fn default() -> Self {
        Self {
            fps: 30,
            resolution: Resolution {
                width: 1920,
                height: 1080,
            },
        }
    }
}
