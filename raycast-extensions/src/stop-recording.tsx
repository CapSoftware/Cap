import { open, showHUD } from "@raycast/api";

export default async function Command() {
  const action = { stop_recording: null };
  const deeplink = `cap-desktop://action?value=${encodeURIComponent(JSON.stringify(action))}`;
  
  try {
    await open(deeplink);
    await showHUD("Recording stopped");
  } catch (error) {
    await showHUD("Failed to stop recording");
  }
}