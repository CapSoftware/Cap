import { closeMainWindow } from "@raycast/api";
import { openDeeplink } from "./deeplink";

export default async function startRecording() {
  await openDeeplink(
    {
      start_recording: {
        capture_mode: { screen: "Main Display" },
        camera: null,
        mic_label: null,
        capture_system_audio: false,
        mode: "studio",
      },
    },
    "Recording started",
  );
  await closeMainWindow();
}
