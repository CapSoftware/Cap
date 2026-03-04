import { runDeepLinkAction } from "./lib/deeplink";

export default async function startStudioRecording() {
  await runDeepLinkAction(
    {
      start_recording: {
        capture_mode: null,
        camera: null,
        mic_label: null,
        capture_system_audio: false,
        mode: "studio",
      },
    },
    "Studio recording started",
  );
}
