import { open, showToast, Toast } from "@raycast/api";

export default async function Command() {
  const action = { resume_recording: null };

  const url = `cap-desktop://action?value=${encodeURIComponent(JSON.stringify(action))}`;

  try {
    await open(url);
    await showToast({ style: Toast.Style.Success, title: "Recording resumed" });
  } catch (error) {
    await showToast({
      style: Toast.Style.Failure,
      title: "Failed to resume recording",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
}
import { open, showToast, Toast } from "@raycast/api";

export default async function Command() {
  const action = { resume_recording: null };

  const url = `cap-desktop://action?value=${encodeURIComponent(JSON.stringify(action))}`;

  try {
    await open(url);
    await showToast({ style: Toast.Style.Success, title: "Recording resumed" });
  } catch (error) {
    await showToast({
      style: Toast.Style.Failure,
      title: "Failed to resume recording",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
