import { openDeeplink } from "./utils/deeplink";

export default async function StopRecording() {
  await openDeeplink("recording/stop", undefined, "⏹ Cap recording stopped");
}
