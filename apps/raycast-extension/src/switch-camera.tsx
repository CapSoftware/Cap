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
      isLoading={isLoading}
      searchBarPlaceholder="Search or enter camera ID..."
      actions={
        <ActionPanel>
          <Action
            title="Disable Camera"
            onAction={() => handleSwitchCamera(null)}
          />
        </ActionPanel>
      }
    >
      <List.Item
        title="Disable Camera"
        subtitle="Turn off camera input"
        actions={
          <ActionPanel>
            <Action
              title="Disable Camera"
              onAction={() => handleSwitchCamera(null)}
            />
          </ActionPanel>
        }
      />
      <List.Section title="Quick Actions">
        <List.Item
          title="Enter Camera ID"
          subtitle="Manually specify camera ID or model"
          actions={
            <ActionPanel>
              <Action
                title="Switch Camera"
                onAction={async () => {
                  // In a real implementation, you'd show a form to enter the camera ID
                  // For now, this is a placeholder
                  await showToast({
                    style: Toast.Style.Failure,
                    title: "Not implemented",
                    message: "Please use the deeplink directly with the camera ID",
                  });
                }}
              />
            </ActionPanel>
          }
        />
      </List.Section>
    </List>
  );
}
