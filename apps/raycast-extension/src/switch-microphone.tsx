import { Action, ActionPanel, Icon, List, showToast, Toast } from "@raycast/api";
import { sendDeepLink, getAvailableMicrophones } from "./deeplink";

export default function SwitchMicrophoneCommand() {
  return (
    <List>
      <List.Section title="Select Microphone">
        {["Default", "MacBook Pro Microphone", "External Microphone"].map((label) => (
          <List.Item
            key={label}
            title={label}
            icon={Icon.Microphone}
            actions={
              <ActionPanel>
                <Action
                  title="Switch to This Microphone"
                  icon={Icon.Checkmark}
                  onAction={async () => {
                    try {
                      await showToast({
                        style: Toast.Style.Animated,
                        title: `Switching to ${label}...`,
                      });
                      
                      await sendDeepLink("switch_microphone", { mic_label: label });
                      
                      await showToast({
                        style: Toast.Style.Success,
                        title: `Switched to ${label}`,
                      });
                    } catch (error) {
                      await showToast({
                        style: Toast.Style.Failure,
                        title: "Failed to Switch Microphone",
                        message: error instanceof Error ? error.message : "Unknown error",
                      });
                    }
                  }}
                />
              </ActionPanel>
            }
          />
        ))}
      </List.Section>
    </List>
  );
}
