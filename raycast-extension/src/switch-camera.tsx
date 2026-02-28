import { List, ActionPanel, Action, showHUD, open } from "@raycast/api";
import { useState, useEffect } from "react";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

interface Camera {
  id: string;
  name: string;
}

export default function Command() {
  const [cameras, setCameras] = useState<Camera[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    async function fetchCameras() {
      try {
        // Get list of cameras using system_profiler
        const { stdout } = await execAsync(
          `system_profiler SPCameraDataType | grep "Model ID" | awk -F': ' '{print $2}'`
        );
        
        const cameraIds = stdout.trim().split("\n").filter(Boolean);
        const cameraList: Camera[] = cameraIds.map((id, index) => ({
          id,
          name: `Camera ${index + 1} (${id})`,
        }));

        // Add built-in camera if available
        if (cameraList.length === 0) {
          cameraList.push({
            id: "built-in",
            name: "Built-in Camera",
          });
        }

        setCameras(cameraList);
      } catch (error) {
        console.error("Failed to fetch cameras:", error);
        // Fallback to built-in camera
        setCameras([{ id: "built-in", name: "Built-in Camera" }]);
      } finally {
        setIsLoading(false);
      }
    }

    fetchCameras();
  }, []);

  async function switchCamera(cameraId: string) {
    try {
      const action = {
        switch_camera: {
          camera: cameraId,
        },
      };

      const encodedAction = encodeURIComponent(JSON.stringify(action));
      const deeplinkUrl = `cap://action?value=${encodedAction}`;

      await open(deeplinkUrl);
      await showHUD(`📷 Switched to camera: ${cameraId}`);
    } catch (error) {
      console.error("Failed to switch camera:", error);
      await showHUD("❌ Failed to switch camera");
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
              <Action
                title="Switch to This Camera"
                onAction={() => switchCamera(camera.id)}
              />
            </ActionPanel>
          }
        />
      ))}
    </List>
  );
}
