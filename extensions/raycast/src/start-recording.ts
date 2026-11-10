import { closeMainWindow, getPreferenceValues, open, showHUD } from "@raycast/api";

interface Preferences {
	recordingMode?: "studio" | "instant";
	captureTargetType?: "screen" | "window";
	targetName?: string;
	captureSystemAudio?: boolean;
}

export default async function Command() {
	const {
		recordingMode = "studio",
		captureTargetType = "screen",
		targetName = "Built-in Retina Display",
		captureSystemAudio = true,
	} = getPreferenceValues<Preferences>();

	const resolvedTarget = targetName.trim() || "Built-in Retina Display";
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
