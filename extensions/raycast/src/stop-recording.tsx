import { showToast, Toast, closeMainWindow } from "@raycast/api";
import { executeCapAction } from "./utils";

export default async function Command() {
  try {
    await closeMainWindow();
    
    await showToast({
      style: Toast.Style.Animated,
      title: "Stopping recording...",
    });

    await executeCapAction({ stop_recording: {} });

    await showToast({
      style: Toast.Style.Success,
      title: "Recording stopped",
    });
  } catch (error) {
    await showToast({
      style: Toast.Style.Failure,
      title: "Failed to stop recording",
      message: String(error),
    });
  }
}
