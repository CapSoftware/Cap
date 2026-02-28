import { resumeRecording } from "./utils/deeplink";

export default async function Command() {
  await resumeRecording();
}
