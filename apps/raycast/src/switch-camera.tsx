import { Action, ActionPanel, Form } from "@raycast/api";
import { cameraFromPreference, preferences, runAction } from "./cap";

type Values = { cameraDeviceId: string };

export default function Command() {
  const prefs = preferences();
  async function submit(values: Values) {
    await runAction(
      { set_camera: { camera: cameraFromPreference(values.cameraDeviceId) } },
      "Switching Cap camera",
    );
  }

  return (
    <Form
      actions={
        <ActionPanel>
          <Action.SubmitForm title="Switch Camera" onSubmit={submit} />
        </ActionPanel>
      }
    >
      <Form.TextField
        id="cameraDeviceId"
        title="Camera Device ID"
        defaultValue={prefs.cameraDeviceId}
        placeholder="Leave blank to disable camera"
      />
    </Form>
  );
}
