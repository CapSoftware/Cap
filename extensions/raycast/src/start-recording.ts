import { showHUD, getPreferenceValues } from "@raycast/api";
import { sendDeepLink } from "./utils";

export default async function Command() {
  await sendDeepLink({
    start_recording: {
      capture_mode: { screen: "" },
      camera: null,
      mic_label: null,
      capture_system_audio: false,
      mode: "studio",
    },
  });
  await showHUD("Recording started");
}
