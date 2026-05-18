import { togglePauseRecording } from "./utils/deeplink";

export default async function Command() {
  await togglePauseRecording();
}
