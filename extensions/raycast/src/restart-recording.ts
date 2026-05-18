import { restartRecording } from "./utils/deeplink";

export default async function Command() {
  await restartRecording();
}
