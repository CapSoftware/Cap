import { executeDeepLink } from "./utils";

export default async function TogglePauseRecording() {
  await executeDeepLink("toggle_pause_recording", "Toggling pause on recording in Cap");
}
