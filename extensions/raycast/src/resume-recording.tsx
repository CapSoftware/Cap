import { executeCapAction, createResumeRecordingAction } from "./utils";

export default async function Command() {
  await executeCapAction(createResumeRecordingAction(), {
    feedbackMessage: "Resuming recording...",
    feedbackType: "hud",
  });
}
