import { showToast, Toast } from "@raycast/api";
import { stopRecording } from "./cap";

export default async function Command() {
  await stopRecording();
  await showToast({
    style: Toast.Style.Success,
    title: "Recording stopped",
  });
}
