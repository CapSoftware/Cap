import { open, showHUD } from "@raycast/api";

export default async function Command() {
  try {
    const action = { resume_recording: null };
    const deeplink = `cap-desktop://action?value=${encodeURIComponent(JSON.stringify(action))}`;

    await open(deeplink);
    await showHUD("▶️ Recording resumed");
  } catch (error) {
    console.error("Failed to resume recording:", error);
    await showHUD("❌ Failed to resume recording");
  }
}
