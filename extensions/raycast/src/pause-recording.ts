import { pauseRecording } from "./utils/deeplink";

export default async function Command() {
  await pauseRecording();
}
