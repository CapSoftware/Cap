import { showToast, Toast } from "@raycast/api";
import { sendDeepLink } from "./utils";

export default async function Command() {
  try {
    await sendDeepLink("pause_recording");

    await showToast({
      style: Toast.Style.Success,
      title: "Pausing recording...",
    });
  } catch (error) {
    await showToast({
      style: Toast.Style.Failure,
      title: "Failed to pause recording",
      message: String(error),
    });
  }
}
