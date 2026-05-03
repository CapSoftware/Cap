import { Action, ActionPanel, Icon, showHUD } from "@raycast/api";
import { sendDeepLink } from "./deeplink";

export default function StopRecordingCommand() {
  const handleStop = async () => {
    try {
      await showHUD("⏹️ Stopping Recording...");
      
      await sendDeepLink("stop_recording");
      
      await showHUD("⏹️ Recording Stopped");
    } catch (error) {
      await showHUD("❌ Failed to Stop Recording");
    }
  };

  return (
    <ActionPanel>
      <Action title="Stop Recording" icon={Icon.Stop} onAction={handleStop} />
    </ActionPanel>
  );
}
