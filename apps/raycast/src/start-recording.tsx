import { Action, ActionPanel, Form } from "@raycast/api";
import {
  cameraFromPreference,
  CaptureMode,
  micFromPreference,
  preferences,
  RecordingMode,
  runAction,
} from "./cap";

type Values = {
  captureType: "screen" | "window";
  targetName: string;
  mode: RecordingMode;
  microphoneLabel: string;
  cameraDeviceId: string;
  captureSystemAudio: boolean;
};

function captureMode(type: Values["captureType"], name: string): CaptureMode {
  return type === "window" ? { window: name } : { screen: name };
}

export default function Command() {
  const prefs = preferences();
  const defaultTarget =
    prefs.defaultWindowName || prefs.defaultScreenName || "Main Display";

  async function submit(values: Values) {
    await runAction(
      {
        start_recording: {
          capture_mode: captureMode(
            values.captureType,
            values.targetName.trim(),
          ),
          camera: cameraFromPreference(values.cameraDeviceId),
          mic_label: micFromPreference(values.microphoneLabel),
          capture_system_audio: values.captureSystemAudio,
          mode: values.mode,
        },
      },
      "Starting Cap recording",
    );
  }

  return (
    <Form
      actions={
        <ActionPanel>
          <Action.SubmitForm title="Start Recording" onSubmit={submit} />
        </ActionPanel>
      }
    >
      <Form.Dropdown
        id="captureType"
        title="Capture"
        defaultValue={prefs.defaultWindowName ? "window" : "screen"}
      >
        <Form.Dropdown.Item value="screen" title="Screen" />
        <Form.Dropdown.Item value="window" title="Window" />
      </Form.Dropdown>
      <Form.TextField
        id="targetName"
        title="Target Name"
        defaultValue={defaultTarget}
        placeholder="Display or window name from Cap"
      />
      <Form.Dropdown
        id="mode"
        title="Mode"
        defaultValue={prefs.recordingMode || "studio"}
      >
        <Form.Dropdown.Item value="studio" title="Studio" />
        <Form.Dropdown.Item value="instant" title="Instant" />
        <Form.Dropdown.Item value="screenshot" title="Screenshot" />
      </Form.Dropdown>
      <Form.TextField
        id="microphoneLabel"
        title="Microphone Label"
        defaultValue={prefs.microphoneLabel}
        placeholder="Optional"
      />
      <Form.TextField
        id="cameraDeviceId"
        title="Camera Device ID"
        defaultValue={prefs.cameraDeviceId}
        placeholder="Optional"
      />
      <Form.Checkbox
        id="captureSystemAudio"
        title="Capture System Audio"
        label="Include system audio"
        defaultValue={prefs.captureSystemAudio ?? true}
      />
    </Form>
  );
}
