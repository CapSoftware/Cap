import { Action, ActionPanel, confirmAlert, Icon, showToast, Toast } from "@raycast/api";
import { sendDeepLink } from "../deeplink";

export default function StartRecordingCommand() {
  const handleStart = async () => {
    try {
      await showToast({
        style: Toast.Style.Animated,
        title: "Starting Recording...",
      });
      
      await sendDeepLink("start_recording", {
        capture_mode: "screen",
        mode: "instant",
        capture_system_audio: "true",
      });
      
      await showToast({
        style: Toast.Style.Success,
        title: "Recording Started",
      });
    } catch (error) {
      await showToast({
        style: Toast.Style.Failure,
        title: "Failed to Start Recording",
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  };

  return (
    <ActionPanel>
      <Action title="Start Recording" icon={Icon.Record} onAction={handleStart} />
    </ActionPanel>
  );
}
