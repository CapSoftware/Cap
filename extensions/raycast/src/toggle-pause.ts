import { showHUD } from "@raycast/api";
import { sendDeepLink } from "./utils";

export default async function command() {
  try {
    // serde unit variant
    await sendDeepLink("toggle_pause_recording");
    await showHUD("⏯ Cap: Toggled pause");
  } catch {
    await showHUD("❌ Failed to toggle pause. Is Cap running?");
  }
}
