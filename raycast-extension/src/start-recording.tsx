import { showHUD } from "@raycast/api";
import { triggerDeeplink } from "./lib/deeplink";

export default async function Command() {
  await triggerDeeplink({
    StartRecording: {
      capture_mode: { Screen: "Main" },
      camera: null,
      mic_label: null,
      capture_system_audio: false,
      mode: "instant",
    },
  });
  await showHUD("▶ Cap recording started");
}
