import { showHUD, showToast, Toast } from "@raycast/api";
import { isCapRunning, stopRecording } from "./utils/cap";

export default async function StopRecording() {
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

    await stopRecording();
    await showHUD("Recording stopped");
  } catch (error) {
    await showToast({
      style: Toast.Style.Failure,
      title: "Failed to stop recording",
      message: String(error),
    });
  }
}
