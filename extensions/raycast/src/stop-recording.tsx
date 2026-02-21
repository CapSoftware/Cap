import { Alert, confirmAlert, Icon } from "@raycast/api";
import { createStopRecordingAction, executeCapAction } from "./utils";

export default async function Command() {
	const confirmed = await confirmAlert({
		title: "Stop Recording?",
		message: "The current recording will be stopped and processed.",
		icon: Icon.Stop,
		primaryAction: {
			title: "Stop Recording",
			style: Alert.ActionStyle.Destructive,
		},
	});

	if (!confirmed) return;

	await executeCapAction(createStopRecordingAction(), {
		feedbackMessage: "Stopping recording...",
		feedbackType: "hud",
	});
}
