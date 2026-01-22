import { executeCapAction, createPauseRecordingAction } from "./utils";

export default async function Command() {
  await executeCapAction(createPauseRecordingAction(), {
    feedbackMessage: "Pausing recording...",
    feedbackType: "hud",
  });
}
