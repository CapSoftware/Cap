import { open, showHUD } from "@raycast/api";

export default async function Command() {
  try {
    const action = { toggle_pause_recording: null };
    const deeplink = `cap-desktop://action?value=${encodeURIComponent(JSON.stringify(action))}`;

    await open(deeplink);
    await showHUD("⏯️ Recording pause toggled");
  } catch (error) {
    console.error("Failed to toggle pause:", error);
    await showHUD("❌ Failed to toggle pause");
  }
}
