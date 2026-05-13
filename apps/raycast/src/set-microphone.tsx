import { Action, ActionPanel, Form, showToast, Toast } from "@raycast/api";
import { openCapAction } from "./cap";

type Values = { microphone?: string };

export default function Command() {
  async function submit(values: Values) {
    await openCapAction("toggle-microphone", {
      mic: values.microphone?.trim(),
    });
    await showToast({
      style: Toast.Style.Success,
      title: values.microphone ? "Setting microphone" : "Clearing microphone",
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
        id="microphone"
        title="Microphone"
        placeholder="Leave empty to disable microphone"
      />
    </Form>
  );
}
