import { Action, ActionPanel, Form } from "@raycast/api";
import { dispatchAction } from "./utils";

type Values = {
  targetType: "screen" | "window";
  targetName: string;
  mode: "studio" | "instant";
  micLabel: string;
  cameraLabel: string;
  captureSystemAudio: boolean;
};

export default function Command() {
  return (
    <Form
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title="Start Recording"
            onSubmit={async (values: Values) => {
              const captureMode =
                values.targetType === "window"
                  ? { window: values.targetName }
                  : { screen: values.targetName };

              await dispatchAction({
                start_recording: {
                  capture_mode: captureMode,
                  camera: null,
                  mic_label: values.micLabel || null,
                  capture_system_audio: values.captureSystemAudio,
                  mode: values.mode,
                },
              });

              if (values.cameraLabel) {
                await dispatchAction({ set_camera: { camera_label: values.cameraLabel } });
              }
            }}
          />
        </ActionPanel>
      }
    >
      <Form.Dropdown id="targetType" title="Target Type" defaultValue="screen">
        <Form.Dropdown.Item value="screen" title="Screen" />
        <Form.Dropdown.Item value="window" title="Window" />
      </Form.Dropdown>
      <Form.TextField id="targetName" title="Target Name" placeholder="Built-in Retina Display" />
      <Form.Dropdown id="mode" title="Mode" defaultValue="studio">
        <Form.Dropdown.Item value="studio" title="Studio" />
        <Form.Dropdown.Item value="instant" title="Instant" />
      </Form.Dropdown>
      <Form.TextField id="micLabel" title="Microphone Label" placeholder="Optional" />
      <Form.TextField id="cameraLabel" title="Camera Label" placeholder="Optional" />
      <Form.Checkbox id="captureSystemAudio" label="Capture System Audio" defaultValue={true} />
    </Form>
  );
}
