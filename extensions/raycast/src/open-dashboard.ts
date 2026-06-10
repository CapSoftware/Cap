import { closeMainWindow, open, showToast, Toast } from "@raycast/api";

export default async function Command() {
  try {
    await closeMainWindow();
    await open("https://cap.so/dashboard");
  } catch (error) {
    await showToast({
      style: Toast.Style.Failure,
      title: "Failed to open dashboard",
      message: String(error),
    });
  }
}
