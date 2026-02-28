import { open, showHUD } from "@raycast/api";

export default async function Command() {
  try {
    const action = { switch_microphone: null };
    const deeplink = `cap-desktop://action?value=${encodeURIComponent(JSON.stringify(action))}`;

    await open(deeplink);
    await showHUD("🎤 Microphone switched");
  } catch (error) {
    console.error("Failed to switch microphone:", error);
    await showHUD("❌ Failed to switch microphone");
  }
}
