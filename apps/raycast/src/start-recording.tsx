import { Action, ActionPanel, Form, showToast, Toast } from "@raycast/api";
import { openCapAction } from "./cap";

type Values = {
  mode: "studio" | "instant";
  targetType: "display" | "window";
  targetName: string;
  microphone?: string;
  cameraDeviceId?: string;
  systemAudio: boolean;
};

export default function Command() {
  async function submit(values: Values) {
    if (!values.targetName.trim()) {
      await showToast({
        style: Toast.Style.Failure,
        title: "Target name is required",
      });
      return;
    }

    await openCapAction("record", {
      mode: values.mode,
      [values.targetType]: values.targetName.trim(),
      mic: values.microphone?.trim(),
      camera_device_id: values.cameraDeviceId?.trim(),
      system_audio: values.systemAudio,
    });

    await showToast({
      style: Toast.Style.Success,
      title: "Starting Cap recording",
    });
  }

  return (
    <Form
      actions={
        <ActionPanel>
          <Action.SubmitForm title="Start Recording" onSubmit={submit} />
        </ActionPanel>
      }
    >
      <Form.Dropdown id="mode" title="Mode" defaultValue="studio">
        <Form.Dropdown.Item value="studio" title="Studio" />
        <Form.Dropdown.Item value="instant" title="Instant" />
      </Form.Dropdown>
      <Form.Dropdown id="targetType" title="Target Type" defaultValue="display">
        <Form.Dropdown.Item value="display" title="Display" />
        <Form.Dropdown.Item value="window" title="Window" />
      </Form.Dropdown>
      <Form.TextField
        id="targetName"
        title="Target Name"
        placeholder="Display or window name as shown in Cap"
      />
      <Form.TextField
        id="microphone"
        title="Microphone"
        placeholder="Optional microphone label"
      />
      <Form.TextField
        id="cameraDeviceId"
        title="Camera Device ID"
        placeholder="Optional camera device id"
      />
      <Form.Checkbox
        id="systemAudio"
        title="System Audio"
        label="Capture system audio"
        defaultValue={false}
      />
    </Form>
  );
}
