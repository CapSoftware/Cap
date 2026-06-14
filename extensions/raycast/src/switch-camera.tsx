import { List, ActionPanel, Action, showToast, Toast, open } from "@raycast/api";
import { useState, useEffect } from "react";
import { getAvailableCameras } from "./utils/devices";
import { buildDeeplink } from "./utils/deeplink";

export default function Command() {
  const [cameras, setCameras] = useState<Array<{ id: string; name: string }>>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    getAvailableCameras()
      .then(setCameras)
      .catch((error) => {
        showToast({
          style: Toast.Style.Failure,
          title: "Failed to load cameras",
          message: String(error),
        });
      })
      .finally(() => setIsLoading(false));
  }, []);

  return (
    <List isLoading={isLoading} searchBarPlaceholder="Search cameras...">
      {cameras.length === 0 && !isLoading && (
        <List.EmptyView title="No cameras available" description="Make sure Cap has camera permissions" />
      )}
      {cameras.map((camera) => (
        <List.Item
          key={camera.id}
          title={camera.name}
          subtitle={camera.id}
          actions={
            <ActionPanel>
              <Action
                title="Switch to This Camera"
                onAction={async () => {
                  try {
                    const deeplink = buildDeeplink({
                      switch_camera: { camera: { device_id: camera.id } },
                    });
                    await open(deeplink);
                    await showToast({
                      style: Toast.Style.Success,
                      title: `Switched to ${camera.name}`,
                    });
                  } catch (error) {
                    await showToast({
                      style: Toast.Style.Failure,
                      title: "Failed to switch camera",
                      message: String(error),
                    });
                  }
                }}
              />
            </ActionPanel>
          }
        />
      ))}
    </List>
  );
}
