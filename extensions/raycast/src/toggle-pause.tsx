import { showToast, Toast, open } from "@raycast/api";
import { buildDeeplink } from "./utils/deeplink";

export default async function Command() {
  try {
    const deeplink = buildDeeplink({ toggle_pause_recording: {} });
    await open(deeplink);
    await showToast({
      style: Toast.Style.Success,
      title: "Recording Toggled",
    });
  } catch (error) {
    await showToast({
      style: Toast.Style.Failure,
      title: "Failed to toggle recording",
      message: String(error),
    });
  }
}
