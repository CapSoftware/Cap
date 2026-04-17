import { closeMainWindow } from "@raycast/api";
import { openDeeplink } from "./deeplink";

export default async function stopRecording() {
  await openDeeplink("stop_recording", "Recording stopped");
  await closeMainWindow();
}
