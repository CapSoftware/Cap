import { showHUD } from "@raycast/api";
import { openDeeplink } from "./utils/deeplink";

export default async function ToggleRecording() {
  await openDeeplink("cap://record/toggle");
  await showHUD("⏺ Toggled recording");
}
