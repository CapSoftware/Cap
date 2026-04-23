import { ActionPanel, Action, List, showToast, Toast } from "@raycast/api";
import { executeCapAction } from "./utils";

export default function Command() {
  // In a real implementation, you would fetch available cameras
  // For now, we'll use placeholder camera names
  const cameras = [
    { id: "default", name: "Default Camera" },
    { id: "facetime", name: "FaceTime HD Camera" },
  ];

  async function switchCamera(cameraId: string, cameraName: string) {
    try {
      await showToast({
        style: Toast.Style.Animated,
        title: `Switching to ${cameraName}...`,
      });

      await executeCapAction({
        switch_camera: {
          camera: cameraId,
        },
      });

      await showToast({
        style: Toast.Style.Success,
        title: `Switched to ${cameraName}`,
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
    <List>
      {cameras.map((camera) => (
        <List.Item
          key={camera.id}
          title={camera.name}
          actions={
            <ActionPanel>
              <Action
                title="Switch to This Camera"
                onAction={() => switchCamera(camera.id, camera.name)}
              />
            </ActionPanel>
          }
        />
      ))}
    </List>
  );
}
