import { Action, ActionPanel, Form } from "@raycast/api";
import { buildUrl, triggerCapDeepLink } from "./deeplink";

type Values = { label: string };

export default function Command() {
  async function onSubmit(values: Values) {
    const url = buildUrl("device/microphone", { label: values.label });
    await triggerCapDeepLink(
      url,
      values.label ? "Sent: Switch microphone" : "Sent: Disable microphone",
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
      <Form.Description text="Leave empty to disable microphone input." />
      <Form.TextField
        id="label"
        title="Microphone Label"
        placeholder="e.g. MacBook Pro Microphone"
      />
    </Form>
  );
}
