import { open, showToast, Toast } from "@raycast/api";

export default async function Command() {
  try {
    const action = { resume_recording: {} };
    const url = `cap-desktop://action?value=${encodeURIComponent(JSON.stringify(action))}`;
    await open(url);
    await showToast({ style: Toast.Style.Success, title: "Recording resumed" });
  } catch (error) {
    await showToast({ style: Toast.Style.Failure, title: "Failed to resume recording", message: String(error) });
  }
}

