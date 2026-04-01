use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecordingState {
    pub pid: u32,
    pub recording_id: String,
    pub project_path: PathBuf,
    pub started_at: String,
    pub screen: Option<String>,
}

fn state_dir() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("/tmp"))
        .join("cap")
}

pub fn state_path() -> PathBuf {
    state_dir().join("recording.json")
}

pub fn socket_path() -> PathBuf {
    state_dir().join("recording.sock")
}

impl RecordingState {
    pub fn save(&self) -> Result<(), String> {
        let path = state_path();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create state dir: {e}"))?;
        }
        let json =
            serde_json::to_string_pretty(self).map_err(|e| format!("Failed to serialize: {e}"))?;
        std::fs::write(&path, json).map_err(|e| format!("Failed to write state: {e}"))?;
        Ok(())
    }

    pub fn load() -> Result<Option<Self>, String> {
        let path = state_path();
        if !path.exists() {
            return Ok(None);
        }
        let contents =
            std::fs::read_to_string(&path).map_err(|e| format!("Failed to read state: {e}"))?;
        let state =
            serde_json::from_str(&contents).map_err(|e| format!("Failed to parse state: {e}"))?;
        Ok(Some(state))
    }

    pub fn remove() -> Result<(), String> {
        let path = state_path();
        if path.exists() {
            std::fs::remove_file(&path).map_err(|e| format!("Failed to remove state: {e}"))?;
        }
        let sock = socket_path();
        if sock.exists() {
            let _ = std::fs::remove_file(&sock);
        }
        Ok(())
    }

    pub fn is_process_alive(&self) -> bool {
        unsafe { libc::kill(self.pid as i32, 0) == 0 }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_state() {
        let state = RecordingState {
            pid: 12345,
            recording_id: "abc123".to_string(),
            project_path: PathBuf::from("/tmp/test.cap"),
            started_at: "2026-03-31T13:00:00Z".to_string(),
            screen: Some("1".to_string()),
        };

        let json = serde_json::to_string(&state).unwrap();
        let restored: RecordingState = serde_json::from_str(&json).unwrap();

        assert_eq!(restored.pid, 12345);
        assert_eq!(restored.recording_id, "abc123");
        assert_eq!(restored.project_path, PathBuf::from("/tmp/test.cap"));
    }
}
