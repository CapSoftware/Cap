import { closeMainWindow, showHUD } from "@raycast/api";
import { runCapDeeplink } from "./deeplink";

export default async function main() {
  await runCapDeeplink({ stop_recording: null });
  await showHUD("Cap: stop recording");
  await closeMainWindow();
}
