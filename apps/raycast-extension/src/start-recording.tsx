import { Action, ActionPanel, Icon, showHUD } from "@raycast/api";
import { sendDeepLink } from "./deeplink";

export default function StartRecordingCommand() {
  const handleStart = async () => {
    try {
      await showHUD("🔴 Starting Recording...");
      
      await sendDeepLink("start_recording", {
        capture_mode: "screen",
        mode: "instant",
        capture_system_audio: "true",
      });
      
      await showHUD("🔴 Recording Started");
    } catch (error) {
      await showHUD("❌ Failed to Start Recording");
    }
  };

  return (
    <ActionPanel>
      <Action title="Start Recording" icon={Icon.Record} onAction={handleStart} />
    </ActionPanel>
  );
}
