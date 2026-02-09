import { executeDeepLink } from "./utils";

export default async function PauseRecording() {
  await executeDeepLink("pause_recording", "Pausing recording in Cap");
}
