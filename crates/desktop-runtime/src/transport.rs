use std::{future::Future, path::PathBuf};

use serde::{Serialize, de::DeserializeOwned};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    net::TcpStream,
    sync::mpsc,
};

use crate::{
    AppHandle, AppPaths, BackendMessage, ChannelMessage, CommandContext, CommandResponse,
    PROTOCOL_VERSION, Result, ShellMessage, dispatch_command,
};

const MAX_FRAME_SIZE: usize = 128 * 1024 * 1024;

pub struct BackendOptions {
    pub identifier: String,
    pub resource_dir: PathBuf,
}

impl BackendOptions {
    pub fn new(identifier: impl Into<String>, resource_dir: impl Into<PathBuf>) -> Self {
        Self {
            identifier: identifier.into(),
            resource_dir: resource_dir.into(),
        }
    }
}

pub async fn run_backend<Setup, Shutdown, ShutdownFuture>(
    options: BackendOptions,
    setup: Setup,
    shutdown: Shutdown,
) -> Result<()>
where
    Setup: FnOnce(&AppHandle) -> Result<()>,
    Shutdown: FnOnce(AppHandle) -> ShutdownFuture,
    ShutdownFuture: Future<Output = Result<()>>,
{
    let address = std::env::var("CAP_ELECTRON_IPC_ADDR")
        .map_err(|_| "CAP_ELECTRON_IPC_ADDR is not set".to_string())?;
    let expected_token = std::env::var("CAP_ELECTRON_IPC_TOKEN")
        .map_err(|_| "CAP_ELECTRON_IPC_TOKEN is not set".to_string())?;
    let stream = TcpStream::connect(&address)
        .await
        .map_err(|error| format!("failed to connect to Electron at {address}: {error}"))?;
    let (mut reader, mut writer) = stream.into_split();

    let hello = read_frame::<_, ShellMessage>(&mut reader).await?;
    match hello {
        ShellMessage::Hello {
            token,
            protocol_version,
        } if token == expected_token && protocol_version == PROTOCOL_VERSION => {}
        ShellMessage::Hello { .. } => {
            return Err("Electron desktop authentication failed".to_string());
        }
        _ => return Err("Electron desktop did not begin with a hello message".to_string()),
    }

    let (outbound_tx, mut outbound_rx) = mpsc::unbounded_channel();
    let paths = AppPaths::discover(&options.identifier, options.resource_dir)?;
    let app = AppHandle::new(outbound_tx.clone(), paths);
    setup(&app)?;

    let (channel_tx, mut channel_rx) = mpsc::unbounded_channel::<ChannelMessage>();
    let channel_outbound = outbound_tx.clone();
    tokio::spawn(async move {
        while let Some(message) = channel_rx.recv().await {
            if channel_outbound
                .send(BackendMessage::Channel(message))
                .is_err()
            {
                break;
            }
        }
    });

    let writer_task = tokio::spawn(async move {
        while let Some(message) = outbound_rx.recv().await {
            let shutdown_complete = matches!(message, BackendMessage::ShutdownComplete);
            write_frame(&mut writer, &message).await?;
            if shutdown_complete {
                break;
            }
        }
        Ok::<_, String>(())
    });

    let mut commands = inventory::iter::<crate::CommandRegistration>
        .into_iter()
        .map(|registration| registration.name.to_string())
        .collect::<Vec<_>>();
    commands.sort_unstable();
    app.send(BackendMessage::Ready {
        protocol_version: PROTOCOL_VERSION,
        commands,
    })?;

    loop {
        match read_frame::<_, ShellMessage>(&mut reader).await? {
            ShellMessage::Hello { .. } => {
                return Err("Electron desktop sent a duplicate hello message".to_string());
            }
            ShellMessage::Invoke {
                id,
                window_label,
                command,
                arguments,
            } => {
                let context = CommandContext::new(app.clone(), window_label, channel_tx.clone());
                let invoke_outbound = outbound_tx.clone();
                tokio::spawn(async move {
                    let response = match dispatch_command(context, &command, arguments).await {
                        Ok(value) => CommandResponse::Ok { value },
                        Err(error) => CommandResponse::Error { error },
                    };
                    let _ = invoke_outbound.send(BackendMessage::InvokeResult { id, response });
                });
            }
            ShellMessage::WindowState { label, state } => app.update_window_state(label, state),
            ShellMessage::WindowEvent { label, event } => app.receive_window_event(label, event),
            ShellMessage::Event { event, payload } => app.receive_event(&event, payload),
            ShellMessage::CursorPosition { x, y } => app.receive_cursor_position(x, y),
            ShellMessage::NativeResult { id, result } => app.receive_native_result(id, result),
            ShellMessage::Shutdown => break,
        }
    }

    shutdown(app.clone()).await?;
    app.send(BackendMessage::ShutdownComplete)?;
    drop(app);
    drop(outbound_tx);
    writer_task
        .await
        .map_err(|error| format!("Electron desktop writer task failed: {error}"))??;
    Ok(())
}

async fn read_frame<R, T>(reader: &mut R) -> Result<T>
where
    R: AsyncRead + Unpin,
    T: DeserializeOwned,
{
    let length = reader
        .read_u32()
        .await
        .map_err(|error| format!("failed to read Electron desktop frame: {error}"))?
        as usize;
    if length > MAX_FRAME_SIZE {
        return Err(format!(
            "Electron desktop frame exceeded {MAX_FRAME_SIZE} bytes"
        ));
    }
    let mut bytes = vec![0; length];
    reader
        .read_exact(&mut bytes)
        .await
        .map_err(|error| format!("failed to read Electron desktop payload: {error}"))?;
    serde_json::from_slice(&bytes)
        .map_err(|error| format!("invalid Electron desktop message: {error}"))
}

async fn write_frame<W, T>(writer: &mut W, message: &T) -> Result<()>
where
    W: AsyncWrite + Unpin,
    T: Serialize,
{
    let bytes = serde_json::to_vec(message)
        .map_err(|error| format!("failed to serialize Electron desktop message: {error}"))?;
    if bytes.len() > MAX_FRAME_SIZE {
        return Err(format!(
            "Electron desktop frame exceeded {MAX_FRAME_SIZE} bytes"
        ));
    }
    writer
        .write_u32(bytes.len() as u32)
        .await
        .map_err(|error| format!("failed to write Electron desktop frame: {error}"))?;
    writer
        .write_all(&bytes)
        .await
        .map_err(|error| format!("failed to write Electron desktop payload: {error}"))?;
    writer
        .flush()
        .await
        .map_err(|error| format!("failed to flush Electron desktop payload: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::duplex;

    #[tokio::test]
    async fn framed_messages_round_trip() {
        let (mut sender, mut receiver) = duplex(4096);
        let message = BackendMessage::Event {
            event: "recording-started".to_string(),
            payload: serde_json::json!({ "id": "recording-1" }),
            target: None,
        };
        let expected = serde_json::to_value(&message).unwrap();
        let send = tokio::spawn(async move { write_frame(&mut sender, &message).await });
        let received = read_frame::<_, BackendMessage>(&mut receiver)
            .await
            .unwrap();
        send.await.unwrap().unwrap();
        assert_eq!(serde_json::to_value(received).unwrap(), expected);
    }
}
