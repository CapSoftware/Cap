import { showHUD } from "@raycast/api";
import { openCapDeeplink } from "./utils/deeplink";

export default async function ResumeRecording() {
  await openCapDeeplink("record/resume");
  await showHUD("▶️ Resumed Cap recording");
}
