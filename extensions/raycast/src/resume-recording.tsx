import { open, showHUD } from "@raycast/api";

export default async function Command() {
  const action = { resume_recording: null };
  const deeplink = `cap-desktop://action?value=${encodeURIComponent(JSON.stringify(action))}`;
  
  try {
    await open(deeplink);
    await showHUD("▶️ Recording resumed");
  } catch (error) {
    await showHUD("❌ Failed to resume recording");
  }
}
