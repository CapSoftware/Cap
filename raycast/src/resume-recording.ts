import { executeDeepLink } from "./utils";

export default async function ResumeRecording() {
  await executeDeepLink("resume_recording", "Resuming recording in Cap");
}
