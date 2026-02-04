import { open, showToast, Toast } from "@raycast/api";
import { generateDeeplink } from "../utils/deeplink";

export default async function Command() {
  // TODO: Replace "default" with actual mic picker when available
  // For now, this will use the default/system microphone
  const deeplink = generateDeeplink("switch_microphone", { 
    mic_label: "default" 
  });
  
  try {
    await open(deeplink);
    await showToast({ style: Toast.Style.Success, title: "Opened Cap" });
  } catch (error) {
    await showToast({ style: Toast.Style.Failure, title: "Error", message: String(error) });
  }
}
