import { Action, ActionPanel, Form, Icon, showToast, Toast } from "@raycast/api";
import { useEffect, useState } from "react";
import {
  DeepLinkDevices,
  capNotInstalled,
  createListDevicesAction,
  createTakeScreenshotAction,
  executeCapAction,
  executeCapActionWithResponse,
} from "./utils";

type CaptureType = "screen" | "window";

export default function Command() {
  const [captureType, setCaptureType] = useState<CaptureType>("screen");
  const [selectedTarget, setSelectedTarget] = useState("");
  const [devices, setDevices] = useState<DeepLinkDevices | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    async function loadDevices() {
      if (await capNotInstalled()) {
        setIsLoading(false);
        return;
      }

      const result = await executeCapActionWithResponse<DeepLinkDevices>(createListDevicesAction());

      if (result) {
        setDevices(result);
        if (result.screens.length > 0) {
          setSelectedTarget(result.screens[0].name);
        }
      } else {
        showToast({
          style: Toast.Style.Failure,
          title: "Could not fetch devices",
          message: "Make sure Cap is running",
        });
      }
      setIsLoading(false);
    }

    loadDevices();
  }, []);

  async function handleSubmit() {
    if (await capNotInstalled()) {
      return;
    }

    if (!selectedTarget) {
      showToast({ style: Toast.Style.Failure, title: "Please select a target" });
      return;
    }

    const captureMode = captureType === "screen" ? { screen: selectedTarget } : { window: selectedTarget };

    await executeCapAction(createTakeScreenshotAction(captureMode), {
      feedbackMessage: "Taking screenshot...",
      feedbackType: "hud",
    });
  }

  const targets =
    captureType === "screen"
      ? (devices?.screens ?? []).map((s) => ({ name: s.name, value: s.name }))
      : (devices?.windows ?? []).map((w) => ({
        name: w.owner_name ? `${w.owner_name} — ${w.name}` : w.name,
        value: w.name,
      }));

  return (
    <Form
      isLoading={isLoading}
      actions={
        <ActionPanel>
          <Action.SubmitForm title="Take Screenshot" icon={Icon.Camera} onSubmit={handleSubmit} />
        </ActionPanel>
      }
    >
      <Form.Dropdown id="captureType" title="Capture Type" value={captureType} onChange={(v) => {
        setCaptureType(v as CaptureType);
        const newTargets = v === "screen"
          ? (devices?.screens ?? [])
          : (devices?.windows ?? []);
        if (newTargets.length > 0) {
          setSelectedTarget(newTargets[0].name);
        } else {
          setSelectedTarget("");
        }
      }}>
        <Form.Dropdown.Item value="screen" title="Screen" icon={Icon.Desktop} />
        <Form.Dropdown.Item value="window" title="Window" icon={Icon.Window} />
      </Form.Dropdown>
      <Form.Dropdown
        id="target"
        title={captureType === "screen" ? "Screen" : "Window"}
        value={selectedTarget}
        onChange={setSelectedTarget}
      >
        {targets.map((t) => (
          <Form.Dropdown.Item key={t.value} value={t.value} title={t.name} />
        ))}
      </Form.Dropdown>
    </Form>
  );
}
