use super::{
    protocol::{DaemonCommand, DaemonResponse},
    state::{self, RecordingState},
};
use cap_recording::studio_recording;
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::UnixListener,
};
use tracing::info;

pub struct RecordingDaemon {
    handle: studio_recording::ActorHandle,
    state: RecordingState,
}

impl RecordingDaemon {
    pub fn new(handle: studio_recording::ActorHandle, state: RecordingState) -> Self {
        Self { handle, state }
    }

    pub async fn run(self) -> Result<(), String> {
        let sock_path = state::socket_path();

        if sock_path.exists() {
            let _ = std::fs::remove_file(&sock_path);
        }

        let listener =
            UnixListener::bind(&sock_path).map_err(|e| format!("Failed to bind socket: {e}"))?;

        info!(socket = %sock_path.display(), "Recording daemon listening");

        let start_time = std::time::Instant::now();

        loop {
            let (stream, _) = listener
                .accept()
                .await
                .map_err(|e| format!("Accept error: {e}"))?;

            let (reader, mut writer) = stream.into_split();
            let mut reader = BufReader::new(reader);
            let mut line = String::new();

            if reader.read_line(&mut line).await.is_err() {
                continue;
            }

            let command: DaemonCommand = match serde_json::from_str(line.trim()) {
                Ok(cmd) => cmd,
                Err(e) => {
                    let resp = DaemonResponse::Error {
                        message: format!("Invalid command: {e}"),
                    };
                    let _ = writer
                        .write_all(
                            format!("{}\n", serde_json::to_string(&resp).unwrap()).as_bytes(),
                        )
                        .await;
                    continue;
                }
            };

            match command {
                DaemonCommand::Status => {
                    let elapsed = start_time.elapsed().as_secs_f64();
                    let resp = DaemonResponse::Recording {
                        duration_secs: elapsed,
                        project_path: self.state.project_path.display().to_string(),
                        screen: self.state.screen.clone(),
                    };
                    let _ = writer
                        .write_all(
                            format!("{}\n", serde_json::to_string(&resp).unwrap()).as_bytes(),
                        )
                        .await;
                }
                DaemonCommand::Stop => {
                    info!("Stop command received, finalizing recording");
                    let elapsed = start_time.elapsed().as_secs_f64();

                    let stop_result = self.handle.stop().await;

                    let resp = match stop_result {
                        Ok(_) => DaemonResponse::Ok {
                            project_path: self.state.project_path.display().to_string(),
                            duration_secs: Some(elapsed),
                        },
                        Err(e) => DaemonResponse::Error {
                            message: format!("Failed to stop recording: {e}"),
                        },
                    };

                    let _ = writer
                        .write_all(
                            format!("{}\n", serde_json::to_string(&resp).unwrap()).as_bytes(),
                        )
                        .await;

                    RecordingState::remove().ok();
                    let _ = std::fs::remove_file(&sock_path);
                    info!("Recording daemon shutting down");
                    return Ok(());
                }
            }
        }
    }
}
