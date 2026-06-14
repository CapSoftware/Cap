import { executeCapAction } from "./utils/deeplink";

export default async function Command() {
  await executeCapAction("resume_recording", "Recording Resumed");
}
