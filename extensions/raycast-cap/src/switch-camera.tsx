import { Action, ActionPanel, List, showToast, Toast } from "@raycast/api";
import { useState, useEffect } from "react";
import { openDeepLink, generateDeepLink } from "./utils";

interface Camera {
  id: string;
  name: string;
}

export default function Command() {
  const [cameras, setCameras] = useState<Camera[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    // In a real implementation, this would fetch from Cap
    // For now, showing example cameras
    setCameras([
      { id: "default", name: "Default Camera" },
      { id: "built-in", name: "Built-in Camera" },
      { id: "external", name: "External Camera" },
    ]);
    setIsLoading(false);
  }, []);

  async function switchCamera(camera: Camera) {
    try {
      await openDeepLink(generateDeepLink("switch-camera", { id: camera.id }));
      
      await showToast({
        style: Toast.Style.Success,
        title: `Switched to ${camera.name}`,
      });
    } catch (error) {
      await showToast({
        style: Toast.Style.Failure,
        title: "Failed to Switch Camera",
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
          actions={
            <ActionPanel>
              <Action title="Switch" onAction={() => switchCamera(camera)} />
            </ActionPanel>
          }
        />
      ))}
    </List>
  );
}
