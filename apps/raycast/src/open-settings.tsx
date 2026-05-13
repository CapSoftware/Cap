import { Action, ActionPanel, Form, showToast, Toast } from "@raycast/api";
import { openCapAction } from "./cap";

type Values = { page?: string };

export default function Command() {
  async function submit(values: Values) {
    await openCapAction("settings", { page: values.page?.trim() });
    await showToast({
      style: Toast.Style.Success,
      title: "Opening Cap settings",
    });
  }

  return (
    <Form
      actions={
        <ActionPanel>
          <Action.SubmitForm title="Open Settings" onSubmit={submit} />
        </ActionPanel>
      }
    >
      <Form.TextField
        id="page"
        title="Page"
        placeholder="Optional settings page"
      />
    </Form>
  );
}
