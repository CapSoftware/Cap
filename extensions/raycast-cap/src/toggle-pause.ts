import { showToast, Toast } from "@raycast/api";
import { openDeepLink, generateDeepLink } from "./utils";

export default async function Command() {
  try {
    await openDeepLink(generateDeepLink("toggle-pause"));
    
    await showToast({
      style: Toast.Style.Success,
      title: "Toggled Recording Pause",
    });
  } catch (error) {
    await showToast({
      style: Toast.Style.Failure,
      title: "Failed to Toggle Pause",
      message: String(error),
    });
  }
}
