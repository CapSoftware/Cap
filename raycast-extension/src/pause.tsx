import { showHUD, open } from "@raycast/api";

export default async function Command() {
  try {
    const action = "pause_recording";
    const url = `cap-desktop://action?value="${action}"`;
    await open(url);
    await showHUD("⏸️ Pausing Cap recording");
  } catch (error) {
    await showHUD("❌ Failed to pause recording");
    console.error(error);
  }
}
