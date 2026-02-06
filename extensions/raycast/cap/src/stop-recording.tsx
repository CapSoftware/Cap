import { showToast, Toast } from "@raycast/api";
import { sendDeepLink } from "./utils";

export default async function Command() {
  try {
    await sendDeepLink("stop_recording");

    await showToast({
      style: Toast.Style.Success,
      title: "Stopping recording...",
    });
  } catch (error) {
    await showToast({
      style: Toast.Style.Failure,
      title: "Failed to stop recording",
      message: String(error),
    });
  }
}
