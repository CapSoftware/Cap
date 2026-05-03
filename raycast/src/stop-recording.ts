import { executeDeepLink } from "./utils";

export default async function StopRecording() {
  await executeDeepLink("stop_recording", "Stopping recording in Cap");
}
