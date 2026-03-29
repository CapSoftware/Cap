import { showHUD } from "@raycast/api";
import { sendDeepLink } from "./utils";

export default async function command() {
  try {
    // serde unit variant
    await sendDeepLink("stop_recording");
    await showHUD("⏹ Cap: Recording stopped");
  } catch {
    await showHUD("❌ Failed to stop recording. Is Cap running?");
  }
}
