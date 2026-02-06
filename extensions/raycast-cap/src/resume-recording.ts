import { showToast, Toast } from "@raycast/api";
import { openDeepLink, generateDeepLink } from "./utils";

export default async function Command() {
  try {
    await openDeepLink(generateDeepLink("resume"));
    
    await showToast({
      style: Toast.Style.Success,
      title: "Resumed Recording",
    });
  } catch (error) {
    await showToast({
      style: Toast.Style.Failure,
      title: "Failed to Resume Recording",
      message: String(error),
    });
  }
}
