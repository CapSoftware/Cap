import { Action, ActionPanel, Icon, List, showHUD, showToast, Toast } from "@raycast/api";
import { useEffect, useState } from "react";
import { Camera, isCapRunning, listCameras, openCap, switchCamera } from "./utils/cap";

export default function SwitchCamera() {
  const [cameras, setCameras] = useState<Camera[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    async function fetchCameras() {
      const cameraList = await listCameras();
      setCameras(cameraList);
      setIsLoading(false);
    }
    fetchCameras();
  }, []);

  async function handleSwitchCamera(camera: Camera | null) {
    try {
      const isRunning = await isCapRunning();
      if (!isRunning) {
        await showToast({ style: Toast.Style.Animated, title: "Starting Cap..." });
        await openCap();
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }

      await switchCamera(camera?.deviceId ?? null);
      await showHUD(camera ? `Switched to ${camera.displayName}` : "Camera disabled");
    } catch (error) {
      await showToast({
        style: Toast.Style.Failure,
        title: "Failed to switch camera",
        message: String(error),
      });
    }
  }

  return (
    <List isLoading={isLoading} searchBarPlaceholder="Select a camera...">
      <List.Item
        icon={Icon.XMarkCircle}
        title="No Camera"
        subtitle="Disable camera"
        actions={
          <ActionPanel>
            <Action title="Disable Camera" icon={Icon.XMarkCircle} onAction={() => handleSwitchCamera(null)} />
          </ActionPanel>
        }
      />
      {cameras.map((camera) => (
        <List.Item
          key={camera.deviceId}
          icon={Icon.Camera}
          title={camera.displayName}
          subtitle={camera.modelId}
          actions={
            <ActionPanel>
              <Action
                title="Switch to This Camera"
                icon={Icon.Camera}
                onAction={() => handleSwitchCamera(camera)}
              />
            </ActionPanel>
          }
        />
      ))}
    </List>
  );
}
