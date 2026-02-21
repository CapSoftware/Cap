import { createResumeRecordingAction, executeCapAction } from "./utils";

export default async function Command() {
	await executeCapAction(createResumeRecordingAction(), {
		feedbackMessage: "Resuming recording...",
		feedbackType: "hud",
	});
}
