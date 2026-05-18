import { showToast, Toast } from "@raycast/api";
import { openDeepLink, generateDeepLink } from "./utils";

export default async function Command() {
  try {
    await openDeepLink(generateDeepLink("pause"));
    
    await showToast({
      style: Toast.Style.Success,
      title: "Paused Recording",
    });
  } catch (error) {
    await showToast({
      style: Toast.Style.Failure,
      title: "Failed to Pause Recording",
      message: String(error),
    });
  }
}
