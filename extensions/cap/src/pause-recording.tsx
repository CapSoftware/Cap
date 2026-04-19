import { closeMainWindow, showHUD } from "@raycast/api";
import { runCapDeeplink } from "./deeplink";

export default async function main() {
  await runCapDeeplink({ pause_recording: null });
  await showHUD("Cap: pause recording");
  await closeMainWindow();
}
