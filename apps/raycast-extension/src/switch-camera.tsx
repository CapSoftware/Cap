import { Action, ActionPanel, Form, closeMainWindow, open, showHUD } from "@raycast/api";

interface Values {
  id: string;
}

export default function Command() {
  async function handleSubmit(values: Values) {
    const id = values.id.trim();
    const url = id
      ? `cap://switch-camera?id=${encodeURIComponent(id)}`
      : "cap://switch-camera";

    await closeMainWindow();
    await open(url);
    await showHUD(id ? `Switching camera to: ${id}` : "Disabling camera");
  }

  return (
    <Form
      actions={
        <ActionPanel>
          <Action.SubmitForm title="Switch Camera" onSubmit={handleSubmit} />
        </ActionPanel>
      }
    >
      <Form.TextField
        id="id"
        title="Camera ID"
        placeholder="e.g. FaceTime HD Camera (leave blank to disable)"
        autoFocus
      />
    </Form>
  );
}