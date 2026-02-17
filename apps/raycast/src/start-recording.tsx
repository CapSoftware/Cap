import { Action, ActionPanel, Form, Toast, showToast } from "@raycast/api";
import { buildUrl, triggerCapDeepLink } from "./deeplink";

type Values = {
  mode: string;
  captureType: string;
  target: string;
  captureSystemAudio: string[];
  micLabel: string;
  cameraDeviceId: string;
  cameraModelId: string;
};

export default function Command() {
  async function onSubmit(values: Values) {
    const target = values.target.trim();
    if (!target) {
      await showToast({
        style: Toast.Style.Failure,
        title: "Target is required",
        message: "Please enter a display/window name",
      });
      return;
    }

    const useSystemAudio = values.captureSystemAudio.includes("enabled")
      ? "true"
      : "false";

    const cameraDeviceId = values.cameraDeviceId.trim();
    const cameraModelId = values.cameraModelId.trim();

    const url = buildUrl("record/start", {
      mode: values.mode,
      capture_type: values.captureType,
      target,
      capture_system_audio: useSystemAudio,
      mic_label: values.micLabel,
      device_id: cameraDeviceId || cameraModelId ? cameraDeviceId || undefined : undefined,
      model_id: cameraDeviceId ? undefined : cameraModelId || undefined,
    });

    await triggerCapDeepLink(url, "Sent: Start recording");
  }

  return (
    <Form
      actions={
        <ActionPanel>
          <Action.SubmitForm title="Start Recording" onSubmit={onSubmit} />
        </ActionPanel>
      }
    >
      <Form.Dropdown id="mode" title="Mode" defaultValue="studio">
        <Form.Dropdown.Item value="studio" title="Studio" />
        <Form.Dropdown.Item value="instant" title="Instant" />
      </Form.Dropdown>

      <Form.Dropdown
        id="captureType"
        title="Capture Type"
        defaultValue="screen"
      >
        <Form.Dropdown.Item value="screen" title="Screen" />
        <Form.Dropdown.Item value="window" title="Window" />
      </Form.Dropdown>

      <Form.TextField
        id="target"
        title="Target Name"
        placeholder="Display/window name in Cap"
      />
      <Form.TagPicker id="captureSystemAudio" title="System Audio">
        <Form.TagPicker.Item value="enabled" title="Capture system audio" />
      </Form.TagPicker>
      <Form.TextField id="micLabel" title="Microphone Label (optional)" />
      <Form.TextField id="cameraDeviceId" title="Camera Device ID (optional)" />
      <Form.TextField id="cameraModelId" title="Camera Model ID (optional)" />
    </Form>
  );
}
