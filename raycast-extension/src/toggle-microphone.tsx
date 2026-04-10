import { Action, ActionPanel, List, showToast, Toast } from "@raycast/api";
import { setMicrophone } from "./cap";

export default function Command() {
  return (
    <List>
      <List.Item
        title="Microphone On"
        actions={
          <ActionPanel>
            <Action
              title="Enable Microphone"
              onAction={async () => {
                await setMicrophone(); // This will prompt for mic selection
                await showToast({
                  style: Toast.Style.Success,
                  title: "Microphone enabled",
                });
              }}
            />
          </ActionPanel>
        }
      />
      <List.Item
        title="Microphone Off"
        actions={
          <ActionPanel>
            <Action
              title="Disable Microphone"
              onAction={async () => {
                await setMicrophone(undefined);
                await showToast({
                  style: Toast.Style.Success,
                  title: "Microphone disabled",
                });
              }}
            />
          </ActionPanel>
        }
      />
    </List>
  );
}
