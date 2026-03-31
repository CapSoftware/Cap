import { closeMainWindow, open, showHUD } from "@raycast/api";

export default async function Command() {
  try {
    const action = encodeURIComponent(JSON.stringify("start_default_recording"));
    await open(`cap://action?value=${action}`);
    await closeMainWindow();
    await showHUD("Starting default recording in Cap");
  } catch (err) {
    await showHUD("Failed to start recording");
  }
}
