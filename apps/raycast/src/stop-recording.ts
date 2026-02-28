import { showHUD } from "@raycast/api";
import { executeDeepLink } from "./utils";

export default async function StopRecording() {
  await executeDeepLink("record/stop");
  await showHUD("⏹️ Recording stopped");
}
