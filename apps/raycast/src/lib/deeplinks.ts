import { open, showToast, Toast } from "@raycast/api";

type CaptureMode =
	| {
			screen: string;
	  }
	| {
			window: string;
	  };

type RecordingMode = "studio" | "instant";

type CameraId =
	| {
			DeviceID: string;
	  }
	| {
			ModelID: {
				id: string;
				name: string;
			};
	  };

type CapAction =
	| {
			start_recording: {
				capture_mode: CaptureMode;
				camera: CameraId | null;
				mic_label: string | null;
				capture_system_audio: boolean;
				mode: RecordingMode;
			};
	  }
	| {
			stop_recording: null;
	  }
	| {
			pause_recording: null;
	  }
	| {
			resume_recording: null;
	  }
	| {
			toggle_pause_recording: null;
	  }
	| {
			take_screenshot: {
				capture_mode: CaptureMode;
			};
	  }
	| {
			set_microphone: {
				mic_label: string | null;
			};
	  }
	| {
			set_camera: {
				camera: CameraId | null;
			};
	  };

export type CaptureTarget = {
	kind: "screen" | "window";
	name: string;
};

export type StartRecordingOptions = {
	target: CaptureTarget;
	mode: RecordingMode;
	micLabel?: string;
	cameraDeviceId?: string;
	captureSystemAudio: boolean;
};

function captureMode(target: CaptureTarget): CaptureMode {
	return target.kind === "screen"
		? { screen: target.name }
		: { window: target.name };
}

function actionUrl(action: CapAction): string {
	const value = encodeURIComponent(JSON.stringify(action));
	return `cap-desktop://action?value=${value}`;
}

export async function runCapAction(action: CapAction, title: string) {
	await open(actionUrl(action));
	await showToast({
		style: Toast.Style.Success,
		title,
	});
}

export async function startRecording(options: StartRecordingOptions) {
	await runCapAction(
		{
			start_recording: {
				capture_mode: captureMode(options.target),
				camera: options.cameraDeviceId
					? { DeviceID: options.cameraDeviceId }
					: null,
				mic_label: options.micLabel?.trim() || null,
				capture_system_audio: options.captureSystemAudio,
				mode: options.mode,
			},
		},
		"Started Cap recording",
	);
}

export async function screenshot(target: CaptureTarget) {
	await runCapAction(
		{
			take_screenshot: {
				capture_mode: captureMode(target),
			},
		},
		"Captured screenshot",
	);
}

export async function setMicrophone(micLabel: string | null) {
	await runCapAction(
		{
			set_microphone: {
				mic_label: micLabel?.trim() || null,
			},
		},
		micLabel ? "Switched microphone" : "Disabled microphone",
	);
}

export async function setCamera(deviceId: string | null) {
	await runCapAction(
		{
			set_camera: {
				camera: deviceId?.trim() ? { DeviceID: deviceId.trim() } : null,
			},
		},
		deviceId ? "Switched camera" : "Disabled camera",
	);
}

export const recordingActions = [
	{
		title: "Pause Recording",
		action: { pause_recording: null },
	},
	{
		title: "Resume Recording",
		action: { resume_recording: null },
	},
	{
		title: "Toggle Pause",
		action: { toggle_pause_recording: null },
	},
	{
		title: "Stop Recording",
		action: { stop_recording: null },
	},
] satisfies Array<{ title: string; action: CapAction }>;
