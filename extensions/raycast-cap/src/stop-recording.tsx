import { executeCapAction } from "./utils/deeplink";

export default async function Command() {
  await executeCapAction("stop_recording", "Recording Stopped");
}
