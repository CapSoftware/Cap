import { showToast, Toast, open } from "@raycast/api";
import { buildDeeplink } from "./utils/deeplink";

export default async function Command() {
  try {
    const deeplink = buildDeeplink({ resume_recording: {} });
    await open(deeplink);
    await showToast({
      style: Toast.Style.Success,
      title: "Recording Resumed",
    });
  } catch (error) {
    await showToast({
      style: Toast.Style.Failure,
      title: "Failed to resume recording",
      message: String(error),
    });
  }
}
