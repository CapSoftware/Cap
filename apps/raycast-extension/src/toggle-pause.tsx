import { Action, ActionPanel, Icon, showToast, Toast } from "@raycast/api";
import { sendDeepLink } from "../deeplink";

export default function TogglePauseCommand() {
  const handleToggle = async () => {
    try {
      await showToast({
        style: Toast.Style.Animated,
        title: "Toggling Pause...",
      });
      
      await sendDeepLink("toggle_pause_recording");
      
      await showToast({
        style: Toast.Style.Success,
        title: "Pause State Toggled",
      });
    } catch (error) {
      await showToast({
        style: Toast.Style.Failure,
        title: "Failed to Toggle Pause",
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  };

  return (
    <ActionPanel>
      <Action title="Toggle Pause" icon={Icon.SwitchCamera} onAction={handleToggle} />
    </ActionPanel>
  );
}
