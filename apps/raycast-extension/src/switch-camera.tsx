import { List, ActionPanel, Action, showToast, Toast, open } from "@raycast/api";

export default function Command() {
  const isLoading = false;


  const handleSwitchCamera = async (cameraId: string | null) => {
    try {
      // Camera ID can be either a model string or a device ID object
      // For simplicity, we'll use model string format
      const action = {
        switch_camera: {
      const action = {
        switch_camera: {
          camera_id: cameraId ? { DeviceID: cameraId } : null,
        },
      };
        },
      };

      const url = `cap-desktop://action?value=${encodeURIComponent(JSON.stringify(action))}`;
      await open(url);
      await showToast({
        style: Toast.Style.Success,
        title: "Camera switched",
        message: cameraId ? `Switched to ${cameraId}` : "Camera disabled",
      });
    } catch (error) {
      await showToast({
        style: Toast.Style.Failure,
        title: "Failed to switch camera",
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  };

  return (
    <List
import { Action, ActionPanel, Form, List, Toast, open, showToast } from "@raycast/api";
import { useState } from "react";

function buildActionUrl(action: unknown) {
  return `cap-desktop://action?value=${encodeURIComponent(JSON.stringify(action))}`;
}

async function switchCamera(cameraId: string | null) {
  const action = {
    switch_camera: {
      camera_id: cameraId ? { DeviceID: cameraId } : null,
    },
  };

  try {
    await open(buildActionUrl(action));
    await showToast({
      style: Toast.Style.Success,
      title: cameraId ? "Camera switched" : "Camera disabled",
      message: cameraId ?? undefined,
    });
  } catch (error) {
    await showToast({
      style: Toast.Style.Failure,
      title: "Failed to switch camera",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
}

function CameraIdForm() {
  const [cameraId, setCameraId] = useState("");

  return (
    <Form
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title="Switch Camera"
            onSubmit={() => switchCamera(cameraId.trim() || null)}
          />
        </ActionPanel>
      }
    >
      <Form.TextField
        id="cameraId"
        title="Camera Device ID"
        value={cameraId}
        onChange={setCameraId}
      />
    </Form>
  );
}

export default function Command() {
  return (
    <List searchBarPlaceholder="Camera device id...">
      <List.Item
        title="Disable Camera"
        actions={
          <ActionPanel>
            <Action title="Disable Camera" onAction={() => switchCamera(null)} />
          </ActionPanel>
        }
      />
      <List.Item
        title="Switch Camera"
        actions={
          <ActionPanel>
            <Action.Push title="Enter Camera Device ID" target={<CameraIdForm />} />
          </ActionPanel>
        }
      />
    </List>
  );
}
