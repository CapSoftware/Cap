import { openDeeplink } from "./utils/deeplink";

export default async function PauseRecording() {
  await openDeeplink("recording/pause", undefined, "⏸ Cap recording paused");
}
