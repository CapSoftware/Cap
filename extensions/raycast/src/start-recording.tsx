import { showToast, Toast } from "@raycast/api";
import { isCapInstalled } from "./utils";
import { open, closeMainWindow } from "@raycast/api";

export default async function Command() {
  const installed = await isCapInstalled();
  if (!installed) {
    await showToast({
      style: Toast.Style.Failure,
      title: "Cap not installed",
      message: "Please install Cap from cap.so",
    });
    return;
  }
  
  await closeMainWindow();
  // Open Cap app - it will show the recording interface
  await open("cap-desktop://");
  
  await showToast({
    style: Toast.Style.Success,
    title: "Cap opened",
    message: "Select a screen or window to record",
  });
}
