import { Form, ActionPanel, Action, showToast, Toast } from "@raycast/api";
import { openCapDeepLink } from "./utils";

export default function Command() {
  return (
    <Form
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title="Switch Camera"
            onSubmit={async (values) => {
              const deviceId = (values.deviceId as string)?.trim();
              const modelId = (values.modelId as string)?.trim();
              if (!deviceId && !modelId) {
                await showToast({ style: Toast.Style.Failure, title: "Provide Device ID or Model ID" });
                return;
              }
              const camera = deviceId ? { DeviceID: deviceId } : { ModelID: modelId };
              await openCapDeepLink({ set_camera: { camera } });
            }}
          />
        </ActionPanel>
      }
    >
      <Form.TextField id="deviceId" title="Device ID" placeholder="<device-id>" />
      <Form.TextField id="modelId" title="Model ID" placeholder="<model-id>" />
    </Form>
  );
}
