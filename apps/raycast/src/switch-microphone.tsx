import { ActionPanel, Action, Form } from "@raycast/api";
import { dispatchAction } from "./utils";

export default function Command() {
  return (
    <Form
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title="Switch Microphone"
            onSubmit={async (values: { micLabel: string }) => {
              await dispatchAction({ set_microphone: { mic_label: values.micLabel || null } });
            }}
          />
        </ActionPanel>
      }
    >
      <Form.TextField id="micLabel" title="Microphone Label" placeholder="MacBook Pro Microphone" />
    </Form>
  );
}
