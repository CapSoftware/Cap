import { Action, ActionPanel, Form, showHUD } from "@raycast/api";
import { dispatchAction } from "./lib/cap";

type Values = {
  captureType: "screen" | "window";
  captureName: string;
  camera: string;
  microphone: string;
  captureSystemAudio: boolean;
  mode: "studio" | "instant";
};

export default function Command() {
  return (
    <Form
      actions={
        <ActionPanel>
          <Action.SubmitForm title="Start Recording" onSubmit={onSubmit} />
        </ActionPanel>
      }
    >
      <Form.Dropdown id="captureType" title="Capture Type" defaultValue="screen">
        <Form.Dropdown.Item value="screen" title="Screen" />
        <Form.Dropdown.Item value="window" title="Window" />
      </Form.Dropdown>
      <Form.TextField id="captureName" title="Capture Name" placeholder="Display or window name" />
      <Form.TextField id="camera" title="Camera (optional)" placeholder="Device/model ID" />
      <Form.TextField id="microphone" title="Microphone (optional)" placeholder="Mic label" />
      <Form.Checkbox id="captureSystemAudio" title="Capture System Audio" defaultValue={false} />
      <Form.Dropdown id="mode" title="Mode" defaultValue="studio">
        <Form.Dropdown.Item value="studio" title="Studio" />
        <Form.Dropdown.Item value="instant" title="Instant" />
      </Form.Dropdown>
    </Form>
  );
}

async function onSubmit(values: Values) {
  const captureMode =
    values.captureType === "screen"
      ? { screen: values.captureName }
      : { window: values.captureName };

  await dispatchAction({
    start_recording: {
      capture_mode: captureMode,
      camera: values.camera ? { DeviceID: values.camera } : null,
      mic_label: values.microphone || null,
      capture_system_audio: values.captureSystemAudio,
      mode: values.mode,
    },
  });

  await showHUD("Cap: start_recording");
}
