import { runDeepLinkAction } from "./lib/deeplink";

export default async function startInstantRecording() {
  await runDeepLinkAction(
    { start_current_recording: { mode: "instant" } },
    "Instant recording dispatched",
  );
}
