import { Action, ActionPanel, Form, closeMainWindow, open, showHUD } from "@raycast/api";

interface Values {
  label: string;
}

export default function Command() {
  async function handleSubmit(values: Values) {
    const label = values.label.trim();
    const url = label
      ? `cap://switch-mic?label=${encodeURIComponent(label)}`
      : "cap://switch-mic";

    await closeMainWindow();
    await open(url);
    await showHUD(label ? `Switching microphone to: ${label}` : "Disabling microphone");
  }

  return (
    <Form
      actions={
        <ActionPanel>
          <Action.SubmitForm title="Switch Microphone" onSubmit={handleSubmit} />
        </ActionPanel>
      }
    >
      <Form.TextField
        id="label"
        title="Microphone Label"
        placeholder="e.g. Built-in Microphone (leave blank to disable)"
        autoFocus
      />
    </Form>
  );
}