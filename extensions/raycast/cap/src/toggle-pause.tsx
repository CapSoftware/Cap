import { showToast, Toast } from "@raycast/api";
import { sendDeepLink } from "./utils";

export default async function Command() {
  try {
    await sendDeepLink("toggle_pause_recording");

    await showToast({
      style: Toast.Style.Success,
      title: "Toggling pause...",
    });
  } catch (error) {
    await showToast({
      style: Toast.Style.Failure,
      title: "Failed to toggle pause",
      message: String(error),
    });
  }
}
