import { Action, ActionPanel, Icon, showHUD } from "@raycast/api";
import { sendDeepLink } from "./deeplink";

export default function ResumeRecordingCommand() {
  const handleResume = async () => {
    try {
      await showHUD("▶️ Resuming Recording...");
      
      await sendDeepLink("resume_recording");
      
      await showHUD("▶️ Recording Resumed");
    } catch (error) {
      await showHUD("❌ Failed to Resume Recording");
    }
  };

  return (
    <ActionPanel>
      <Action title="Resume Recording" icon={Icon.Play} onAction={handleResume} />
    </ActionPanel>
  );
}
