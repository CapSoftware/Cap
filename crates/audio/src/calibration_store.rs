use crate::sync_analysis::DeviceSyncCalibration;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct CalibrationStore {
    calibrations: HashMap<String, StoredCalibration>,
    #[serde(default)]
    version: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredCalibration {
    pub camera_id: String,
    pub microphone_id: String,
    pub offset_secs: f64,
    pub confidence: f64,
    pub measurement_count: u32,
    #[serde(default)]
    pub last_updated_ms: u64,
}

impl CalibrationStore {
    const CURRENT_VERSION: u32 = 1;
    const FILENAME: &'static str = "sync_calibrations.json";

    pub fn new() -> Self {
        Self {
            calibrations: HashMap::new(),
            version: Self::CURRENT_VERSION,
        }
    }

    pub fn load(data_dir: &Path) -> Self {
        let path = data_dir.join(Self::FILENAME);

        if !path.exists() {
            return Self::new();
        }

        match std::fs::read_to_string(&path) {
            Ok(contents) => serde_json::from_str(&contents).unwrap_or_else(|e| {
                tracing::warn!("Failed to parse calibration store: {}, creating new", e);
                Self::new()
            }),
            Err(e) => {
                tracing::warn!("Failed to read calibration store: {}, creating new", e);
                Self::new()
            }
        }
    }

    pub fn save(&self, data_dir: &Path) -> Result<(), std::io::Error> {
        let path = data_dir.join(Self::FILENAME);

        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }

        let contents = serde_json::to_string_pretty(self)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;

        std::fs::write(&path, contents)
    }

    fn make_key(camera_id: &str, microphone_id: &str) -> String {
        format!("{camera_id}|{microphone_id}")
    }

    pub fn get_calibration(
        &self,
        camera_id: &str,
        microphone_id: &str,
    ) -> Option<&StoredCalibration> {
        let key = Self::make_key(camera_id, microphone_id);
        self.calibrations.get(&key)
    }

    pub fn get_offset(&self, camera_id: &str, microphone_id: &str) -> Option<f64> {
        self.get_calibration(camera_id, microphone_id)
            .filter(|c| c.confidence >= 0.5)
            .map(|c| c.offset_secs)
    }

    pub fn update_calibration(&mut self, calibration: &DeviceSyncCalibration) {
        let key = Self::make_key(&calibration.camera_id, &calibration.microphone_id);

        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);

        let stored = StoredCalibration {
            camera_id: calibration.camera_id.clone(),
            microphone_id: calibration.microphone_id.clone(),
            offset_secs: calibration.measured_offset_secs,
            confidence: calibration.confidence,
            measurement_count: calibration.measurement_count,
            last_updated_ms: now_ms,
        };

        self.calibrations.insert(key, stored);
    }

    pub fn remove_calibration(&mut self, camera_id: &str, microphone_id: &str) {
        let key = Self::make_key(camera_id, microphone_id);
        self.calibrations.remove(&key);
    }

    pub fn list_calibrations(&self) -> impl Iterator<Item = &StoredCalibration> {
        self.calibrations.values()
    }

    pub fn clear(&mut self) {
        self.calibrations.clear();
    }
}

pub fn apply_calibration_to_offset(
    base_offset: f64,
    camera_id: Option<&str>,
    microphone_id: Option<&str>,
    store: &CalibrationStore,
) -> f64 {
    match (camera_id, microphone_id) {
        (Some(cam), Some(mic)) => {
            if let Some(cal_offset) = store.get_offset(cam, mic) {
                base_offset + cal_offset
            } else {
                base_offset
            }
        }
        _ => base_offset,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn test_calibration_store_save_load() {
        let temp_dir = TempDir::new().unwrap();
        let path = temp_dir.path().to_path_buf();

        let mut store = CalibrationStore::new();
        let cal = DeviceSyncCalibration {
            camera_id: "camera1".into(),
            microphone_id: "mic1".into(),
            measured_offset_secs: 0.042,
            confidence: 0.85,
            measurement_count: 5,
        };
        store.update_calibration(&cal);
        store.save(&path).unwrap();

        let loaded = CalibrationStore::load(&path);
        let retrieved = loaded.get_calibration("camera1", "mic1").unwrap();
        assert!((retrieved.offset_secs - 0.042).abs() < 0.0001);
        assert_eq!(retrieved.measurement_count, 5);
    }

    #[test]
    fn test_get_offset_requires_confidence() {
        let mut store = CalibrationStore::new();

        let low_conf = DeviceSyncCalibration {
            camera_id: "cam".into(),
            microphone_id: "mic".into(),
            measured_offset_secs: 0.05,
            confidence: 0.3,
            measurement_count: 1,
        };
        store.update_calibration(&low_conf);
        assert!(store.get_offset("cam", "mic").is_none());

        let high_conf = DeviceSyncCalibration {
            camera_id: "cam".into(),
            microphone_id: "mic".into(),
            measured_offset_secs: 0.05,
            confidence: 0.8,
            measurement_count: 3,
        };
        store.update_calibration(&high_conf);
        assert!(store.get_offset("cam", "mic").is_some());
    }
}
