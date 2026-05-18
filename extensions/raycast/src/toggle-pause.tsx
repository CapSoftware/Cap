import { showToast, Toast, closeMainWindow } from "@raycast/api";
import { executeCapAction } from "./utils";

export default async function Command() {
  try {
    await closeMainWindow();
    
    await showToast({
      style: Toast.Style.Animated,
      title: "Toggling pause...",
    });

    await executeCapAction({ toggle_pause_recording: {} });

    await showToast({
      style: Toast.Style.Success,
      title: "Recording pause toggled",
    });
  } catch (error) {
    await showToast({
      style: Toast.Style.Failure,
      title: "Failed to toggle pause",
      message: String(error),
    });
  }
}
