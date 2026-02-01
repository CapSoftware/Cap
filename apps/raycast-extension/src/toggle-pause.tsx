import { showHUD, showToast, Toast } from "@raycast/api";
import { isCapRunning, togglePauseRecording } from "./utils/cap";

export default async function TogglePause() {
  try {
    const isRunning = await isCapRunning();
    if (!isRunning) {
      await showToast({
        style: Toast.Style.Failure,
        title: "Cap is not running",
        message: "Please start Cap first",
      });
      return;
    }

    await togglePauseRecording();
    await showHUD("Recording pause toggled");
  } catch (error) {
    await showToast({
      style: Toast.Style.Failure,
      title: "Failed to toggle pause",
      message: String(error),
    });
  }
}
