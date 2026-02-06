import { showToast, Toast } from "@raycast/api";
import { openDeepLink, generateDeepLink } from "./utils";

export default async function Command() {
  try {
    await openDeepLink(generateDeepLink("record"));
    
    await showToast({
      style: Toast.Style.Success,
      title: "Started Recording",
    });
  } catch (error) {
    await showToast({
      style: Toast.Style.Failure,
      title: "Failed to Start Recording",
      message: String(error),
    });
  }
}
