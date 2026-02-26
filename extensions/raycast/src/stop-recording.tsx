import { Alert, confirmAlert, Icon, open } from "@raycast/api";
import {
	capNotInstalled,
	createGetStatusAction,
	createStopRecordingAction,
	executeCapAction,
	executeCapActionWithResponse,
	type RecordingStatus,
} from "./utils";

export default async function Command() {
	if (await capNotInstalled()) {
		return;
	}

	const status = await executeCapActionWithResponse<RecordingStatus>(
		createGetStatusAction(),
	);

	const isRecording = status?.is_recording ?? false;
	const isPaused = status?.is_paused ?? false;
	const recordingMode = status?.recording_mode;

	if (!isRecording) {
		// If not recording, show alert with option to open Cap
		await confirmAlert({
			title: "No Active Recording",
			message: "There is no recording in progress to stop.",
			icon: Icon.Stop,
			primaryAction: {
				title: "Open Cap",
				onAction: () => open("cap-desktop://"),
			},
		});
		return;
	}

	// Build context message for active recording
	let contextMessage = "The current recording will be stopped and ";
	if (recordingMode === "instant") {
		contextMessage += "processed for instant sharing.";
	} else if (recordingMode === "studio") {
		contextMessage += "opened in the editor for post-processing.";
	} else {
		contextMessage += "saved.";
	}

	if (isPaused) {
		contextMessage += "\n\n(Recording is currently paused)";
	}

	const confirmed = await confirmAlert({
		title: "Stop Recording?",
		message: contextMessage,
		icon: Icon.Stop,
		primaryAction: {
			title: "Stop Recording",
			style: Alert.ActionStyle.Destructive,
		},
	});

	if (!confirmed) return;

	await executeCapAction(createStopRecordingAction(), {
		feedbackMessage: "Recording stopped",
		feedbackType: "hud",
	});
}
