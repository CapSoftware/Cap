import { showToast, Toast } from "@raycast/api";
import { resumeRecording } from "./cap";

export default async function Command() {
  await resumeRecording();
  await showToast({
    style: Toast.Style.Success,
    title: "Recording resumed",
  });
}
