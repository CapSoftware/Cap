import { showHUD } from "@raycast/api";
import { sendDeepLink } from "./utils";

export default async function command() {
  try {
    // serde externally-tagged struct variant
    await sendDeepLink({
      start_recording: {
        capture_mode: { screen: "Main Display" },
        camera: null,
        mic_label: null,
        capture_system_audio: false,
        mode: "instant",
      },
    });
    await showHUD("🔴 Cap: Recording started");
  } catch {
    await showHUD("❌ Failed to start recording. Is Cap running?");
  }
}
