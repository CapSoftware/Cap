import { Action, ActionPanel, Icon, showHUD } from "@raycast/api";
import { sendDeepLink } from "./deeplink";

export default function PauseRecordingCommand() {
  const handlePause = async () => {
    try {
      await showHUD("⏸️ Pausing Recording...");
      
      await sendDeepLink("pause_recording");
      
      await showHUD("⏸️ Recording Paused");
    } catch (error) {
      await showHUD("❌ Failed to Pause Recording");
    }
  };

  return (
    <ActionPanel>
      <Action title="Pause Recording" icon={Icon.Pause} onAction={handlePause} />
    </ActionPanel>
  );
}
