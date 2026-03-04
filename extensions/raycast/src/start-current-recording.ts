import { runDeepLinkAction } from "./lib/deeplink";

export default async function startCurrentRecording() {
  await runDeepLinkAction(
    { start_current_recording: { mode: null } },
    "Recording started with saved settings",
  );
}
