use cap_recording::{
    RecordingMode, feeds::camera::DeviceOrModelID, sources::screen_capture::ScreenCaptureTarget,
};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, Url};
use tracing::trace;

use crate::{App, ArcLock, recording::StartRecordingInputs, windows::ShowCapWindow};

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CaptureMode {
    Screen(String),
    Window(String),
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeepLinkAction {
    StartRecording {
        capture_mode: CaptureMode,
        camera: Option<DeviceOrModelID>,
        mic_label: Option<String>,
        capture_system_audio: bool,
        mode: RecordingMode,
    },
    StopRecording,
    PauseRecording,
    ResumeRecording,
    SwitchMic {
        label: Option<String>,
    },
    SwitchCamera {
        id: Option<DeviceOrModelID>,
    },
    OpenEditor {
        project_path: PathBuf,
    },
    OpenSettings {
        page: Option<String>,
    },
}

pub fn register(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    use tauri_plugin_deep_link::DeepLinkExt;
    let app_handle = app.handle().clone();
    app.deep_link().on_open_urls(move |event| {
        handle(&app_handle, event.urls().to_vec());
    })?;
    Ok(())
}

pub fn handle(app_handle: &AppHandle, urls: Vec<Url>) {
    trace!("Handling deep actions for: {:?}", &urls);

    let actions: Vec<_> = urls
        .into_iter()
        .filter(|url| !url.as_str().is_empty())
        .filter_map(|url| {
            DeepLinkAction::try_from(&url)
                .map_err(|e| match e {
                    ActionParseFromUrlError::ParseFailed(msg) => {
                        eprintln!("Failed to parse deep link \"{}\": {}", &url, msg)
                    }
                    ActionParseFromUrlError::Invalid => {
                        eprintln!("Invalid deep link format \"{}\"", &url)
                    }
                    // Likely login action, not handled here.
                    ActionParseFromUrlError::NotAction => {}
                })
                .ok()
        })
        .collect();

    if actions.is_empty() {
        return;
    }

    let app_handle = app_handle.clone();
    tauri::async_runtime::spawn(async move {
        for action in actions {
            if let Err(e) = action.execute(&app_handle).await {
                eprintln!("Failed to handle deep link action: {e}");
            }
        }
    });
}

pub enum ActionParseFromUrlError {
    ParseFailed(String),
    Invalid,
    NotAction,
}

impl TryFrom<&Url> for DeepLinkAction {
    type Error = ActionParseFromUrlError;

    fn try_from(url: &Url) -> Result<Self, Self::Error> {
        #[cfg(target_os = "macos")]
        if url.scheme() == "file" {
            return Ok(Self::OpenEditor {
                project_path: url.to_file_path().unwrap(),
            });
        }

        let domain = url.domain().unwrap_or_default();

        // Handle simple path-based deeplinks (e.g. cap://stop-recording)
        match domain {
            "stop-recording" => return Ok(Self::StopRecording),
            "pause-recording" => return Ok(Self::PauseRecording),
            "resume-recording" => return Ok(Self::ResumeRecording),
            "switch-mic" => {
                let params: std::collections::HashMap<_, _> = url.query_pairs().collect();
                return Ok(Self::SwitchMic {
                    label: params.get("label").map(|v| v.to_string()),
                });
            }
            "switch-camera" => {
                let params: std::collections::HashMap<_, _> = url.query_pairs().collect();
                let id = params.get("id").and_then(|v| {
                    let raw = v.as_ref();
                    serde_json::from_str::<DeviceOrModelID>(raw)
                        .or_else(|_| {
                            serde_json::from_str::<DeviceOrModelID>(&format!(r#""{}""#, raw))
                        })
                        .ok()
                });
                return Ok(Self::SwitchCamera { id });
            }
            "action" => {
                // Fall through to JSON-based parsing below.
            }
            _ => return Err(ActionParseFromUrlError::NotAction),
        }

        // Legacy JSON-based action parsing: cap://action?value=<json>
        let params = url
            .query_pairs()
            .collect::<std::collections::HashMap<_, _>>();
        let json_value = params
            .get("value")
            .ok_or(ActionParseFromUrlError::Invalid)?;
        let action: Self = serde_json::from_str(json_value)
            .map_err(|e| ActionParseFromUrlError::ParseFailed(e.to_string()))?;
        Ok(action)
    }
}

impl DeepLinkAction {
    pub async fn execute(self, app: &AppHandle) -> Result<(), String> {
        match self {
            DeepLinkAction::StartRecording {
                capture_mode,
                camera,
                mic_label,
                capture_system_audio,
                mode,
            } => {
                let state = app.state::<ArcLock<App>>();

                crate::set_camera_input(app.clone(), state.clone(), camera, None).await?;
                crate::set_mic_input(state.clone(), mic_label).await?;

                let capture_target: ScreenCaptureTarget = match capture_mode {
                    CaptureMode::Screen(name) => cap_recording::screen_capture::list_displays()
                        .into_iter()
                        .find(|(s, _)| s.name == name)
                        .map(|(s, _)| ScreenCaptureTarget::Display { id: s.id })
                        .ok_or(format!("No screen with name \"{}\"", &name))?,
                    CaptureMode::Window(name) => cap_recording::screen_capture::list_windows()
                        .into_iter()
                        .find(|(w, _)| w.name == name)
                        .map(|(w, _)| ScreenCaptureTarget::Window { id: w.id })
                        .ok_or(format!("No window with name \"{}\"", &name))?,
                };

                let inputs = StartRecordingInputs {
                    mode,
                    capture_target,
                    capture_system_audio,
                    organization_id: None,
                };

                crate::recording::start_recording(app.clone(), state, inputs)
                    .await
                    .map(|_| ())
            }
            DeepLinkAction::StopRecording => {
                crate::recording::stop_recording(app.clone(), app.state()).await
            }
            DeepLinkAction::PauseRecording => {
                crate::recording::pause_recording(app.clone(), app.state()).await
            }
            DeepLinkAction::ResumeRecording => {
                crate::recording::resume_recording(app.clone(), app.state()).await
            }
            DeepLinkAction::SwitchMic { label } => {
                let state = app.state::<ArcLock<App>>();
                crate::set_mic_input(state, label).await
            }
            DeepLinkAction::SwitchCamera { id } => {
                let state = app.state::<ArcLock<App>>();
                crate::set_camera_input(app.clone(), state, id, None).await
            }
            DeepLinkAction::OpenEditor { project_path } => {
                crate::open_project_from_path(Path::new(&project_path), app.clone())
            }
            DeepLinkAction::OpenSettings { page } => {
                crate::show_window(app.clone(), ShowCapWindow::Settings { page }).await
            }
        }
    }
}

{
  "$schema": "https://www.raycast.com/schemas/extension.json",
  "name": "cap",
  "title": "Cap",
  "description": "Control Cap screen recording from Raycast",
  "icon": "icon.png",
  "author": "cap",
  "license": "MIT",
  "version": "1.0.0",
  "commands": [
    {
      "name": "start-recording",
      "title": "Start Recording",
      "subtitle": "Cap",
      "description": "Start a Cap screen or window recording",
      "mode": "view"
    },
    {
      "name": "stop-recording",
      "title": "Stop Recording",
      "subtitle": "Cap",
      "description": "Stop the current Cap recording",
      "mode": "no-view"
    },
    {
      "name": "pause-recording",
      "title": "Pause Recording",
      "subtitle": "Cap",
      "description": "Pause the current Cap recording",
      "mode": "no-view"
    },
    {
      "name": "resume-recording",
      "title": "Resume Recording",
      "subtitle": "Cap",
      "description": "Resume the current Cap recording",
      "mode": "no-view"
    },
    {
      "name": "switch-mic",
      "title": "Switch Microphone",
      "subtitle": "Cap",
      "description": "Switch the active microphone in Cap",
      "mode": "view"
    },
    {
      "name": "switch-camera",
      "title": "Switch Camera",
      "subtitle": "Cap",
      "description": "Switch the active camera in Cap",
      "mode": "view"
    },
    {
      "name": "open-settings",
      "title": "Open Settings",
      "subtitle": "Cap",
      "description": "Open Cap settings",
      "mode": "no-view"
    }
  ],
  "dependencies": {
    "@raycast/api": "^1.0.0"
  },
  "devDependencies": {
    "typescript": "^5.0.0"
  },
  "scripts": {
    "build": "ray build -e dist",
    "dev": "ray develop",
    "fix-lint": "ray lint --fix",
    "lint": "ray lint",
    "publish": "npx @raycast/api@latest publish"
  }
}

{
  "compilerOptions": {
    "target": "ES2020",
    "module": "CommonJS",
    "lib": ["ES2020"],
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noImplicitReturns": true,
    "moduleResolution": "node",
    "esModuleInterop": true,
    "skipLibCheck": true
  }
}

import { Form, ActionPanel, Action, open, closeMainWindow } from "@raycast/api";

interface FormValues {
  captureType: string;
  captureName: string;
  micLabel: string;
  captureSystemAudio: boolean;
  recordingMode: string;
}

export default function StartRecording() {
  async function handleSubmit(values: FormValues) {
    await closeMainWindow();
    const captureMode =
      values.captureType === "screen"
        ? { screen: values.captureName }
        : { window: values.captureName };
    const payload = {
      start_recording: {
        capture_mode: captureMode,
        camera: null,
        mic_label: values.micLabel.trim() || null,
        capture_system_audio: values.captureSystemAudio,
        mode: values.recordingMode,
      },
    };
    const value = encodeURIComponent(JSON.stringify(payload));
    await open(`cap://action?value=${value}`);
  }

  return (
    <Form
      actions={
        <ActionPanel>
          <Action.SubmitForm title="Start Recording" onSubmit={handleSubmit} />
        </ActionPanel>
      }
    >
      <Form.Dropdown id="captureType" title="Capture Type" defaultValue="screen">
        <Form.Dropdown.Item value="screen" title="Screen" />
        <Form.Dropdown.Item value="window" title="Window" />
      </Form.Dropdown>
      <Form.TextField
        id="captureName"
        title="Screen or Window Name"
        placeholder="e.g. Built-in Retina Display or Finder"
      />
      <Form.Dropdown id="recordingMode" title="Recording Mode" defaultValue="studio">
        <Form.Dropdown.Item value="studio" title="Studio" />
        <Form.Dropdown.Item value="instant_capture" title="Instant Capture" />
      </Form.Dropdown>
      <Form.TextField
        id="micLabel"
        title="Microphone Label"
        placeholder="Leave empty to use default"
      />
      <Form.Checkbox id="captureSystemAudio" label="Capture System Audio" defaultValue={false} />
    </Form>
  );
}

import { open, closeMainWindow } from "@raycast/api";

export default async function StopRecording() {
  await closeMainWindow();
  await open("cap://stop-recording");
}

import { open, closeMainWindow } from "@raycast/api";

export default async function PauseRecording() {
  await closeMainWindow();
  await open("cap://pause-recording");
}

import { open, closeMainWindow } from "@raycast/api";

export default async function ResumeRecording() {
  await closeMainWindow();
  await open("cap://resume-recording");
}