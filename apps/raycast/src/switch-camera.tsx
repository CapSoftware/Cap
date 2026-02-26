import { Action, ActionPanel, Form, showHUD } from "@raycast/api";
import { dispatchAction } from "./lib/cap";

type Values = { camera: string };

export default function Command() {
  return (
    <Form
      actions={
        <ActionPanel>
          <Action.SubmitForm title="Switch Camera" onSubmit={onSubmit} />
        </ActionPanel>
      }
    >
      <Form.TextField id="camera" title="Camera Device/Model ID" placeholder="FaceTime HD Camera" />
    </Form>
  );
}

async function onSubmit(values: Values) {
  await dispatchAction({
    switch_camera: {
      camera: values.camera ? { DeviceID: values.camera } : null,
    },
  });

  await showHUD("Cap: switch_camera");
}
