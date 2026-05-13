import { Action, ActionPanel, Form, showToast, Toast } from "@raycast/api";
import { openCapAction } from "./cap";

type Values = { cameraDeviceId?: string };

export default function Command() {
  async function submit(values: Values) {
    await openCapAction("toggle-camera", {
      camera_device_id: values.cameraDeviceId?.trim(),
    });
    await showToast({
      style: Toast.Style.Success,
      title: values.cameraDeviceId ? "Setting camera" : "Clearing camera",
    });
  }

  return (
    <Form
      actions={
        <ActionPanel>
          <Action.SubmitForm title="Apply" onSubmit={submit} />
        </ActionPanel>
      }
    >
      <Form.TextField
        id="cameraDeviceId"
        title="Camera Device ID"
        placeholder="Leave empty to disable camera"
      />
    </Form>
  );
}
