import { Action, ActionPanel, Form, showHUD } from "@raycast/api";
import { dispatchAction } from "./lib/cap";

type Values = { micLabel: string };

export default function Command() {
  return (
    <Form
      actions={
        <ActionPanel>
          <Action.SubmitForm title="Switch Microphone" onSubmit={onSubmit} />
        </ActionPanel>
      }
    >
      <Form.TextField id="micLabel" title="Microphone Label" placeholder="Built-in Microphone" />
    </Form>
  );
}

async function onSubmit(values: Values) {
  await dispatchAction({
    switch_microphone: {
      mic_label: values.micLabel || null,
    },
  });

  await showHUD("Cap: switch_microphone");
}
