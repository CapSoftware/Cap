import { openDeeplink } from "./utils/deeplink";

export default async function StartRecording() {
  await openDeeplink("recording/start", undefined, "▶ Cap recording started");
}
