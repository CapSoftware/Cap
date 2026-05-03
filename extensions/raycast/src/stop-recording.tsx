import { open, showHUD } from "@raycast/api";

export default async function Command() {
  try {
    const action = { stop_recording: null };
    const deeplink = `cap-desktop://action?value=${encodeURIComponent(JSON.stringify(action))}`;

    await open(deeplink);
    await showHUD("⏹️ Recording stopped");
  } catch (error) {
    console.error("Failed to stop recording:", error);
    await showHUD("❌ Failed to stop recording");
  }
}
