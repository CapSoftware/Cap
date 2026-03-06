import { ActionPanel, Action, Form } from "@raycast/api";
import { dispatchAction } from "./utils";

export default function Command() {
  return (
    <Form
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title="Switch Camera"
            onSubmit={async (values: { cameraLabel: string }) => {
              await dispatchAction({ set_camera: { camera_label: values.cameraLabel || null } });
            }}
          />
        </ActionPanel>
      }
    >
      <Form.TextField id="cameraLabel" title="Camera Label" placeholder="FaceTime HD Camera" />
    </Form>
  );
}
