import { Action, ActionPanel, Form, Icon } from "@raycast/api";
import { useState } from "react";
import { executeCapAction, createStartRecordingAction, capNotInstalled } from "./utils";

type CaptureType = "screen" | "window";
type RecordingMode = "instant" | "studio";

export default function Command() {
  const [captureType, setCaptureType] = useState<CaptureType>("screen");
  const [targetName, setTargetName] = useState("");
  const [recordingMode, setRecordingMode] = useState<RecordingMode>("instant");

  async function handleSubmit() {
    if (await capNotInstalled()) {
      return;
    }

    if (!targetName.trim()) {
      return;
    }

    const captureMode = captureType === "screen" ? { screen: targetName } : { window: targetName };

    await executeCapAction(createStartRecordingAction(captureMode, recordingMode), {
      feedbackMessage: `Starting ${recordingMode} recording...`,
      feedbackType: "hud",
    });
  }

  return (
    <Form
      actions={
        <ActionPanel>
          <Action.SubmitForm title="Start Recording" icon={Icon.Video} onSubmit={handleSubmit} />
        </ActionPanel>
      }
    >
      <Form.Dropdown id="captureType" title="Capture Type" value={captureType} onChange={(v) => setCaptureType(v as CaptureType)}>
        <Form.Dropdown.Item value="screen" title="Screen" icon={Icon.Desktop} />
        <Form.Dropdown.Item value="window" title="Window" icon={Icon.Window} />
      </Form.Dropdown>
      <Form.TextField
        id="targetName"
        title={captureType === "screen" ? "Screen Name" : "Window Name"}
        placeholder={captureType === "screen" ? "e.g., Built-in Retina Display" : "e.g., Safari"}
        value={targetName}
        onChange={setTargetName}
      />
      <Form.Dropdown id="recordingMode" title="Recording Mode" value={recordingMode} onChange={(v) => setRecordingMode(v as RecordingMode)}>
        <Form.Dropdown.Item value="instant" title="Instant" icon={Icon.Video} />
        <Form.Dropdown.Item value="studio" title="Studio" icon={Icon.Camera} />
      </Form.Dropdown>
      <Form.Description text="Tip: Run 'List Devices' command in Cap to see available screen and window names." />
    </Form>
  );
}
