import { Action, ActionPanel, Form } from "@raycast/api";
import { micFromPreference, preferences, runAction } from "./cap";

type Values = { microphoneLabel: string };

export default function Command() {
  const prefs = preferences();
  async function submit(values: Values) {
    await runAction(
      {
        set_microphone: {
          mic_label: micFromPreference(values.microphoneLabel),
        },
      },
      "Switching Cap microphone",
    );
  }

  return (
    <Form
      actions={
        <ActionPanel>
          <Action.SubmitForm title="Switch Microphone" onSubmit={submit} />
        </ActionPanel>
      }
    >
      <Form.TextField
        id="microphoneLabel"
        title="Microphone Label"
        defaultValue={prefs.microphoneLabel}
        placeholder="Leave blank to disable microphone"
      />
    </Form>
  );
}
