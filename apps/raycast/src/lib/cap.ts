import { open, showHUD } from "@raycast/api";

type RecordingMode = "instant" | "studio";
type CaptureMode =
	| {
			screen: string;
	  }
	| {
			window: string;
	  };
type DeviceOrModelID =
	| {
			DeviceID: string;
	  }
	| {
			ModelID: string;
	  };
type CapAction =
	| {
			start_recording: {
				capture_mode: CaptureMode;
				camera: DeviceOrModelID | null;
				mic_label: string | null;
				capture_system_audio: boolean;
				mode: RecordingMode;
			};
	  }
	| { stop_recording: null }
	| { pause_recording: null }
	| { resume_recording: null }
	| { toggle_pause_recording: null }
	| {
			set_microphone: {
				mic_label: string | null;
			};
	  }
	| {
			set_camera: {
				camera: DeviceOrModelID | null;
			};
	  };

export function captureMode(kind: "screen" | "window", targetName: string): CaptureMode {
	return kind === "screen" ? { screen: targetName } : { window: targetName };
}

export function cameraIdentifier(
	identifierType: "device" | "model",
	cameraIdentifier: string,
): DeviceOrModelID {
	return identifierType === "model"
		? { ModelID: cameraIdentifier }
		: { DeviceID: cameraIdentifier };
}

export async function triggerCapAction(action: CapAction, hudMessage: string) {
	const value = encodeURIComponent(JSON.stringify(action));
	const deepLink = `cap-desktop://action?value=${value}`;

	await open(deepLink);
	await showHUD(hudMessage);
}
