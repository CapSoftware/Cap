import { executeCapAction, createRestartRecordingAction } from "./utils";

export default async function Command() {
    await executeCapAction(createRestartRecordingAction(), {
        feedbackMessage: "Restarting recording...",
        feedbackType: "hud",
    });
}
