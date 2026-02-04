import { showToast, Toast, closeMainWindow } from "@raycast/api";
import { executeCapAction } from "./utils";

export default async function Command() {
  try {
    await closeMainWindow();
    
    await showToast({
      style: Toast.Style.Animated,
      title: "Resuming recording...",
    });

    await executeCapAction({ resume_recording: {} });

    await showToast({
      style: Toast.Style.Success,
      title: "Recording resumed",
    });
  } catch (error) {
    await showToast({
      style: Toast.Style.Failure,
      title: "Failed to resume recording",
      message: String(error),
    });
  }
}
