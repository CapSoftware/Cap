import { executeCapAction } from "./utils/deeplink";

export default async function Command() {
  await executeCapAction(
    {
      start_recording: {
        capture_mode: { screen: "Main Display" },
        camera: null,
        mic_label: null,
        capture_system_audio: false,
        mode: "instant",
      },
    },
    "Recording Started"
  );
}
