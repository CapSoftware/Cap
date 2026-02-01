import { showToast, Toast, open } from "@raycast/api";
import { buildDeeplink } from "./utils/deeplink";

export default async function Command() {
  try {
    const deeplink = buildDeeplink({ stop_recording: {} });
    await open(deeplink);
    await showToast({
      style: Toast.Style.Success,
      title: "Recording Stopped",
    });
  } catch (error) {
    await showToast({
      style: Toast.Style.Failure,
      title: "Failed to stop recording",
      message: String(error),
    });
  }
}
