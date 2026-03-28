import { Action, ActionPanel, Form, open, showHUD } from "@raycast/api";
import { buildDeeplinkUrl } from "./utils";

export default function Command() {
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
      <Form.TextField id="captureName" title="Screen/Window Name" placeholder="e.g. Built-in Retina Display" />
      <Form.Dropdown id="mode" title="Recording Mode" defaultValue="studio">
        <Form.Dropdown.Item value="studio" title="Studio" />
        <Form.Dropdown.Item value="instant" title="Instant" />
      </Form.Dropdown>
      <Form.TextField id="camera" title="Camera (optional)" placeholder="Camera name or model" />
      <Form.TextField id="mic" title="Microphone (optional)" placeholder="Microphone label" />
      <Form.Checkbox id="systemAudio" title="System Audio" label="Capture system audio" defaultValue={false} />
    </Form>
  );
}

interface FormValues {
  captureType: string;
  captureName: string;
  mode: string;
  camera: string;
  mic: string;
  systemAudio: boolean;
}

async function handleSubmit(values: FormValues) {
  const captureMode =
    values.captureType === "screen"
      ? { screen: values.captureName }
      : { window: values.captureName };

  const camera = values.camera ? { ModelID: values.camera } : null;
  const micLabel = values.mic || null;

  const url = buildDeeplinkUrl({
    start_recording: {
      capture_mode: captureMode,
      camera,
      mic_label: micLabel,
      capture_system_audio: values.systemAudio,
      mode: values.mode as "studio" | "instant",
    },
  });

  await open(url);
  await showHUD("Starting Cap recording");
}
