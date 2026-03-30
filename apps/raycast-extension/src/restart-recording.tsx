import { showHUD } from "@raycast/api";
import { openDeeplink } from "./utils/deeplink";

export default async function RestartRecording() {
  await openDeeplink("cap://record/restart");
  await showHUD("🔄 Restarted recording");
}
