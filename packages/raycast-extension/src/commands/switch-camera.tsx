import { open, showToast, Toast } from "@raycast/api";
import { generateDeeplink } from "../utils/deeplink";

export default async function Command() {
  // TODO: Replace "default" with actual device picker when available
  // For now, this will use the default/primary camera device
  const deeplink = generateDeeplink("switch_camera", { 
    device_id: "default" 
  });
  
  try {
    await open(deeplink);
    await showToast({ style: Toast.Style.Success, title: "Opened Cap" });
  } catch (error) {
    await showToast({ style: Toast.Style.Failure, title: "Error", message: String(error) });
  }
}
