import { Form, ActionPanel, Action, showToast, Toast } from "@raycast/api";
import { openCapDeepLink } from "./utils";

export default function Command() {
  return (
    <Form
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title="Start Recording (Screen)"
            onSubmit={async (values) => {
              const screenName = (values.screenName as string)?.trim();
              if (!screenName) {
                await showToast({ style: Toast.Style.Failure, title: "Screen name is required" });
                return;
              }
              await openCapDeepLink({
                start_recording: {
                  capture_mode: { screen: screenName },
                  camera: null,
                  mic_label: null,
                  capture_system_audio: true,
                  mode: "instant",
                },
              });
            }}
          />
        </ActionPanel>
      }
    >
      <Form.TextField id="screenName" title="Screen Name" placeholder="Built-in Display" />
    </Form>
  );
}
