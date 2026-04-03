use super::{
    protocol::{DaemonCommand, DaemonResponse},
    state,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::UnixStream,
};

pub async fn send_command(command: DaemonCommand) -> Result<DaemonResponse, String> {
    let sock_path = state::socket_path();
    if !sock_path.exists() {
        return Err("No active recording found.".to_string());
    }

    let stream = UnixStream::connect(&sock_path)
        .await
        .map_err(|e| format!("Failed to connect to recording daemon: {e}"))?;

    let (reader, mut writer) = stream.into_split();

    let msg = serde_json::to_string(&command).map_err(|e| format!("Serialize error: {e}"))?;
    writer
        .write_all(format!("{msg}\n").as_bytes())
        .await
        .map_err(|e| format!("Write error: {e}"))?;

    let mut reader = BufReader::new(reader);
    let mut line = String::new();
    reader
        .read_line(&mut line)
        .await
        .map_err(|e| format!("Read error: {e}"))?;

    serde_json::from_str(line.trim()).map_err(|e| format!("Parse error: {e}"))
}

pub async fn stop_recording() -> Result<DaemonResponse, String> {
    send_command(DaemonCommand::Stop).await
}

pub async fn get_status() -> Result<DaemonResponse, String> {
    send_command(DaemonCommand::Status).await
}
