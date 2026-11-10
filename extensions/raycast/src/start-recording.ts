import {
	Toast,
	closeMainWindow,
	getPreferenceValues,
	open,
	openExtensionPreferences,
	showHUD,
	showToast,
} from "@raycast/api";

interface Preferences {
	recordingMode?: "studio" | "instant";
	captureTargetType?: "screen" | "window";
	targetName: string;
	captureSystemAudio?: boolean;
}

export default async function Command() {
	const {
		recordingMode = "studio",
		captureTargetType = "screen",
		targetName,
		captureSystemAudio = true,
	} = getPreferenceValues<Preferences>();

	const resolvedTarget = targetName?.trim();
	if (!resolvedTarget) {
		await showToast({
			style: Toast.Style.Failure,
			title: "Capture target name required",
			message: "Set a valid display or window name in extension preferences before recording.",
		});
		await openExtensionPreferences();
		return;
	}

	const capture_mode =
		captureTargetType === "window"
			? { window: resolvedTarget }
			: { screen: resolvedTarget };

	const action = {
		start_recording: {
			capture_mode,
			camera: null,
			mic_label: null,
			capture_system_audio: Boolean(captureSystemAudio),
			mode: recordingMode,
		},
	};

	await closeMainWindow();
	await open(`cap-desktop://action?value=${encodeURIComponent(JSON.stringify(action))}`);
	await showHUD(`Cap ${recordingMode} recording started (${resolvedTarget})`);
}
