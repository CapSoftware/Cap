import { open, showToast, Toast } from "@raycast/api";
import { generateDeeplink } from "../utils/deeplink";

export default async function Command() {
  const deeplink = generateDeeplink("start_recording", {
    capture_mode: { screen: "default" },
    camera: null,
    mic_label: null,
    capture_system_audio: false,
    mode: "normal"
  });
  
  try {
    await open(deeplink);
    await showToast({ style: Toast.Style.Success, title: "Opened Cap" });
  } catch (error) {
    await showToast({ style: Toast.Style.Failure, title: "Error", message: String(error) });
  }
}
