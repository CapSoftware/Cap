import { closeMainWindow, open, showHUD, showToast, Toast } from "@raycast/api";

export default async function Command() {
  try {
    await closeMainWindow();
    await open("cap://record");
    await showHUD("Sent start request to Cap");
  } catch (error) {
    await showToast({
      style: Toast.Style.Failure,
      title: "Failed to start Cap recording",
      message: String(error),
    });
  }
}
