import { showHUD } from "@raycast/api";
import { openDeeplink } from "./utils/deeplink";

export default async function ResumeRecording() {
  await openDeeplink("cap://record/resume");
  await showHUD("▶️ Resumed recording");
}
