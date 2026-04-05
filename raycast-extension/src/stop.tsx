import { showHUD, open } from "@raycast/api";

export default async function Command() {
  try {
    const action = "stop_recording";
    const url = `cap-desktop://action?value="${action}"`;
    await open(url);
    await showHUD("⏹️ Stopping Cap recording");
  } catch (error) {
    await showHUD("❌ Failed to stop recording");
    console.error(error);
  }
}
