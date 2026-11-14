import { closeMainWindow, type LaunchProps, showHUD } from "@raycast/api";
import {
	buildStartDefaultRecordingAction,
	type RecordingModeOverride,
	triggerCapAction,
} from "./utils";

interface StartRecordingArguments {
	mode?: RecordingModeOverride;
}

export default async function Command(
	props: LaunchProps<{ arguments: StartRecordingArguments }>,
) {
	await closeMainWindow();

	const mode = props.arguments?.mode;
	const action = buildStartDefaultRecordingAction(mode);

	try {
		await triggerCapAction(action);
		await showHUD("🎥 Starting Cap recording...");
	} catch {
		await showHUD(
			"⚠️ Failed to trigger Cap recording. Make sure Cap is installed and running.",
		);
	}
}
