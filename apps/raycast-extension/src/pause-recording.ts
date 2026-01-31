import { open, showToast, Toast } from "@raycast/api";

export default async function Command() {
  const action = { pause_recording: null };

  const url = `cap-desktop://action?value=${encodeURIComponent(JSON.stringify(action))}`;

  try {
    await open(url);
    await showToast({ style: Toast.Style.Success, title: "Recording paused" });
  } catch (error) {
    await showToast({
      style: Toast.Style.Failure,
      title: "Failed to pause recording",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
}

export default async function Command() {
  const action = { pause_recording: null };

  const url = `cap-desktop://action?value=${encodeURIComponent(JSON.stringify(action))}`;
  await open(url);
}
