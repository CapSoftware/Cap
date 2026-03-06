import { runDeepLinkAction } from "./lib/deeplink";

export default async function startStudioRecording() {
  await runDeepLinkAction(
    { start_current_recording: { mode: "studio" } },
    "Studio recording dispatched",
  );
}
