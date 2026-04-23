import { showHUD } from "@raycast/api";
import { triggerDeeplink } from "./lib/deeplink";
import { LocalStorage } from "@raycast/api";

const PAUSED_KEY = "cap_is_paused";

export default async function Command() {
  const isPaused = (await LocalStorage.getItem<string>(PAUSED_KEY)) === "true";

  if (isPaused) {
    await triggerDeeplink({ ResumeRecording: {} });
    await LocalStorage.setItem(PAUSED_KEY, "false");
    await showHUD("▶ Cap recording resumed");
  } else {
    await triggerDeeplink({ PauseRecording: {} });
    await LocalStorage.setItem(PAUSED_KEY, "true");
    await showHUD("⏸ Cap recording paused");
  }
}
