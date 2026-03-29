import { showHUD } from "@raycast/api";
import { openDeeplink } from "./utils/deeplink";

export default async function PauseRecording() {
  await openDeeplink("cap://record/pause");
  await showHUD("⏸ Paused recording");
}
