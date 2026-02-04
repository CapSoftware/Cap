import { open, showToast, Toast } from "@raycast/api";
import { generateDeeplink } from "../utils/deeplink";

export default async function Command() {
  const deeplink = generateDeeplink("pause_recording");
  
  try {
    await open(deeplink);
    await showToast({ style: Toast.Style.Success, title: "Opened Cap" });
  } catch (error) {
    await showToast({ style: Toast.Style.Failure, title: "Error", message: String(error) });
  }
}
