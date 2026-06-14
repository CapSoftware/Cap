import { Action, ActionPanel, Icon, showHUD } from "@raycast/api";
import { sendDeepLink } from "./deeplink";

export default function TogglePauseCommand() {
  const handleToggle = async () => {
    try {
      await showHUD("🎬 Pause State Toggled");
      
      await sendDeepLink("toggle_pause_recording");
    } catch (error) {
      await showHUD("❌ Failed to Toggle Pause");
    }
  };

  return (
    <ActionPanel>
      <Action title="Toggle Pause" icon={Icon.Pause} onAction={handleToggle} />
    </ActionPanel>
  );
}
