import { showHUD } from "@raycast/api";
import { openCapDeeplink } from "./utils/deeplink";

export default async function RestartRecording() {
  await openCapDeeplink("record/restart");
  await showHUD("🔁 Restarted Cap recording");
}
