import { runDeepLinkAction } from "./lib/deeplink";

export default async function togglePauseRecording() {
  await runDeepLinkAction(
    "toggle_pause_recording",
    "Pause toggle dispatched",
  );
}
