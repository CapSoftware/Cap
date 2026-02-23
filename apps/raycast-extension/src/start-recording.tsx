import {
	closeMainWindow,
	getPreferenceValues,
	open,
	showHUD,
} from "@raycast/api";

interface Preferences {
	captureType: "screen" | "window";
	captureName: string;
	captureSystemAudio: boolean;
	recordingMode: "instant" | "studio";
}

export default async function Command() {
	const prefs = getPreferenceValues<Preferences>();

	const captureName = prefs.captureName?.trim();
	if (!captureName) {
		await showHUD("Set a screen/window name in Raycast preferences first");
		return;
	}
	const captureMode =
		prefs.captureType === "window"
			? { window: captureName }
			: { screen: captureName };

	const action = {
		start_recording: {
			capture_mode: captureMode,
			camera: null,
			mic_label: null,
			capture_system_audio: prefs.captureSystemAudio ?? false,
			mode: prefs.recordingMode ?? "instant",
		},
	};

	const url = `cap://action?value=${encodeURIComponent(JSON.stringify(action))}`;

	await closeMainWindow();
	await open(url);
	await showHUD("Starting recording…");
}
