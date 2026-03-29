import { showHUD } from "@raycast/api";
import { openCapDeeplink } from "./utils/deeplink";

export default async function PauseRecording() {
  await openCapDeeplink("record/pause");
  await showHUD("⏸ Paused Cap recording");
}
