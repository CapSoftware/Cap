import { runDeepLinkAction } from "./lib/deeplink";

export default async function startInstantRecording() {
  await runDeepLinkAction(
    {
      start_recording: {
        capture_mode: null,
        camera: null,
        mic_label: null,
        capture_system_audio: false,
        mode: "instant",
      },
    },
    "Instant recording started",
  );
}
