import { openDeeplink } from "./utils/deeplink";

export default async function ResumeRecording() {
  await openDeeplink("recording/resume", undefined, "▶ Cap recording resumed");
}
