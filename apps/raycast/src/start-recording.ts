import { LaunchProps } from "@raycast/api";

import { captureMode, triggerCapAction } from "./lib/cap";

type StartRecordingArguments = {
	captureMode: "screen" | "window";
	targetName: string;
	recordingMode: "instant" | "studio";
};

export default async function Command(
	props: LaunchProps<{ arguments: StartRecordingArguments }>,
) {
	const { captureMode: mode, targetName, recordingMode } = props.arguments;

	await triggerCapAction(
		{
			start_recording: {
				capture_mode: captureMode(mode, targetName),
				camera: null,
				mic_label: null,
				capture_system_audio: false,
				mode: recordingMode,
			},
		},
		"Cap start recording request sent",
	);
}
