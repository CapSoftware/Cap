import { open, showToast, Toast } from "@raycast/api";

export default async function Command() {
  try {
    const action = {
      take_screenshot: {
        target: { variant: "display", id: "0" }
      }
    };
    const url = `cap-desktop://action?value=${encodeURIComponent(JSON.stringify(action))}`;
    await open(url);
    await showToast({ style: Toast.Style.Success, title: "Screenshot requested" });
  } catch (error) {
    await showToast({ style: Toast.Style.Failure, title: "Failed to take screenshot", message: String(error) });
  }
}

