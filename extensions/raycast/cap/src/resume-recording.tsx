import { showToast, Toast } from "@raycast/api";
import { sendDeepLink } from "./utils";

export default async function Command() {
  try {
    await sendDeepLink("resume_recording");

    await showToast({
      style: Toast.Style.Success,
      title: "Resuming recording...",
    });
  } catch (error) {
    await showToast({
      style: Toast.Style.Failure,
      title: "Failed to resume recording",
      message: String(error),
    });
  }
}
