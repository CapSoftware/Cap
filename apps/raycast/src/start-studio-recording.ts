import { executeDeepLink } from "./utils";

export default async function command() {
  await executeDeepLink(
    {
      start_recording: {
        capture_mode: { screen: "Main Display" },
        camera: null,
        mic_label: null,
        capture_system_audio: false,
        mode: "studio",
      },
    },
    "Starting studio recording...",
  );
}
