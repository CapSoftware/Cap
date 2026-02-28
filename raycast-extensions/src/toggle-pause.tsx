import { open, showHUD } from "@raycast/api";

export default async function Command() {
  const action = { toggle_pause_recording: null };
  const deeplink = `cap-desktop://action?value=${encodeURIComponent(JSON.stringify(action))}`;
  
  try {
    await open(deeplink);
    await showHUD("Recording pause toggled");
  } catch (error) {
    await showHUD("Failed to toggle pause");
  }
}