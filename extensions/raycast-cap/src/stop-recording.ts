import { showToast, Toast } from "@raycast/api";
import { openDeepLink, generateDeepLink } from "./utils";

export default async function Command() {
  try {
    await openDeepLink(generateDeepLink("stop"));
    
    await showToast({
      style: Toast.Style.Success,
      title: "Stopped Recording",
    });
  } catch (error) {
    await showToast({
      style: Toast.Style.Failure,
      title: "Failed to Stop Recording",
      message: String(error),
    });
  }
}
