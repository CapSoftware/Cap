import { Action, ActionPanel, Icon, showToast, Toast } from "@raycast/api";
import { sendDeepLink } from "../deeplink";

export default function StopRecordingCommand() {
  const handleStop = async () => {
    try {
      await showToast({
        style: Toast.Style.Animated,
        title: "Stopping Recording...",
      });
      
      await sendDeepLink("stop_recording");
      
      await showToast({
        style: Toast.Style.Success,
        title: "Recording Stopped",
      });
    } catch (error) {
      await showToast({
        style: Toast.Style.Failure,
        title: "Failed to Stop Recording",
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  };

  return (
    <ActionPanel>
      <Action title="Stop Recording" icon={Icon.Stop} onAction={handleStop} />
    </ActionPanel>
  );
}
