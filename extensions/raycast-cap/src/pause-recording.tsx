import { executeCapAction } from "./utils/deeplink";

export default async function Command() {
  await executeCapAction("pause_recording", "Recording Paused");
}
