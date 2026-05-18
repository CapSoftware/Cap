import { showHUD, open } from "@raycast/api";

export default async function Command() {
  try {
    // Note: This toggles between pause and resume
    // The actual state management is handled by the Cap app
    // For now, we'll try to pause first, and if already paused, it will resume
    const pauseAction = "pause_recording";
    const encodedAction = encodeURIComponent(JSON.stringify(pauseAction));
    const deeplinkUrl = `cap://action?value=${encodedAction}`;

    await open(deeplinkUrl);
    await showHUD("⏸️ Toggled pause/resume");
  } catch (error) {
    console.error("Failed to toggle pause:", error);
    await showHUD("❌ Failed to toggle pause");
  }
}
