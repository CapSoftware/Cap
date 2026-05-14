import { triggerAction } from "./utils";
import { showHUD } from "@raycast/api";

export default async function Command() {
  // Trigger a standard recording. User can configure devices in the app.
  await triggerAction({
    start_recording: {
      capture_mode: { screen: "Main" },
      camera: null,
      mic_label: null,
      capture_system_audio: true,
      mode: "instant"
    }
  });
  await showHUD("Starting Cap Recording");
}
