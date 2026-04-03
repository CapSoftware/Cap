use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "command")]
pub enum DaemonCommand {
    #[serde(rename = "stop")]
    Stop,
    #[serde(rename = "status")]
    Status,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "status")]
pub enum DaemonResponse {
    #[serde(rename = "ok")]
    Ok {
        project_path: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        duration_secs: Option<f64>,
    },
    #[serde(rename = "recording")]
    Recording {
        duration_secs: f64,
        project_path: String,
        screen: Option<String>,
    },
    #[serde(rename = "error")]
    Error { message: String },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serialize_stop_command() {
        let cmd = DaemonCommand::Stop;
        let json = serde_json::to_string(&cmd).unwrap();
        assert_eq!(json, r#"{"command":"stop"}"#);
    }

    #[test]
    fn serialize_status_command() {
        let cmd = DaemonCommand::Status;
        let json = serde_json::to_string(&cmd).unwrap();
        assert_eq!(json, r#"{"command":"status"}"#);
    }

    #[test]
    fn deserialize_stop_command() {
        let cmd: DaemonCommand = serde_json::from_str(r#"{"command":"stop"}"#).unwrap();
        assert!(matches!(cmd, DaemonCommand::Stop));
    }

    #[test]
    fn serialize_ok_response() {
        let resp = DaemonResponse::Ok {
            project_path: "/tmp/rec.cap".to_string(),
            duration_secs: Some(42.5),
        };
        let json = serde_json::to_string(&resp).unwrap();
        assert!(json.contains("\"status\":\"ok\""));
        assert!(json.contains("42.5"));
    }

    #[test]
    fn serialize_recording_response() {
        let resp = DaemonResponse::Recording {
            duration_secs: 10.0,
            project_path: "/tmp/rec.cap".to_string(),
            screen: Some("1".to_string()),
        };
        let json = serde_json::to_string(&resp).unwrap();
        assert!(json.contains("\"status\":\"recording\""));
    }

    #[test]
    fn round_trip_error_response() {
        let resp = DaemonResponse::Error {
            message: "something broke".to_string(),
        };
        let json = serde_json::to_string(&resp).unwrap();
        let restored: DaemonResponse = serde_json::from_str(&json).unwrap();
        match restored {
            DaemonResponse::Error { message } => assert_eq!(message, "something broke"),
            _ => panic!("expected Error variant"),
        }
    }
}
