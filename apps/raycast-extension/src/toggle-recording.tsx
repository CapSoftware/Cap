import { showHUD } from "@raycast/api";
import { openCapDeeplink } from "./utils/deeplink";

export default async function ToggleRecording() {
  await openCapDeeplink("record/toggle");
  await showHUD("🔄 Toggled Cap recording");
}
