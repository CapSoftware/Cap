import { Form, ActionPanel, Action, showToast, Toast } from "@raycast/api";
import { openCapDeepLink } from "./utils";

export default function Command() {
  return (
    <Form
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title="Switch Microphone"
            onSubmit={async (values) => {
              const micLabel = (values.micLabel as string)?.trim();
              if (!micLabel) {
                await showToast({ style: Toast.Style.Failure, title: "Mic label is required" });
                return;
              }
              await openCapDeepLink({ set_microphone: { mic_label: micLabel } });
            }}
          />
        </ActionPanel>
      }
    >
      <Form.TextField id="micLabel" title="Microphone Label" placeholder="MacBook Pro Microphone" />
    </Form>
  );
}
