import { showToast, Toast, closeMainWindow } from "@raycast/api";
import { executeCapAction } from "./utils";

export default async function Command() {
  try {
    await closeMainWindow();
    
    await showToast({
      style: Toast.Style.Animated,
      title: "Pausing recording...",
    });

    await executeCapAction({ pause_recording: {} });

    await showToast({
      style: Toast.Style.Success,
      title: "Recording paused",
    });
  } catch (error) {
    await showToast({
      style: Toast.Style.Failure,
      title: "Failed to pause recording",
      message: String(error),
    });
  }
}
