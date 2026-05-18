import { closeMainWindow, showHUD } from "@raycast/api";
import { runCapDeeplink } from "./deeplink";

export default async function main() {
  await runCapDeeplink({ resume_recording: null });
  await showHUD("Cap: resume recording");
  await closeMainWindow();
}
