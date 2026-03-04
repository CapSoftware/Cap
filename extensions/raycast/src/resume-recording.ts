import { runDeepLinkAction } from "./lib/deeplink";

export default async function resumeRecording() {
  await runDeepLinkAction("resume_recording", "Recording resumed");
}
