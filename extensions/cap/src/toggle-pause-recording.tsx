import { closeMainWindow, showHUD } from "@raycast/api";
import { runCapDeeplink } from "./deeplink";

export default async function main() {
  await runCapDeeplink({ toggle_pause_recording: null });
  await showHUD("Cap: toggle pause");
  await closeMainWindow();
}
