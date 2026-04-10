import { Action, ActionPanel, List, showToast, Toast } from "@raycast/api";
import { setCamera } from "./cap";

export default function Command() {
  return (
    <List>
      <List.Item
        title="Camera On"
        actions={
          <ActionPanel>
            <Action
              title="Enable Camera"
              onAction={async () => {
                await setCamera(); // This will prompt for camera selection
                await showToast({
                  style: Toast.Style.Success,
                  title: "Camera enabled",
                });
              }}
            />
          </ActionPanel>
        }
      />
      <List.Item
        title="Camera Off"
        actions={
          <ActionPanel>
            <Action
              title="Disable Camera"
              onAction={async () => {
                await setCamera(undefined);
                await showToast({
                  style: Toast.Style.Success,
                  title: "Camera disabled",
                });
              }}
            />
          </ActionPanel>
        }
      />
    </List>
  );
}
