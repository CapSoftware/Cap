import { showHUD } from "@raycast/api";
import { triggerDeeplink } from "./lib/deeplink";

export default async function Command() {
  await triggerDeeplink({ StopRecording: {} });
  await showHUD("⏹ Cap recording stopped");
}
