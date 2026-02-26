import { List, ActionPanel, Action, showToast, Toast } from "@raycast/api";
import { useState, useEffect } from "react";
import { sendDeepLink } from "./utils";

interface Camera {
  id: string;
  name: string;
}

export default function Command() {
  const [cameras, setCameras] = useState<Camera[]>([
    { id: "default", name: "System Default" },
    { id: "none", name: "No Camera" },
  ]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    // In a future iteration, this could fetch available cameras from Cap
    // For now, we provide the basic options
    setIsLoading(false);
  }, []);

  async function handleSwitchCamera(cameraId: string) {
    try {
      const camera = cameraId === "none" ? null : cameraId === "default" ? null : { DeviceID: cameraId };
      
      await sendDeepLink("switch_camera", {
        camera,
      });

      await showToast({
        style: Toast.Style.Success,
        title: "Switching camera...",
      });
    } catch (error) {
      await showToast({
        style: Toast.Style.Failure,
        title: "Failed to switch camera",
        message: String(error),
      });
    }
  }

  return (
    <List isLoading={isLoading} searchBarPlaceholder="Search cameras...">
      {cameras.map((camera) => (
        <List.Item
          key={camera.id}
          title={camera.name}
          icon={camera.id === "none" ? "🚫" : "📷"}
          actions={
            <ActionPanel>
              <Action title="Switch to Camera" onAction={() => handleSwitchCamera(camera.id)} />
            </ActionPanel>
          }
        />
      ))}
    </List>
  );
}
