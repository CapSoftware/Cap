import { Action, ActionPanel, Icon, List, showToast, Toast } from "@raycast/api";
import { sendDeepLink } from "../deeplink";

export default function OpenSettingsCommand() {
  const handleOpen = async (page?: string) => {
    try {
      await showToast({
        style: Toast.Style.Animated,
        title: "Opening Settings...",
      });
      
      await sendDeepLink("open_settings", page ? { page } : undefined);
      
      await showToast({
        style: Toast.Style.Success,
        title: "Settings Opened",
      });
    } catch (error) {
      await showToast({
        style: Toast.Style.Failure,
        title: "Failed to Open Settings",
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  };

  return (
    <List>
      <List.Section title="Cap Settings">
        <List.Item
          title="General"
          icon={Icon.Gear}
          actions={
            <ActionPanel>
              <Action title="Open General Settings" icon={Icon.ArrowRight} onAction={() => handleOpen("general")} />
            </ActionPanel>
          }
        />
        <List.Item
          title="Recording"
          icon={Icon.Record}
          actions={
            <ActionPanel>
              <Action title="Open Recording Settings" icon={Icon.ArrowRight} onAction={() => handleOpen("recording")} />
            </ActionPanel>
          }
        />
        <List.Item
          title="Audio"
          icon={Icon.Microphone}
          actions={
            <ActionPanel>
              <Action title="Open Audio Settings" icon={Icon.ArrowRight} onAction={() => handleOpen("audio")} />
            </ActionPanel>
          }
        />
        <List.Item
          title="Video"
          icon={Icon.Camera}
          actions={
            <ActionPanel>
              <Action title="Open Video Settings" icon={Icon.ArrowRight} onAction={() => handleOpen("video")} />
            </ActionPanel>
          }
        />
      </List.Section>
    </List>
  );
}
