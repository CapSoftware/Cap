import { triggerDeepLink } from "./utils";

export default async function Command() {
  await triggerDeepLink(
    {
      start_recording: {
        capture_mode: null,
        camera: null,
        mic_label: null,
        capture_system_audio: false,
        mode: "studio",
      },
    },
    "📹 Starting Cap recording…",
  );
}
