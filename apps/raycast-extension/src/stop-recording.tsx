import { closeMainWindow, open, showHUD } from "@raycast/api";

export default async function Command() {
  try {
    const action = encodeURIComponent(JSON.stringify("stop_recording"));
    await open(`cap://action?value=${action}`);
    await closeMainWindow();
    await showHUD("Stopped recording in Cap");
  } catch (err) {
    await showHUD("Failed to stop recording");
  }
}
