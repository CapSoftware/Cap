import { runDeepLinkAction } from "./lib/deeplink";

export default async function stopRecording() {
  await runDeepLinkAction("stop_recording", "Stop recording dispatched");
}
