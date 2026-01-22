import { Action, ActionPanel, Form, Icon } from "@raycast/api";
import { useState } from "react";
import { executeCapAction, createTakeScreenshotAction, capNotInstalled } from "./utils";

type CaptureType = "screen" | "window";

export default function Command() {
  const [captureType, setCaptureType] = useState<CaptureType>("screen");
  const [targetName, setTargetName] = useState("");

  async function handleSubmit() {
    if (await capNotInstalled()) {
      return;
    }

    if (!targetName.trim()) {
      return;
    }

    const captureMode = captureType === "screen" ? { screen: targetName } : { window: targetName };

    await executeCapAction(createTakeScreenshotAction(captureMode), {
      feedbackMessage: "Taking screenshot...",
      feedbackType: "hud",
    });
  }

  return (
    <Form
      actions={
        <ActionPanel>
          <Action.SubmitForm title="Take Screenshot" icon={Icon.Camera} onSubmit={handleSubmit} />
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
      <Form.Description text="Tip: Run 'List Devices' command in Cap to see available screen and window names." />
    </Form>
  );
}
