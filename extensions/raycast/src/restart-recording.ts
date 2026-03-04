import { runDeepLinkAction } from "./lib/deeplink";

export default async function restartRecording() {
  await runDeepLinkAction("restart_recording", "Recording restarted");
}
