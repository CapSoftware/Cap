import { Action, ActionPanel, Icon, showToast, Toast } from "@raycast/api";
import { sendDeepLink } from "../deeplink";

export default function PauseRecordingCommand() {
  const handlePause = async () => {
    try {
      await showToast({
        style: Toast.Style.Animated,
        title: "Pausing Recording...",
      });
      
      await sendDeepLink("pause_recording");
      
      await showToast({
        style: Toast.Style.Success,
        title: "Recording Paused",
      });
    } catch (error) {
      await showToast({
        style: Toast.Style.Failure,
        title: "Failed to Pause Recording",
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  };

  return (
    <ActionPanel>
      <Action title="Pause Recording" icon={Icon.Pause} onAction={handlePause} />
    </ActionPanel>
  );
}
