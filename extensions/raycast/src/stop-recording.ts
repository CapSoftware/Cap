import { stopRecording } from "./utils/deeplink";

export default async function Command() {
  await stopRecording();
}
