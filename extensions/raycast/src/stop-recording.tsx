import { executeCapAction, createStopRecordingAction } from "./utils";

export default async function Command() {
  await executeCapAction(createStopRecordingAction(), {
    feedbackMessage: "Stopping recording...",
    feedbackType: "hud",
  });
}
