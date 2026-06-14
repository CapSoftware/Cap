import { showHUD, open } from "@raycast/api";

export default async function Command() {
  try {
    const action = "stop_recording";
    const encodedAction = encodeURIComponent(JSON.stringify(action));
    const deeplinkUrl = `cap://action?value=${encodedAction}`;

    await open(deeplinkUrl);
    await showHUD("⏹️ Stopped recording");
  } catch (error) {
    console.error("Failed to stop recording:", error);
    await showHUD("❌ Failed to stop recording");
  }
}
