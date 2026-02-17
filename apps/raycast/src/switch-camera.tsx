import { Action, ActionPanel, Form } from "@raycast/api";
import { buildUrl, triggerCapDeepLink } from "./deeplink";

type Values = {
  off: string[];
  deviceId: string;
  modelId: string;
};

export default function Command() {
  async function onSubmit(values: Values) {
    const shouldDisable = values.off.includes("off");
    const deviceId = values.deviceId.trim();
    const modelId = values.modelId.trim();

    const url = buildUrl("device/camera", {
      off: shouldDisable ? "true" : undefined,
      device_id: shouldDisable
        ? undefined
        : deviceId || modelId
          ? deviceId || undefined
          : undefined,
      model_id: shouldDisable ? undefined : deviceId ? undefined : modelId || undefined,
    });

    await triggerCapDeepLink(
      url,
      shouldDisable ? "Sent: Disable camera" : "Sent: Switch camera",
    );
  }

  return (
    <Form
      actions={
        <ActionPanel>
          <Action.SubmitForm title="Apply" onSubmit={onSubmit} />
        </ActionPanel>
      }
    >
      <Form.TagPicker id="off" title="Disable Camera">
        <Form.TagPicker.Item value="off" title="Turn camera off" />
      </Form.TagPicker>
      <Form.TextField id="deviceId" title="Camera Device ID (optional)" />
      <Form.TextField id="modelId" title="Camera Model ID (optional)" />
    </Form>
  );
}
