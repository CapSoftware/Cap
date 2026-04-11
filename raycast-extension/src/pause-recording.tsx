import { showToast, Toast } from "@raycast/api";
import { pauseRecording } from "./cap";

export default async function Command() {
  await pauseRecording();
  await showToast({
    style: Toast.Style.Success,
    title: "Recording paused",
  });
}
