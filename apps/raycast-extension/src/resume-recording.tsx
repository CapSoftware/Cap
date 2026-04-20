import { Action, ActionPanel, Icon, showToast, Toast } from "@raycast/api";
import { sendDeepLink } from "../deeplink";

export default function ResumeRecordingCommand() {
  const handleResume = async () => {
    try {
      await showToast({
        style: Toast.Style.Animated,
        title: "Resuming Recording...",
      });
      
      await sendDeepLink("resume_recording");
      
      await showToast({
        style: Toast.Style.Success,
        title: "Recording Resumed",
      });
    } catch (error) {
      await showToast({
        style: Toast.Style.Failure,
        title: "Failed to Resume Recording",
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  };

  return (
    <ActionPanel>
      <Action title="Resume Recording" icon={Icon.Play} onAction={handleResume} />
    </ActionPanel>
  );
}
