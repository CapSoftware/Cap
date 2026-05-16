import { closeMainWindow, open, showHUD, showToast, Toast } from "@raycast/api";

export default async function Command() {
  try {
    await closeMainWindow();
    await open("cap://stop");
    await showHUD("Sent stop request to Cap");
  } catch (error) {
    await showToast({
      style: Toast.Style.Failure,
      title: "Failed to stop Cap recording",
      message: String(error),
    });
  }
}
