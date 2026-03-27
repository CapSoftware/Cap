import { showHUD, open } from "@raycast/api";

export default async function Command() {
  try {
    const action = "toggle_mic";
    const url = `cap-desktop://action?value="${action}"`;
    await open(url);
    await showHUD("🎤 Toggling microphone");
  } catch (error) {
    await showHUD("❌ Failed to toggle microphone");
    console.error(error);
  }
}
